// ─── scraper.js ───
// Server-side data layer for AnimeIDHentai (https://animeidhentai.com)
//
// The source site is a Next.js App-Router application that server-renders every
// page and ships the raw data inside RSC "flight" payloads
// (self.__next_f.push([...])). This module fetches those pages, decodes the
// flight stream and extracts the structured JSON objects
// (videos / series / genres / upcoming entries).
//
// Additionally the source site exposes a small public JSON API:
//   GET /api/search?q=<query>&limit=<n>  →  { videos: [...] }
//
// Responses are cached in-memory with TTLs (mirrors the old Next.js
// revalidate windows) and identical in-flight requests are deduplicated.

import { cached } from "./cache.js";

const SITE_URL = process.env.SITE_URL || "https://animeidhentai.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const TTL_SHORT = Number(process.env.CACHE_TTL_SHORT) || 300;   // 5 min  — episode/series pages
const TTL_MED = Number(process.env.CACHE_TTL_MED) || 900;       // 15 min — trending / browse lists
const TTL_LONG = Number(process.env.CACHE_TTL_LONG) || 86400;   // 24 h   — genres

// ─────────────────────────────────────────────────────────────────────────────
// Low-level: fetch + flight decoding
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPage(path, ttl = TTL_MED) {
  const url = `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  return cached(`page:${url}`, ttl, async () => {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (!res.ok) {
        console.error(`[scraper] ${path} → HTTP ${res.status}`);
        return null;
      }
      return await res.text();
    } catch (err) {
      console.error(`[scraper] ${path} → ${err.message}`);
      return null;
    }
  });
}

/**
 * Decodes the RSC flight stream embedded in a Next.js SSR page.
 * Each push is `self.__next_f.push([1,"<json-string>"])`; the decoded strings
 * concatenated together form the flight rows.
 */
function extractFlight(html) {
  if (!html) return "";
  const marker = 'self.__next_f.push([1,';
  let flight = "";
  let i = 0;
  while (true) {
    const idx = html.indexOf(marker, i);
    if (idx === -1) break;
    let j = idx + marker.length;
    while (j < html.length && /\s/.test(html[j])) j++;
    if (html[j] !== '"') { i = idx + marker.length; continue; }
    let k = j + 1;
    let raw = "";
    while (k < html.length) {
      const ch = html[k];
      if (ch === "\\") { raw += html.slice(k, k + 2); k += 2; continue; }
      if (ch === '"') break;
      raw += ch;
      k++;
    }
    try {
      flight += JSON.parse('"' + raw + '"');
    } catch {
      // skip malformed chunk
    }
    i = k + 1;
  }
  return flight;
}

/**
 * Extracts complete JSON objects from a flight string via string-aware
 * brace matching. `predicate` receives the raw candidate text.
 */
function extractObjects(flight, predicate) {
  const objs = [];
  const stack = [];
  let i = 0;
  const n = flight.length;
  while (i < n) {
    const ch = flight[i];
    if (ch === '"') {
      i++;
      while (i < n) {
        if (flight[i] === "\\") { i += 2; continue; }
        if (flight[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "{") { stack.push(i); i++; continue; }
    if (ch === "}") {
      const start = stack.pop();
      if (start !== undefined) {
        const candidate = flight.slice(start, i + 1);
        if (predicate(candidate)) {
          try { objs.push(JSON.parse(candidate)); } catch { /* skip */ }
        }
      }
      i++;
      continue;
    }
    i++;
  }
  return objs;
}

const isVideoObj = (s) =>
  s.startsWith('{"id":"') && s.includes('"slug"') && s.includes('"titleSlug"') && s.includes('"embedUrl"');

/**
 * Removes the `initialNotifications` prop (site-wide latest-episode dropdown)
 * from the flight text so its videos don't pollute page content extraction.
 */
function stripNotifications(flight) {
  const key = '"initialNotifications":[';
  const idx = flight.indexOf(key);
  if (idx === -1) return flight;
  let i = idx + key.length - 1; // at '['
  let depth = 0;
  while (i < flight.length) {
    const ch = flight[i];
    if (ch === '"') {
      i++;
      while (i < flight.length) {
        if (flight[i] === "\\") { i += 2; continue; }
        if (flight[i] === '"') break;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return flight.slice(0, idx) + flight.slice(i + 1);
    }
    i++;
  }
  return flight;
}

/** Extract content video objects from a page (deduped, in page order). */
function extractPageVideos(html) {
  const flight = stripNotifications(extractFlight(html));
  const videos = extractObjects(flight, isVideoObj);
  const seen = new Set();
  const out = [];
  for (const v of videos) {
    if (!v || seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
  }
  return out;
}

/** Extract a top-level `"key":[ ... ]` array from flight text. */
function getPropArray(flight, key) {
  const needle = `"${key}":[`;
  const idx = flight.indexOf(needle);
  if (idx === -1) return null;
  let i = idx + needle.length - 1; // at '['
  let depth = 0;
  while (i < flight.length) {
    const ch = flight[i];
    if (ch === '"') {
      i++;
      while (i < flight.length) {
        if (flight[i] === "\\") { i += 2; continue; }
        if (flight[i] === '"') break;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(flight.slice(idx + needle.length - 1, i + 1)); }
        catch { return null; }
      }
    }
    i++;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization → shapes expected by the TaroFlix UI
// ─────────────────────────────────────────────────────────────────────────────

const absImg = (p) => (p && !p.startsWith("http") ? `${SITE_URL}${p}` : p || "");

const stripHtml = (s) => (s || "").replace(/<[^>]*>/g, "").trim();

/** Normalize a site video/episode object into a catalog card item. */
function normalizeVideo(v) {
  if (!v) return null;
  return {
    // watch id = series slug; the specific episode travels via ?ep=
    id: v.titleSlug || v.slug,
    type: "hentai",
    media_type: "hentai",
    title: v.title || "",
    poster: absImg(v.cover || v.featureImage),
    banner: absImg(v.backdrop || v.thumb || v.cover),
    year: v.year ? String(v.year) : "",
    quality: v.quality || "HD",
    duration: v.duration || "",
    description: stripHtml(v.description),
    genres: v.tags || [],
    tags: v.tags || [],
    brand: v.brand || "",
    language: v.language || "",
    censored: v.censored !== false,
    views: v.views || 0,
    likes: v.likes || 0,
    dislikes: v.dislikes || 0,
    rating: v.rating || null,
    vote_average: v.rating || 0,
    episodeCount: null,
    // episode-specific data
    ep: v.ep || 1,
    slug: v.slug || "",
    embedUrl: v.embedUrl || "",
    releasedAt: v.releasedAt || "",
    released: v.releasedAt ? v.releasedAt.slice(0, 10) : "",
    status: "Released",
    popularity: v.views || 0,
  };
}

/** Normalize an upcoming calendar entry. */
function normalizeUpcoming(item) {
  if (!item) return null;
  const release = new Date(item.releaseAt);
  return {
    id: `upcoming-${item.id}`,
    type: "hentai",
    media_type: "hentai",
    title: item.name || "",
    name: item.name || "",
    poster: absImg(item.poster),
    banner: absImg(item.poster),
    year: String(release.getFullYear() || ""),
    quality: "HD",
    duration: "",
    description: `Episode ${item.epNumber || 1} — releases ${release.toDateString()}`,
    genres: [],
    brand: item.studio || "",
    studio: item.studio || "",
    epNumber: item.epNumber || 1,
    ep: item.epNumber || 1,
    releaseAt: item.releaseAt || "",
    released: item.releaseAt ? item.releaseAt.slice(0, 10) : "",
    status: "Upcoming",
    embedUrl: "",
    upcoming: true,
  };
}

/** Normalize a series object (from explore/series list). */
function normalizeSeries(s) {
  if (!s) return null;
  return {
    id: s.slug,
    type: "hentai",
    media_type: "hentai",
    title: s.name || "",
    poster: absImg(s.cover),
    banner: absImg(s.cover),
    year: s.lastReleasedAt ? String(s.lastReleasedAt.slice(0, 4)) : "",
    quality: s.rating ? Number(s.rating).toFixed(1) : "HD",
    vote_average: s.rating || 0,
    duration: "",
    description: "",
    genres: [],
    brand: s.brand || "",
    episodeCount: s.episodes || 0,
    views: s.views || 0,
    status: "Released",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public data functions
// ─────────────────────────────────────────────────────────────────────────────

/** Trending board (top ~60 episodes). */
export async function getTrendingVideos() {
  const html = await fetchPage("/trending");
  if (!html) return { results: [] };
  return { results: extractPageVideos(html).map(normalizeVideo).filter(Boolean) };
}

/**
 * Browse catalog with filters.
 * @param {object} opts
 * @param {number}  opts.page     1-based page number (28 items per page)
 * @param {string}  opts.sort     "Most Recent" | "Most Viewed" | "Top Rated"
 * @param {string[]|string} opts.genres  genre names (NOT slugs), e.g. ["Tentacles"]
 * @param {string[]|string} opts.brands  brand names
 */
export async function getBrowse({ page = 1, sort = "Most Recent", genres = [], brands = [] } = {}) {
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, page)));
  if (sort && sort !== "Most Recent") params.set("sort", sort);
  if (genres && (Array.isArray(genres) ? genres.length : genres)) {
    params.set("genres", Array.isArray(genres) ? genres.join(",") : genres);
  }
  if (brands && (Array.isArray(brands) ? brands.length : brands)) {
    params.set("brands", Array.isArray(brands) ? brands.join(",") : brands);
  }
  const html = await fetchPage(`/browse?${params.toString()}`);
  if (!html) return { results: [], total_pages: 1, total: 0 };
  const flight = extractFlight(html);
  const videos = getPropArray(flight, "initialVideos") || extractPageVideos(html);
  const total = Number((flight.match(/"initialTotal":(\d+)/) || [])[1] || 0);
  const pages = Number((flight.match(/"initialPages":(\d+)/) || [])[1] || 1);
  return {
    results: (videos || []).map(normalizeVideo).filter(Boolean),
    total: total || videos.length,
    total_pages: pages || Math.ceil((total || videos.length) / 28) || 1,
  };
}

/** Latest episodes (browse, default sort). */
export async function getLatestVideos(page = 1) {
  return getBrowse({ page, sort: "Most Recent" });
}

/** Most viewed episodes. */
export async function getMostViewedVideos(page = 1) {
  return getBrowse({ page, sort: "Most Viewed" });
}

/** Top rated episodes. */
export async function getTopRatedVideos(page = 1) {
  return getBrowse({ page, sort: "Top Rated" });
}

/** Browse by genre name(s). */
export async function getVideosByGenre(genre, page = 1) {
  return getBrowse({ page, genres: genre, sort: "Most Recent" });
}

/** Upcoming release calendar entries. */
export async function getUpcomingVideos() {
  const html = await fetchPage("/upcoming", TTL_MED);
  if (!html) return { results: [] };
  const flight = extractFlight(html);
  const items = getPropArray(flight, "items");
  if (items) return { results: items.map(normalizeUpcoming).filter(Boolean) };
  // fallback: UpcomingClient props may sit under a different key
  const flightNoNotif = stripNotifications(flight);
  const objs = extractObjects(flightNoNotif, (s) => s.includes('"epNumber"') && s.includes('"releaseAt"'));
  return { results: objs.map(normalizeUpcoming).filter(Boolean) };
}

/**
 * Genre list. Preference: the full filterable list from the browse page
 * (names work directly as ?genres= filters), fallback: curated genre objects
 * from /explore.
 */
export async function getGenres() {
  const browseHtml = await fetchPage("/browse", TTL_LONG);
  if (browseHtml) {
    const flight = extractFlight(browseHtml);
    // the filterable genres prop sits right after initialFilters: },"genres":[
    const anchor = flight.indexOf("},\"genres\":[");
    if (anchor !== -1) {
      const tail = flight.slice(anchor + 2); // start at "genres":[
      const arr = getPropArray(tail, "genres");
      if (arr && arr.length) {
        return arr
          .filter((g) => g && g.name)
          .map((g) => ({
            id: g.name,
            name: g.name,
            slug: g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
            count: g.count || 0,
          }));
      }
    }
  }
  const html = await fetchPage("/explore", TTL_LONG);
  if (html) {
    const flight = extractFlight(html);
    const genres = getPropArray(flight, "genres");
    if (genres && genres.length) {
      return genres.map((g) => ({
        id: g.slug,
        name: g.name,
        slug: g.slug,
        count: g.count || 0,
        description: stripHtml(g.description),
      }));
    }
  }
  return [];
}

/** Explore feed: main items + genres + popular series. */
export async function getExplore() {
  const html = await fetchPage("/explore");
  if (!html) return { items: [], genres: [], series: [] };
  const flight = extractFlight(html);
  const videos = extractPageVideos(html);
  const genres = getPropArray(flight, "genres") || [];
  const series = getPropArray(flight, "series") || [];
  return {
    items: videos.map(normalizeVideo).filter(Boolean),
    genres: genres.map((g) => ({ id: g.slug, name: g.name, slug: g.slug, count: g.count || 0 })),
    series: series.map(normalizeSeries).filter(Boolean),
  };
}

/** Direct search through the source site's JSON API. */
export async function searchVideos(q, limit = 40) {
  if (!q || !q.trim()) return { results: [] };
  const url = `${SITE_URL}/api/search?q=${encodeURIComponent(q.trim())}&limit=${limit}`;
  return cached(`search:${url}`, TTL_SHORT, async () => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept": "application/json" },
      });
      if (!res.ok) return { results: [] };
      const data = await res.json();
      const videos = data?.videos || [];
      return { results: videos.map(normalizeVideo).filter(Boolean) };
    } catch (err) {
      console.error(`[scraper] search "${q}" → ${err.message}`);
      return { results: [] };
    }
  });
}

/**
 * Series detail: metadata + all episodes (each with its embed URL).
 * @param {string} slug series slug, e.g. "kanojo-saimin"
 */
export async function getSeriesInfo(slug) {
  if (!slug) return null;
  const clean = String(slug).replace(/[^a-z0-9-]/gi, "");
  const html = await fetchPage(`/series/${clean}`, TTL_SHORT);
  if (!html) return null;
  const flight = extractFlight(html);
  const episodes = extractPageVideos(html).map(normalizeVideo).filter(Boolean);
  if (!episodes.length) return null;

  episodes.sort((a, b) => (a.ep || 0) - (b.ep || 0));
  const first = episodes[0];

  // Optional: scrape the series hero (aliases) from the flight text
  let aliases = [];
  const aliasMatch = flight.match(/"children":\["Also known as ","((?:[^"\\]|\\.)*)"\]/);
  if (aliasMatch) {
    try { aliases = [JSON.parse(`"${aliasMatch[1]}"`)]; } catch { aliases = []; }
  }
  const totalViews = episodes.reduce((sum, e) => sum + (e.views || 0), 0);

  return {
    id: clean,
    type: "hentai",
    media_type: "hentai",
    title: first.title,
    poster: first.poster,
    banner: first.banner || first.poster,
    description: first.description,
    year: first.year,
    quality: first.quality,
    duration: first.duration,
    genres: first.genres,
    tags: first.tags,
    brand: first.brand,
    production: first.brand ? [first.brand] : [],
    language: first.language,
    censored: first.censored,
    rating: first.rating,
    vote_average: first.vote_average,
    views: totalViews,
    episodeCount: episodes.length,
    number_of_episodes: episodes.length,
    seasons: [{ seasonId: 1, seasonName: "Episodes", episodeCount: episodes.length }],
    status: "Released",
    released: first.released,
    aliases,
    episodes: episodes.map((e) => ({
      episodeId: e.slug,
      episode_no: e.ep,
      episode_number: e.ep,
      season_number: 1,
      title: `Episode ${e.ep}`,
      name: `${e.title} — Episode ${e.ep}`,
      overview: e.description,
      still_path: e.banner,
      thumb: e.banner,
      runtime: null,
      air_date: e.released,
      vote_average: e.rating || 0,
      isAired: true,
      embedUrl: e.embedUrl,
      slug: e.slug,
      language: e.language,
      duration: e.duration,
    })),
  };
}

/**
 * Episode detail: the episode itself + related videos from the episode page.
 * @param {string} slug episode slug, e.g. "kanojo-saimin-episode-1"
 */
export async function getEpisodeInfo(slug) {
  if (!slug) return null;
  const clean = String(slug).replace(/[^a-z0-9-]/gi, "");
  const html = await fetchPage(`/${clean}`, TTL_SHORT);
  if (!html) return null;
  const videos = extractPageVideos(html).map(normalizeVideo).filter(Boolean);
  const episode = videos.find((v) => v.slug === clean) || videos[0] || null;
  const related = videos.filter((v) => v.slug !== clean).slice(0, 12);
  return { episode, related };
}

/**
 * Everything the home page needs in one call (parallel fetches).
 */
export async function getHomeData() {
  const [trending, latest, mostViewed, upcoming, explore] = await Promise.all([
    getTrendingVideos(),
    getLatestVideos(1),
    getMostViewedVideos(1),
    getUpcomingVideos(),
    getExplore(),
  ]);

  const trendingResults = trending.results || [];
  const spotlights = trendingResults.slice(0, 10);

  return {
    spotlights,
    trending: {
      all: trendingResults.slice(0, 20),
      censored: trendingResults.filter((v) => v.censored).slice(0, 20),
      uncensored: trendingResults.filter((v) => !v.censored).slice(0, 20),
    },
    latest: {
      results: latest.results || [],
      total_pages: latest.total_pages || 1,
    },
    mostViewed: {
      results: mostViewed.results || [],
      total_pages: mostViewed.total_pages || 1,
    },
    topRated: (explore.series || []).slice(0, 10),
    upcoming: {
      results: (upcoming.results || []).slice(0, 12),
    },
    genres: explore.genres || [],
    series: explore.series || [],
  };
}

export { SITE_URL };
