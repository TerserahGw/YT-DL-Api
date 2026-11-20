import { Innertube } from "youtubei.js";

/** One lightweight session per warm Vercel function instance. Recreated after errors. */
let instance: Promise<Innertube> | undefined;

export function youtube(): Promise<Innertube> {
  if (!instance) {
    instance = Innertube.create({
      lang: "id",
      location: "ID",
      generate_session_locally: true,
      // Direct media URLs requiring signature deciphering are not guaranteed.
      retrieve_player: false,
    }).catch((error: unknown) => {
      instance = undefined;
      throw error;
    });
  }
  return instance;
}

/** Convert typed YouTube.js parser nodes into small, stable, serializable JSON. */
type Node = Record<string, any>;
const safe = (x: unknown): Node => x && typeof x === "object" ? x as Node : {};

export function stringValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  const obj = safe(value);
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.name === "string") return obj.name;
  if (typeof obj.simpleText === "string") return obj.simpleText;
  if (Array.isArray(obj.runs)) return obj.runs.map((r: any) => r?.text || "").join("");
  try {
    const output = String(value);
    return output === "[object Object]" ? "" : output;
  } catch { return ""; }
}
export function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const str = stringValue(value);
  // Only parse unambiguous plain numerals, not locale-dependent 1,2 jt / 1.2M text.
  if (/^\d{1,16}$/.test(str)) return Number(str);
  return null;
}
function timeValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = stringValue(value);
  if (!/^\d{1,3}:\d\d(?::\d\d)?$/.test(raw)) return null;
  return raw.split(":").reduce((n, t) => n * 60 + Number(t), 0);
}
function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const u = new URL(value); return ["https:", "http:"].includes(u.protocol) ? u.href : null; }
  catch { return null; }
}
export function images(value: unknown): Array<{url:string, width:number|null, height:number|null}> {
  let list: unknown[] = Array.isArray(value) ? value : Array.isArray(safe(value).thumbnails) ? safe(value).thumbnails : [];
  if (list.length === 0 && safe(value).url) list = [value];
  return list.slice(0, 12).map((entry) => {
    const item = safe(entry);
    return { url: safeUrl(item.url), width: numberValue(item.width), height: numberValue(item.height) };
  }).filter((i): i is {url:string,width:number|null,height:number|null} => !!i.url);
}
export function bestImage(value: unknown): string | null {
  const pics = images(value);
  return pics.length ? pics[pics.length-1].url : null;
}
export function normalizeItem(source: unknown): Node | null {
  const item = safe(source);
  if (!Object.keys(item).length) return null;
  const itemType = stringValue(item.type || item.constructor?.type).toLowerCase();
  const videoId = stringValue(item.video_id || (itemType.includes("video") ? item.id : "")).trim();
  const playlistId = stringValue(item.playlist_id || (itemType.includes("playlist") ? item.id : "")).trim();
  const channelId = stringValue(item.channel_id || (itemType.includes("channel") ? item.id : "")).trim();
  const author = item.author || item.owner || item.byline_text;
  const authorName = stringValue(safe(author).name || author);
  const thumb = images(item.thumbnails || item.thumbnail || safe(author).thumbnails);
  const name = stringValue(item.title || item.name || safe(author).name);
  const url = videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId) ? "https://www.youtube.com/watch?v=" + videoId
    : playlistId ? "https://www.youtube.com/playlist?list=" + encodeURIComponent(playlistId)
    : channelId ? "https://www.youtube.com/channel/" + encodeURIComponent(channelId)
    : safeUrl(item.url || item.share_url || safe(item.endpoint).metadata?.url);
  const type = videoId ? "stream" : playlistId ? "playlist" : channelId ? "channel"
    : itemType.includes("playlist") ? "playlist" : itemType.includes("channel") ? "channel" : "stream";
  if (!name || !url) return null;
  return {
    type, name, url,
    thumbnailUrl: thumb.length ? thumb[thumb.length-1].url : null,
    thumbnails: thumb,
    uploaderName: authorName || null,
    uploaderUrl: safeUrl(safe(author).url),
    duration: timeValue(item.duration || item.length_text || item.length),
    viewCount: numberValue(item.view_count || item.views),
    uploadDate: stringValue(item.published || item.published_time || item.upload_date) || null,
    videoCount: numberValue(item.video_count || item.video_count_short),
    description: stringValue(item.description_snippet || item.description) || null,
  };
}
export function normalizeItems(raw: unknown): Node[] {
  if (!Array.isArray(raw)) return [];
  const result: Node[] = [];
  for (const entry of raw.slice(0, 100)) {
    const item = normalizeItem(entry);
    if (item) result.push(item);
  }
  return result;
}
export function streamData(info: unknown): Node {
  const obj = safe(info);
  const basic = safe(obj.basic_info);
  const channel = safe(basic.channel);
  const thumb = images(basic.thumbnail || basic.thumbnails);
  const fmts = safe(obj.streaming_data);
  const full = [...(Array.isArray(fmts.formats) ? fmts.formats : []), ...(Array.isArray(fmts.adaptive_formats) ? fmts.adaptive_formats : [])];
  const serializeFormat = (entry: any) => {
    const format = safe(entry);
    const mime = stringValue(format.mime_type);
    const video = Boolean(format.has_video) || mime.startsWith("video/");
    const audio = Boolean(format.has_audio) || mime.startsWith("audio/");
    return {
      itag: format.itag ?? null,
      format: mime || null,
      quality: stringValue(format.quality_label || format.audio_quality || format.quality) || null,
      resolution: format.quality_label || (format.height ? format.height + "p" : null),
      bitrate: numberValue(format.bitrate),
      width: numberValue(format.width), height: numberValue(format.height),
      fps: numberValue(format.fps),
      hasAudio: audio, hasVideo: video,
      codec: mime.includes("codecs=") ? mime.split("codecs=")[1].replaceAll('"', "") : null,
      // Do not invent URLs: YouTube may return cipher-only or SABR formats.
      url: safeUrl(format.url), content: safeUrl(format.url),
    };
  };
  const formats = full.map(serializeFormat);
  const audioStreams = formats.filter(f => f.hasAudio && !f.hasVideo);
  const videoStreams = formats.filter(f => f.hasVideo && f.hasAudio);
  const videoOnlyStreams = formats.filter(f => f.hasVideo && !f.hasAudio);
  const videoId = stringValue(basic.id);
  const name = stringValue(basic.title);
  return {
    id: videoId, url: videoId ? "https://www.youtube.com/watch?v=" + videoId : null,
    name, videoTitle: name, title: name,
    uploaderName: stringValue(channel.name || basic.author) || null,
    channelName: stringValue(channel.name || basic.author) || null,
    channelUrl: channel.id ? "https://www.youtube.com/channel/" + channel.id : null,
    duration: numberValue(basic.duration),
    viewCount: numberValue(basic.view_count),
    likeCount: numberValue(basic.like_count),
    uploadDate: stringValue(basic.upload_date) || null,
    description: { type: 3, content: stringValue(basic.short_description) },
    thumbnailUrl: thumb.length ? thumb[thumb.length-1].url : null,
    thumbnails: thumb,
    audioStreams, videoStreams, videoOnlyStreams,
    hlsManifestUrl: safeUrl(fmts.hls_manifest_url),
    dashManifestUrl: safeUrl(fmts.dash_manifest_url),
    streamingAvailable: formats.length > 0,
    playbackStatus: stringValue(safe(obj.playability_status).status) || null,
    source: "youtubei.js"
  };
}

export function classifyError(error: unknown): {status:number, code:string, message:string} {
  const msg = error instanceof Error ? error.message : String(error);
  if (/sign.in.to.confirm|not.a.bot|LOGIN_REQUIRED|UPSTREAM_BLOCKED|bot detection|unusual traffic|please sign in/i.test(msg)) {
    return { status: 503, code: "UPSTREAM_BLOCKED", message: "YouTube meminta verifikasi anti-bot untuk IP Vercel. YouTube.js juga dapat terkena pembatasan ini." };
  }
  if (/not found|unavailable|video does not exist/i.test(msg)) {
    return { status: 404, code: "NOT_FOUND", message: "Konten tidak ditemukan atau tidak tersedia." };
  }
  if (/private|members.only|permission|forbidden/i.test(msg)) {
    return { status: 403, code: "FORBIDDEN", message: "Konten tidak bisa diakses secara publik." };
  }
  return { status: 502, code: "EXTRACTOR_ERROR", message: "YouTube.js gagal mengambil data dari YouTube. Coba lagi nanti." };
}
