#!/usr/bin/env node
/**
 * lirik.js — modul + CLI pengambil lirik multi-sumber dalam SATU file.
 * (versi single-file dari proyek "lirik-sync" v1.0.0)
 *
 * Sumber didukung (7): LRCLIB, Musixmatch, Netease Cloud Music, QQ Music,
 * Kugou Music, Genius, lyrics.ovh.
 *
 * Keluaran : JSON normalisasi + konverter LRC / Enhanced LRC (per-kata) /
 *            teks polos. Waktu dalam detik (float).
 *
 * Tanpa dependency eksternal. Node.js >= 18 (memakai fetch bawaan).
 *
 * Pemakaian sebagai modul:
 *   import LirikSync from './lirik.js';
 *   const lirik = new LirikSync();
 *   const { result } = await lirik.find({ track: 'To the Bone', artist: 'Pamungkas' });
 *   console.log(lirik.toEnhancedLRC(result));   // lirik per-kata
 *   console.log(lirik.toLRC(result));           // LRC per baris
 *   console.log(lirik.toPlain(result));         // teks polos
 *   console.log(lirik.toJSON(result));          // JSON normalisasi
 *
 * Ekspor utama:
 *   default            LirikSync (class aggregator)
 *   LirikSync          sama dengan default
 *   createLirikSync()  helper pabrik
 *   SOURCES            metadata semua sumber (label, homepage, kemampuan)
 *   toLRC / toEnhancedLRC / toPlain / toJSON / fmtTime   konverter
 *   BaseProvider / buildResult   untuk membuat provider kustom (lirik.use())
 *   Provider kelas: LrclibProvider, MusixmatchProvider, NeteaseProvider,
 *   QQMusicProvider, KugouProvider, GeniusProvider, LyricsOvhProvider
 *   Parser: parseLrc, parseLrcFile, parseYrc, attachTranslation, parseKrc,
 *   decodeKrc, parseQrc, decryptQrc, parseRichsync
 *   Core: http, httpRequest, HttpError, Cache, scoreCandidate, normalizeText,
 *   stripJunk, similarity, buildKeyword
 *
 * Pemakaian sebagai CLI (langsung dari terminal):
 *   node lirik.js "pamungkas - to the bone"
 *   node lirik.js "taylor swift cruel summer" -e           (Enhanced LRC per-kata)
 *   node lirik.js --track "晴天" --artist "周杰伦" -s kugou  (paksa satu sumber)
 *   node lirik.js "coldplay yellow" --all                   (bandingkan semua sumber)
 *   node lirik.js --sources                                 (daftar sumber)
 *   node lirik.js --help                                    (bantuan lengkap)
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { writeFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/* ============================================================ *
 *  §1  HTTP CLIENT — fetch bawaan + timeout + retry ringan
 * ============================================================ */

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Permintaan HTTP generik.
 * @param {string} url
 * @param {object} [opts]
 * @param {string}   [opts.method='GET']
 * @param {object}   [opts.headers] header tambahan
 * @param {string|null} [opts.body] body string mentah
 * @param {object|null} [opts.form] object -> di-encode jadi application/x-www-form-urlencoded
 * @param {number}   [opts.timeoutMs=10000]
 * @param {number}   [opts.retries=1] jumlah percobaan ulang utk error jaringan/429/5xx
 * @param {'json'|'text'|'buffer'} [opts.as='json']
 * @returns {Promise<{status:number, headers:Headers, data:any}>}
 */
export async function httpRequest(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    form = null,
    timeoutMs = 10000,
    retries = 1,
    as = 'json',
  } = opts;

  let payload = body;
  const reqHeaders = { 'User-Agent': DEFAULT_UA, ...headers };
  if (form) {
    payload = new URLSearchParams(form).toString();
    reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: reqHeaders,
        body: payload,
        signal: ac.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);

      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        lastErr = new HttpError(`HTTP ${res.status}`, res.status, url);
        await sleep(350 + attempt * 250);
        continue;
      }

      let data;
      if (as === 'buffer') {
        data = Buffer.from(await res.arrayBuffer());
      } else {
        const text = await res.text();
        if (as === 'json') {
          try {
            data = JSON.parse(text);
          } catch {
            data = null; // biarkan provider yang memutuskan (mis. respons bukan JSON)
          }
        } else {
          data = text;
        }
      }
      return { status: res.status, headers: res.headers, data };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const isAbort = err && (err.name === 'AbortError' || /timeout/i.test(String(err.message)));
      if (attempt < retries && (isAbort || err?.cause || err?.code === 'ECONNRESET')) {
        await sleep(300 + attempt * 200);
        continue;
      }
      break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new HttpError(String(lastErr), 0, url);
}

export const http = {
  /** GET JSON; mengembalikan null bila respons bukan JSON valid. */
  async getJson(url, opts = {}) {
    const { status, headers, data } = await httpRequest(url, { ...opts, as: 'json' });
    return { status, headers, data };
  },

  async getText(url, opts = {}) {
    const { status, headers, data } = await httpRequest(url, { ...opts, as: 'text' });
    return { status, headers, data };
  },

  async getBuffer(url, opts = {}) {
    const { status, headers, data } = await httpRequest(url, { ...opts, as: 'buffer' });
    return { status, headers, data };
  },
};

/* ============================================================ *
 *  §2  CACHE — TTL sederhana berbasis Map (in-memory)
 * ============================================================ */

export class Cache {
  constructor(defaultTtlMs = 6 * 60 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
    this._map = new Map();
  }

  set(key, value, ttlMs) {
    const ttl = ttlMs ?? this.defaultTtlMs;
    this._map.set(key, { value, expires: Date.now() + ttl });
    // pembersihan ringan bila cache membesar
    if (this._map.size > 500) this.sweep();
    return value;
  }

