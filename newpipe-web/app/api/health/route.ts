import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/** Local readiness; optional probe checks private yt-dlp container connectivity. */
export async function GET(req: NextRequest) {
  const configured=Boolean(process.env.YTDLP_INTERNAL_URL);
  let fallbackStatus: "not-configured"|"unchecked"|"online"|"offline"=configured?"unchecked":"not-configured";
  if (configured && req.nextUrl.searchParams.get("probe")==="1") {
    try {
      const url=new URL("/health",process.env.YTDLP_INTERNAL_URL);
      const r=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(7500)});
      fallbackStatus=r.ok?"online":"offline";
    } catch {fallbackStatus="offline";}
  }
  return NextResponse.json({
    ok:true, configured:true, status:"online",backend:"youtubei.js",
    version:"18.3.0",upstream:"unchecked",
    fallback:{engine:"yt-dlp",configured,status:fallbackStatus},
    lyrics:{available:true,endpoint:"/api/lyrics",sources:"/api/lyrics/sources"},
    note:"Health checks service readiness only. YouTube may block streaming even when both engines are online."
  },{headers:{"Cache-Control":"no-store"}});
}
