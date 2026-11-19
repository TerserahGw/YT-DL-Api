# NewPipe Web — Full Vercel (Original Java NewPipeExtractor)

**One Vercel project. No VPS, no second host, no reimplementation of NewPipeExtractor in JavaScript.**

- `web` service: Next.js 16 responsive website + JSON API gateway.
- `extractor` service: **actual Java backend** using [TeamNewPipe/NewPipeExtractor](https://github.com/TeamNewPipe/NewPipeExtractor), packaged by the independent GPL-3.0 project [NewPipeExtractorAPI](https://github.com/kl3pt0gr4ph/NewPipeExtractorAPI) as `mrtumble/opentube-backend:latest`.
- Vercel's **Container Runtime** runs Java from `backend/Dockerfile.vercel`.
- Vercel's **private service binding** provides `EXTRACTOR_BASE_URL` to Next.js. No public Java endpoint to create, and you don't need to set this variable yourself.

This uses Vercel Services / Container Runtime **Beta**. The feature is documented as available on all plans, but deployment success and Java runtime behavior on your project must be confirmed by actual build/runtime logs. Vercel Functions are metered and Java startup may increase cold-start latency and resource usage.

## Deploy from GitHub using an Android phone (recommended)

1. Open https://vercel.com/new and login to GitHub.
2. Import `TerserahGw/YT-DL-Api`.
3. Set **Root Directory** to `newpipe-web`. This is mandatory since the repository also contains a separate older project at its root.
4. Vercel should detect the **Vercel Services** configuration from `newpipe-web/vercel.json`. Do not replace this file with the old single-service Next.js config.
5. Do **not** set `EXTRACTOR_BASE_URL` manually. The `web → extractor` service binding injects it at runtime.
6. Click **Deploy**. The frontend and Java container will be built in the same deployment.
7. When the deployment is ready, open `https://YOUR-VERCEL-URL/api/health`. Then test `/api/search?q=Minecraft`, `/api/services` and the home page.

If you already created a Vercel project from the earlier revision, keep the same GitHub repo and root directory, then **Redeploy** after this commit. Remove any old manually set `EXTRACTOR_BASE_URL` to avoid interference with the binding.

### Diagnosing a build or runtime problem

- **Project detects only Next.js**: ensure Root Directory = `newpipe-web` and the `vercel.json` in that folder still contains `services`.
- **Java service reports that it can't bind port 80** (unprivileged upstream image): in Vercel Project → Settings → Environment Variables set `PORT=8080` and `SERVER_PORT=8080`, then redeploy. Vercel's Container runtime defaults to routing port 80, but the project environment `PORT` may override this.
- **503 unconfigured**: the `web` service did not receive `EXTRACTOR_BASE_URL`. Check the service binding in `vercel.json`; it cannot be replaced with a browser-side variable.
- **502 / timeout / cold start**: check Vercel Runtime Logs for both services. Java startup may exceed the calling function's timeout; multiple requests can create additional cold starts.
- **403 / no streams**: NewPipeExtractor depends on changing upstream providers, IP reputation, and content availability. This does not imply Vercel cannot run Java.
- **Service not enabled**: Vercel Services and Containers remain beta. The Vercel account/project must be able to deploy them.

### Security and usage notes

- Java service remains **private** (no public rewrite). Public clients only access Next.js allowlisted API routes.
- Public API is unauthenticated by default; use Vercel Firewall / rate limits and restrict access for production traffic.
- Media streaming URLs may be tied to the extractor server's public IP and often cannot be played directly on a viewer's different IP. We expose stream metadata but do not promise universal playback/download.
- Cold starts, function limits, YouTube bot challenges, changing service responses, and third-party rights/platform terms still apply.
- NewPipeExtractor and the independent Java backend retain their own GPL-3.0 licensing. See the linked upstream repositories and license notices.
- Docker image `latest` can change; pin to a digest or tested tag for production reproducibility.

## REST API

| Public path | Example | Notes |
| --- | --- | --- |
| `/api/health` | `/api/health` | Check Java service |
| `/api/search` | `/api/search?q=Another+Love` | Search videos/channels/playlists |
| `/api/stream` | `/api/stream?id=dQw4w9WgXcQ` | Raw StreamInfo JSON |
| `/api/details` | `/api/details?id=dQw4w9WgXcQ` | Video metadata |
| `/api/audio` | `/api/audio?id=dQw4w9WgXcQ` | Audio formats |
| `/api/video-streams` | `/api/video-streams?id=dQw4w9WgXcQ` | Video formats |
| `/api/subtitles` | `/api/subtitles?id=dQw4w9WgXcQ` | Subtitle tracks |
| `/api/related` | `/api/related?id=dQw4w9WgXcQ` | Related content |
| `/api/comments` | `/api/comments?id=dQw4w9WgXcQ` | Comments |
| `/api/playlist` | `/api/playlist?id=PL...` | Playlist details |
| `/api/channel` | `/api/channel?id=%40GoogleDevelopers` | Channel info |
| `/api/channel-videos` | `/api/channel-videos?id=%40GoogleDevelopers` | Channel videos |
| `/api/trending` | `/api/trending?category=trending_music` | Trending categories |
| `/api/services` | `/api/services` | Available extractor services |

JSON responses are from the Java extractor API (e.g., search uses `items`).

## Local development

Run Java container separately for local Next.js development if you have Docker:
```sh
docker run --rm -p 8080:8080 mrtumble/opentube-backend:latest
cd newpipe-web
cp .env.example .env.local
npm install
npm run dev
```
`next dev` reads local `EXTRACTOR_BASE_URL=http://127.0.0.1:8080`. If you want to test the full two-service topology, use `vercel dev` from `newpipe-web` with Docker installed.

## Official documentation

- https://vercel.com/kb/guide/vercel-services
- https://vercel.com/kb/guide/docker
- https://github.com/TeamNewPipe/NewPipeExtractor
- https://github.com/kl3pt0gr4ph/NewPipeExtractorAPI
