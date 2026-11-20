/**
 * Manual, bounded redirects for Googlevideo media.
 *
 * Never allow a signed /api/media link to act as an arbitrary URL fetcher:
 * validate both the initial URL and EACH redirect destination.
 * Do not expose upstream redirect Locations or signed provider URLs in errors.
 */
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function isMediaPlaybackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.port && (host === "googlevideo.com" || host.endsWith(".googlevideo.com")) &&
      (url.pathname === "/videoplayback" || url.pathname.startsWith("/videoplayback/"));
  } catch { return false; }
}

export type MediaRedirectResult =
  | { ok: true; response: Response; redirects: number }
  | { ok: false; code:
      "INVALID_UPSTREAM_HOST" | "UPSTREAM_REDIRECT_BLOCKED" |
      "UPSTREAM_REDIRECT_LOOP" | "UPSTREAM_REDIRECT_LIMIT" | "UPSTREAM_FETCH_FAILED";
      redirects: number };

export async function fetchMediaFollowingSafeRedirects(
  initialUrl: string,
  options: {
    method?: "GET" | "HEAD";
    range?: string;
    timeoutMs?: number;
    maxRedirects?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<MediaRedirectResult> {
  if (!isMediaPlaybackUrl(initialUrl)) return { ok: false, code: "INVALID_UPSTREAM_HOST", redirects: 0 };

  const fetcher = options.fetchImpl ?? fetch;
  const maxRedirects = Math.min(MAX_REDIRECTS, Math.max(0, options.maxRedirects ?? MAX_REDIRECTS));
  const signal = AbortSignal.timeout(options.timeoutMs ?? 25000); // One timeout for the entire chain.
  const visited = new Set<string>();
  let current = initialUrl;

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    if (visited.has(current)) return { ok: false, code: "UPSTREAM_REDIRECT_LOOP", redirects };
    visited.add(current);
    let response: Response;
    try {
      response = await fetcher(current, {
        method: options.method ?? "GET",
        redirect: "manual",
        headers: {
          ...(options.range ? { Range: options.range } : {}),
          "Accept-Encoding": "identity"
        },
        cache: "no-store",
        signal
      });
    } catch {
      return { ok: false, code: "UPSTREAM_FETCH_FAILED", redirects };
    }
    if (!REDIRECT_STATUSES.has(response.status)) return { ok: true, response, redirects };

    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    if (!location || location.length > 16000) return { ok: false, code: "UPSTREAM_REDIRECT_BLOCKED", redirects };
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { ok: false, code: "UPSTREAM_REDIRECT_BLOCKED", redirects };
    }
    if (!isMediaPlaybackUrl(next.toString()))
      return { ok: false, code: "UPSTREAM_REDIRECT_BLOCKED", redirects };

    // Some Googlevideo edges drop the unsigned byte-range query on redirect.
    // Re-add only the range value already requested, never copy signature or cookies.
    const rangeQuery = new URL(current).searchParams.get("range");
    if (rangeQuery && !next.searchParams.has("range")) next.searchParams.set("range", rangeQuery);

    if (redirects >= maxRedirects) return { ok: false, code: "UPSTREAM_REDIRECT_LIMIT", redirects: redirects + 1 };
    current = next.toString();
  }
  return { ok: false, code: "UPSTREAM_REDIRECT_LIMIT", redirects: maxRedirects };
}
