# NewPipe Web + REST API Gateway (Vercel)

A responsive web dashboard and safe server-side REST gateway for **NewPipeExtractor**, designed for Next.js on Vercel. The actual extractor runs on a **separate Java/Docker service**. No YouTube API key is needed by NewPipeExtractor.

> IMPORTANT: This Vercel application does **not** run the Java extractor by itself. Search, media metadata and extraction require `EXTRACTOR_BASE_URL`. The UI will show an offline/unconfigured state until it is set.

## Quick Vercel deployment

1. Import `TerserahGw/YT-DL-Api` on https://vercel.com/new
2. Set **Root Directory** to `newpipe-web` (do not select repository root).
3. Framework Preset: **Next.js**. Use the default `npm run build`.
4. Add **Environment Variable** `EXTRACTOR_BASE_URL=https://your-java-backend.example.com` (origin only, do not append `/api/v1`).
5. Deploy; then test `https://your-domain.vercel.app/api/health` and `/api/search?q=Another+Love`.

`EXTRACTOR_BASE_URL` must be publicly reachable **via HTTPS** from Vercel. Localhost, LAN-only IPs, and Termux on your phone are not reachable from Vercel.

## Backend using NewPipeExtractor

The backend is provided by [kl3pt0gr4ph/NewPipeExtractorAPI](https://github.com/kl3pt0gr4ph/NewPipeExtractorAPI), an independent GPL-3.0 Spring Boot wrapper around [TeamNewPipe/NewPipeExtractor](https://github.com/TeamNewPipe/NewPipeExtractor). This repository's `docker-compose.backend.yml` runs its published container on a Java-capable host:

```sh
docker compose -f docker-compose.backend.yml up -d
curl 'http://127.0.0.1:8080/api/v1/search?searchString=Another%20Love'
```

Put the backend behind HTTPS. Protect it using your reverse proxy, WAF/rate limits and, when possible, a proxy-injected Authorization token. To make the gateway send a reverse-proxy authorization header, configure `BACKEND_AUTHORIZATION` in Vercel (never use a `NEXT_PUBLIC_` prefix). The upstream app itself does not enforce this token; your proxy must.

**IP-bound streams:** YouTube may bind stream links to the backend's egress IP. Extracted media URLs can fail in the browser or when downloaded from a different IP. This app primarily exposes extraction **metadata** and direct-link inspection, not a guaranteed cross-IP media streaming proxy. Direct links expire; refresh extraction before using them.

## Features

- Responsive mobile-first UI with dark glass styling
- Search for videos, channels and playlists
- Details panel for a selected item, stream lists and raw JSON
- Music, gaming and movie trending category switches
- API reference and copyable example paths
- Runtime health indicator showing whether the Java service is reachable
- Vercel REST gateway with strict route/parameter allowlist, upstream timeout and sanitized errors
- No arbitrary upstream URL parameter, no generic open proxy

## REST API

| Route | Input | Upstream route |
| --- | --- | --- |
| `/api/search?q=...` | query | `/api/v1/search?searchString=...` |
| `/api/stream?id=...` | YouTube video ID | `/api/v1/streams` |
| `/api/details?id=...` | video ID | `/api/v1/streams/details` |
| `/api/audio?id=...` | video ID | `/api/v1/streams/audio` |
| `/api/video-streams?id=...` | video ID | `/api/v1/streams/video` |
| `/api/subtitles?id=...` | video ID | `/api/v1/streams/subtitles` |
| `/api/related?id=...` | video ID | `/api/v1/streams/related` |
| `/api/comments?id=...` | video ID | `/api/v1/comments` |
| `/api/playlist?id=...` | playlist ID | `/api/v1/playlists` |
| `/api/channel?id=...` | channel handle or path | `/api/v1/channels` |
| `/api/channel-videos?id=...` | channel handle or path | `/api/v1/channels/tab?tab=videos` |
| `/api/trending?category=trending_music` | known category | `/api/v1/kiosks/{category}` |
| `/api/services` | none | `/api/v1/services` |
| `/api/health` | none | checks backend health |

API responses mirror the upstream JSON shape. For example search results use `items`, not `results`. The upstream backend's Swagger documentation can be found at `https://<backend>/swagger-ui.html` if you choose to expose it.

## Local development

```sh
cd newpipe-web
cp .env.example .env.local
# Edit EXTRACTOR_BASE_URL in .env.local
npm install
npm run dev
```

Open http://localhost:3000. If you run the Java backend on the same machine, `EXTRACTOR_BASE_URL=http://127.0.0.1:8080` is permitted only for local Next.js development.

## Security and limitations

- The API is public by default. Add Vercel Firewall / rate limiting and access control before sharing at scale.
- Avoid exposing the raw Java API unprotected. Configure HTTPS at the proxy.
- The frontend doesn't store credentials, cookies, or extracted video URLs.
- Search and streaming may break when YouTube changes or challenges the backend's public IP.
- YouTube and other platform terms, copyright, and rights to access/download media still apply.
- Java backend and original NewPipeExtractor code are external dependencies with their respective GPL-3.0 licenses. This project does not claim to be an official NewPipe product.

## Credits

- TeamNewPipe: https://github.com/TeamNewPipe/NewPipeExtractor
- Independent Java REST wrapper: https://github.com/kl3pt0gr4ph/NewPipeExtractorAPI
