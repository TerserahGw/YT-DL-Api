# NewPipe Web UI — YouTube.js v2 (Vercel)

> **Backend migrated:** This project now uses [YouTube.js / youtubei.js](https://github.com/LuanRT/YouTube.js) **18.3.0**, not the Java NewPipeExtractor. The original visual branding and public REST API paths are retained for client compatibility.

## Architecture

**One Next.js service on Vercel, with no VPS, Java, Docker or external backend.**

- Repository-root `vercel.json` defines the one public service `newpipe-web` rooted at `newpipe-web/`.
- Frontend: existing responsive Explore, Trending, API Explorer, and Setup pages.
- Backend: Next.js Node.js Route Handlers import `youtubei.js` on the server.
- `newpipe-web/lib/youtube.ts`: session reuse and JSON normalization.
- The old Express implementation in repository root is intentionally kept for historical compatibility but **is not deployed** by this Vercel configuration.
- No Vercel Services bindings; no `EXTRACTOR_BASE_URL`.

## Deploy / redeploy

1. In **Vercel Dashboard**, open your existing GitHub-connected project for `TerserahGw/YT-DL-Api`.
2. Keep the **Root Directory** set to the **repository root** (empty, `./`). This is required because the active `vercel.json` is at root. Do **not** select `newpipe-web`.
3. If framework preset is configurable, use **Services** (with services config autodetected). Only one `newpipe-web` service should be listed; `backend` (Java container) was removed.
4. In **Settings → Environment Variables**, delete any manually set `EXTRACTOR_BASE_URL` and `BACKEND_AUTHORIZATION`. Neither is used.
5. GitHub pushes to `main` should trigger deployment. Otherwise select **Deployments → Redeploy** using the latest commit.
6. Open your existing domain and test:
   - `/api/health` → `ok: true`, `backend: "youtubei.js"`, `upstream: "unchecked"`
   - `/api/search?q=Minecraft` → `items` array
   - `/api/stream?id=dQw4w9WgXcQ` → video info (may report `UPSTREAM_BLOCKED`)
   - `/api/services` → provider list

### API compatibility

The API names and common JSON fields are preserved; responses are **adapter compatible**, not byte-for-byte copies of NewPipeExtractor DTOs.

| Endpoint | YouTube.js implementation | Notes |
| --- | --- | --- |
| `/api/search?q=...` | `yt.search` | `items`, `name`, `url`, `type`, `thumbnailUrl`, etc. |
| `/api/stream?id=...` | `yt.getBasicInfo` | `audioStreams`, `videoStreams`, `videoOnlyStreams`, metadata; URLs only when genuinely provided |
| `/api/details?id=...` | `yt.getBasicInfo` | metadata |
| `/api/audio?id=...` | `yt.getBasicInfo` | `audioStreams` |
| `/api/video-streams?id=...` | `yt.getBasicInfo` | `videoStreams`, `videoOnlyStreams` |
| `/api/subtitles?id=...` | `yt.getBasicInfo` | `subtitles` |
| `/api/related?id=...` | `yt.getInfo` | `items` derived from watch-next feed |
| `/api/comments?id=...` | `yt.getComments` | first-page `comments` |
| `/api/playlist?id=...` | `yt.getPlaylist` | `relatedItems`, metadata |
| `/api/channel?id=%40handle` | `yt.resolveURL` + `getChannel` | handle and channel IDs |
| `/api/channel-videos?id=%40handle` | `yt.getChannel` / `getVideos` | first page `items` |
| `/api/trending?category=trending_music` | `yt.search` | **Search-based discovery, NOT official trending charts** |
| `/api/services` | static supported provider | YouTube only |
| `/api/health` | local readiness | Does **not** check upstream anti-bot access |

### Known limitations

- **YouTube rate limits and `LOGIN_REQUIRED` remain possible, especially on shared cloud/Vercel IPs.** Switching from NewPipeExtractor does not guarantee bypass.
- `youtubei.js` direct stream links may be missing, signature-protected, require Proof-of-Origin tokens, or use SABR. This implementation never fabricates links or promises download of any video.
- `retrieve_player: false` speeds up serverless initialization but limits deciphering. A full streaming solution needs a separate approved player/attestation implementation and appropriate rights.
- Search pagination, playlist pagination, and comment pagination are **not implemented**. `hasNextPage: false` means "this API exposes first page only" rather than a definitive end of YouTube results.
- This is a **YouTube-only** backend (NewPipeExtractor supported multiple sites).
- API endpoints are public, so add Vercel Firewall/rate limits if your project is exposed broadly. Avoid aggressive retries against YouTube.
- Stream URLs can expire or be bound to the server's egress IP and fail in browsers.
- YouTube.js is unofficial and unaffiliated with YouTube. Respect rights and platform usage terms.

## Local dev (optional)

```sh
cd newpipe-web
npm install
npm run typecheck
npm run build
npm run dev
```

Then open http://localhost:3000. No extra backend required.

## Credits and license

- YouTube.js (MIT): https://github.com/LuanRT/YouTube.js
- Original NewPipeExtractor (not used in v2): https://github.com/TeamNewPipe/NewPipeExtractor
