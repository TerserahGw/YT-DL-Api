import { NextRequest, NextResponse } from "next/server";
import LirikSync, { SOURCES } from "@/lib/lyrics/lirik.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const client = new LirikSync({
  wordLevelFirst:true,
  timeoutMs: 5500,
  // Must identify the application when requesting LRCLIB.
  userAgent:"NewPipeWeb-Lyrics/2.1 (self-hosted application; source: github.com/TerserahGw/YT-DL-Api)"
});
const error = (code:string,message:string,status:number)=>NextResponse.json(
  {ok:false,code,error:message}, {status,headers:{"Cache-Control":"no-store"}}
);
export async function GET(req:NextRequest) {
  const q=req.nextUrl.searchParams;
  const rawTrack=q.get("track")?.trim() || "";
  const artist=q.get("artist")?.trim() || "";
  const freeQuery=q.get("q")?.trim() || "";
  const album=q.get("album")?.trim() || "";
  const source=q.get("source")?.trim().toLowerCase() || "auto";
  const durationText=q.get("duration")?.trim() || "";
  const duration=durationText ? Number(durationText) : undefined;
  if ((!rawTrack && !freeQuery) || rawTrack.length>160 || artist.length>160 || freeQuery.length>200 || album.length>160)
    return error("INVALID_QUERY","Gunakan track=judul&artist=penyanyi, atau q=judul lagu.",400);
  if (source!=="auto" && !Object.prototype.hasOwnProperty.call(SOURCES,source))
    return error("INVALID_SOURCE","Sumber tidak tersedia. Lihat /api/lyrics/sources.",400);
  if (durationText && (!Number.isFinite(duration) || duration! < 0 || duration! > 86400))
    return error("INVALID_DURATION","Durasi wajib dalam detik (0-86400).",400);
  const query={...(rawTrack?{track:rawTrack}:{}),...(artist?{artist}:{}),...(freeQuery?{q:freeQuery}:{}),...(album?{album}:{}),...(duration!==undefined?{duration}:{})};
  try {
    // The uploaded module uses an ordered, multi-source best-match strategy.
    const {result,attempts}=await client.find(query,source!=="auto"?{source}:undefined);
    if (!result) return error("LYRICS_NOT_FOUND","Tidak ada lirik yang cocok dari sumber yang dicoba.",404);
    const clean=client.toJSON(result,{raw:false});
    // Preserve original normalized timing data (seconds) without emitting provider raw payloads.
    return NextResponse.json({
      ok:true,...clean,
      formats:{lrc:client.toLRC(result),enhancedLrc:client.toEnhancedLRC(result),plain:client.toPlain(result)},
      attempts:attempts.map(a=>({source:a.source,ok:a.ok,note:a.note||null}))
    },{headers:{"Cache-Control":"public, s-maxage=300, stale-while-revalidate=300"}});
  } catch {
    return error("LYRICS_PROVIDER_FAILED","Sumber lirik tidak dapat diakses saat ini.",502);
  }
}
