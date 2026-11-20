import test from "node:test";
import assert from "node:assert/strict";
import { fetchMediaFollowingSafeRedirects, isMediaPlaybackUrl } from "../lib/media-redirect.ts";
import { interpretMediaRange, parseMediaRange } from "../lib/media-range.ts";

const base = "https://rr4---sn-sample.googlevideo.com/videoplayback?clen=4008192&range=100-109&sig=fake";
const edge = "https://rr5---sn-sample.googlevideo.com/videoplayback?clen=4008192&sig=other";

test("redirect target is restricted to HTTPS Googlevideo playback paths", () => {
  assert.equal(isMediaPlaybackUrl(base), true);
  for (const invalid of [
    "http://rr5---sn-sample.googlevideo.com/videoplayback",
    "https://attacker.googlevideo.com.evil.org/videoplayback",
    "https://rr5---sn-sample.googlevideo.com.evil.org/videoplayback",
    "https://youtube.com/watch?v=123",
    "https://rr5---sn-sample.googlevideo.com:8443/videoplayback",
    "https://rr5---sn-sample.googlevideo.com/private",
    "https://rr5---sn-sample.googlevideo.com@evil.org/videoplayback"
  ]) assert.equal(isMediaPlaybackUrl(invalid), false, invalid);
});
test("HTTP 302 follows verified Googlevideo destination, keeps Range and range query", async () => {
  const calls = [];
  const mock = async (url, init) => {
    calls.push({url,init});
    if (calls.length === 1) return new Response(null, {status:302,headers:{"Location":edge}});
    return new Response(new Uint8Array(10), {
      status:206,headers:{"Content-Range":"bytes 100-109/4008192","Content-Length":"10","Content-Type":"audio/mp4"}
    });
  };
  const result=await fetchMediaFollowingSafeRedirects(base,{range:"bytes=100-109",fetchImpl:mock,timeoutMs:10000});
  assert.equal(result.ok,true);
  assert.equal(result.redirects,1);
  assert.equal(calls.length,2);
  assert.equal(calls[1].init.redirect,"manual");
  assert.equal(calls[1].init.headers.Range,"bytes=100-109");
  assert.equal(new URL(calls[1].url).searchParams.get("range"),"100-109");
  const plan=interpretMediaRange(result.response.status,result.response.headers,parseMediaRange("bytes=100-109",4008192),4008192);
  assert.equal(plan.ok,true);
});
test("redirect 302 to validated 200 bounded Googlevideo response", async () => {
  const mock=async (url) => url===base
    ? new Response(null,{status:302,headers:{Location:edge}})
    : new Response(new Uint8Array(10),{status:200,headers:{"Content-Length":"10","Content-Type":"audio/mp4"}});
  const result=await fetchMediaFollowingSafeRedirects(base,{range:"bytes=100-109",fetchImpl:mock});
  assert.equal(result.ok,true);
  const plan=interpretMediaRange(result.response.status,result.response.headers,parseMediaRange("bytes=100-109",4008192),4008192);
  assert.equal(plan.ok,true);
  assert.equal(plan.mode,"youtube-200");
});
test("redirect to a different domain is BLOCKED and never fetched", async () => {
  let called=0;
  const mock=async () => {
    called++;
    return new Response(null,{status:302,headers:{Location:"https://www.youtube.com/watch?v=secret"}});
  };
  const result=await fetchMediaFollowingSafeRedirects(base,{fetchImpl:mock});
  assert.equal(result.ok,false);
  assert.equal(result.code,"UPSTREAM_REDIRECT_BLOCKED");
  assert.equal(called,1);
});
test("relative redirect is resolved safely", async () => {
  const calls=[];
  const mock=async url=>{
    calls.push(url);
    return calls.length===1
      ? new Response(null,{status:302,headers:{Location:"/videoplayback?clen=4008192&sig=x"}})
      : new Response(new Uint8Array(10),{status:206,headers:{"Content-Range":"bytes 100-109/4008192","Content-Length":"10"}});
  };
  const result=await fetchMediaFollowingSafeRedirects(base,{range:"bytes=100-109",fetchImpl:mock});
  assert.equal(result.ok,true);
  assert.equal(calls.length,2);
  assert.equal(new URL(calls[1]).searchParams.get("range"),"100-109");
});
test("looping redirects and chain-limit fail safely", async () => {
  const loop=async url=>new Response(null,{status:302,headers:{Location:url}});
  const loopResult=await fetchMediaFollowingSafeRedirects(base,{fetchImpl:loop});
  assert.equal(loopResult.ok,false);
  assert.equal(loopResult.code,"UPSTREAM_REDIRECT_LOOP");
  let i=0;
  const chain=async ()=>new Response(null,{status:302,headers:{Location:edge+"&hop="+(++i)}});
  const capped=await fetchMediaFollowingSafeRedirects(base,{maxRedirects:2,fetchImpl:chain});
  assert.equal(capped.ok,false);
  assert.equal(capped.code,"UPSTREAM_REDIRECT_LIMIT");
  assert.equal(i,3);
});
test("redirect missing Location returns actionable code", async () => {
  const r=await fetchMediaFollowingSafeRedirects(base,{fetchImpl:async()=>new Response(null,{status:302})});
  assert.equal(r.ok,false);
  assert.equal(r.code,"UPSTREAM_REDIRECT_BLOCKED");
});
