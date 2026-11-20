"""Private Vercel Services fallback for metadata extraction; no media downloads."""
from __future__ import annotations
import asyncio
import contextlib
import os
import re
import tempfile
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import yt_dlp

app = FastAPI(title="Private yt-dlp fallback", docs_url=None, redoc_url=None, openapi_url=None)
VALID_VIDEO = re.compile(r"^[A-Za-z0-9_-]{11}$")
VALID_PLAYLIST = re.compile(r"^[A-Za-z0-9_-]{10,100}$")
VALID_CHANNEL = re.compile(r"^(?:@[A-Za-z0-9_.-]{3,50}|UC[A-Za-z0-9_-]{20,45}|channel/UC[A-Za-z0-9_-]{20,45})$")
COOKIE_NAME = re.compile(r"^[A-Za-z0-9_!#$%&'*+.^`|~-]+$")
SEMAPHORE = asyncio.Semaphore(2)

class ExtractRequest(BaseModel):
    kind: Literal["video", "search", "playlist", "channel"]
    id: str | None = Field(default=None, max_length=110)
    query: str | None = Field(default=None, max_length=160)
    cookie: str | None = Field(default=None, max_length=20000)

class QuietLogger:
    def debug(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg): pass

def num(n):
    return n if isinstance(n, (int, float)) and not isinstance(n, bool) else None

def valid_url(u):
    return u if isinstance(u, str) and u.startswith(("https://", "http://")) else None

def pic(info):
    imgs=info.get("thumbnails") or []
    return valid_url(info.get("thumbnail") or (imgs[-1].get("url") if imgs and isinstance(imgs[-1],dict) else None))

def item(info):
    if not isinstance(info,dict):
        return None
    vid=info.get("id") or info.get("video_id")
    url=info.get("webpage_url") or info.get("url")
    typ=info.get("_type")
    if isinstance(vid,str) and VALID_VIDEO.fullmatch(vid):
        url="https://www.youtube.com/watch?v="+vid
        kind="stream"
    elif typ in ("playlist", "multi_video"):
        kind="playlist"
    else:
        kind="channel" if isinstance(url,str) and ("/channel/" in url or "/@" in url) else "stream"
    if not valid_url(url) or not info.get("title"):
        return None
    return {
        "type":kind, "name":str(info["title"]), "url":url,
        "thumbnailUrl":pic(info), "uploaderName":info.get("uploader") or info.get("channel"),
        "uploaderUrl":valid_url(info.get("uploader_url") or info.get("channel_url")),
        "duration":num(info.get("duration")), "viewCount":num(info.get("view_count")),
        "description":info.get("description")[:300] if isinstance(info.get("description"),str) else None,
        "uploadDate":str(info.get("upload_date")) if info.get("upload_date") else None,
        "videoCount":num(info.get("playlist_count"))
    }

def shape_video(info):
    formats=[]
    for f in (info.get("formats") or [])[:180]:
        if not isinstance(f,dict):
            continue
        video=f.get("vcodec") not in ("none",None)
        audio=f.get("acodec") not in ("none",None)
        if not (video or audio):
            continue
        formats.append({
            "itag":f.get("format_id"), "format":f.get("ext"),
            "quality":f.get("format_note") or f.get("resolution") or f.get("acodec"),
            "resolution":f.get("resolution"), "bitrate":num(f.get("tbr")),
            "width":num(f.get("width")), "height":num(f.get("height")),
            "fps":num(f.get("fps")), "hasAudio":audio, "hasVideo":video,
            "codec":f.get("vcodec") if video else f.get("acodec"),
            "url":valid_url(f.get("url")), "content":valid_url(f.get("url"))
        })
    audios=[f for f in formats if f["hasAudio"] and not f["hasVideo"]]
    video_only=[f for f in formats if f["hasVideo"] and not f["hasAudio"]]
    video_both=[f for f in formats if f["hasVideo"] and f["hasAudio"]]
    v_id=info.get("id")
    return {
        "id":v_id,
        "url":"https://www.youtube.com/watch?v="+str(v_id),
        "name":info.get("title"),"videoTitle":info.get("title"),"title":info.get("title"),
        "uploaderName":info.get("uploader") or info.get("channel"),
        "channelName":info.get("channel") or info.get("uploader"),
        "channelUrl":valid_url(info.get("channel_url")),
        "duration":num(info.get("duration")), "viewCount":num(info.get("view_count")),
        "likeCount":num(info.get("like_count")), "uploadDate":info.get("upload_date"),
        "description":{"type":3,"content":info.get("description") or ""},
        "thumbnailUrl":pic(info), "thumbnails":[],
        "audioStreams":audios,"videoStreams":video_both,"videoOnlyStreams":video_only,
        "hlsManifestUrl":valid_url(info.get("manifest_url")),
        "dashManifestUrl":None,
        "directStreamsAvailable":any(f["url"] for f in formats),
        "manifestAvailable":bool(valid_url(info.get("manifest_url"))),
        "streamingAvailable":any(f["url"] for f in formats) or bool(valid_url(info.get("manifest_url"))),
        "playbackStatus":"OK" if formats else "UNPLAYABLE",
        "source":"yt-dlp"
    }

