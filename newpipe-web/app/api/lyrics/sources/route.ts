import { NextResponse } from "next/server";
import { SOURCES } from "@/lib/lyrics/lirik.js";
export const runtime = "nodejs";
export async function GET() {
  return NextResponse.json({ok:true,count:Object.keys(SOURCES).length,sources:SOURCES},
    {headers:{"Cache-Control":"public, s-maxage=3600"}});
}
