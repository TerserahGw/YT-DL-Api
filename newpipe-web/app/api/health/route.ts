import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Local readiness is not a promise that YouTube will accept traffic from Vercel.
  return NextResponse.json({
    ok:true, configured:true, status:"online", backend:"youtubei.js", version:"18.3.0",
    upstream:"unchecked", note:"A successful health response does not guarantee YouTube stream access."
  }, { headers:{"Cache-Control":"no-store"} });
}