def save_cookie_header(cookie):
    """Ephemeral Netscape file, written only inside the internal service."""
    if not cookie:
        return None
    rows=[]
    for raw in cookie.split(";"):
        name, sep, value=raw.strip().partition("=")
        if sep and COOKIE_NAME.fullmatch(name) and value and not any(c in value for c in "\r\n\t"):
            rows.append((".youtube.com","TRUE","/","TRUE","2147483647",name,value))
    if not rows: return None
    f=tempfile.NamedTemporaryFile("w",delete=False,prefix="ytdlp-cookie-",suffix=".txt")
    try:
        os.fchmod(f.fileno(),0o600)
        f.write("# Netscape HTTP Cookie File\n")
        for row in rows: f.write("\t".join(row)+"\n")
    finally:
        f.close()
    return f.name

def run_extract(request:ExtractRequest):
    kind=request.kind
    if kind=="video":
        if not request.id or not VALID_VIDEO.fullmatch(request.id):
            raise ValueError("INVALID_ID")
        target="https://www.youtube.com/watch?v="+request.id
    elif kind=="playlist":
        if not request.id or not VALID_PLAYLIST.fullmatch(request.id):
            raise ValueError("INVALID_ID")
        target="https://www.youtube.com/playlist?list="+request.id
    elif kind=="channel":
        if not request.id or not VALID_CHANNEL.fullmatch(request.id):
            raise ValueError("INVALID_ID")
        value=request.id
        target="https://www.youtube.com/"+(value if value.startswith(("@","channel/")) else "channel/"+value)+"/videos"
    else:
        if not request.query or not request.query.strip() or len(request.query)>160:
            raise ValueError("INVALID_QUERY")
        target="ytsearch12:"+request.query.strip()
    cookiefile=save_cookie_header(request.cookie)
    try:
        opts={
            "quiet":True,"no_warnings":True,"logger":QuietLogger(),
            "skip_download":True,"ignoreerrors":False,
            "socket_timeout":8,"retries":0,"fragment_retries":0,"extractor_retries":0,
            "playlistend":20,"noplaylist":kind=="video",
            "extract_flat":kind!="video",
            "js_runtimes":{"node":{}}
        }
        if cookiefile: opts["cookiefile"]=cookiefile
        with yt_dlp.YoutubeDL(opts) as ydl:
            data=ydl.extract_info(target,download=False)
        if not isinstance(data,dict): raise ValueError("NO_RESULT")
        if kind=="video":
            if not VALID_VIDEO.fullmatch(str(data.get("id") or "")): raise ValueError("INVALID_RESULT")
            return shape_video(data)
        entries=[x for x in data.get("entries") or [] if isinstance(x,dict)]
        items=[x for x in (item(e) for e in entries) if x is not None]
        if kind=="search":
            return {"name":request.query,"searchString":request.query,"url":None,"items":items,
                "hasNextPage":False,"nextPage":None,"source":"yt-dlp"}
        if kind=="playlist":
            return {"id":request.id,"url":target,"name":data.get("title") or "Playlist",
                "uploaderName":data.get("uploader") or data.get("channel"),
                "thumbnailUrl":pic(data),"streamCount":num(data.get("playlist_count")),
                "relatedItems":items,"source":"yt-dlp"}
        return {"id":request.id,"url":target,"name":data.get("title") or request.id,
                "description":data.get("description") or "","subscriberCount":num(data.get("channel_follower_count")),
                "items":items,"source":"yt-dlp"}
    finally:
        if cookiefile:
            with contextlib.suppress(FileNotFoundError): os.unlink(cookiefile)

@app.get("/health")
def health():
    return {"ok":True,"engine":"yt-dlp","upstream":"unchecked"}

@app.post("/extract")
async def extract(request:ExtractRequest):
    async with SEMAPHORE:
        try:
            data=await asyncio.wait_for(asyncio.to_thread(run_extract,request),timeout=23)
            return {"ok":True,"source":"yt-dlp","data":data}
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504,detail="Timed out")
        except ValueError as e:
            if str(e).startswith("INVALID"):
                raise HTTPException(status_code=400,detail="Invalid request")
            raise HTTPException(status_code=502,detail="No extractable data")
        except Exception:
            # No exception strings or user cookies in client-facing responses or logs.
            raise HTTPException(status_code=503,detail="yt-dlp upstream unavailable")
