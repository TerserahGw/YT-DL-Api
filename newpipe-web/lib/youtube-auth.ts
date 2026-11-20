import "server-only";
import cookieConfig from "@/config/cookies.json";

type Config = {
  enabled?: boolean;
  cookie?: string;
  cookies?: Array<{ name: string; value: string; domain?: string }>;
};
function parseConfig(raw: unknown): Config {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Config;
  return {};
}
function cookieHeader(config: Config): string {
  if (typeof config.cookie === "string" && config.cookie.trim()) return config.cookie.trim();
  if (!Array.isArray(config.cookies)) return "";
  return config.cookies.filter((x) => x && typeof x.name === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(x.name) && typeof x.value === "string")
    .map((x) => `${x.name}=${x.value}`).join("; ");
}

/** Server side only. Never render the value to users, console logs or client JS. */
export function getYouTubeCookieHeader(): string {
  const direct = process.env.YOUTUBE_COOKIE?.trim();
  if (direct) return direct;
  const json = process.env.YOUTUBE_COOKIES_JSON;
  if (json?.trim()) {
    try { return cookieHeader(parseConfig(JSON.parse(json))); } catch { return ""; }
  }
  const file = parseConfig(cookieConfig);
  return file.enabled ? cookieHeader(file) : "";
}