  get(key) {
    const item = this._map.get(key);
    if (!item) return undefined;
    if (Date.now() > item.expires) {
      this._map.delete(key);
      return undefined;
    }
    return item.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  sweep() {
    const now = Date.now();
    for (const [k, v] of this._map) {
      if (now > v.expires) this._map.delete(k);
    }
  }
}

/* ============================================================ *
 *  §3  MATCHING — normalisasi teks + penilaian kemiripan kandidat
 * ============================================================ */

/** Buang sampah umum di judul: (Official Video), [Lyrics], feat. X, dll. */
export function stripJunk(s) {
  if (!s) return '';
  return String(s)
    .replace(/\(([^)]*)\)/g, ' ')
    .replace(/\[([^\]]*)\]/g, ' ')
    .replace(/\{([^}]*)\}/g, ' ')
    .replace(/\s*(feat|ft|featuring)\.?\s+.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lowercase + hapus diakritik + buang tanda baca. */
export function normalizeText(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(s) {
  return normalizeText(stripJunk(s)).split(' ').filter(Boolean);
}

/** Kemiripan 0..1 berbasis irisan token (Dice coefficient). */
export function similarity(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

function durationScore(d1, d2) {
  if (!d1 || !d2) return 0.5; // tidak diketahui -> netral
  const diff = Math.abs(d1 - d2);
  if (diff <= 2) return 1;
  if (diff >= 8) return 0;
  return 1 - (diff - 2) / 6;
}

/**
 * @param {object} query {track, artist, album, duration}
 * @param {object} cand  {track, artist, album, duration}
 * @returns {number} skor 0..1
 */
export function scoreCandidate(query, cand) {
  let titleSim;
  if (query.track && cand.track) {
    titleSim = Math.max(similarity(query.track, cand.track), similarity(stripJunk(query.track), stripJunk(cand.track)));
  } else {
    // hanya kueri bebas: gunakan seluruh string
    titleSim = query.q && cand.track ? similarity(query.q, `${cand.track} ${cand.artist || ''}`) : 0;
  }

  const artistSim =
    query.artist && cand.artist
      ? similarity(query.artist, cand.artist) ||
        // artis bisa berisi beberapa nama "A / B" -> cek kemunculan
        (normalizeText(cand.artist).includes(normalizeText(query.artist)) ? 1 : 0)
      : 0.5; // artis tidak diberikan -> netral

  const albumSim = query.album && cand.album ? similarity(query.album, cand.album) : 0.5;

  const dur = durationScore(query.duration, cand.duration);

  const score = 0.5 * titleSim + 0.3 * artistSim + 0.05 * albumSim + 0.15 * dur;
  return Math.max(0, Math.min(1, score));
}

/** Gabung kueri bebas jadi keyword pencarian. */
export function buildKeyword(query) {
  if (query.q) return query.q;
  const parts = [query.track, query.artist].filter(Boolean);
  return parts.join(' ');
}

/* ============================================================ *
 *  §4  PARSER LRC — standar + Enhanced LRC (tag kata <mm:ss.xx>)
 * ============================================================ */

const LRC_TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const LRC_WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

function toSec(min, sec, frac) {
  const f = frac ? parseFloat('0.' + frac) : 0;
  return min * 60 + sec + f;
}

/**
 * @param {string} text isi file LRC
 * @returns {{lines: Array<{time:number|null, endTime:number|null, text:string, words?:Array<{text,start,end}>}>, metadata: Record<string,string>}}
 */
export function parseLrc(text) {
  const metadata = {};
  const out = [];

  for (const raw of String(text ?? '').split(/\r\n|\r|\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    // header metadata: [ti:..] [ar:..] [offset:..] dsb
    const metaMatch = line.match(/^\[([a-zA-Z#]+):(.*)\]$/);
    if (metaMatch && !/\d{1,3}:\d{1,2}/.test(metaMatch[1])) {
      metadata[metaMatch[1].toLowerCase()] = metaMatch[2].trim();
      continue;
    }

    LRC_TIME_TAG.lastIndex = 0;
    const times = [];
    let m;
    let rest = line;
    while ((m = LRC_TIME_TAG.exec(line)) !== null) {
      times.push(toSec(parseInt(m[1], 10), parseInt(m[2], 10), m[3]));
    }
    if (times.length) rest = line.replace(LRC_TIME_TAG, '');

    // tag kata (Enhanced LRC): <mm:ss.xx>kata
    LRC_WORD_TAG.lastIndex = 0;
    const words = [];
    let w;
    const segments = [];
    let lastIdx = 0;
    let plain = '';
    while ((w = LRC_WORD_TAG.exec(rest)) !== null) {
      const before = rest.slice(lastIdx, w.index);
      plain += before;
      if (words.length) {
        // teks sebelum tag ini adalah isi kata sebelumnya
        words[words.length - 1].text += before;
      }
      words.push({
        text: '',
        start: toSec(parseInt(w[1], 10), parseInt(w[2], 10), w[3]),
        end: null,
      });
      lastIdx = w.index + w[0].length;
    }
    if (words.length) {
      const tail = rest.slice(lastIdx);
      words[words.length - 1].text += tail;
      plain += tail;
      // durasi kata = mulai kata berikutnya
      for (let i = 0; i < words.length; i++) {
        const next = words[i + 1];
        if (next) words[i].end = next.start;
        // kata terakhir: end tetap null (ditutup endTime baris di atasnya)
        words[i].text = words[i].text.trim();
      }
      // buang kata kosong
      const clean = words.filter((x) => x.text);
      words.length = 0;
      for (const x of clean) words.push(x);
    } else {
      plain = rest;
    }

    for (const t of times) {
      out.push({
        time: t,
        endTime: null,
        text: plain.replace(LRC_WORD_TAG, '').trim(),
        ...(words.length ? { words: words.map((x) => ({ ...x })) } : {}),
      });
    }
    if (!times.length && plain.trim()) {
      out.push({ time: null, endTime: null, text: plain.trim() });
    }
  }

  // terapkan offset metadata (detik, positif = geser maju)
  const offset = parseFloat(metadata.offset);
  if (!Number.isNaN(offset) && offset !== 0) {
    for (const l of out) {
      if (l.time != null) l.time += offset;
      if (l.endTime != null) l.endTime += offset;
      for (const w of l.words || []) {
        w.start += offset;
        if (w.end != null) w.end += offset;
      }
    }
  }

  // urutkan berdasarkan waktu
  out.sort((a, b) => (a.time ?? -1) - (b.time ?? -1));

  // isi endTime baris dari baris berikutnya
  for (let i = 0; i < out.length; i++) {
    if (out[i].endTime == null && out[i].time != null) {
      const next = out[i + 1];
      if (next && next.time != null && next.time > out[i].time) {
        out[i].endTime = next.time;
      }
    }
    const words = out[i].words;
    if (words?.length) {
      for (let j = 0; j < words.length - 1; j++) {
        if (words[j].end == null) words[j].end = words[j + 1].start;
      }
      if (words[words.length - 1].end == null) {
        words[words.length - 1].end = out[i].endTime ?? (words[words.length - 1].start ?? 0) + 1;
      }
    }
  }

  return { lines: out, metadata };
}

/* ============================================================ *
 *  §5  PARSER LYRICSFILE — subset YAML milik LRCLIB
 *      (metadata + lines[].text/start_ms/end_ms/words[].text/start_ms)
 *      Struktur berubah -> null agar pemanggil fallback ke LRC.
 * ============================================================ */

function unquote(v) {
  if (v == null) return '';
  v = v.trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1);
  }
  return v;
}

export function parseLrcFile(yamlText) {
  if (!yamlText || typeof yamlText !== 'string') return null;
  const lines = [];
  const metadata = {};
  let section = null; // 'metadata' | 'lines'
  let curLine = null;
  let curWord = null;
  let inWords = false;

  try {
    for (const raw of yamlText.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      if (raw.startsWith('version:')) continue;

      if (raw.startsWith('metadata:')) { section = 'metadata'; inWords = false; curLine = null; continue; }
      if (raw.startsWith('lines:')) { section = 'lines'; inWords = false; curLine = null; continue; }

      if (section === 'metadata') {
        const m = raw.match(/^(\s*)([\w-]+):\s*(.*)$/);
        if (m && m[1].length >= 2) metadata[m[2]] = unquote(m[3]);
        continue;
      }

      if (section !== 'lines') continue;

      // entri baris: "- text: ..." di indentasi dasar
      const lineEntry = raw.match(/^- text:\s*(.*)$/);
      if (lineEntry) {
        curLine = { text: unquote(lineEntry[1]), start: null, end: null, words: [] };
        lines.push(curLine);
        inWords = false;
        continue;
      }
      // entri kata: "- text: ..." di indentasi dalam (dibawah words:)
      const wordEntry = raw.match(/^\s{2,}- text:\s*(.*)$/);
      if (wordEntry && inWords && curLine) {
        curWord = { text: unquote(wordEntry[1]), start: null };
        curLine.words.push(curWord);
        continue;
      }
      if (raw.startsWith('  words:')) { inWords = true; continue; }

      const field = raw.match(/^\s+([\w-]+):\s*(.*)$/);
      if (field) {
        const key = field[1];
        const val = unquote(field[2]);
        const num = Number(val);
        if (inWords && curWord) {
          if (key === 'start_ms') curWord.start = num / 1000;
        } else if (curLine && !inWords) {
          if (key === 'start_ms') curLine.start = num / 1000;
          if (key === 'end_ms') curLine.end = num / 1000;
        }
      }
    }
  } catch {
    return null;
  }

  if (!lines.length) return null;

  const out = [];
  for (const l of lines) {
    if (l.start == null) continue;
    const words = (l.words || [])
      .filter((w) => w.text && w.start != null)
      .map((w, i, arr) => ({
        text: w.text.trim(),
        start: w.start,
        end: i < arr.length - 1 ? arr[i + 1].start : l.end ?? w.start + 1,
      }));
    out.push({
      time: l.start,
      endTime: l.end,
      text: l.text.trim(),
      ...(words.length ? { words } : {}),
    });
  }

  if (!out.length) return null;
  return { lines: out, metadata };
}

/* ============================================================ *
 *  §6  PARSER YRC — lirik per-kata Netease Cloud Music
 *      1. Baris kredit (JSON): {"t": ms, "c": [{"tx": "..."}, ...]}
 *      2. Baris bernyanyi: [start,dur](wStart,wDur,0)kata...
 *         Timestamp kata ABSOLUT (milidetik).
 * ============================================================ */

const YRC_SONG_LINE = /^\[(\d+),(\d+)\](.*)$/;
const YRC_WORD_TAG = /\((\d+),(\d+),(\d+)\)/g;

export function parseYrc(text) {
  const lines = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('{')) {
      try {
        const o = JSON.parse(line);
        const text2 = (o.c || []).map((c) => c.tx ?? '').join('').trim();
        if (text2) lines.push({ time: (o.t || 0) / 1000, endTime: null, text: text2 });
      } catch { /* baris rusak: lewati */ }
      continue;
    }

    const m = line.match(YRC_SONG_LINE);
    if (!m) continue;
    const start = parseInt(m[1], 10);
    const dur = parseInt(m[2], 10);
    const content = m[3];

    const words = [];
    let lastIdx = 0;
    let w;
    YRC_WORD_TAG.lastIndex = 0;
    let textAll = '';
    while ((w = YRC_WORD_TAG.exec(content)) !== null) {
      const before = content.slice(lastIdx, w.index);
      textAll += before;
      if (words.length) words[words.length - 1].textRaw += before;
      words.push({
        textRaw: '',
        start: parseInt(w[1], 10) / 1000,
        end: (parseInt(w[1], 10) + parseInt(w[2], 10)) / 1000,
      });
      lastIdx = w.index + w[0].length;
    }
    if (words.length) {
      const tail = content.slice(lastIdx);
      textAll += tail;
      words[words.length - 1].textRaw += tail;
    } else {
      textAll = content;
    }

    const clean = words
      .map((x) => ({ text: x.textRaw.trim(), start: x.start, end: x.end }))
      .filter((x) => x.text);

    lines.push({
      time: start / 1000,
      endTime: (start + dur) / 1000,
      text: textAll.replace(YRC_WORD_TAG, '').replace(/\s+/g, (s) => (s.includes('\n') ? s : ' ')).trim(),
      ...(clean.length ? { words: clean } : {}),
    });
  }

  lines.sort((a, b) => (a.time ?? -1) - (b.time ?? -1));
  return lines;
}

/** Gabungkan terjemahan (tlyric LRC) ke baris berdasarkan waktu. */
export function attachTranslation(lines, translationLrc) {
  if (!translationLrc) return lines;
  const map = new Map();
  for (const raw of String(translationLrc).split(/\r?\n/)) {
    const m = raw.match(/^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)$/);
    if (!m) continue;
    const t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + (m[3] ? parseFloat('0.' + m[3]) : 0);
    const text = m[4].trim();
    if (text) map.set(Math.round(t * 100), text);
  }
  if (!map.size) return lines;
  for (const l of lines) {
    if (l.time == null) continue;
    const tr = map.get(Math.round(l.time * 100));
    if (tr) l.translation = tr;
  }
  return lines;
}

/* ============================================================ *
 *  §7  PARSER KRC — lirik per-kata Kugou Music
 *      Pipeline: base64 -> buang magic "krc1" (4 byte) -> XOR kunci
 *      16 byte -> zlib inflate -> teks KRC.
 *      [start,dur]<off,dur,0>kata...  (offset kata RELATIF ke awal baris)
 *      Terjemahan ada di blok [language:] (base64 JSON).
 * ============================================================ */

// Kunci XOR KRC (karakter '@','G','a','w','^','2','t','G','Q','6','1','-',0xce,0xd2,'n','i')
const KRC_XOR_KEY = Buffer.from([
  64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105,
]);

/** base64 dari endpoint download lyrics.kugou.com -> teks KRC */
export function decodeKrc(base64) {
  const buf = Buffer.from(String(base64 ?? ''), 'base64');
  if (buf.length <= 4) throw new Error('payload KRC terlalu pendek');
  const body = buf.slice(4); // lewati magic "krc1"
  const xored = Buffer.from(body); // salinan
  for (let i = 0; i < xored.length; i++) {
    xored[i] = xored[i] ^ KRC_XOR_KEY[i % KRC_XOR_KEY.length];
  }
  return zlib.inflateSync(xored).toString('utf8');
}

const KRC_LINE = /^\[(\d+),(\d+)\](.*)$/;
const KRC_WORD = /<(\d+),(\d+)(?:,(\d+))?>/g;

export function parseKrc(text) {
  const lines = [];
  let translationBlock = null;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('[language:')) {
      translationBlock = line.slice(line.indexOf(':') + 1, line.lastIndexOf(']'));
      continue;
    }

    const m = line.match(KRC_LINE);
    if (!m) continue; // [ti:..] [ar:..] [offset:0] dll diabaikan
    const start = parseInt(m[1], 10);
    const dur = parseInt(m[2], 10);
    const content = m[3];

    const words = [];
    let lastIdx = 0;
    let w;
    KRC_WORD.lastIndex = 0;
    let textAll = '';
    while ((w = KRC_WORD.exec(content)) !== null) {
      const before = content.slice(lastIdx, w.index);
      textAll += before;
      if (words.length) words[words.length - 1].textRaw += before;
      words.push({
        textRaw: '',
        start: start + parseInt(w[1], 10),
        end: start + parseInt(w[1], 10) + parseInt(w[2], 10),
      });
      lastIdx = w.index + w[0].length;
    }
    if (words.length) {
      const tail = content.slice(lastIdx);
      textAll += tail;
      words[words.length - 1].textRaw += tail;
    } else {
      textAll = content;
    }

    const clean = words
      .map((x) => ({ text: x.textRaw.trim(), start: x.start / 1000, end: x.end / 1000 }))
      .filter((x) => x.text);

    lines.push({
      time: start / 1000,
      endTime: (start + dur) / 1000,
      text: textAll.replace(KRC_WORD, '').replace(/\s+/g, (s) => (s.includes('\n') ? s : ' ')).trim(),
      ...(clean.length ? { words: clean } : {}),
    });
  }

  lines.sort((a, b) => (a.time ?? -1) - (b.time ?? -1));

  // Terjemahan: blok [language:] berisi JSON base64; type 1 = terjemahan.
  if (translationBlock) {
    try {
      const json = JSON.parse(Buffer.from(translationBlock, 'base64').toString('utf8'));
      const contents = Array.isArray(json?.content) ? json.content : [];
      for (const item of contents) {
        if (item?.type !== 1 || !Array.isArray(item.lyricContent)) continue;
        let idx = 0;
        for (const entry of item.lyricContent) {
          const trText = Array.isArray(entry) ? entry.join('') : String(entry?.lyricContent ?? '');
          const time = Number(entry?.time ?? NaN);
          if (!trText.trim()) continue;
          const target =
            (Number.isFinite(time)
              ? lines.find((l) => Math.abs(l.time * 1000 - time) < 50)
              : null) || lines[idx];
          if (target && !target.translation) target.translation = trText.trim();
          idx++;
        }
      }
    } catch { /* terjemahan tidak valid: abaikan */ }
  }

  return lines;
}

/* ============================================================ *
 *  §8  PARSER QRC — lirik per-kata QQ Music
 *      Pipeline: hex -> 3DES-ECB (dua kunci historis) -> zlib inflate.
 *      [start,dur]teks<wStart,wDur>kata...  (timestamp kata ABSOLUT)
 * ============================================================ */

// Dua kunci 3DES yang dikenal dipakai QRC (era desktop lama & API baru).
const QRC_KEYS = [
  Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL'),
  Buffer.from([
    0x51, 0x88, 0x0a, 0x1d, 0xd2, 0x53, 0xe4, 0x90,
    0x40, 0x1c, 0x9a, 0xf3, 0x84, 0x35, 0x18, 0x90,
    0xd5, 0x6e, 0x2c, 0x76, 0x54, 0xe2, 0x33, 0x90,
  ]),
];

function looksLikeQrcText(s) {
  const t = s.trimStart();
  return t.startsWith('[') || /\[\d+,\d+\]/.test(s.slice(0, 2000));
}

/** @returns {string|null} teks QRC plaintext */
export function decryptQrc(hex) {
  if (!hex) return null;
  let data;
  try {
    data = Buffer.from(String(hex), 'hex');
  } catch {
    return null;
  }
  if (!data.length) return null;

  for (const key of QRC_KEYS) {
    try {
      const decipher = crypto.createDecipheriv('des-ede3', key, null);
      const dec = Buffer.concat([decipher.update(data), decipher.final()]);
      // varian A: hasil dekripsi = stream zlib
      if (dec[0] === 0x78 || dec[0] === 0x1f) {
        try {
          const text = zlib.inflateSync(dec).toString('utf8');
          if (looksLikeQrcText(text)) return text;
        } catch { /* lanjut */ }
      }
      // varian B: hasil dekripsi = plaintext langsung
      const asText = dec.toString('utf8');
      if (looksLikeQrcText(asText)) return asText;
    } catch { /* kunci salah / blok tidak valid: coba kunci berikutnya */ }
  }

  // varian C: payload ternyata zlib tanpa 3DES
  if (data[0] === 0x78 || data[0] === 0x1f) {
    try {
      const text = zlib.inflateSync(data).toString('utf8');
      if (looksLikeQrcText(text)) return text;
    } catch { /* abaikan */ }
  }
  return null;
}

const QRC_LINE = /^\[(\d+),(\d+)\](.*)$/;
const QRC_WORD = /<(\d+),(\d+)>/g;

export function parseQrc(text) {
  const lines = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const m = line.match(QRC_LINE);
    if (!m) continue; // header [ti:..] / [offset:..] diabaikan untuk versi ini
    const start = parseInt(m[1], 10);
    const dur = parseInt(m[2], 10);
    const content = m[3];

    const words = [];
    let lastIdx = 0;
    let w;
    QRC_WORD.lastIndex = 0;
    let textAll = '';
    while ((w = QRC_WORD.exec(content)) !== null) {
      const before = content.slice(lastIdx, w.index);
      textAll += before;
      if (words.length) words[words.length - 1].textRaw += before;
      words.push({
        textRaw: '',
        start: parseInt(w[1], 10) / 1000,
        end: (parseInt(w[1], 10) + parseInt(w[2], 10)) / 1000,
      });
      lastIdx = w.index + w[0].length;
    }
    if (words.length) {
      const tail = content.slice(lastIdx);
      textAll += tail;
      words[words.length - 1].textRaw += tail;
    } else {
      textAll = content;
    }

    const clean = words
      .map((x) => ({ text: x.textRaw.trim(), start: x.start, end: x.end }))
      .filter((x) => x.text);

    lines.push({
      time: start / 1000,
      endTime: (start + dur) / 1000,
      text: textAll.replace(QRC_WORD, '').replace(/\s+/g, (s) => (s.includes('\n') ? s : ' ')).trim(),
      ...(clean.length ? { words: clean } : {}),
    });
  }

  lines.sort((a, b) => (a.time ?? -1) - (b.time ?? -1));
  return lines;
}

