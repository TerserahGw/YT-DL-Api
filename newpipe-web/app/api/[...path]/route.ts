import { NextRequest, NextResponse } from "next/server";
import { youtube, normalizeItem, normalizeItems, streamData, classifyError, stringValue, numberValue, bestImage, images } from "@/lib/youtube";
import { tryYtDlp } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Obj = Record<string, any>;
const VIDEO = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST = /^[A-Za-z0-9_-]{10,100}$/;
const CHANNEL = /^(?:@[A-Za-z0-9_.-]{3,50}|UC[A-Za-z0-9_-]{20,45}|channel\/UC[A-Za-z0-9_-]{20,45})$/;
const validPaths = new Set(["search","stream","details","audio","video-streams","subtitles","related","comments","playlist","channel","channel-videos","trending","services"]);
const trendingTerms: Record<string, string> = {
  trending_music: "musik populer terbaru",
  trending_gaming: "gaming trending Indonesia",
  trending_movies_and_shows: "trailer film terbaru"
};

const failure = (status: number, code: string, error: string) =>
  NextResponse.json({ ok: false, code, error }, { status, headers: { "Cache-Control": "no-store" } });
const success = (data: unknown, seconds=0) =>
  NextResponse.json(data, { headers: {
    "Cache-Control": seconds ? `public, s-maxage=${seconds}, stale-while-revalidate=60` : "no-store",
    "X-Content-Type-Options": "nosniff"
  } });

const text = (params: URLSearchParams, field: string, pattern: RegExp, max = 160) => {
  const v = params.get(field)?.trim() || "";
  return v.length <= max && pattern.test(v) ? v : null;
};
function extractVideoId(id: string) {
  if (VIDEO.test(id)) return id;
  try {
    const url = new URL(id);
    if (!["www.youtube.com","youtube.com","youtu.be","m.youtube.com","music.youtube.com"].includes(url.hostname)) return null;
    const v = url.hostname==="youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v") || url.pathname.split("/")[2];
    return v && VIDEO.test(v) ? v : null;
  } catch { return null; }
}
function responseList(items: Obj[], query: string, source: string) {
  return { url: null, name: query, searchString: query, searchSuggestion: null,
    isCorrectedSearch: false, items, hasNextPage: false, nextPage: null, source };
}
async function channelFromId(yt: any, value: string) {
  let id = value.startsWith("channel/") ? value.slice(8) : value;
  if (id.startsWith("@")) {
    const endpoint = await yt.resolveURL("https://www.youtube.com/" + id);
    id = stringValue(endpoint?.payload?.browseId || endpoint?.payload?.browse_id);
    if (!/^UC[A-Za-z0-9_-]{20,45}$/.test(id)) throw new Error("Channel not found");
  }
  return yt.getChannel(id);
}
function channelHeader(channel: any, id: string) {
  const metadata = channel.metadata || {};
  const header = channel.header || {};
  return {
    id, name: stringValue(metadata.title || header.author?.name || header.title),
    url: id.startsWith("UC") ? "https://www.youtube.com/channel/" + id : "https://www.youtube.com/" + id,
    description: stringValue(metadata.description || header.description),
    subscriberCount: numberValue(header.subscriber_count || metadata.subscriber_count),
    avatars: images(header.avatars || header.avatar || header.author?.thumbnails),
    banners: images(header.banners || header.banner),
    verified: Boolean(header.author?.is_verified),
    source: "youtubei.js"
  };
}

