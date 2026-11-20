import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MEDIA_CHUNK, parseMediaRange, mediaLengthHint,
  rangedGoogleVideoUrl, interpretMediaRange, boundedMediaStream
} from "../lib/media-range.ts";

const sample = "https://rr1---sn-test.googlevideo.com/videoplayback?clen=4008192&itag=140&sig=test";
test("only single bounded ranges accepted; can clamp to known file size", () => {
  assert.equal(parseMediaRange("bytes=0-")?.end, MAX_MEDIA_CHUNK - 1);
  assert.equal(parseMediaRange("bytes=2097152-", 4008192)?.end, 4008191);
  assert.equal(parseMediaRange("bytes=4008192-", 4008192), null);
  assert.equal(parseMediaRange("bytes=-100"), null);
  assert.equal(parseMediaRange("bytes=0-100,200-300"), null);
  assert.equal(parseMediaRange("bytes=10-5"), null);
  assert.equal(parseMediaRange("bytes=0-0")?.end, 0);
});
test("Googlevideo query range preserves signed parameters", () => {
  const range = parseMediaRange("bytes=2097152-", 4008192);
  assert.ok(range);
  const url = new URL(rangedGoogleVideoUrl(sample, range));
  assert.equal(url.searchParams.get("sig"), "test");
  assert.equal(url.searchParams.get("range"), "2097152-4008191");
  assert.equal(mediaLengthHint(sample), 4008192);
});
test("accept validated HTTP 206 response", () => {
  const range = parseMediaRange("bytes=0-", 4008192);
  const plan = interpretMediaRange(206, new Headers({
    "Content-Range": "bytes 0-2097151/4008192",
    "Content-Length": String(MAX_MEDIA_CHUNK)
  }), range, 4008192);
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, "http-206");
});
test("accept Googlevideo 200 response ONLY with exact requested chunk length", () => {
  const range = parseMediaRange("bytes=2097152-", 4008192);
  const length = 4008192-2097152;
  const correct = interpretMediaRange(200, new Headers({
    "Content-Length": String(length)
  }), range, 4008192);
  assert.equal(correct.ok, true);
  assert.equal(correct.mode, "youtube-200");
  assert.equal(correct.start, 2097152);
  assert.equal(correct.end, 4008191);
});
test("ignore full-file 200 after seek: never serve wrong offset", () => {
  const range = parseMediaRange("bytes=2097152-", 4008192);
  const denied = interpretMediaRange(200, new Headers({
    "Content-Length": "4008192"
  }), range, 4008192);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "UPSTREAM_IGNORED_RANGE");
});
test("full-file 200 prefix is safe only from offset zero", () => {
  const range = parseMediaRange(null, 4008192);
  const accepted = interpretMediaRange(200, new Headers({
    "Content-Length": "4008192"
  }), range, 4008192);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.mode, "full-200-prefix");
  assert.equal(accepted.length, MAX_MEDIA_CHUNK);
});
test("reject mismatched 206, missing total or unverified 200", () => {
  const range = parseMediaRange("bytes=1024-", 4008192);
  assert.equal(interpretMediaRange(206,new Headers({"Content-Range":"bytes 0-2000/4008192"}),range,4008192).ok,false);
  assert.equal(interpretMediaRange(200,new Headers(),range,4008192).ok,false);
  assert.equal(interpretMediaRange(200,new Headers({"Content-Length":"2097152"}),range,null).ok,false);
});
test("media stream never relays more than approved bytes", async () => {
  const src = new ReadableStream({start(c) {c.enqueue(Uint8Array.from([1,2,3,4,5])); c.close();}});
  const out = boundedMediaStream(src,3);
  const result = new Uint8Array(await new Response(out).arrayBuffer());
  assert.deepEqual([...result],[1,2,3]);
});
