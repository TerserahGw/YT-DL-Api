"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Obj = Record<string, any>;
type Item = Obj;
type Mode = "discover" | "trending" | "api" | "about";
type Detail = { kind: string; data: Obj; item?: Item; url?: string };
type FetchState = { loading: boolean; error: string; data: Obj | null; label: string };
const INITIAL: FetchState = { loading: false, error: "", data: null, label: "" };
const API_ENDPOINTS = [
  { path: "/api/search?q=Another+Love", title: "Search", note: "Video, channel, dan playlist" },
  { path: "/api/stream?id=dQw4w9WgXcQ", title: "Stream info", note: "Informasi stream lengkap" },
  { path: "/api/details?id=dQw4w9WgXcQ", title: "Details", note: "Judul, channel dan statistik" },
  { path: "/api/audio?id=dQw4w9WgXcQ", title: "Audio formats", note: "Daftar format audio" },
  { path: "/api/video-streams?id=dQw4w9WgXcQ", title: "Video formats", note: "Daftar kualitas video" },
  { path: "/api/subtitles?id=dQw4w9WgXcQ", title: "Subtitles", note: "Track subtitle tersedia" },
  { path: "/api/related?id=dQw4w9WgXcQ", title: "Related", note: "Rekomendasi konten" },
  { path: "/api/comments?id=dQw4w9WgXcQ", title: "Comments", note: "Komentar video" },
  { path: "/api/playlist?id=PLxxxxxxxxxxxx", title: "Playlist", note: "Metadata dan daftar video (ganti ID)" },
  { path: "/api/channel?id=%40GoogleDevelopers", title: "Channel", note: "Info channel (ganti handle)" },
  { path: "/api/channel-videos?id=%40GoogleDevelopers", title: "Channel videos", note: "Video channel" },
  { path: "/api/trending?category=trending_music", title: "Trending", note: "Musik, gaming, atau film" },
  { path: "/api/services", title: "Services", note: "Daftar layanan yang didukung" },
  { path: "/api/health", title: "Health", note: "Kesiapan layanan YouTube.js dan status proxy" },
  { path: "/api/lyrics?track=Yellow&artist=Coldplay", title: "Lyrics JSON", note: "Lirik multisumber, timestamp baris dan per kata" },
  { path: "/api/lyrics/sources", title: "Lyrics sources", note: "Daftar 7 penyedia lirik" }
];
const TRENDS = [
  { id: "trending_music", title: "Music", icon: "♫" },
  { id: "trending_gaming", title: "Gaming", icon: "◈" },
  { id: "trending_movies_and_shows", title: "Movies", icon: "▣" }
];
function validLink(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch { return undefined; }
}
function mediaId(value: string): string | null {
  const v = value.trim();
  if (/^[\w-]{11}$/.test(v)) return v;
  try {
    const u = new URL(v);
    if (!["youtube.com","www.youtube.com","m.youtube.com","music.youtube.com","youtu.be"].includes(u.hostname)) return null;
    const id = u.hostname === "youtu.be" ? u.pathname.split("/")[1] : (u.searchParams.get("v") || (/^\/(?:shorts|live|embed)\//.test(u.pathname) ? u.pathname.split("/")[2] : ""));
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
function playId(value: string): string | null {
  try { const u = new URL(value); return /(^|\.)youtube\.com$/.test(u.hostname) ? u.searchParams.get("list") : null; }
  catch { return null; }
}
function channelId(value: string): string | null {
  const v = value.trim();
  if (/^@[\w.-]{3,50}$/.test(v) || /^channel\/UC[\w-]{20,45}$/.test(v)) return v;
  try {
    const u = new URL(v);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
    const path = decodeURIComponent(u.pathname.replace(/^\//, "")).split("/").slice(0, 2).join("/");
    return /^@[\w.-]{3,50}$/.test(path.split("/")[0]) ? path.split("/")[0] : /^channel\/UC[\w-]{20,45}$/.test(path) ? path : null;
  } catch { return null; }
}
function toItems(value: Obj | null): Item[] {
  if (!value) return [];
  const candidates = [value.items, value.relatedItems, value.streams, value.videos, value.results];
  return (candidates.find(Array.isArray) || []) as Item[];
}
function thumb(item?: Obj): string | undefined {
  if (!item) return undefined;
  return validLink(item.thumbnailUrl || item.thumbnail || item.thumbnails?.[0]?.url || item.uploaderAvatars?.[0]?.url || item.avatars?.[0]?.url);
}
function title(item?: Obj): string { return String(item?.name || item?.title || item?.videoTitle || "Untitled content"); }
function number(value: unknown): string {
  return typeof value === "number" && value >= 0 ? Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(value) : "—";
}
function duration(value: unknown): string {
  if (typeof value !== "number" || value < 0) return "";
  const s = Math.floor(value);
  return (s >= 3600 ? `${Math.floor(s/3600)}:${String(Math.floor(s%3600/60)).padStart(2,"0")}` : String(Math.floor(s/60))) + ":" + String(s%60).padStart(2,"0");
}
async function api(path: string): Promise<Obj> {
  const res = await fetch(path, { cache: "no-store" });
  const content = (await res.json()) as Obj;
  if (!res.ok) {
    if (content.code === "UPSTREAM_BLOCKED") {
      throw new Error("YouTube meminta verifikasi anti-bot untuk IP server Vercel. YouTube.js bisa mengalami kendala ini meskipun aplikasi berhasil berjalan.");
    }
    throw new Error(String(content.error || content.message || `HTTP ${res.status}`));
  }
  return content;
}

export default function HomePage() {
  const [mode, setMode] = useState<Mode>("discover");
  const [query, setQuery] = useState("");
  const [state, setState] = useState<FetchState>(INITIAL);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selectedTab, setSelectedTab] = useState<"info" | "streams" | "json">("info");
  const [trend, setTrend] = useState("trending_music");
  const [health, setHealth] = useState<"checking" | "online" | "offline" | "unconfigured">("checking");
  const [copied, setCopied] = useState("");
  const [mobileMenu, setMobileMenu] = useState(false);

  useEffect(() => {
    api("/api/health").then((r) => setHealth(r.ok ? "online" : r.configured ? "offline" : "unconfigured"))
      .catch(async () => { try { const res = await fetch("/api/health"); const r = await res.json(); setHealth(r.configured ? "offline" : "unconfigured"); } catch { setHealth("offline"); } });
  }, []);

  const items = useMemo(() => toItems(state.data), [state.data]);

  async function load(path: string, label: string, kind?: string, item?: Item) {
    if (kind) {
      setDetail(null);
      setSelectedTab("info");
      setState((old) => ({ ...old, error: "" }));
    } else setState({ loading: true, error: "", data: null, label });
    try {
      const data = await api(path);
      if (kind) setDetail({ kind, data, item, url: item?.url });
      else setState({ loading: false, error: "", data, label });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (kind) setDetail({ kind: "request-error", data: { message }, item, url: item?.url });
      else setState({ loading: false, error: message, data: null, label });
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setMode("discover");
    setDetail(null);
    const playlist = playId(q);
    const channel = channelId(q);
    const video = mediaId(q);
    if (playlist && /^[\w-]{10,100}$/.test(playlist)) return load("/api/playlist?id=" + encodeURIComponent(playlist), "Playlist", "playlist", { url: q, name: "Playlist" });
    if (video) return load("/api/stream?id=" + video, "Video", "stream", { url: q, name: "Video" });
    if (channel) return load("/api/channel?id=" + encodeURIComponent(channel), "Channel", "channel", { url: q, name: channel });
    await load("/api/search?q=" + encodeURIComponent(q), `Hasil untuk "${q}"`);
  }
  async function selectItem(item: Item) {
    const kind = String(item.type || item.infoType || "stream").toLowerCase();
    const url = String(item.url || "");
    const playlist = playId(url);
    const channel = channelId(url) || (kind === "channel" && item.id ? String(item.id) : null);
    const id = mediaId(url);
    if (kind.includes("playlist") && playlist && /^[\w-]{10,100}$/.test(playlist)) return load("/api/playlist?id=" + encodeURIComponent(playlist), "Playlist", "playlist", item);
    if (kind.includes("channel") && channel) return load("/api/channel?id=" + encodeURIComponent(channel), "Channel", "channel", item);
    if (id) return load("/api/stream?id=" + id, "Video", "stream", item);
    if (validLink(url)) window.open(url, "_blank", "noopener,noreferrer");
  }
  async function loadTrend(id: string) {
    setMode("trending");
    setTrend(id);
    setDetail(null);
    await load("/api/trending?category=" + id, `Trending ${TRENDS.find(t=>t.id===id)?.title || ""}`);
  }
  function navigate(next: Mode) {
    setMode(next);
    setMobileMenu(false);
    setDetail(null);
    if (next === "trending" && !state.loading) void loadTrend(trend);
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(text); window.setTimeout(() => setCopied(""), 1600); }
    catch { setCopied("Copy failed"); }
  }
  const selected = detail?.data;
  const selectedItems = detail?.kind === "playlist" ? toItems(selected || null) : [];
  const streamAudios = Array.isArray(selected?.audioStreams) ? selected.audioStreams : [];
  const streamVideos = [...(Array.isArray(selected?.videoStreams) ? selected.videoStreams : []), ...(Array.isArray(selected?.videoOnlyStreams) ? selected.videoOnlyStreams : [])];

  return <div className="shell">
    <div className="ambient ambient-a" /><div className="ambient ambient-b" />
    <aside className={"sidebar " + (mobileMenu ? "sidebar-open" : "")}>
      <div className="brand">
        <div className="brand-symbol"><span>◉</span></div>
        <div><strong>newpipe<span className="accent-text">.web</span></strong><small>EXTRACTOR CONSOLE</small></div>
      </div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        <button className={"nav-item " + (mode==="discover"?"active":"")} onClick={()=>navigate("discover")}><span>⌕</span> Explore <span className="nav-arrow">›</span></button>
        <button className={"nav-item " + (mode==="trending"?"active":"")} onClick={()=>navigate("trending")}><span>♬</span> Trending <span className="nav-arrow">›</span></button>
        <button className={"nav-item " + (mode==="api"?"active":"")} onClick={()=>navigate("api")}><span>⌘</span> API Explorer <span className="nav-arrow">›</span></button>
      </nav>
      <div className="nav-label nav-secondary">SYSTEM</div>
      <nav>
        <button className={"nav-item " + (mode==="about"?"active":"")} onClick={()=>navigate("about")}><span>ⓘ</span> Setup & About <span className="nav-arrow">›</span></button>
      </nav>
      <div className="sidebar-bottom">
        <div className="service-card"><div className="service-row"><span className={"status-dot " + health} /><span>YouTube.js API</span></div><b>{health==="online"?"Connected":health==="unconfigured"?"Not configured":health==="checking"?"Checking...":"Unavailable"}</b><small>{health==="online"?"Runtime online (YouTube not checked)":"Check deployment status"}</small></div>
        <div className="sidebar-foot">Built for Vercel · YouTube.js</div>
      </div>
    </aside>
    {mobileMenu && <button className="mobile-cover" aria-label="Close sidebar" onClick={()=>setMobileMenu(false)} />}
    <main className="main">
      <header className="topbar">
        <div className="topbar-left"><button className="menu-toggle" onClick={()=>setMobileMenu(!mobileMenu)} aria-label="Toggle menu">☰</button><span className="breadcrumbs">Workspace <span>/</span> {mode==="discover"?"Explore":mode==="trending"?"Trending":mode==="api"?"API Explorer":"Setup"}</span></div>
        <div className="header-right"><span className="header-version">v2.2.0</span><span className={"connection " + health}><span className={"status-dot "+health}/>{health==="online"?"Backend online":health==="unconfigured"?"Needs setup":health==="checking"?"Checking":"Backend offline"}</span></div>
      </header>
      <div className="content">
        {mode==="discover" && <>
          <section className="hero">
            <div className="hero-tag"><span className="hero-star">✳</span> UNIVERSAL MEDIA EXTRACTOR · WEB INTERFACE</div>
            <h1>Discover. Extract.<br/><span>Explore anything.</span></h1>
            <p>Jelajahi video, channel, dan playlist dengan YouTube.js melalui REST API milikmu. Tanpa VPS dan tanpa Java.</p>
            <form className="search-form" onSubmit={submit}>
              <span className="search-symbol">⌕</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Cari video, musik, atau tempel URL YouTube..." aria-label="Search content" maxLength={300}/><button type="submit" disabled={state.loading}>{state.loading?"Loading...":"Search"} <span>↗</span></button>
            </form>
            <div className="quick-terms"><span>Try searching</span>{["Another Love","Lo-fi beats","Minecraft","Music"].map(t=><button key={t} onClick={()=>setQuery(t)}>{t}</button>)}</div>
          </section>
          <div className="section-head"><div><span className="eyebrow">DISCOVER</span><h2>{detail ? "Content details" : state.label || "Everything in one place"}</h2></div><span className="muted">{detail?"Extractor result":items.length ? `${items.length} results` : "Powered by YouTube.js"}</span></div>
          {!state.loading && !state.error && !detail && !state.data && <div className="feature-grid">
            <button className="feature-card" onClick={()=>void loadTrend("trending_music")}><div className="feature-icon purple">♫</div><h3>Explore trending</h3><p>Temukan musik, gaming, dan film yang sedang populer.</p><span>Explore →</span></button>
            <button className="feature-card" onClick={()=>navigate("api")}><div className="feature-icon blue">⌘</div><h3>REST API</h3><p>Akses data dari bot, website, atau aplikasi lewat JSON.</p><span>View endpoints →</span></button>
            <button className="feature-card" onClick={()=>navigate("about")}><div className="feature-icon pink">⚙</div><h3>YouTube.js runtime</h3><p>YouTube.js menangani permintaan utama, yt-dlp menjadi fallback internal jika gagal, dan tersedia API lirik JSON.</p><span>Setup guide →</span></button>
          </div>}
          {renderResults()}
        </>}
        {mode==="trending" && <>
          <div className="page-heading"><span className="eyebrow">DISCOVER</span><h1>Trending now<span className="accent-text">.</span></h1><p>Konten populer yang diekstrak dari kategori kiosks NewPipe.</p></div>
          <div className="trend-tabs">{TRENDS.map(t=><button className={trend===t.id?"chosen":""} key={t.id} onClick={()=>void loadTrend(t.id)}><span>{t.icon}</span> {t.title}</button>)}</div>
          {renderResults()}
        </>}
        {mode==="api" && <>
          <div className="page-heading"><span className="eyebrow">DEVELOPER TOOLS</span><h1>API Explorer<span className="accent-text">.</span></h1><p>Seluruh endpoint tersedia dari domain Vercel milikmu. Klik untuk menyalin request.</p></div>
          <div className="api-tip"><span>◈</span><div><b>Base URL</b><code>{typeof window!=="undefined"?window.location.origin:"https://your-domain.vercel.app"}</code></div></div>
          <div className="api-list">{API_ENDPOINTS.map(e=><div className="api-row" key={e.path}><span className="method">GET</span><div><strong>{e.title}</strong><code>{e.path}</code><small>{e.note}</small></div><button onClick={()=>void copy((typeof window!=="undefined"?window.location.origin:"")+e.path)}>{copied.endsWith(e.path)?"Copied ✓":"Copy ↗"}</button></div>)}</div>
          <p className="disclaimer">API mempertahankan nama endpoint sebelumnya dan menyediakan JSON adapter YouTube.js. Beberapa properti streaming atau hasil trending mungkin berbeda; gunakan rate limit / Vercel Firewall untuk API publik.</p>
        </>}
        {mode==="about" && <>
          <div className="page-heading"><span className="eyebrow">SYSTEM SETUP</span><h1>YouTube.js setup<span className="accent-text">.</span></h1><p>Website dan API sekarang menggunakan YouTube.js langsung dalam satu layanan Next.js di Vercel. Tidak ada backend Java atau VPS.</p></div>
          <div className="steps"><div><span>01</span><h3>Import GitHub repository</h3><p>Import <code>TerserahGw/YT-DL-Api</code> ke Vercel. Pilih Root Directory <code>newpipe-web</code>.</p></div><div><span>02</span><h3>One Next.js service</h3><p><code>vercel.json</code> menjalankan hanya <code>newpipe-web</code>. API Route Handler memanggil library <code>youtubei.js</code> langsung.</p></div><div><span>03</span><h3>No backend URL</h3><p>Hapus environment variable lama <code>EXTRACTOR_BASE_URL</code> dan <code>BACKEND_AUTHORIZATION</code> jika ada. Tidak perlu menyiapkan Java atau Docker.</p></div><div><span>04</span><h3>Test API endpoints</h3><p>Setelah deploy, uji <code>/api/health</code> lalu <code>/api/search?q=Minecraft</code> dan <code>/api/stream?id=dQw4w9WgXcQ</code>. Health hanya menguji kesiapan aplikasi, bukan akses YouTube.</p></div></div>
          <div className="setup-note"><strong>Important</strong><p>YouTube.js tidak menjamin lolos pemblokiran IP Vercel. Sebagian URL media perlu decipher, attestation, atau tidak tersedia akibat protokol SABR.</p></div>
        </>}
        <footer>Unofficial YouTube.js API viewer · Not affiliated with YouTube or TeamNewPipe. <span>© 2026 · Built for developers</span></footer>
      </div>
    </main>
  </div>;

  function renderResults() {
    if (state.loading) return <div className="loading-grid">{Array.from({length:6},(_,i)=><div className="skeleton" key={i}><div/><span/><span/></div>)}</div>;
    if (state.error) return <div className="empty-state error-state"><div>!</div><h3>Gagal mengambil data</h3><p>{state.error}</p><button onClick={()=>navigate("about")}>Lihat status backend ↗</button></div>;
    if (detail?.kind === "request-error") return <div className="empty-state error-state">
      <div>!</div><h3>Video belum dapat diekstrak</h3>
      <p>{detail.data.message}</p>
      <p>Permintaan ditolak oleh YouTube, bukan karena aplikasi Node.js mati. Hindari mengulang permintaan terus-menerus; tunggu sebelum mencoba lagi.</p>
      <button onClick={()=>setDetail(null)}>← Kembali ke hasil pencarian</button>
      {validLink(detail.url) && <p><a className="external-link" href={validLink(detail.url)} target="_blank" rel="noopener noreferrer">Buka sumber video ↗</a></p>}
    </div>;
    if (detail) return <div className="detail-panel">
      <button className="back-btn" onClick={()=>setDetail(null)}>← Back to results</button>
      <div className="detail-head">
        {thumb(detail.item || selected) ? <img src={thumb(detail.item || selected)} alt="" /> : <div className="detail-no-image">◉</div>}
        <div><span className="type-pill">{detail.kind.toUpperCase()}</span><h2>{title(detail.kind==="stream"?selected:detail.kind==="playlist"?selected:detail.kind==="channel"?selected:detail.item)}</h2><p>{selected?.uploaderName || selected?.channelName || detail.item?.uploaderName || selected?.description?.content?.slice(0,100) || "NewPipeExtractor data"}</p>
          <div className="detail-stats"><span>Views: {number(selected?.viewCount)}</span><span>Duration: {duration(selected?.duration) || "—"}</span></div>
          {validLink(selected?.url || detail.url) && <a className="external-link" href={validLink(selected?.url || detail.url)} target="_blank" rel="noreferrer">Open source ↗</a>}
        </div>
      </div>
      <div className="detail-tabs"><button className={selectedTab==="info"?"active":""} onClick={()=>setSelectedTab("info")}>Overview</button><button className={selectedTab==="streams"?"active":""} onClick={()=>setSelectedTab("streams")}>Streams & items</button><button className={selectedTab==="json"?"active":""} onClick={()=>setSelectedTab("json")}>Raw JSON</button></div>
      {selectedTab==="info" && <div className="detail-fields">{Object.entries(selected || {}).filter(([k,v])=>["name","videoTitle","uploaderName","channelName","duration","viewCount","likeCount","subscriberCount","streamCount","uploadDate","id","url","description"].includes(k)).map(([k,v])=><div key={k}><label>{k}</label><span>{typeof v==="object" ? JSON.stringify(v).slice(0,700) : String(v)}</span></div>)}</div>}
      {selectedTab==="streams" && <div className="streams-section">
        {detail.kind==="stream" ? <><h3>Audio formats ({streamAudios.length})</h3>{renderStreamList(streamAudios)}<h3>Video formats ({streamVideos.length})</h3>{renderStreamList(streamVideos)}</> :
          <>{selectedItems.length ? <div className="results-grid">{selectedItems.map((it,i)=>renderCard(it,i))}</div> : <div className="empty-state"><h3>No items in this response</h3><p>Full lists might require additional pages from the Java backend.</p></div>}</>}
        <p className="disclaimer">Direct stream links can expire or be restricted to the extractor server's IP.</p>
      </div>}
      {selectedTab==="json" && <div className="json-wrap"><button onClick={()=>void copy(JSON.stringify(selected,null,2))}>{copied.startsWith("{")?"Copied ✓":"Copy JSON"}</button><pre>{JSON.stringify(selected,null,2)}</pre></div>}
    </div>;
    if (!state.data) return null;
    if (!items.length) return <div className="empty-state"><div>⌕</div><h3>No matching items</h3><p>Backend berhasil merespons, tetapi tidak ada hasil yang dapat ditampilkan.</p><div className="json-preview"><pre>{JSON.stringify(state.data,null,2).slice(0,2000)}</pre></div></div>;
    return <div className="results-grid">{items.map((item,i)=>renderCard(item,i))}</div>;
  }
  function renderCard(item:Item, i:number) {
    return <button key={String(item.url || i)+"-"+i} className="result-card" onClick={()=>void selectItem(item)}>
      <div className="thumb">{thumb(item) ? <img src={thumb(item)} loading="lazy" alt=""/>:<span>▶</span>}{typeof item.duration==="number" && item.duration>=0 && <span className="duration">{duration(item.duration)}</span>}</div>
      <div className="item-body"><span className="item-kind">{String(item.type || item.infoType || "STREAM").toUpperCase()}</span><h3>{title(item)}</h3><p>{item.uploaderName || item.channelName || item.description || "Unknown source"}</p><div className="item-meta"><span>{number(item.viewCount)} views</span><span>↗</span></div></div>
    </button>;
  }
  function renderStreamList(streams:Item[]) {
    return streams.length ? <div className="format-list">{streams.slice(0,70).map((s,i)=><div className="format-row" key={i}><span>#{i+1}</span><div><b>{s.quality || s.resolution || s.format?.name || s.format || "Unknown format"}</b><small>{s.bitrate ? `${Math.round(s.bitrate/1000)} kbps` : ""} {s.codec || ""}</small></div>{validLink(s.content || s.url) ? <a href={validLink(s.content || s.url)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}>Link ↗</a>:<small>No URL</small>}</div>)}</div> : <p className="muted">Tidak ada stream tersedia dalam respons ini.</p>;
  }
}