/* ============================================================ *
 *  §9  PARSER RICHSYNC — lirik per-kata Musixmatch (JSON)
 *      [{ "ts": detikAwal, "te": detikAkhir,
 *         "x": [ { "c": teksKata, "o": offsetDetik }, ... ] }]
 *      Offset kata (o) relatif terhadap awal baris.
 * ============================================================ */

export function parseRichsync(richsync) {
  if (!Array.isArray(richsync)) return [];
  const lines = [];

  for (const seg of richsync) {
    if (typeof seg?.ts !== 'number') continue;
    const start = seg.ts;
    const end = typeof seg.te === 'number' ? seg.te : null;
    const rawWords = Array.isArray(seg.x) ? seg.x : [];

    const words = [];
    let textAll = '';
    for (const w of rawWords) {
      const wText = String(w?.c ?? '');
      if (!wText) continue;
      const wStart = start + (typeof w?.o === 'number' ? w.o : 0);
      textAll += wText;
      words.push({ text: wText.trim(), start: wStart, end: null });
    }

    // akhir kata = awal kata berikutnya; kata terakhir ditutup endTime baris
    for (let i = 0; i < words.length; i++) {
      if (words[i + 1]) words[i].end = words[i + 1].start;
      else words[i].end = end ?? words[i].start + 0.5;
    }

    const clean = words.filter((x) => x.text);
    lines.push({
      time: start,
      endTime: end,
      text: textAll.trim(),
      ...(clean.length ? { words: clean } : {}),
    });
  }

  lines.sort((a, b) => (a.time ?? -1) - (b.time ?? -1));
  return lines;
}

/* ============================================================ *
 *  §10  KONVERTER FORMAT — LRC / Enhanced LRC / plain / JSON
 * ============================================================ */

export function fmtTime(sec) {
  if (sec == null || Number.isNaN(sec)) return '00:00.00';
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const ss = Math.floor(rest);
  const cs = Math.round((rest - ss) * 100);
  const csAdj = cs === 100 ? 0 : cs;
  const ssAdj = cs === 100 ? ss + 1 : ss;
  return `${String(m).padStart(2, '0')}:${String(ssAdj).padStart(2, '0')}.${String(csAdj).padStart(2, '0')}`;
}

