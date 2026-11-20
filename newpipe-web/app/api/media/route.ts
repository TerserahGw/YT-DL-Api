import { NextRequest, NextResponse } from "next/server";
import { youtube, streamData, stringValue } from "@/lib/youtube";
import { tryYtDlp } from "@/lib/ytdlp";
import { isMediaHost, proxyIsEnabled, verifyProxyRequest } from "@/lib/media-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Item = { itag?: string | number | null; url?: string | null; content?: string | null };
type MediaInfo = { url: string; source: "youtubei.js"|"yt-dlp" };
const MAX_CHUNK = 1024 * 1024 * 2; // Keep chunks below Vercel's nonstreamed payload limit.
const MAX_REQUESTED_START = Number.MAX_SAFE_INTEGER - MAX_CHUNK;

const failure = (status: number, code: string, error: string) =>
  NextResponse.json({ok:false,code,error}, {status,headers:{"Cache-Control":"no-store"}});
function mediaList(info: Record<string, any>): Item[] {
  return [
    ...(Array.isArray(info.audioStreams)?info.audioStreams:[]),
    ...(Array.isArray(info.videoStreams)?info.videoStreams:[]),
    ...(Array.isArray(info.videoOnlyStreams)?info.videoOnlyStreams:[])
  ];
}
async function fetchFormatFromEngine(id: string, itag: string, engine: "youtubei"|"ytdlp"): Promise<MediaInfo|null> {
  if (engine==="ytdlp") {
    const result = await tryYtDlp({kind:"video",id});
    if (!result.ok) return null;
    const found=mediaList(result.data).find(f=>String(f.itag)===itag && f.url && isMediaHost(f.url));
    return found?.url ? {url:found.url,source:"yt-dlp"} : null;
  }
  const yt=await youtube({player:true});
  const info=await yt.getBasicInfo(id);
  const status=stringValue(info.playability_status?.status);
  if (status==="LOGIN_REQUIRED") return null;
  const mapped=await streamData(info,yt.session.player);
  const found=mediaList(mapped).find(f=>String(f.itag)===itag && f.url && isMediaHost(f.url));
  return found?.url ? {url:found.url,source:"youtubei.js"} : null;
}
async function resolveVideo(id: string, itag: string, engine: "youtubei"|"ytdlp"): Promise<MediaInfo|null> {
  try {
    const result = await fetchFormatFromEngine(id,itag,engine);
    if (result) return result;
  } catch { /* Try fallback source without disclosing upstream errors. */ }
  try {
    return await fetchFormatFromEngine(id,itag,engine==="youtubei"?"ytdlp":"youtubei");
  } catch { return null; }
}
function requestedRange(header: string | null): {value:string;start:number;end:number}|null {
  if (!header) return {value:`bytes=0-${MAX_CHUNK-1}`,start:0,end:MAX_CHUNK-1};
  const m=/^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const start=Number(m[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start > MAX_REQUESTED_START) return null;
  const end=m[2] ? Number(m[2]) : start+MAX_CHUNK-1;
  if (!Number.isSafeInteger(end) || end < start) return null;
  const bounded=Math.min(end,start+MAX_CHUNK-1);
  return {value:`bytes=${start}-${bounded}`,start,end:bounded};
}
async function handle(req: NextRequest, head = false): Promise<Response> {
  if (!proxyIsEnabled()) return failure(503,"MEDIA_PROXY_NOT_CONFIGURED","Set MEDIA_PROXY_SECRET (minimal 32 karakter) di Vercel Environment Variables, lalu redeploy.");
  const verified=verifyProxyRequest(req.nextUrl.searchParams);
  if (!verified) return failure(403,"INVALID_MEDIA_TOKEN","Tautan media tidak valid atau sudah kedaluwarsa. Ambil ulang URL dari /api/stream.");
  const range=requestedRange(req.headers.get("range"));
  if (!range) return failure(416,"INVALID_RANGE","Gunakan Range: bytes=<start>-<end> (satu rentang).");
  const media=await resolveVideo(verified.videoId,verified.itag,verified.engine);
  if (!media || !isMediaHost(media.url)) return failure(503,"MEDIA_UNAVAILABLE","Tidak ada URL media yang dapat diakses dari server. Coba lagi melalui /api/stream.");
  try {
    const upstream=await fetch(media.url,{
      method:"GET",
      headers:{"Range":range.value,"Accept-Encoding":"identity"},
      redirect:"manual",cache:"no-store",
      signal:AbortSignal.timeout(25000)
    });
    if (upstream.status===403 || upstream.status===401) {
      await upstream.body?.cancel().catch(()=>{});
      return failure(403,"UPSTREAM_IP_BLOCKED","Server media menolak alamat IP keluar Vercel. Proxy tidak dapat menjamin IP tetap sama.");
    }
    if (upstream.status!==206) {
      await upstream.body?.cancel().catch(()=>{});
      return failure(502,"UPSTREAM_RANGE_UNSUPPORTED",
        "Sumber media tidak mendukung permintaan Range terbatas pada koneksi ini.");
    }
    const contentRange=upstream.headers.get("content-range");
    const parsed=/^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange||"");
    if (!parsed || Number(parsed[1])!==range.start || Number(parsed[2])-range.start+1>MAX_CHUNK) {
      await upstream.body?.cancel().catch(()=>{});
      return failure(502,"UPSTREAM_BAD_RANGE","Respons Content-Range dari sumber media tidak sesuai.");
    }
    const responseHeaders=new Headers({
      "Accept-Ranges":"bytes","Cache-Control":"private, no-store",
      "Content-Range":contentRange!,
      "Content-Type":upstream.headers.get("content-type")||"application/octet-stream",
      "Content-Length":String(Number(parsed[2])-Number(parsed[1])+1),
      "X-Content-Type-Options":"nosniff",
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Expose-Headers":"Accept-Ranges,Content-Range,Content-Length,Content-Type",
      "Content-Disposition":"inline"
    });
    if (head) {
      await upstream.body?.cancel().catch(()=>{});
      // HEAD describes the whole resource, not the first chunk.
      responseHeaders.delete("Content-Range");
      responseHeaders.set("Content-Length",parsed[3]==="*"?"0":parsed[3]);
      return new Response(null,{status:200,headers:responseHeaders});
    }
    if (!upstream.body) return failure(502,"NO_MEDIA_BODY","Sumber tidak memberikan data media.");
    // Stream bytes without buffering a complete movie in Vercel memory.
    return new Response(upstream.body,{status:206,headers:responseHeaders});
  } catch {
    return failure(502,"MEDIA_FETCH_FAILED","Koneksi server proxy ke media gagal atau kedaluwarsa.");
  }
}
export async function GET(req: NextRequest) { return handle(req); }
export async function HEAD(req: NextRequest) { return handle(req,true); }
