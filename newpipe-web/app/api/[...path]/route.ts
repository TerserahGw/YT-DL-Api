import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Specification = { endpoint: string; key?: string; from?: string; max?: number; cache?: number; pattern?: RegExp };
const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const PLAYLIST_ID = /^[a-zA-Z0-9_-]{10,100}$/;
const CHANNEL_ID = /^(?:@[a-zA-Z0-9_.-]{3,50}|channel\/UC[a-zA-Z0-9_-]{20,45})$/;
const routes: Record<string, Specification> = {
  search: { endpoint: "/search", from: "q", key: "searchString", max: 160, cache: 30 },
  stream: { endpoint: "/streams", from: "id", key: "id", pattern: VIDEO_ID },
  details: { endpoint: "/streams/details", from: "id", key: "id", pattern: VIDEO_ID },
  audio: { endpoint: "/streams/audio", from: "id", key: "id", pattern: VIDEO_ID },
  "video-streams": { endpoint: "/streams/video", from: "id", key: "id", pattern: VIDEO_ID },
  subtitles: { endpoint: "/streams/subtitles", from: "id", key: "id", pattern: VIDEO_ID },
  related: { endpoint: "/streams/related", from: "id", key: "id", pattern: VIDEO_ID, cache: 30 },
  comments: { endpoint: "/comments", from: "id", key: "id", pattern: VIDEO_ID, cache: 30 },
  playlist: { endpoint: "/playlists", from: "id", key: "id", pattern: PLAYLIST_ID, cache: 45 },
  channel: { endpoint: "/channels", from: "id", key: "id", pattern: CHANNEL_ID, cache: 45 },
  "channel-videos": { endpoint: "/channels/tab", from: "id", key: "id", pattern: CHANNEL_ID, cache: 45 },
  services: { endpoint: "/services", cache: 120 }
};
const categories = new Set(["trending_music", "trending_gaming", "trending_movies_and_shows"]);
const bad = (message: string, status = 400) => NextResponse.json({ ok: false, error: message }, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.length !== 1) return bad("Unknown API route.", 404);
  const name = path[0];
  const spec = routes[name];
  if (!spec && name !== "trending") return bad("Unknown API route.", 404);
  const base = process.env.EXTRACTOR_BASE_URL?.trim();
  if (!base) return bad("Extractor backend not configured. Set EXTRACTOR_BASE_URL.", 503);

  let origin: URL;
  try {
    origin = new URL(base);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") return bad("Invalid EXTRACTOR_BASE_URL; use a host origin only.", 503);
    const localDev = process.env.NODE_ENV === "development" && origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
    if (origin.protocol !== "https:" && !localDev) return bad("Extractor backend must use HTTPS.", 503);
  } catch { return bad("Invalid EXTRACTOR_BASE_URL.", 503); }

  const upstream = new URL("/api/v1" + (name === "trending" ? "/kiosks/" : spec.endpoint), origin);
  if (name === "trending") {
    const category = request.nextUrl.searchParams.get("category") || "trending_music";
    if (!categories.has(category)) return bad("Invalid trending category.");
    upstream.pathname += category;
  } else if (spec.from && spec.key) {
    const value = request.nextUrl.searchParams.get(spec.from)?.trim() || "";
    if (!value || value.length > (spec.max || 128) || (spec.pattern && !spec.pattern.test(value))) return bad("Invalid or missing " + spec.from + ".");
    upstream.searchParams.set(spec.key, value);
    if (name === "channel-videos") upstream.searchParams.set("tab", "videos");
  }
  try {
    const headers: HeadersInit = { Accept: "application/json" };
    if (process.env.BACKEND_AUTHORIZATION) headers["Authorization"] = process.env.BACKEND_AUTHORIZATION;
    const response = await fetch(upstream, { headers, signal: AbortSignal.timeout(22000), cache: "no-store", redirect: "error" });
    const raw = await response.text();
    if (raw.length > 8_000_000) return bad("Backend response too large.", 502);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return bad("Backend returned invalid JSON.", 502); }
    if (!response.ok) {
      const err = body as { message?: string; errorCode?: string };
      return NextResponse.json({ ok: false, error: typeof err.message === "string" ? err.message.slice(0, 300) : "Extractor error", code: err.errorCode || "UPSTREAM_ERROR" },
        { status: response.status >= 400 && response.status < 600 ? response.status : 502, headers: { "Cache-Control": "no-store" } });
    }
    const cache = spec?.cache || 0;
    return NextResponse.json(body, { status: 200, headers: { "Cache-Control": cache ? `public, s-maxage=${cache}, stale-while-revalidate=30` : "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return bad(timedOut ? "Extractor backend timed out." : "Extractor backend unavailable.", timedOut ? 504 : 502);
  }
}
