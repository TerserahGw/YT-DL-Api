# NewPipe Web v2.1 — YouTube.js + yt-dlp fallback + Lyrics JSON

Next.js web interface and compatible public REST API, deployed **100% in one Vercel project**, no VPS.

## Services

Repository root `vercel.json` defines:
- **`newpipe-web`** — public Next.js interface and APIs (YouTube.js primary)
- **`ytdlp`** — **private** Python/yt-dlp Container Runtime fallback, bound to the frontend as `YTDLP_INTERNAL_URL`. No public rewrite for this service.

Calls to `/api/stream`, `/api/audio`, `/api/video-streams` first run YouTube.js signature deciphering, and fall back when it fails or provides **no usable direct stream URL** (even if format metadata exists). Search, playlist and channel endpoints also attempt fallback when YouTube.js throws. Comments and related videos are primary-library only because yt-dlp has no equivalent reliable adapter. Responses include `source` and `fallbackUsed:true` when fallback succeeds.

**Limitations:** YouTube may block **both** engines from the same Vercel IP (`LOGIN_REQUIRED`, `UNPLAYABLE`). Cookies and yt-dlp do not guarantee working audio/video streams. Some URLs are short-lived or IP/session-bound. The stream response distinguishes `formatCount`, `directStreamsAvailable`, `manifestAvailable`, and `streamingAvailable`; a format entry with `url: null` is **not** a direct download link. This API returns metadata and links but does not proxy or download media binaries. The Java NewPipeExtractor is no longer used.

### Vercel redeployment

1. Open Vercel Dashboard → existing project for `TerserahGw/YT-DL-Api`.
2. **Root Directory must be repository root (`./`)**, not `newpipe-web`; multi-service `vercel.json` is at repository root.
3. Deploy latest `main`. Vercel should create a **public `newpipe-web`** and **private `ytdlp`** Docker-based service (Services/Container Runtime).
4. Do **not** set `YTDLP_INTERNAL_URL` yourself. Vercel injects it from the binding.
5. `EXTRACTOR_BASE_URL` and `BACKEND_AUTHORIZATION` from the old Java setup are obsolete; remove them from Vercel settings.
6. Test `/api/health`, `/api/lyrics/sources`, `/api/search?q=Minecraft`, `/api/lyrics?track=Yellow&artist=Coldplay`, `/api/stream?id=dQw4w9WgXcQ`.
7. Check Runtime Logs for both services if fallback is unreachable.

The Docker service uses Python and yt-dlp plus its JavaScript challenge component on Node 22. Vercel containers may increase build time, cold-start latency, and service billing.

## YouTube authentication (OPTIONAL)

A **blank JSON template** is at `newpipe-web/config/cookies.json`:

```json
{
  "enabled": false,
  "cookie": "",
  "cookies": []
}
```

To use the file **only after you first make the GitHub repository private**, set `enabled: true` and provide a Cookie header in the `cookie` field. The `cookies` array is an alternative that accepts `{ "name": "...", "value": "..." }` entries. This configuration is used server-side by YouTube.js, and is passed to the private yt-dlp fallback for the same request. The cookie is not exposed via `/api/health`, `/api/services`, or JSON results.

**More secure, strongly recommended:** leave `config/cookies.json` blank, set the secret **`YOUTUBE_COOKIE`** in Vercel Project → Settings → Environment Variables (server-only). Or use `YOUTUBE_COOKIES_JSON` as a JSON string `{"cookie":"..."}`. Precedence is `YOUTUBE_COOKIE` → `YOUTUBE_COOKIES_JSON` → JSON file. Never prefix these with `NEXT_PUBLIC_`.

**Security warnings:**
- Cookies are login credentials. **A private GitHub repository still retains secrets in commit history, clones, builds, and deployment artifacts.** Prefer Vercel Environment Variables. Making a repo private after pushing secrets does not erase older public commits.
- **Make the repository private before entering any cookies.** Do not paste cookies in ChatGPT or a GitHub issue.
- Use a separate low-privilege account, not your primary account; refresh or revoke sessions as needed.
- Cookie-based authentication may trigger account challenges or limitations. Do not run aggressive retries.

See https://ytjs.dev/guide/authentication and https://github.com/yt-dlp/yt-dlp/wiki/Extractors.

## Lyrics API (the supplied original `lirik.js` module)

The provided full `lirik.js` lives at `newpipe-web/lib/lyrics/lirik.js` and powers two server endpoints:

### `GET /api/lyrics`

Query parameters:
- `track` — song title (recommended together with `artist`)
- `artist` — singer/band (optional if `q` is given)
- `q` — free-text song query instead of `track`
- `album` — optional matching hint
- `duration` — track duration in **seconds** (optional)
- `source` — `auto` (default) or one of `lrclib`, `musixmatch`, `netease`, `qq`, `kugou`, `genius`, `lyricsovh`

Example:

```http
GET /api/lyrics?track=Yellow&artist=Coldplay
```

The response is JSON with: `ok`, `source`, `sourceUrl`, `track`, `synced`, `wordLevel`, `lines`, `words`, `plain`, `formats` (`lrc`, `enhancedLrc`, `plain`), and `attempts`. Timing fields `time`, `endTime`, `words[].start`, and `words[].end` are seconds. Word timing is returned only if upstream data provides it; it is not fabricated.

### `GET /api/lyrics/sources`

Returns JSON listing all 7 provider IDs, names, websites and supported lyric formats.

Sourcing is best-effort. Musixmatch, Genius, and other providers may restrict access; not every track has synchronized or per-word lyrics. Respect the rights and terms of source providers. Vercel Function timeout and rate limits apply.

## Existing endpoints retained

`/api/search`, `/api/stream`, `/api/details`, `/api/audio`, `/api/video-streams`, `/api/subtitles`, `/api/related`, `/api/comments`, `/api/playlist`, `/api/channel`, `/api/channel-videos`, `/api/trending`, `/api/services`, `/api/health`.

Their common JSON fields remain compatible with the previous web UI, not guaranteed byte-for-byte equivalent to Java/NewPipe's original API.

## Local development / testing

```sh
cd newpipe-web
npm install
npm run test:lyrics
npm run typecheck
npm run build
npm run dev
```

Local Next dev without running the Python yt-dlp container has **YouTube.js-only** behavior. For the complete Services topology, use `vercel dev` at repository root with local Docker.

## Credits

- User-provided multi-provider `lirik.js` module
- [YouTube.js](https://github.com/LuanRT/YouTube.js)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [Vercel Services](https://vercel.com/docs/services)