function lrcHeader(result) {
  const out = [];
  out.push(`[ti:${result.track?.title ?? ''}]`);
  out.push(`[ar:${result.track?.artist ?? ''}]`);
  if (result.track?.album) out.push(`[al:${result.track.album}]`);
  out.push('[by:lirik-sync]');
  return out;
}

/** LRC per baris: [mm:ss.xx]teks */
export function toLRC(result, { withHeader = true } = {}) {
  if (!result) return '';
  if (!result.synced) return toPlain(result);
  const out = withHeader ? lrcHeader(result) : [];
  for (const l of result.lines) {
    if (l.time == null) {
      if (l.text) out.push(l.text);
      continue;
    }
    out.push(`[${fmtTime(l.time)}]${l.text ?? ''}`);
  }
  return out.join('\n') + '\n';
}

/**
 * Enhanced LRC per-kata: [mm:ss.xx]<mm:ss.xx>kata1 <mm:ss.xx>kata2 ...
 * Bila sumber tidak punya timing kata, otomatis jatuh ke toLRC.
 */
export function toEnhancedLRC(result, { withHeader = true } = {}) {
  if (!result) return '';
  if (!result.synced) return toPlain(result);
  const hasWords = result.lines.some((l) => Array.isArray(l.words) && l.words.length);
  if (!hasWords) return toLRC(result, { withHeader });
  const out = withHeader ? lrcHeader(result) : [];
  for (const l of result.lines) {
    if (l.time == null) {
      if (l.text) out.push(l.text);
      continue;
    }
    if (!l.words?.length) {
      out.push(`[${fmtTime(l.time)}]${l.text ?? ''}`);
      continue;
    }
    const body = l.words.map((w) => `<${fmtTime(w.start)}>${w.text}`).join(' ');
    out.push(`[${fmtTime(l.time)}]${body}`);
  }
  return out.join('\n') + '\n';
}

/** Teks polos tanpa timestamp. */
export function toPlain(result) {
  if (!result) return '';
  if (result.plain && !result.lines.some((l) => l.time != null)) return result.plain;
  return result.lines.map((l) => l.text ?? '').join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** JSON normalisasi (raw dibuang kecuali diminta). */
export function toJSON(result, { raw = false } = {}) {
  if (!result) return null;
  const clone = { ...result };
  delete clone.sourceLabel;
  if (!raw) clone.raw = undefined;
  return clone;
}

/* ============================================================ *
 *  §11  BASE PROVIDER — kontrak untuk semua sumber
 * ============================================================ */

export class BaseProvider {
  /** @type {LirikSync} */
  constructor(client) {
    this.client = client;
    this.id = 'base';
    this.label = 'Base';
    this.homepage = '';
    this.caps = { word: false, synced: false, plain: false };
  }

  get http() {
    return this.client.http;
  }

  get cache() {
    return this.client.cache;
  }

  get options() {
    return this.client.options;
  }

  log(msg) {
    if (this.client.options.debug) console.error(`[lirik-sync:${this.id}] ${msg}`);
  }

  /**
   * @param {object} query {q?, track?, artist?, album?, duration?}
   * @returns {Promise<Array<{id:any, score:number, track:object, extra?:object}>>}
   */
  async search(query, _opts = {}) {
    return [];
  }

  /**
   * @param {object} cand kandidat dari search()
   * @returns {Promise<object|null>} hasil lirik normalisasi
   */
  async get(_cand, _opts = {}) {
    return null;
  }

  /** Alur lengkap: cari -> pilih terbaik -> ambil lirik. */
  async find(query, opts = {}) {
    const cands = await this.search(query, opts);
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    const maxTry = opts.maxCandidates ?? 3;
    for (const cand of cands.slice(0, maxTry)) {
      try {
        const result = await this.get(cand, opts);
        if (result) return result;
      } catch (err) {
        this.log(`get gagal untuk kandidat ${cand.id}: ${err.message}`);
      }
    }
    return null;
  }

  /** Susun kandidat dari metadata mentah + skor kemiripan. */
  makeCandidate(query, raw, extra = {}) {
    const cand = {
      id: raw.id,
      score: scoreCandidate(query, raw.track),
      track: raw.track,
      ...extra,
    };
    return cand;
  }
}

/**
 * Bangun hasil lirik normalisasi.
 * Waktu dalam detik (float). `lines[i] = {time, endTime, text, translation?, words?}`
 * `words` = daftar kata flatten (bila word-level tersedia).
 */
export function buildResult(provider, { id, sourceUrl = null, track, lines = [], plain = null, instrumental = false, language = null, raw = null }) {
  const hasWords = lines.some((l) => Array.isArray(l.words) && l.words.length);
  const words = hasWords
    ? lines.flatMap((l) => (l.words || []).map((w) => ({ ...w, line: l.text })))
    : null;
  return {
    source: provider.id,
    sourceLabel: provider.label,
    sourceUrl,
    id: id ?? null,
    track: {
      title: track?.title ?? null,
      artist: track?.artist ?? null,
      album: track?.album ?? null,
      duration: track?.duration ?? null,
      artwork: track?.artwork ?? null,
    },
    synced: lines.some((l) => l.time != null),
    wordLevel: !!hasWords,
    instrumental: !!instrumental,
    language,
    lines,
    words,
    plain: plain ?? null,
    raw,
  };
}

/* ============================================================ *
 *  §12  PROVIDER LRCLIB — database lirik tersinkronisasi terbuka
 *      - syncedLyrics: LRC per baris
 *      - lyricsfile : YAML dengan timing per kata (hasWordSync: true)
 *      - plainLyrics: teks polos
 *      Tanpa API key; WAJIB User-Agent yang mengidentifikasi aplikasi.
 * ============================================================ */

const LRCLIB_BASE = 'https://lrclib.net/api';

export class LrclibProvider extends BaseProvider {
  constructor(client) {
    super(client);
    this.id = 'lrclib';
    this.label = 'LRCLIB';
    this.homepage = 'https://lrclib.net';
    this.caps = { word: true, synced: true, plain: true };
  }

  ua() {
    return this.options.userAgent || 'LirikSync v1.0.0 (github.com/lirik-sync)';
  }

  async search(query, opts = {}) {
    const headers = { 'User-Agent': this.ua() };
    const cands = new Map();

    // 1) pencocokan presisi bila metadata lengkap (paling akurat)
    if (query.track && query.artist) {
      const url =
        `${LRCLIB_BASE}/get?track_name=${encodeURIComponent(query.track)}` +
        `&artist_name=${encodeURIComponent(query.artist)}` +
        (query.album ? `&album_name=${encodeURIComponent(query.album)}` : '') +
        (query.duration ? `&duration=${Math.round(query.duration)}` : '');
      try {
        const { data } = await this.http.getJson(url, { headers, timeoutMs: this.options.timeoutMs });
        if (data?.id) {
          cands.set(data.id, this.makeCandidate(query, {
            id: data.id,
            track: { title: data.trackName, artist: data.artistName, album: data.albumName, duration: data.duration },
          }));
        }
      } catch (err) {
        this.log(`get presisi gagal: ${err.message}`);
      }
    }

    // 2) pencarian bebas / terstruktur
    const url2 = query.track
      ? `${LRCLIB_BASE}/search?track_name=${encodeURIComponent(query.track)}` +
        (query.artist ? `&artist_name=${encodeURIComponent(query.artist)}` : '')
      : `${LRCLIB_BASE}/search?q=${encodeURIComponent(query.q || '')}`;
    try {
      const { data } = await this.http.getJson(url2, { headers, timeoutMs: this.options.timeoutMs });
      if (Array.isArray(data)) {
        for (const r of data.slice(0, 12)) {
          if (!r?.id || cands.has(r.id)) continue;
          cands.set(r.id, this.makeCandidate(query, {
            id: r.id,
            track: { title: r.trackName, artist: r.artistName, album: r.albumName, duration: r.duration },
          }));
        }
      }
    } catch (err) {
      this.log(`search gagal: ${err.message}`);
    }

    return [...cands.values()].filter((c) => c.score >= 0.25).sort((a, b) => b.score - a.score);
  }

  async get(cand, opts = {}) {
    const headers = { 'User-Agent': this.ua() };
    const { data } = await this.http.getJson(`${LRCLIB_BASE}/get/${cand.id}`, {
      headers,
      timeoutMs: this.options.timeoutMs,
    });
    if (!data?.id) return null;

    const track = {
      title: data.trackName,
      artist: data.artistName,
      album: data.albumName,
      duration: data.duration,
      artwork: null,
    };
    const sourceUrl = `${this.homepage}/track/${data.id}`;

    if (data.instrumental) {
      return buildResult(this, { id: data.id, sourceUrl, track, lines: [], instrumental: true });
    }

    // 1) word-level via lyricsfile (YAML)
    if (data.hasWordSync && data.lyricsfile) {
      const parsed = parseLrcFile(data.lyricsfile);
      if (parsed?.lines?.length) {
        return buildResult(this, {
          id: data.id,
          sourceUrl,
          track,
          lines: parsed.lines,
          language: parsed.metadata?.language || null,
          raw: data.lyricsfile,
        });
      }
    }

    // 2) LRC per baris
    if (data.syncedLyrics) {
      const parsed = parseLrc(data.syncedLyrics);
      return buildResult(this, {
        id: data.id,
        sourceUrl,
        track,
        lines: parsed.lines,
        raw: data.syncedLyrics,
      });
    }

    // 3) teks polos
    if (data.plainLyrics) {
      const lines = data.plainLyrics
        .split(/\r?\n/)
        .filter((x) => x.trim())
        .map((t) => ({ time: null, endTime: null, text: t }));
      return buildResult(this, { id: data.id, sourceUrl, track, lines, plain: data.plainLyrics });
    }

    return null;
  }
}

/* ============================================================ *
 *  §13  PROVIDER MUSIXMATCH — API desktop (tidak resmi, graceful)
 *      - richsync : lirik per-kata (f_sync_type=json)
 *      - subtitle : LRC per baris
 *      Token diambil dari token.get; bisa dibatasi sewaktu-waktu
 *      (401/404) -> provider tetap graceful: gagal -> null.
 * ============================================================ */

const MXM_BASE = 'https://apic-desktop.musixmatch.com/ws/1.1';
const MXM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

export class MusixmatchProvider extends BaseProvider {
  constructor(client) {
    super(client);
    this.id = 'musixmatch';
    this.label = 'Musixmatch';
    this.homepage = 'https://www.musixmatch.com';
    this.caps = { word: true, synced: true, plain: false };
  }

  appId() {
    return this.options.musixmatch?.appId || 'web-desktop-app-v1.0';
  }

  async token() {
    const cached = this.cache.get('musixmatch:token');
    if (cached) return cached;
    const { data } = await this.http.getJson(
      `${MXM_BASE}/token.get?app_id=${encodeURIComponent(this.appId())}&format=json`,
      { headers: { 'User-Agent': MXM_UA }, timeoutMs: this.options.timeoutMs }
    );
    const tk = data?.message?.body?.user_token;
    if (!tk) throw new Error('token musixmatch tidak tersedia');
    this.cache.set('musixmatch:token', tk, 30 * 60 * 1000);
    return tk;
  }

  async call(path, params, tk) {
    const url = new URL(`${MXM_BASE}/${path}`);
    url.searchParams.set('app_id', this.appId());
    url.searchParams.set('format', 'json');
    url.searchParams.set('user_token', tk);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const { data } = await this.http.getJson(url.toString(), {
      headers: { 'User-Agent': MXM_UA },
      timeoutMs: this.options.timeoutMs,
    });
    return data;
  }

  async search(query, opts = {}) {
    const tk = await this.token();
    const params = {
      page: 1,
      page_size: 8,
      s_track_rating: 'desc',
      commontracks: 'true',
    };
    if (query.track) {
      params.q_track = query.track;
      if (query.artist) params.q_artist = query.artist;
    } else {
      params.q = query.q || '';
    }
    const data = await this.call('track.search', params, tk);
    const list = data?.message?.body?.track_list || [];
    return list
      .map((item) => {
        const t = item.track || {};
        return this.makeCandidate(query, {
          id: t.track_id,
          track: {
            title: t.track_name,
            artist: t.artist_name,
            album: t.album_name,
            duration: t.track_length ? t.track_length / 1000 : null,
            artwork: t.album_coverart_100x100 || null,
          },
        });
      })
      .filter((c) => c.score >= 0.25)
      .sort((a, b) => b.score - a.score);
  }

  async get(cand, opts = {}, refreshed = false) {
    const tk = await this.token();
    const track = cand.track;
    const sourceUrl = `${this.homepage}/lyrics/${encodeURIComponent(track.artist || '')}/${encodeURIComponent(track.title || '')}`;

    // 1) richsync (per-kata)
    try {
      const data = await this.call('track.richsync.get', {
        track_id: cand.id,
        f_sync_type: 'json',
        commontracks: 'true',
      }, tk);
      const rs = data?.message?.body?.richsync;
      if (data?.message?.header?.status_code === 401 && !refreshed) {
        this.cache.delete('musixmatch:token');
        return this.get(cand, opts, true);
      }
      if (rs && Array.isArray(rs) && rs.length) {
        const lines = parseRichsync(rs);
        if (lines.length) {
          return buildResult(this, { id: cand.id, sourceUrl, track, lines, raw: JSON.stringify(rs) });
        }
      }
    } catch (err) {
      this.log(`richsync gagal: ${err.message}`);
    }

    // 2) subtitle (LRC)
    try {
      const data = await this.call('track.subtitle.get', {
        track_id: cand.id,
        subtitle_format: 'lrc',
        commontracks: 'true',
      }, tk);
      const sub = data?.message?.body?.subtitle?.subtitles;
      if (sub) {
        const lines = parseLrc(sub).lines;
        if (lines.length) {
          return buildResult(this, { id: cand.id, sourceUrl, track, lines, raw: sub });
        }
      }
    } catch (err) {
      this.log(`subtitle gagal: ${err.message}`);
    }

    return null;
  }
}

/* ============================================================ *
 *  §14  PROVIDER NETEASE CLOUD MUSIC — protokol EAPI
 *      - yrc   : lirik per-kata (karaoke) bila tersedia
 *      - lrc   : LRC per baris
 *      - tlyric: terjemahan (digabung ke tiap baris)
 *      EAPI: AES-128-ECB kunci "e82ckenh8dichen8",
 *      sign = md5("nobody"+path+"use"+params+"md5forencrypt"),
 *      payload = path + "-36cd479b6b5-" + params + "-36cd479b6b5-" + sign.
 * ============================================================ */

const EAPI_HOST = 'https://interface.music.163.com';
const EAPI_KEY = Buffer.from('e82ckenh8dichen8');

function eapiEncrypt(path, params) {
  const text = JSON.stringify(params);
  const sign = crypto
    .createHash('md5')
    .update('nobody' + path + 'use' + text + 'md5forencrypt')
    .digest('hex');
  const msg = `${path}-36cd479b6b5-${text}-36cd479b6b5-${sign}`;
  const cipher = crypto.createCipheriv('aes-128-ecb', EAPI_KEY, null);
  return Buffer.concat([cipher.update(Buffer.from(msg)), cipher.final()]).toString('hex').toUpperCase();
}

function eapiDecrypt(buf) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', EAPI_KEY, null);
  return Buffer.concat([decipher.update(buf), decipher.final()]).toString('utf8');
}

