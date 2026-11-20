import { NextRequest, NextResponse } from "next/server";
import { youtube, streamData, stringValue } from "@/lib/youtube";
import { tryYtDlp } from "@/lib/ytdlp";
import { isMediaHost, proxyIsEnabled, verifyProxyRequest } from "@/lib/media-proxy";
import { fetchMediaFollowingSafeRedirects } from "@/lib/media-redirect";
import {
  boundedMediaStream, interpretMediaRange, mediaLengthHint,
  parseMediaRange, rangedGoogleVideoUrl
} from "@/lib/media-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Item = { itag?: string | number | null; url?: string | null; content?: string | null };
type MediaInfo = { url: string; source: "youtubei.js" | "yt-dlp" };
const failure = (status: number, code: string, error: string) =>
  NextResponse.json({ ok: false, code, error }, {
    status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });

function mediaList(info: Record<string, any>): Item[] {
  return [
    ...(Array.isArray(info.audioStreams) ? info.audioStreams : []),
    ...(Array.isArray(info.videoStreams) ? info.videoStreams : []),
    ...(Array.isArray(info.videoOnlyStreams) ? info.videoOnlyStreams : [])
  ];
}
async function fetchFormatFromEngine(
  id: string, itag: string, engine: "youtubei" | "ytdlp"
): Promise<MediaInfo | null> {
  if (engine === "ytdlp") {
    const result = await tryYtDlp({ kind: "video", id });
    if (!result.ok) return null;
    const found = mediaList(result.data).find(f => String(f.itag) === itag && f.url && isMediaHost(f.url));
    return found?.url ? { url: found.url, source: "yt-dlp" } : null;
  }
  const yt = await youtube({ player: true });
  const info = await yt.getBasicInfo(id);
  if (stringValue(info.playability_status?.status) === "LOGIN_REQUIRED") return null;
  const mapped = await streamData(info, yt.session.player);
  const found = mediaList(mapped).find(f => String(f.itag) === itag && f.url && isMediaHost(f.url));
  return found?.url ? { url: found.url, source: "youtubei.js" } : null;
}
async function resolveVideo(id: string, itag: string, engine: "youtubei" | "ytdlp"): Promise<MediaInfo | null> {
  try {
    const result = await fetchFormatFromEngine(id, itag, engine);
    if (result) return result;
  } catch { /* The alternate extractor may still succeed. */ }
  try {
    return await fetchFormatFromEngine(id, itag, engine === "youtubei" ? "ytdlp" : "youtubei");
  } catch { return null; }
}
const validSize = (raw: string | null): number | null => {
  if (!raw || !/^[0-9]{1,16}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

/** Some URLs do not include clen. Probe metadata only; never download the whole video. */
async function probeMediaSize(url: string): Promise<number | null> {
  try {
    const result = await fetchMediaFollowingSafeRedirects(url, { method: "HEAD", timeoutMs: 6500 });
    if (result.ok) {
      const { response } = result;
      const length = response.status === 200 ? validSize(response.headers.get("content-length")) : null;
      await response.body?.cancel().catch(() => {});
      if (length) return length;
    }
  } catch { /* HEAD is frequently disallowed; try one-byte GET. */ }
  try {
    const result = await fetchMediaFollowingSafeRedirects(url, {
      method: "GET", range: "bytes=0-0", timeoutMs: 6500
    });
    if (!result.ok) return null;
    const response = result.response;
    const match = /^bytes 0-0\/([0-9]+)$/i.exec(response.headers.get("content-range") || "");
    const size = response.status === 206 && match ? validSize(match[1]) : null;
    await response.body?.cancel().catch(() => {});
    return size;
  } catch { return null; }
}

async function handle(request: NextRequest, head = false): Promise<Response> {
  if (!proxyIsEnabled()) {
    return failure(503, "MEDIA_PROXY_NOT_CONFIGURED",
      "Atur MEDIA_PROXY_SECRET (minimal 32 karakter) di Vercel, lalu redeploy.");
  }
  const token = verifyProxyRequest(request.nextUrl.searchParams);
  if (!token) return failure(403, "INVALID_MEDIA_TOKEN", "Link media tidak valid atau telah kedaluwarsa. Ambil ulang URL dari /api/stream.");

  const originalRange = request.headers.get("range");
  if (!parseMediaRange(originalRange)) {
    return failure(416, "INVALID_RANGE", "Hanya Range: bytes=<start>-<end> tunggal yang didukung.");
  }
  const media = await resolveVideo(token.videoId, token.itag, token.engine);
  if (!media || !isMediaHost(media.url)) {
    return failure(503, "MEDIA_UNAVAILABLE", "Tidak ada URL media yang dapat diakses dari server.");
  }

  let totalHint = mediaLengthHint(media.url);
  if (!totalHint) totalHint = await probeMediaSize(media.url);
  const range = parseMediaRange(originalRange, totalHint);
  if (!range) {
    const response = failure(416, "RANGE_NOT_SATISFIABLE", "Byte awal melebihi ukuran media.");
    if (totalHint) response.headers.set("Content-Range", "bytes */" + totalHint);
    return response;
  }

  try {
    // Googlevideo uses BOTH normal HTTP 206 and HTTP 200 for bounded
    // range=START-END query URLs. Check the byte count before ever accepting 200.
    const targets = [
      { url: rangedGoogleVideoUrl(media.url, range), mode: "query" },
      { url: media.url, mode: "header" }
    ];
    let lastCode = "UNSUPPORTED_UPSTREAM_STATUS";
    let lastStatus = 0;
    let lastRedirects = 0;

    for (const target of targets) {
      const result = await fetchMediaFollowingSafeRedirects(target.url, {
        method: "GET", range: range.value, timeoutMs: 25000
      });
      if (!result.ok) {
        lastCode = result.code;
        lastRedirects = result.redirects;
        continue;
      }
      const upstream = result.response;
      lastStatus = upstream.status;
      lastRedirects = result.redirects;
      if (!upstream.body && !head) {
        lastCode = "NO_MEDIA_BODY";
        continue;
      }
      const type = (upstream.headers.get("content-type") || "").toLowerCase();
      const looksLikeMedia = !type || type.startsWith("audio/") || type.startsWith("video/") ||
        type.startsWith("application/octet-stream");
      if (!looksLikeMedia && (upstream.status === 200 || upstream.status === 206)) {
        await upstream.body?.cancel().catch(() => {});
        lastCode = "UPSTREAM_NON_MEDIA_RESPONSE";
        continue;
      }
      const plan = interpretMediaRange(upstream.status, upstream.headers, range, totalHint);
      if (!plan.ok) {
        lastCode = plan.code;
        await upstream.body?.cancel().catch(() => {});
        // Do not return unverified bytes, even when upstream supplied 200.
        continue;
      }
      const headers = new Headers({
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "Content-Range": "bytes " + plan.start + "-" + plan.end + "/" + plan.total,
        "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
        "Content-Length": String(plan.length),
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "X-Media-Range-Mode": plan.mode,
        "X-Media-Redirects": String(lastRedirects),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Accept-Ranges,Content-Range,Content-Length,Content-Type,X-Media-Range-Mode,X-Media-Redirects"
      });
      if (head) {
        await upstream.body?.cancel().catch(() => {});
        headers.delete("Content-Range");
        headers.set("Content-Length", String(plan.total));
        return new Response(null, { status: 200, headers });
      }
      if (!upstream.body) return failure(502, "NO_MEDIA_BODY", "Sumber tidak mengembalikan data media.");
      return new Response(boundedMediaStream(upstream.body, plan.length), {
        status: 206, headers
      });
    }
    console.warn("[media-range]", { source: media.source, result: lastCode, status: lastStatus, redirects: lastRedirects });
    if (lastStatus === 401 || lastStatus === 403) {
      return failure(403, "UPSTREAM_IP_BLOCKED",
        "Googlevideo menolak koneksi dari IP server Vercel. Proxy tidak dapat menjamin IP yang sama.");
    }
    if (lastStatus === 429) return failure(503, "UPSTREAM_RATE_LIMITED", "Server media membatasi permintaan.");
    if (lastCode === "UPSTREAM_REDIRECT_BLOCKED" || lastCode === "UPSTREAM_REDIRECT_LIMIT" ||
        lastCode === "UPSTREAM_REDIRECT_LOOP") {
      return failure(502, lastCode,
        "Sumber media mengalihkan permintaan ke lokasi yang tidak didukung atau berulang. Tidak ada URL tujuan yang dibuka ke publik.");
    }
    if (lastCode === "UPSTREAM_IGNORED_RANGE") {
      return failure(502, "UPSTREAM_IGNORED_RANGE",
        "Server mengirim seluruh file untuk permintaan seek; proxy menolak agar byte video tidak rusak.");
    }
    return failure(502, "UPSTREAM_RANGE_UNVERIFIED",
      "Sumber media tidak mengembalikan ukuran/rentang byte yang dapat diverifikasi (" + lastCode + ", HTTP " + lastStatus + ").");
  } catch {
    return failure(502, "MEDIA_FETCH_FAILED", "Koneksi proxy ke server media gagal atau kedaluwarsa.");
  }
}

export async function GET(req: NextRequest) { return handle(req); }
export async function HEAD(req: NextRequest) { return handle(req, true); }