async function fallbackResponse(route:string, params:URLSearchParams): Promise<NextResponse|null> {
  let kind: "video"|"search"|"playlist"|"channel";
  let id: string | undefined;
  let query: string | undefined;
  if (["stream","details","audio","video-streams","subtitles"].includes(route)) {
    const parsed = extractVideoId(params.get("id")?.trim() || "");
    if (!parsed) return null;
    kind="video"; id=parsed;
  } else if (route === "search" || route === "trending") {
    if (route === "search") {
      query=text(params,"q",/^[\s\S]{1,160}$/) || undefined;
    } else {
      query=trendingTerms[params.get("category") || "trending_music"];
    }
    if (!query) return null;
    kind="search";
  } else if (route === "playlist") {
    id=text(params,"id",PLAYLIST,100) || undefined;
    if (!id) return null;
    kind="playlist";
  } else if (route === "channel" || route === "channel-videos") {
    id=text(params,"id",CHANNEL,70) || undefined;
    if (!id) return null;
    kind="channel";
  } else {
    return null; // yt-dlp cannot provide a reliable related-videos or comments adapter.
  }
  const result=await tryYtDlp({kind, ...(id?{id}:{}), ...(query?{query}:{})});
  if (!result.ok) return null;
  const data=result.data;
  if (kind==="video" && (!data?.id || !data?.name)) return null;
  if (route==="audio") return success({id,audioStreams:data.audioStreams||[],source:"yt-dlp",fallbackUsed:true},0);
  if (route==="video-streams") return success({id,videoStreams:data.videoStreams||[],videoOnlyStreams:data.videoOnlyStreams||[],source:"yt-dlp",fallbackUsed:true},0);
  if (route==="details") return success({id,videoTitle:data.videoTitle,name:data.name,url:data.url,description:data.description,viewCount:data.viewCount,likeCount:data.likeCount,channelName:data.channelName,uploadDate:data.uploadDate,duration:data.duration,thumbnails:data.thumbnails||[],source:"yt-dlp",fallbackUsed:true},20);
  if (route==="subtitles") return success({id,subtitles:data.subtitles||[],source:"yt-dlp",fallbackUsed:true},0);
  if (route==="channel-videos") return success({...responseList(data.items||[],id||"","yt-dlp"),id,fallbackUsed:true},20);
  if (route==="trending") return success({...data,category:params.get("category")||"trending_music",officialChart:false,source:"yt-dlp",fallbackUsed:true},30);
  return success({...data,source:"yt-dlp",fallbackUsed:true},0);
}

