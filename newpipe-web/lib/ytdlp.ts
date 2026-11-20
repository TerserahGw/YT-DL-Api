import "server-only";
import { getYouTubeCookieHeader } from "@/lib/youtube-auth";

type FallbackType = "video" | "search" | "playlist" | "channel";
type Payload = { kind: FallbackType; id?: string; query?: string };
type Result = { ok: true; source: "yt-dlp"; data: Record<string, any> } | { ok: false; code: string };

export async function tryYtDlp(payload: Payload): Promise<Result> {
  const raw = process.env.YTDLP_INTERNAL_URL;
  if (!raw) return { ok: false, code: "FALLBACK_NOT_CONFIGURED" };
  try {
    const origin = new URL(raw);
    // Vercel Services bindings are private HTTP URLs, accepted only when deployed on Vercel.
    const bindingAllowed = process.env.VERCEL === "1" && origin.protocol === "http:";
    const localDev = process.env.NODE_ENV === "development" && ["localhost","127.0.0.1"].includes(origin.hostname);
    if (!(origin.protocol === "https:" || bindingAllowed || localDev) || origin.username || origin.password) {
      return { ok: false, code: "INVALID_FALLBACK_BINDING" };
    }
    const endpoint = new URL("/extract",origin);
    const cookie = getYouTubeCookieHeader();
    const response = await fetch(endpoint, {
      method:"POST",
      headers:{"Content-Type":"application/json","Accept":"application/json"},
      body:JSON.stringify({...payload, ...(cookie ? { cookie } : {})}),
      redirect:"error",
      cache:"no-store",
      signal:AbortSignal.timeout(22000)
    });
    if (!response.ok) return {ok:false,code:response.status===403?"FALLBACK_FORBIDDEN":"FALLBACK_ERROR"};
    const body:unknown = await response.json();
    if (!body || typeof body!=="object" || !(body as any).ok || !(body as any).data) return {ok:false,code:"FALLBACK_INVALID_RESPONSE"};
    return {ok:true,source:"yt-dlp",data:(body as any).data};
  } catch {
    return {ok:false,code:"FALLBACK_UNAVAILABLE"};
  }
}