const DEVICE_HEADER = {
  os: 'pc',
  appver: '2.9.7',
  osver: 'Microsoft Windows 10 Pro',
  ct: '20',
  clienttype: '0',
  channel: '0',
};

export class NeteaseProvider extends BaseProvider {
  constructor(client) {
    super(client);
    this.id = 'netease';
    this.label = 'Netease Cloud Music';
    this.homepage = 'https://music.163.com';
    this.caps = { word: true, synced: true, plain: false };
  }

  async eapi(path, params) {
    const payload = { ...params, header: { ...DEVICE_HEADER } };
    const hex = eapiEncrypt(path, payload);
    const body = new URLSearchParams({ params: hex }).toString();
    const res = await fetch(`${EAPI_HOST}/eapi${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: 'https://music.163.com/',
        Cookie: 'os=pc; appver=2.9.7',
      },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const raw = buf.toString('utf8');
    try {
      return JSON.parse(raw);
    } catch {
      try {
        return JSON.parse(eapiDecrypt(buf));
      } catch {
        return null;
      }
    }
  }

  async search(query, opts = {}) {
    const kw = query.q || [query.track, query.artist].filter(Boolean).join(' ');
    if (!kw) return [];
    const s = await this.eapi('/api/cloudsearch/pc', {
      offset: 0,
      limit: 8,
      hlposttag: '</span>',
      hlpretag: "<span class='s-fc7'>",
      total: true,
      type: 1,
      s: kw,
    });
    const songs = s?.result?.songs || [];
    return songs
      .map((song) =>
        this.makeCandidate(query, {
          id: song.id,
          track: {
            title: song.name,
            artist: (song.ar || song.artists || []).map((a) => a.name).join('/'),
            album: song.al?.name || song.album?.name || null,
            duration: (song.dt || song.duration || 0) / 1000,
          },
        })
      )
      .filter((c) => c.score >= 0.25)
      .sort((a, b) => b.score - a.score);
  }

  async get(cand, opts = {}) {
    const l = await this.eapi('/api/song/lyric/v1', {
      id: cand.id,
      _nmclfl: 1,
      weberver: '1.0.0',
      lv: -1,
      tv: -1,
      rv: -1,
      kv: -1,
      yv: -1,
      fv: -1,
      ztv: -1,
      zrv: -1,
    });
    if (!l || l.code !== 200) return null;

    const track = cand.track;
    const sourceUrl = `${this.homepage}/#/song?id=${cand.id}`;
    const translation = l.tlyric?.lyric || null;

    // 1) per-kata (yrc)
    if (l.yrc?.lyric) {
      const lines = attachTranslation(parseYrc(l.yrc.lyric), translation);
      if (lines.length) {
        return buildResult(this, {
          id: cand.id,
          sourceUrl,
          track,
          lines,
          raw: l.yrc.lyric,
        });
      }
    }

    // 2) LRC per baris
    if (l.lrc?.lyric) {
      const lines = attachTranslation(parseLrc(l.lrc.lyric).lines, translation);
      if (lines.length) {
        return buildResult(this, { id: cand.id, sourceUrl, track, lines, raw: l.lrc.lyric });
      }
    }

    return null;
  }
}

/* ============================================================ *
 *  §15  PROVIDER QQ MUSIC — musicu.fcg + endpoint klasik
 *      - qrc  : lirik per-kata terenkripsi (3DES + zlib),
 *               ketersediaan tergantung lagu/wilayah
 *      - lyric: LRC per baris (base64)
 *      - trans: terjemahan LRC (base64)
 * ============================================================ */

const QQ_FCG = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QQ_LRC_FCG = 'https://i.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
const QQ_HEADERS = { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' };

export class QQMusicProvider extends BaseProvider {
  constructor(client) {
    super(client);
    this.id = 'qq';
    this.label = 'QQ Music';
    this.homepage = 'https://y.qq.com';
    this.caps = { word: true, synced: true, plain: false };
  }

  async musicu(payload) {
    const { data } = await this.http.getJson(QQ_FCG, {
      method: 'POST',
      headers: QQ_HEADERS,
      body: JSON.stringify(payload),
      timeoutMs: this.options.timeoutMs,
    });
    return data;
  }

  async search(query, opts = {}) {
    const kw = query.q || [query.track, query.artist].filter(Boolean).join(' ');
    if (!kw) return [];

    // 1) endpoint klasik client_search_cp (lebih stabil)
    try {
      const { data } = await this.http.getJson(
        `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(kw)}&format=json&cr=1`,
        { headers: QQ_HEADERS, timeoutMs: this.options.timeoutMs }
      );
      const list = data?.data?.song?.list || [];
      if (list.length) {
        return list
          .map((song) =>
            this.makeCandidate(query, {
              id: song.songmid,
              track: {
                title: song.songname,
                artist: (song.singer || []).map((s) => s.name).join('/'),
                album: song.albumname || null,
                duration: song.interval || null,
              },
            })
          )
          .filter((c) => c.score >= 0.25)
          .sort((a, b) => b.score - a.score);
      }
    } catch (err) {
      this.log(`client_search_cp gagal: ${err.message}`);
    }

    // 2) fallback: musicu.fcg DoSearchForQQMusicDesktop (kadang anti-bot membatasi)
    const res = await this.musicu({
      req: {
        method: 'DoSearchForQQMusicDesktop',
        module: 'music.search.SearchCgiService',
        param: { search_type: 0, query: kw, page_num: 1, num_per_page: 8 },
      },
    });
    const songs = res?.req?.data?.body?.song?.list || [];
    return songs
      .map((song) =>
        this.makeCandidate(query, {
          id: song.mid,
          track: {
            title: song.name,
            artist: (song.singer || []).map((s) => s.name).join('/'),
            album: song.album?.name || null,
            duration: song.interval || null,
          },
        })
      )
      .filter((c) => c.score >= 0.25)
      .sort((a, b) => b.score - a.score);
  }

  async get(cand, opts = {}) {
    const track = cand.track;
    const sourceUrl = `${this.homepage}/n/ryqq/songDetail/${cand.id}`;

    // 1) QRC per-kata via musicu.fcg (ketersediaan tergantung lagu/wilayah)
    let translationLrc = null;
    try {
      const res = await this.musicu({
        'music.musichallSong.PlayLyricInfo.GetPlayLyricInfo': {
          method: 'GetPlayLyricInfo',
          module: 'music.musichallSong.PlayLyricInfo',
          param: { songMID: String(cand.id), songID: 0, trans: 1, qrc: 1, ct: 20, cv: 1932 },
        },
      });
      const data = Object.values(res || {}).find((v) => v && typeof v === 'object' && 'data' in v)?.data;
      if (data?.qrc && typeof data.qrc === 'string' && data.qrc.length > 100) {
        const text = decryptQrc(data.qrc);
        if (text) {
          const lines = parseQrc(text);
          if (lines.length) {
            return buildResult(this, { id: cand.id, sourceUrl, track, lines, raw: text });
          }
        }
      }
    } catch (err) {
      this.log(`qrc gagal: ${err.message}`);
    }

    // 2) LRC per baris via endpoint klasik (base64 LRC + terjemahan)
    const { data: fcg } = await this.http.getJson(
      `${QQ_LRC_FCG}?songmid=${encodeURIComponent(String(cand.id))}&g_tk=5381&format=json`,
      { headers: QQ_HEADERS, timeoutMs: this.options.timeoutMs }
    );
    if (!fcg || (fcg.retcode !== 0 && fcg.code !== 0)) return null;

    if (fcg.lyric) {
      const lrcText = Buffer.from(fcg.lyric, 'base64').toString('utf8');
      translationLrc = fcg.trans ? Buffer.from(fcg.trans, 'base64').toString('utf8') : null;
      const parsed = attachTranslation(parseLrc(lrcText).lines, translationLrc);
      if (!parsed.length) return null;
      return buildResult(this, { id: cand.id, sourceUrl, track, lines: parsed, raw: lrcText });
    }

    return null;
  }
}

/* ============================================================ *
 *  §16  PROVIDER KUGOU MUSIC — lyrics.kugou.com
 *      - KRC: lirik per-kata terenkripsi (base64 -> XOR -> zlib)
 *      - LRC: fallback per baris
 * ============================================================ */

const KUGOU_SEARCH_HTTP = 'http://mobilecdn.kugou.com/api/v3/search/song';
const KUGOU_SEARCH_HTTPS = 'https://mobilecdn.kugou.com/api/v3/search/song';
const KUGOU_LYRIC_API = 'https://lyrics.kugou.com';

export class KugouProvider extends BaseProvider {
  constructor(client) {
    super(client);
    this.id = 'kugou';
    this.label = 'Kugou Music';
    this.homepage = 'https://www.kugou.com';
    this.caps = { word: true, synced: true, plain: false };
  }

  async search(query, opts = {}) {
    const kw = query.q || [query.track, query.artist].filter(Boolean).join(' ');
    if (!kw) return [];
    // API search Kugou hanya stabil lewat HTTP; HTTPS kadang gagal di jaringan tertentu
    let data = null;
    for (const base of [KUGOU_SEARCH_HTTP, KUGOU_SEARCH_HTTPS]) {
      try {
        const res = await this.http.getJson(
          `${base}?format=json&keyword=${encodeURIComponent(kw)}&page=1&pagesize=8`,
          { timeoutMs: this.options.timeoutMs }
        );
        if (res.data?.data?.info?.length) {
          data = res.data;
          break;
        }
      } catch (err) {
        this.log(`search via ${new URL(base).protocol} gagal: ${err.message}`);
      }
    }
    const info = data?.data?.info || [];
    return info
      .map((song) =>
        this.makeCandidate(query, {
          id: song.hash,
          track: {
            title: song.songname,
            artist: song.singername,
            album: song.album_name || null,
            duration: song.duration || null,
          },
        })
      )
      .filter((c) => c.score >= 0.25)
      .sort((a, b) => b.score - a.score);
  }

  async get(cand, opts = {}) {
    const track = cand.track;
    const dur = Math.round(track.duration || 0);

    // 1) cari kandidat KRC/LRC di lyrics.kugou.com
    const { data: candRes } = await this.http.getJson(
      `${KUGOU_LYRIC_API}/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(track.title || '')}` +
        `&duration=${dur}&hash=${cand.id}&timelength=${dur * 1000}`,
      { timeoutMs: this.options.timeoutMs }
    );
    const candidates = candRes?.candidates || candRes?.data?.candidates || [];
    if (!candidates.length) return null;

    for (const c of candidates.slice(0, 3)) {
      // 2) coba KRC (per-kata)
      try {
        const { data: dl } = await this.http.getJson(
          `${KUGOU_LYRIC_API}/download?ver=1&client=pc&id=${c.id}&accesskey=${c.accesskey}&fmt=krc&charset=utf8`,
          { timeoutMs: this.options.timeoutMs }
        );
        if (dl?.status === 200 && dl?.content) {
          const text = decodeKrc(dl.content);
          const lines = parseKrc(text);
          if (lines.length) {
            return buildResult(this, { id: cand.id, sourceUrl: this.homepage, track, lines, raw: text });
          }
        }
      } catch (err) {
        this.log(`krc gagal: ${err.message}`);
      }

      // 3) fallback LRC
      try {
        const { data: dl2 } = await this.http.getJson(
          `${KUGOU_LYRIC_API}/download?ver=1&client=pc&id=${c.id}&accesskey=${c.accesskey}&fmt=lrc&charset=utf8`,
          { timeoutMs: this.options.timeoutMs }
        );
        if (dl2?.status === 200 && dl2?.content) {
          const lrcText = Buffer.from(dl2.content, 'base64').toString('utf8');
          const lines = parseLrc(lrcText).lines;
          if (lines.length) {
            return buildResult(this, { id: cand.id, sourceUrl: this.homepage, track, lines, raw: lrcText });
          }
        }
      } catch (err) {
        this.log(`lrc gagal: ${err.message}`);
      }
    }

    return null;
  }
}

/* ============================================================ *
 *  §17  PROVIDER GENIUS — teks polos hasil komunitas (tanpa timestamp)
 *      Pencarian via /api/search/multi (JSON tanpa key), lirik di-scrape
 *      dari halaman lagu. Genius memakai proteksi bot -> dari jaringan
 *      tertentu bisa 403; provider tetap graceful (null).
 * ============================================================ */

const GENIUS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const GENIUS_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&hellip;': '…',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|#39|#x27|apos|nbsp|hellip);/g, (m) => GENIUS_ENTITIES[m] ?? m);
}

/** Ambil isi div seimbang (menghitung <div ...> / </div>) dari `startIdx`. */
function extractBalancedDiv(html, startIdx) {
  const re = /<\/?div\b[^>]*>/g;
  re.lastIndex = startIdx;
  let depth = 0;
  let end = html.length;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[0].startsWith('</')) {
      depth--;
      if (depth === 0) {
        end = m.index;
        break;
      }
    } else if (!m[0].endsWith('/>')) {
      depth++;
    }
  }
  return html.slice(startIdx, end);
}

