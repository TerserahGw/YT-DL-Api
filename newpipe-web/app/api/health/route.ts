import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const base = process.env.EXTRACTOR_BASE_URL?.trim();
  if (!base) return NextResponse.json({ ok: false, configured: false, status: "unconfigured", message: "Set EXTRACTOR_BASE_URL in Vercel Environment Variables." }, { headers: { "Cache-Control": "no-store" } });
  try {
    const url = new URL(base);
    const localDev = process.env.NODE_ENV === "development" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    const privateBinding = process.env.VERCEL === "1" && url.protocol === "http:";
    if (!(url.protocol === "https:" || localDev || privateBinding)) {
      return NextResponse.json({ ok: false, configured: true, status: "invalid-config", message: "The backend must use HTTPS or a private Vercel service binding." }, { status: 503 });
    }
    const upstream = new URL("/actuator/health", url);
    const headers: HeadersInit = {};
    if (process.env.BACKEND_AUTHORIZATION) headers["Authorization"] = process.env.BACKEND_AUTHORIZATION;
    const response = await fetch(upstream, { signal: AbortSignal.timeout(16000), headers, cache: "no-store" });
    return NextResponse.json({ ok: response.ok, configured: true, status: response.ok ? "online" : "offline" }, { status: response.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, configured: true, status: "offline", message: "Unable to contact Java backend." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
