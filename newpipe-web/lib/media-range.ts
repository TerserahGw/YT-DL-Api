/** Safe and verified handling of HTTP 206 and Googlevideo HTTP 200 byte-range responses. */
export const MAX_MEDIA_CHUNK = 2 * 1024 * 1024;

export interface MediaByteRange {
  start: number;
  end: number;
  value: string;
}
export type MediaRangePlan =
  | { ok: true; mode: "http-206" | "youtube-200" | "full-200-prefix"; start: number; end: number; total: number; length: number }
  | { ok: false; code: "BAD_UPSTREAM_RANGE" | "AMBIGUOUS_UPSTREAM_200" | "UPSTREAM_IGNORED_RANGE" | "UNSUPPORTED_UPSTREAM_STATUS" };

const positiveInteger = (value: string | null): number | null => {
  if (!value || !/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function mediaLengthHint(raw: string): number | null {
  try {
    const url = new URL(raw);
    const queryLength = positiveInteger(url.searchParams.get("clen"));
    if (queryLength) return queryLength;
    const m = /\/clen\/(\d{1,16})(?:\/|$)/.exec(url.pathname);
    return m ? positiveInteger(m[1]) : null;
  } catch { return null; }
}

export function parseMediaRange(header: string | null, total?: number | null): MediaByteRange | null {
  const normalized = header?.trim() || "";
  const match = normalized ? /^bytes=(\d+)-(\d*)$/.exec(normalized) : null;
  if (normalized && !match) return null;
  const start = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(start) || start < 0 || start > Number.MAX_SAFE_INTEGER - MAX_MEDIA_CHUNK) return null;
  if (total != null && start >= total) return null;
  const requestedEnd = match && match[2] ? Number(match[2]) : start + MAX_MEDIA_CHUNK - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  const end = Math.min(requestedEnd, start + MAX_MEDIA_CHUNK - 1, total == null ? Number.MAX_SAFE_INTEGER : total - 1);
  if (end < start) return null;
  return { start, end, value: "bytes=" + start + "-" + end };
}

export function rangedGoogleVideoUrl(raw: string, range: MediaByteRange): string {
  const u = new URL(raw);
  u.searchParams.set("range", range.start + "-" + range.end);
  return u.toString();
}

/** HTTP 200 only counts when Content-Length verifies the exact byte interval.
 * A full-body 200 is safe only at offset zero, with an explicitly capped body. */
export function interpretMediaRange(
  status: number, headers: Pick<Headers, "get">, range: MediaByteRange, hintedTotal: number | null
): MediaRangePlan {
  if (status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(headers.get("content-range") || "");
    if (!match) return { ok: false, code: "BAD_UPSTREAM_RANGE" };
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === "*" ? hintedTotal : positiveInteger(match[3]);
    const length = end - start + 1;
    const declared = headers.get("content-length");
    const declaredLength = declared ? positiveInteger(declared) : null;
    if (!total || !Number.isSafeInteger(end) || !Number.isSafeInteger(start) || start !== range.start ||
        end > range.end || length <= 0 || length > MAX_MEDIA_CHUNK || end >= total ||
        (declared != null && declaredLength !== length)) {
      return { ok: false, code: "BAD_UPSTREAM_RANGE" };
    }
    return { ok: true, mode: "http-206", start, end, total, length };
  }
  if (status !== 200) return { ok: false, code: "UNSUPPORTED_UPSTREAM_STATUS" };
  const length = positiveInteger(headers.get("content-length"));
  if (!length || !hintedTotal || !Number.isSafeInteger(hintedTotal) || range.start >= hintedTotal)
    return { ok: false, code: "AMBIGUOUS_UPSTREAM_200" };
  const end = Math.min(range.end, hintedTotal - 1);
  const needed = end - range.start + 1;
  if (length === needed)
    return { ok: true, mode: "youtube-200", start: range.start, end, total: hintedTotal, length: needed };
  if (range.start === 0 && length === hintedTotal)
    return { ok: true, mode: "full-200-prefix", start: 0, end, total: hintedTotal, length: needed };
  return { ok: false, code: length === hintedTotal ? "UPSTREAM_IGNORED_RANGE" : "AMBIGUOUS_UPSTREAM_200" };
}

/** Do not relay more than the requested interval, even if upstream misbehaves. */
export function boundedMediaStream(source: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let left = length;
  const stop = () => { void reader.cancel().catch(() => {}); };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (left === 0) { controller.close(); stop(); return; }
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.error(new Error("Upstream ended before requested chunk completed"));
          return;
        }
        if (value.byteLength > left) {
          controller.enqueue(value.subarray(0, left));
          left = 0;
        } else {
          controller.enqueue(value);
          left -= value.byteLength;
        }
        if (left === 0) { controller.close(); stop(); }
      } catch (err) { controller.error(err); }
    },
    cancel(reason) { return reader.cancel(reason).then(() => {}); }
  });
}