function extractLyrics(html) {
  const marker = 'data-lyrics-container="true"';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const tagStart = html.lastIndexOf('<div', idx);
  const inner = extractBalancedDiv(html, tagStart);
  return inner
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => decodeEntities(l).trimEnd())
    .join('\n')
    .trim();
}

export class GeniusProvider extends BaseProvider {
  constructor(client) {
    super(client);
    this.id = 'genius';
    this.label = 'Genius';
    this.homepage = 'https://genius.com';
    this.caps = { word: false, synced: false, plain: true };
  }

  headers() {
    return {
      'User-Agent': GENIUS_UA,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://genius.com/',
    };
  }

  async search(query, opts = {}) {
    const kw = query.q || [query.track, query.artist].filter(Boolean).join(' ');
    if (!kw) return [];
    const { data } = await this.http.getJson(
      `${this.homepage}/api/search/multi?sykon_artist_id=0&q=${encodeURIComponent(kw)}`,
      { headers: this.headers(), timeoutMs: this.options.timeoutMs }
    );
    const hits = (data?.response?.sections || []).flatMap((s) => s.hits || []);
    return hits
      .filter((h) => h.type === 'song' && h.result)
      .slice(0, 8)
      .map((h) =>
        this.makeCandidate(query, {
          id: `${h.result.id}|${h.result.path}`,
          track: {
            title: h.result.title,
            artist: h.result.primary_artist?.name || null,
            album: null,
            duration: null,
            artwork: h.result.song_art_image_thumbnail_url || null,
          },
        })
      )
      .filter((c) => c.score >= 0.25)
      .sort((a, b) => b.score - a.score);
  }