export async function GET(request: NextRequest, context: {params: Promise<{path:string[]}>}) {
  const { path } = await context.params;
  if (path.length !== 1 || !validPaths.has(path[0])) return failure(404,"NOT_FOUND","Endpoint API tidak dikenal.");
  const route = path[0];
  const params = request.nextUrl.searchParams;
  try {
    if (route === "services") return success({services:[{name:"YouTube", id:0}],backend:"youtubei.js",version:"18.3.0"},3600);
    const yt = await youtube({player:["stream","audio","video-streams"].includes(route)});
    if (route === "search") {
      const q = text(params,"q",/^[\s\S]{1,160}$/);
      if (!q) return failure(400,"INVALID_QUERY","Parameter q wajib diisi (maksimum 160 karakter).");
      const result: any = await yt.search(q);
      return success(responseList(normalizeItems(result.results),q,"youtubei.js"),30);
    }
    if (route === "trending") {
      const category = params.get("category") || "trending_music";
      if (!Object.hasOwn(trendingTerms,category)) return failure(400,"INVALID_CATEGORY","Kategori tidak didukung.");
      const q = trendingTerms[category];
      // YouTube.js does not expose the original NewPipe kiosks; honest search-based substitute.
      const result: any = await yt.search(q, { type: "video" });
      return success({...responseList(normalizeItems(result.results), q, "youtubei.js-search-fallback"), category, officialChart:false},60);
    }
    if (["stream","details","audio","video-streams","subtitles","related","comments"].includes(route)) {
      const id = extractVideoId(params.get("id")?.trim() || "");
      if (!id) return failure(400,"INVALID_VIDEO_ID","Parameter id harus ID video YouTube yang valid.");
      if (route === "comments") {
        const commentPage:any = await yt.getComments(id);
        const rows = Array.isArray(commentPage.contents) ? commentPage.contents : [];
        return success({id, comments: rows.slice(0,80).map((entry:any)=>{
          const c = entry?.comment || {};
          return {id:stringValue(c.comment_id || c.id), text:stringValue(c.content || c.text),
            author:stringValue(c.author?.name || c.author), likes:stringValue(c.vote_count || c.like_count),
            published:stringValue(c.published), replies:numberValue(entry?.reply_count)};
        }), hasNextPage:false, source:"youtubei.js"},20);
      }
      const info: any = route === "related" ? await yt.getInfo(id) : await yt.getBasicInfo(id);
      const playbackStatus = stringValue(info?.playability_status?.status).toUpperCase();
      if (playbackStatus === "LOGIN_REQUIRED") {
        const fallback=await fallbackResponse(route,params);
        if (fallback) return fallback;
        return failure(503, "UPSTREAM_BLOCKED",
          "YouTube.js dan fallback yt-dlp gagal: YouTube meminta login/verifikasi untuk permintaan pemutaran dari server Vercel.");
      }
      const base = await streamData(info, yt.session.player);
      // A format list with null URLs is not a usable direct stream.
      const needed = route === "audio" ? base.audioStreams
        : route === "video-streams" ? [...base.videoStreams, ...base.videoOnlyStreams]
        : [...base.audioStreams, ...base.videoStreams, ...base.videoOnlyStreams];
      const directUrls = needed.some((format: {url?: string|null}) => Boolean(format.url));
      if (!directUrls && ["stream","audio","video-streams"].includes(route)) {
        const fallback=await fallbackResponse(route,params);
        if (fallback) return fallback;
      }
      if (!base.id || !base.name) {
        if (playbackStatus && playbackStatus !== "OK") {
          return failure(422, "UNPLAYABLE",
            "YouTube menolak akses video ini (" + playbackStatus + ") dan tidak mengembalikan metadata.");
        }
        return failure(502, "INCOMPLETE_METADATA",
          "YouTube tidak mengembalikan metadata video yang diperlukan. Respons kosong tidak lagi dilaporkan sebagai sukses.");
      }
      // Metadata can still be valid when playback is UNPLAYABLE. Preserve it for
      // /api/stream and /api/details, with streamingAvailable:false and playbackStatus.
      if (route === "stream") return success({
        ...base,
        fallbackAttempted: !directUrls,
        ...(!directUrls ? {warning:"Format berhasil ditemukan, tetapi belum ada URL langsung. Jika HLS tersedia, tautannya bisa bersifat sementara atau terikat IP server."} : {})
      },0);
      if (route === "details") return success({
        id, videoTitle:base.videoTitle, name:base.name, url:base.url,
        description:base.description, viewCount:base.viewCount, likeCount:base.likeCount,
        channelName:base.channelName, uploadDate:base.uploadDate,
        duration:base.duration, thumbnails:base.thumbnails,
        source:"youtubei.js"
      },20);
      if (route === "audio") return success({id, audioStreams:base.audioStreams, directStreamsAvailable:base.audioStreams.some((f:{url?:string|null})=>Boolean(f.url)), fallbackAttempted:!directUrls, source:"youtubei.js"},0);
      if (route === "video-streams") return success({id, videoStreams:base.videoStreams, videoOnlyStreams:base.videoOnlyStreams, directStreamsAvailable:directUrls, fallbackAttempted:!directUrls, source:"youtubei.js"},0);
      if (route === "subtitles") {
        const raw = info.captions?.caption_tracks;
        const tracks = Array.isArray(raw) ? raw : [];
        return success({id, subtitles: tracks.map((t:any)=>({
          language: stringValue(t.language_code), name:stringValue(t.name),
          url: typeof t.base_url==="string" ? t.base_url : null, automatic: t.kind==="asr"
        })),source:"youtubei.js"},30);
      }
      if (route === "related") return success({...responseList(normalizeItems(info.watch_next_feed),id,"youtubei.js"),id},20);
    }
    if (route === "playlist") {
      const id = text(params,"id",PLAYLIST,100);
      if (!id) return failure(400,"INVALID_PLAYLIST_ID","Parameter id playlist tidak valid.");
      const data:any = await yt.getPlaylist(id);
      const info = data.info || {};
      const items = normalizeItems(data.items);
      return success({id, url:"https://www.youtube.com/playlist?list="+id, name:stringValue(info.title || info.name) || "Playlist",
        uploaderName:stringValue(info.author?.name || info.author), thumbnailUrl:bestImage(info.thumbnails),
        thumbnails:images(info.thumbnails), streamCount:items.length, relatedItems:items, source:"youtubei.js"},40);
    }
    if (route === "channel" || route === "channel-videos") {
      const id = text(params,"id",CHANNEL,70);
      if (!id) return failure(400,"INVALID_CHANNEL_ID","Gunakan @handle atau channel/UC... sebagai id.");
      const data:any = await channelFromId(yt,id);
      if (route === "channel") return success(channelHeader(data,id),40);
      const videos:any = await data.getVideos();
      const items = normalizeItems(videos.videos);
      return success({...responseList(items,id,"youtubei.js"),id},45);
    }
    return failure(404,"NOT_FOUND","Endpoint tidak ditemukan.");
  } catch (error: unknown) {
    const fallback=await fallbackResponse(route,params);
    if (fallback) return fallback;
    const problem = classifyError(error);
    // Never include session data, request headers or full upstream error payloads in public JSON.
    console.error("[youtubei]",route,problem.code,error instanceof Error? error.name : "UnknownError");
    return failure(problem.status,problem.code,problem.message);
  }
}
