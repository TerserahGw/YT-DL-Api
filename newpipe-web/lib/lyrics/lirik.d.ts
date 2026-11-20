export interface LyricsLine {
  time: number | null;
  endTime: number | null;
  text: string;
  translation?: string;
  words?: Array<{ text: string; start: number; end: number | null }>;
}
export interface LyricsResult {
  source: string;
  sourceLabel?: string;
  sourceUrl: string | null;
  id: string | number | null;
  track: { title: string | null; artist: string | null; album: string | null; duration: number | null; artwork: string | null };
  synced: boolean;
  wordLevel: boolean;
  instrumental: boolean;
  language: string | null;
  lines: LyricsLine[];
  words: unknown;
  plain: string | null;
  raw?: unknown;
}
export interface LyricsSource {
  id: string; label: string; homepage: string; caps: Record<string, unknown>;
}
export class LirikSync {
  constructor(options?: { sources?: string[]; wordLevelFirst?: boolean; timeoutMs?: number; cacheTtlMs?: number; userAgent?: string; debug?: boolean });
  find(query: { q?: string; track?: string; artist?: string; album?: string; duration?: number }, opts?: { source?: string }): Promise<{ result: LyricsResult | null; attempts: Array<{ source: string; ok: boolean; note?: string }> }>;
  toJSON(result: LyricsResult, options?: {raw?: boolean}): LyricsResult;
  toLRC(result: LyricsResult): string;
  toEnhancedLRC(result: LyricsResult): string;
  toPlain(result: LyricsResult): string;
  listSources(): LyricsSource[];
}
export const SOURCES: Record<string, LyricsSource>;
export default LirikSync;
