import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const FORMAT_ID = /^[A-Za-z0-9_.-]{1,60}$/;
export type MediaEngine = "youtubei" | "ytdlp";
type Format = { itag?: string | number | null; url?: string | null; content?: string | null; [key: string]: unknown };
type Data = Record<string, any>;
const LIFETIME_SECONDS = 60 * 60;

function key(): string | null {
  const value = process.env.MEDIA_PROXY_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}
function message(videoId: string, itag: string, engine: MediaEngine, expires: number) {
  return [videoId, itag, engine, String(expires)].join("\n");
}
function signature(videoId: string, itag: string, engine: MediaEngine, expires: number, secret: string) {
  return createHmac("sha256", secret).update(message(videoId, itag, engine, expires)).digest("hex");
}
export function isMediaHost(rawUrl: string): boolean {
  try {
    const uri = new URL(rawUrl);
    const hostname = uri.hostname.toLowerCase();
    return uri.protocol === "https:" && !uri.username && !uri.password &&
      (hostname === "googlevideo.com" || hostname.endsWith(".googlevideo.com")) &&
      uri.pathname.startsWith("/videoplayback");
  } catch {
    return false;
  }
}
export function verifyProxyRequest(search: URLSearchParams):
  | { videoId: string; itag: string; engine: MediaEngine }
  | null {
  const secret = key();
  if (!secret) return null;
  const videoId = search.get("id") || "";
  const itag = search.get("itag") || "";
  const engine = search.get("engine") || "";
  const expires = Number(search.get("expires"));
  const sig = search.get("sig") || "";
  if (!VIDEO_ID.test(videoId) || !FORMAT_ID.test(itag) ||
    (engine !== "youtubei" && engine !== "ytdlp") ||
    !Number.isSafeInteger(expires) || !/^[a-f0-9]{64}$/.test(sig) ||
    expires < Math.floor(Date.now() / 1000) ||
    expires > Math.floor(Date.now() / 1000) + LIFETIME_SECONDS + 120) return null;
  const expected = signature(videoId, itag, engine, expires, secret);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex")) ?
    { videoId, itag, engine } : null;
}
export function proxyIsEnabled() { return key() !== null; }
export function proxyUrl(origin: string, videoId: string, itag: string, engine: MediaEngine): string | null {
  const secret = key();
  if (!secret || !VIDEO_ID.test(videoId) || !FORMAT_ID.test(itag)) return null;
  const expires = Math.floor(Date.now() / 1000) + LIFETIME_SECONDS;
  const endpoint = new URL("/api/media", origin);
  endpoint.searchParams.set("id", videoId);
  endpoint.searchParams.set("itag", itag);
  endpoint.searchParams.set("engine", engine);
  endpoint.searchParams.set("expires", String(expires));
  endpoint.searchParams.set("sig", signature(videoId, itag, engine, expires, secret));
  return endpoint.toString();
}
function convertFormats(list: Format[] | undefined, id: string, engine: MediaEngine, origin: string) {
  return (Array.isArray(list) ? list : []).map((format) => {
    const actualUrl = format.url || format.content;
    // Only supported Google video playback URLs are rewritten.
    if (typeof actualUrl !== "string" || !isMediaHost(actualUrl)) return { ...format, proxied: false };
    const itag = String(format.itag || "");
    const url = proxyUrl(origin, id, itag, engine);
    return url ? { ...format, url, content: url, proxyUrl: url, proxied: true }
      : { ...format, proxied: false };
  });
}
/** Serialize public URLs; never include original provider URLs in a signed proxy link. */
export function makeMediaProxyUrls(data: Data, origin: string, id: string, engine: MediaEngine): Data {
  if (!VIDEO_ID.test(id)) return data;
  const audioStreams = convertFormats(data.audioStreams, id, engine, origin);
  const videoStreams = convertFormats(data.videoStreams, id, engine, origin);
  const videoOnlyStreams = convertFormats(data.videoOnlyStreams, id, engine, origin);
  const count = [...audioStreams,...videoStreams,...videoOnlyStreams].filter(x=>x.proxied).length;
  return {
    ...data, audioStreams, videoStreams, videoOnlyStreams,
    proxy: {enabled:proxyIsEnabled(),endpoint:"/api/media",signedUrls:count,expiresAfterSeconds:LIFETIME_SECONDS,
      note: "Media URLs may expire, vary by server egress IP, and incur Vercel bandwidth charges. HLS manifests are not proxied."}
  };
}