  async get(cand, opts = {}) {
    const [gid, path] = String(cand.id).split('|');
    if (!path) return null;
    const { status, data } = await this.http.getText(`${this.homepage}${path}`, {
      headers: { ...this.headers(), Accept: 'text/html' },
      timeoutMs: Math.max(this.options.timeoutMs, 15000),
    });
    if (status !== 200 || typeof data !== 'string') return null;
    const lyrics = extractLyrics(data);
    if (!lyrics) return null;

    const lines = lyrics.split('\n').map((t) => ({ time: null, endTime: null, text: t }));
    return buildResult(this, { id: gid, sourceUrl: `${this.homepage}${path}`, track: cand.track, lines, plain: lyrics });
  }
}

/* ============================================================ *
 *  §18  PROVIDER LYRICS.OVH — API teks polos gratis, tanpa key
 *      Hanya mendukung pencarian pasangan (artis, judul) yang eksak.
 * ============================================================ */

export class LyricsOvhProvider extends BaseProvider {
  constructor(client) {
    super(client);
    this.id = 'lyricsovh';
    this.label = 'lyrics.ovh';
    this.homepage = 'https://lyrics.ovh';
    this.caps = { word: false, synced: false, plain: true };
  }

  async search(query, opts = {}) {
    if (!query.track || !query.artist) return [];
    return [
      {
        id: `${query.artist}/${query.track}`,
        score: 0.6,
        track: { title: query.track, artist: query.artist, album: query.album ?? null, duration: query.duration ?? null },
      },
    ];
  }

  async get(cand, opts = {}) {
    const [artist, title] = String(cand.id).split('/');
    if (!artist || !title) return null;
    const { data } = await this.http.getJson(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
      { timeoutMs: Math.max(this.options.timeoutMs, 15000), retries: 0 }
    );
    const lyrics = typeof data?.lyrics === 'string' ? data.lyrics.trim() : null;
    if (!lyrics || /(^|\n)\s*\(?\s*instrumental/i.test(lyrics)) return null;

    const lines = lyrics.split(/\r?\n/).map((t) => ({ time: null, endTime: null, text: t }));
    return buildResult(this, {
      id: cand.id,
      sourceUrl: `https://lyrics.ovh/${artist}/${title}`,
      track: cand.track,
      lines,
      plain: lyrics,
    });
  }
}

/* ============================================================ *
 *  §19  AGGREGATOR LIRIKSYNC — gabung semua sumber + strategi
 *      putaran 1: hanya sumber per-kata -> pulang bila ketemu per-kata
 *      putaran 2: sisa sumber -> pakai fallback terbaik
 * ============================================================ */

export const SOURCES = {
  musixmatch: {
    id: 'musixmatch',
    label: 'Musixmatch',
    homepage: 'https://www.musixmatch.com',
    caps: { word: 'richsync', synced: 'subtitle', plain: false },
  },
  qq: {
    id: 'qq',
    label: 'QQ Music',
    homepage: 'https://y.qq.com',
    caps: { word: 'qrc (tergantung lagu)', synced: 'lrc', plain: false },
  },
  kugou: {
    id: 'kugou',
    label: 'Kugou Music',
    homepage: 'https://www.kugou.com',
    caps: { word: 'krc', synced: 'lrc', plain: false },
  },
  netease: {
    id: 'netease',
    label: 'Netease Cloud Music',
    homepage: 'https://music.163.com',
    caps: { word: 'yrc (tergantung lagu)', synced: 'lrc', plain: false },
  },
  lrclib: {
    id: 'lrclib',
    label: 'LRCLIB',
    homepage: 'https://lrclib.net',
    caps: { word: 'lyricsfile (hasWordSync)', synced: 'lrc', plain: 'plainLyrics' },
  },
  genius: {
    id: 'genius',
    label: 'Genius',
    homepage: 'https://genius.com',
    caps: { word: false, synced: false, plain: 'scrape halaman' },
  },
  lyricsovh: {
    id: 'lyricsovh',
    label: 'lyrics.ovh',
    homepage: 'https://lyrics.ovh',
    caps: { word: false, synced: false, plain: 'api' },
  },
};

/** Urutan default: sumber per-kata dulu, lalu LRC, terakhir teks polos. */
const DEFAULT_ORDER = ['musixmatch', 'qq', 'kugou', 'netease', 'lrclib', 'genius', 'lyricsovh'];
const PLAIN_ONLY_ORDER = ['lrclib', 'genius', 'lyricsovh'];

const COOLDOWN_MS = 5 * 60 * 1000;

export class LirikSync {
  /**
   * @param {object} [options]
   * @param {string[]} [options.sources] urutan id sumber; default perkata dulu
   * @param {boolean}  [options.wordLevelFirst=true] prioritaskan sumber per-kata
   * @param {number}   [options.timeoutMs=12000] timeout HTTP per permintaan
   * @param {number}   [options.cacheTtlMs=21600000] TTL cache (default 6 jam)
   * @param {boolean}  [options.debug=false] log percobaan ke stderr
   * @param {string}   [options.userAgent] User-Agent untuk LRCLIB (wajib identitas jelas)
   * @param {{appId?: string}} [options.musixmatch] konfigurasi Musixmatch
   */
  constructor(options = {}) {
    this.options = {
      wordLevelFirst: true,
      timeoutMs: 12000,
      cacheTtlMs: 6 * 60 * 60 * 1000,
      debug: false,
      ...options,
    };
    this.http = http;
    this.cache = new Cache(this.options.cacheTtlMs);
    this._cooldown = new Map(); // id -> ts kegagalan

    const registry = {
      lrclib: LrclibProvider,
      musixmatch: MusixmatchProvider,
      netease: NeteaseProvider,
      qq: QQMusicProvider,
      kugou: KugouProvider,
      genius: GeniusProvider,
      lyricsovh: LyricsOvhProvider,
    };
    this._registry = registry;
    this.providers = new Map();
    const order = this.options.sources || (this.options.wordLevelFirst ? DEFAULT_ORDER : PLAIN_ONLY_ORDER);
    for (const id of order) {
      const Cls = registry[id];
      if (Cls) this.providers.set(id, new Cls(this));
    }
  }

  /** Daftarkan provider kustom (harus extends BaseProvider). */
  use(provider) {
    if (!(provider instanceof BaseProvider)) throw new TypeError('provider harus extends BaseProvider');
    this.providers.set(provider.id, provider);
    return this;
  }

  provider(id) {
    return this.providers.get(id);
  }

  listSources() {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      label: p.label,
      homepage: p.homepage,
      caps: p.caps,
    }));
  }

  /**
   * Cari lirik terbaik dari sumber-sumber aktif.
   * Bila wordLevelFirst aktif: putaran pertama hanya sumber ber-kemampuan per-kata
   * (langsung pulang bila hasilnya per-kata); putaran kedua menyusuri sisa sumber.
   * Kalau tidak ada yang per-kata, hasil dari sumber prioritas tertinggi yang dipakai.
   * @param {object} query {q?} atau {track, artist?, album?, duration?}
   * @param {object} [opts] {source?: string} untuk paksa satu sumber
   * @returns {Promise<{result: object|null, attempts: Array<{source:string, ok:boolean, note?:string}>}>}
   */
  async find(query, opts = {}) {
    const attempts = [];
    const ids = opts.source ? [opts.source] : [...this.providers.keys()];
    const fallbacks = [];
    const tried = new Set();
    const wordFirst = this.options.wordLevelFirst && !opts.source;
    const passes = wordFirst ? ['word', 'rest'] : ['all'];

    const tryProvider = async (id) => {
      const provider = this.providers.get(id);
      if (!provider) {
        attempts.push({ source: id, ok: false, note: 'sumber tidak dikenal' });
        return;
      }
      const cd = this._cooldown.get(id);
      if (cd && Date.now() - cd < COOLDOWN_MS && !opts.source) {
        attempts.push({ source: id, ok: false, note: 'cooldown (gagal baru-baru ini)' });
        return;
      }
      try {
        const result = await provider.find(query, opts);
        if (result) {
          this._cooldown.delete(id);
          if (result.wordLevel) {
            attempts.push({ source: id, ok: true, note: 'per-kata' });
            return { result };
          }
          attempts.push({ source: id, ok: true, note: 'cadangan (bukan per-kata)' });
          fallbacks.push(result);
          return;
        }
        attempts.push({ source: id, ok: false, note: 'tidak ketemu' });
      } catch (err) {
        this._cooldown.set(id, Date.now());
        attempts.push({ source: id, ok: false, note: err.message });
        if (this.options.debug) console.error(`[lirik-sync] ${id}: ${err.message}`);
      }
      return;
    };

    for (const pass of passes) {
      for (const id of ids) {
        if (tried.has(id)) continue;
        if (pass === 'word' && !this.providers.get(id)?.caps?.word) continue;
        tried.add(id);
        const out = await tryProvider(id);
        if (out?.result) return { result: out.result, attempts };
      }
    }

    return { result: fallbacks[0] ?? null, attempts };
  }

  /**
   * Panggil semua sumber secara paralel.
   * @returns {Promise<{results: Record<string, object|null>, errors: Record<string, string>}>}
   */
  async searchAll(query, opts = {}) {
    const results = {};
    const errors = {};
    await Promise.allSettled(
      [...this.providers.entries()].map(async ([id, provider]) => {
        try {
          results[id] = await provider.find(query, opts);
        } catch (err) {
          results[id] = null;
          errors[id] = err.message;
        }
      })
    );
    return { results, errors };
  }

  /** Ambil lirik langsung dari satu sumber berdasarkan id track provider. */
  async get(source, id, extra = {}) {
    const provider = this.providers.get(source);
    if (!provider) throw new Error(`sumber tidak dikenal: ${source}`);
    return provider.get({ id, track: extra.track ?? {}, score: 1 }, extra);
  }

  // ---- konverter format (juga dipakai via instance) ----
  toLRC(result, opts) {
    return toLRC(result, opts);
  }
  toEnhancedLRC(result, opts) {
    return toEnhancedLRC(result, opts);
  }
  toPlain(result) {
    return toPlain(result);
  }
  toJSON(result, opts) {
    return toJSON(result, opts);
  }
}

export function createLirikSync(options) {
  return new LirikSync(options);
}

/* ============================================================ *
 *  §20  CLI — aktif bila file ini dijalankan langsung
 *      node lirik.js "artis - judul" [opsi]
 * ============================================================ */

const CLI_HELP = `
lirik — pencari lirik multi-sumber (LRCLIB, Musixmatch, QQ, Kugou, Netease, Genius, lyrics.ovh)

Pemakaian:
  node lirik.js "artis - judul" [opsi]
  node lirik.js --track JUDUL --artist ARTIS [opsi]

Opsi:
  -a, --artist NAME      nama artis
  -t, --track TITLE      judul lagu
  -A, --album ALBUM      nama album (opsional, menaikkan akurasi)
  -d, --duration DETIK   durasi lagu dalam detik (opsional)
  -s, --source ID        paksa satu sumber: lrclib|musixmatch|qq|kugou|netease|genius|lyricsovh
      --all              tarik dari SEMUA sumber paralel lalu tampilkan ringkasannya
  -j, --json             keluaran JSON normalisasi
  -e, --enhanced         Enhanced LRC per-kata (bila tersedia)
  -p, --plain            teks polos tanpa timestamp
  -l, --lrc              LRC per baris (default)
  -o, --save FILE        simpan keluaran ke file
      --no-word          tidak memprioritaskan sumber per-kata
      --raw              sertakan data mentah di JSON / tampilkan raw LRC-QRC dsb
      --debug            log proses ke stderr
      --timeout MS       timeout HTTP per permintaan (default 12000)
      --sources          daftar sumber yang didukung
  -h, --help             tampilkan bantuan
`.trim();

function cliParseArgs(argv) {
  const args = { _: [] };
  // peta flag -> nama kanonik (shorthand dan panjang menunjuk kunci yang sama)
  const valueFlags = {
    '-a': 'artist', '--artist': 'artist',
    '-t': 'track', '--track': 'track',
    '-A': 'album', '--album': 'album',
    '-d': 'duration', '--duration': 'duration',
    '-s': 'source', '--source': 'source',
    '-o': 'save', '--save': 'save',
    '--timeout': 'timeout',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags[a]) {
      args[valueFlags[a]] = argv[++i];
      continue;
    }
    switch (a) {
      case '--all': args.all = true; break;
      case '-j': case '--json': args.json = true; break;
      case '-e': case '--enhanced': args.enhanced = true; break;
      case '-p': case '--plain': args.plain = true; break;
      case '-l': case '--lrc': args.lrc = true; break;
      case '--no-word': args.noWord = true; break;
      case '--raw': args.raw = true; break;
      case '--debug': args.debug = true; break;
      case '--sources': args.sources = true; break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (a.startsWith('-')) { console.error(`opsi tidak dikenal: ${a}`); process.exit(2); }
        args._.push(a);
    }
  }
  return args;
}

function cliBuildQuery(args) {
  const query = {};
  if (args.artist) query.artist = args.artist;
  if (args.track) query.track = args.track;
  if (args.album) query.album = args.album;
  if (args.duration) query.duration = Number(args.duration) || undefined;
  if (!query.track && args._.length) {
    const joined = args._.join(' ');
    // konvensi "artis - judul"
    const m = joined.match(/^(.+?)\s+-\s+(.+)$/);
    if (m) {
      query.artist = query.artist || m[1].trim();
      query.track = query.track || m[2].trim();
    } else {
      query.q = joined;
    }
  }
  if (!query.track && !query.q && query.artist) query.q = query.artist;
  return query;
}

async function cliMain() {
  const args = cliParseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(CLI_HELP);
    return;
  }

  const lirik = new LirikSync({
    wordLevelFirst: !args.noWord,
    debug: !!args.debug,
    timeoutMs: Number(args.timeout) || 12000,
  });

  if (args.sources) {
    console.log('Sumber yang didukung:\n');
    for (const s of lirik.listSources()) {
      const meta = SOURCES[s.id];
      const caps = meta?.caps ?? s.caps;
      console.log(`  ${s.id.padEnd(12)} ${s.label.padEnd(22)} ${s.homepage}`);
      console.log(`${' '.repeat(15)}per-kata: ${caps.word || '-'} | lrc: ${caps.synced || '-'} | plain: ${caps.plain || '-'}`);
    }
    return;
  }

  const query = cliBuildQuery(args);
  if (!query.track && !query.q) {
    console.error('Kueri kosong. Contoh: node lirik.js "pamungkas - to the bone"');
    process.exit(2);
  }

  if (args.all) {
    const { results, errors } = await lirik.searchAll(query);
    console.log('== Ringkasan semua sumber ==\n');
    // tampilkan sesuai urutan prioritas sumber, bukan urutan selesai
    for (const id of lirik.providers.keys()) {
      const res = results[id];
      const err = errors[id];
      const info = res
        ? `synced=${res.synced} perkata=${res.wordLevel} baris=${res.lines.length}`
        : err ? `gagal: ${err}` : 'tidak ketemu';
      console.log(`  ${id.padEnd(12)} ${info}`);
    }
    const best = Object.values(results).find((r) => r && r.wordLevel)
      || Object.values(results).find((r) => r && r.synced)
      || Object.values(results).find((r) => r);
    if (best && !args.json) {
      console.log('\n== Keluaran sumber terbaik:', best.source, '==\n');
      console.log(args.enhanced ? toEnhancedLRC(best) : toLRC(best));
    } else if (best) {
      console.log('\n' + JSON.stringify(lirik.toJSON(best, { raw: args.raw }), null, 2));
    }
    return;
  }

  const { result, attempts } = await lirik.find(query, {
    source: args.source || undefined,
  });

  if (args.debug) {
    for (const a of attempts) console.error(`  [${a.source}] ${a.ok ? 'OK' : `skip (${a.note})`}`);
  }

  if (!result) {
    console.error('Lirik tidak ditemukan di sumber manapun.');
    process.exit(1);
  }

  let output;
  if (args.json) {
    output = JSON.stringify(lirik.toJSON(result, { raw: args.raw }), null, 2);
  } else if (args.plain) {
    output = toPlain(result);
  } else if (args.enhanced) {
    output = toEnhancedLRC(result);
  } else {
    // default: LRC (bila tersinkron) atau plain
    output = result.synced ? toLRC(result) : toPlain(result);
    if (args.raw && result.raw) {
      output += '\n--- RAW (format asli) ---\n' + String(result.raw).slice(0, 4000) + '\n';
    }
  }

  if (args.save) {
    writeFileSync(args.save, output, 'utf8');
    console.error(`Tersimpan: ${args.save} (sumber: ${result.source}${result.wordLevel ? ', per-kata' : ''})`);
  } else {
    process.stdout.write(output);
  }
}

/* ============================================================ *
 *  DETEKSI MODE CLI — jalankan cliMain() hanya bila file ini
 *  dieksekusi langsung (bukan di-import sebagai modul).
 * ============================================================ */

const invokedDirectly = (() => {
  try {
    const arg = process.argv[1];
    if (!arg) return false;
    if (import.meta.url === pathToFileURL(arg).href) return true;
    // cocokkan juga lewat realpath (mis. dijalankan via symlink)
    try {
      return import.meta.url === pathToFileURL(realpathSync(arg)).href;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  cliMain().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

/* ============================================================ *
 *  CATATAN EKSPOR — semua API publik sudah diekspor inline di
 *  tiap bagian: parser (parseLrc, parseLrcFile, parseYrc,
 *  attachTranslation, decodeKrc, parseKrc, decryptQrc, parseQrc,
 *  parseRichsync), provider (LrclibProvider, MusixmatchProvider,
 *  NeteaseProvider, QQMusicProvider, KugouProvider, GeniusProvider,
 *  LyricsOvhProvider, BaseProvider, buildResult), core (http,
 *  httpRequest, HttpError, Cache, stripJunk, normalizeText,
 *  tokenize, similarity, scoreCandidate, buildKeyword), konverter
 *  (toLRC, toEnhancedLRC, toPlain, toJSON, fmtTime), aggregator
 *  (LirikSync, createLirikSync, SOURCES).
 * ============================================================ */

export default LirikSync;