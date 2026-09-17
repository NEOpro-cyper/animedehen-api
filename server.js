// ─── server.js ───
// TaroFlix Data API — standalone Express server.
//
// Host this on a heavy VPS; the TaroFlix site only needs NEXT_PUBLIC_API_URL
// pointed at it. All animeidhentai.com scraping + caching happens here, so the
// site server stays light and browsers hit this API directly.
//
// Endpoints:
//   GET /health                  → liveness + cache stats
//   GET /                        → endpoint docs (JSON)
//   GET /api/hentai?action=...   → compat endpoint (same contract the site uses)
//   REST aliases:
//     GET /api/home
//     GET /api/trending
//     GET /api/latest?page=
//     GET /api/viewed?page=
//     GET /api/rated?page=
//     GET /api/upcoming
//     GET /api/genres
//     GET /api/genre?genre=&page=
//     GET /api/browse?page=&sort=&genre=&genre=...
//     GET /api/series/:slug        (or ?slug=)
//     GET /api/episode/:slug       (or ?slug=)
//     GET /api/search?q=&limit=

import express from "express";
import {
  getTrendingVideos,
  getBrowse,
  getLatestVideos,
  getMostViewedVideos,
  getTopRatedVideos,
  getVideosByGenre,
  getUpcomingVideos,
  getGenres,
  getSeriesInfo,
  getEpisodeInfo,
  searchVideos,
  getHomeData,
  SITE_URL,
} from "./scraper.js";
import { cacheStats } from "./cache.js";

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT) || 4000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"; // e.g. https://your-site.com
const API_KEY = process.env.API_KEY || ""; // optional shared secret

// ─── CORS ───
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── Optional API key gate ───
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const provided = req.get("x-api-key") || req.query.key;
  if (provided === API_KEY) return next();
  return res.status(401).json({ error: "Unauthorized — missing/invalid API key" });
});

// ─── Cache headers ───
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
  next();
});

// ─── Action dispatcher (shared by compat + REST routes) ───
async function dispatch(action, query) {
  const page = Math.max(1, Number(query.page) || 1);
  const q = query.q || "";
  const slug = query.slug || "";
  const genre = query.genre || "";
  const sort = query.sort || "Most Recent";
  const limit = Math.min(60, Number(query.limit) || 40);

  switch (action) {
    case "home":
      return getHomeData();
    case "trending":
      return getTrendingVideos();
    case "latest":
      return getLatestVideos(page);
    case "viewed":
      return getMostViewedVideos(page);
    case "rated":
      return getTopRatedVideos(page);
    case "upcoming":
      return getUpcomingVideos();
    case "genres":
      return { results: await getGenres() };
    case "genre":
      return getVideosByGenre(genre, page);
    case "browse": {
      // Accept repeated ?genre= params (comma-joined also works)
      let genres = query.genre;
      if (genres === undefined) genres = [];
      return getBrowse({ page, sort, genres });
    }
    case "series":
      return getSeriesInfo(slug);
    case "episode":
      return getEpisodeInfo(slug);
    case "search":
      return searchVideos(q, limit);
    default:
      throw Object.assign(new Error(`Unknown action: ${action}`), { status: 400 });
  }
}

// Repeated query params (?genre=A&genre=B) arrive as array or string — normalize.
function normalizeGenres(query) {
  const raw = query.genre;
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// ─── Compat endpoint: GET /api/hentai?action=... ───
app.get("/api/hentai", async (req, res) => {
  const action = req.query.action || "browse";
  try {
    const query = { ...req.query };
    if (action === "browse") query.genre = normalizeGenres(req.query);
    const data = await dispatch(action, query);
    res.json(data);
  } catch (err) {
    const status = err.status || 500;
    console.error(`[api] ${action} failed:`, err.message);
    res.status(status).json({ error: err.message, results: [] });
  }
});

// ─── REST aliases ───
const route = (path, action, transform = (q) => q) =>
  app.get(path, async (req, res) => {
    try {
      const data = await dispatch(action, transform(req.query));
      res.json(data);
    } catch (err) {
      const status = err.status || 500;
      console.error(`[api] ${action} failed:`, err.message);
      res.status(status).json({ error: err.message, results: [] });
    }
  });

route("/api/home", "home");
route("/api/trending", "trending");
route("/api/latest", "latest");
route("/api/viewed", "viewed");
route("/api/rated", "rated");
route("/api/upcoming", "upcoming");
route("/api/genres", "genres");
route("/api/genre", "genre");
route("/api/browse", "browse", (q) => ({ ...q, genre: normalizeGenres(q) }));
route("/api/search", "search");
route("/api/series", "series");
route("/api/episode", "episode");

// Path-param variants: /api/series/:slug, /api/episode/:slug
app.get("/api/series/:slug", async (req, res) => {
  try {
    res.json(await getSeriesInfo(req.params.slug));
  } catch (err) {
    res.status(500).json({ error: err.message, results: [] });
  }
});
app.get("/api/episode/:slug", async (req, res) => {
  try {
    res.json(await getEpisodeInfo(req.params.slug));
  } catch (err) {
    res.status(500).json({ error: err.message, results: [] });
  }
});

// ─── Health & docs ───
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    source: SITE_URL,
    cache: cacheStats(),
  });
});

app.get("/", (req, res) => {
  res.json({
    service: "TaroFlix Data API",
    endpoints: {
      compat: "GET /api/hentai?action=home|trending|latest|viewed|rated|upcoming|genres|genre|browse|series|episode|search",
      rest: [
        "GET /api/home",
        "GET /api/trending",
        "GET /api/latest?page=1",
        "GET /api/viewed?page=1",
        "GET /api/rated?page=1",
        "GET /api/upcoming",
        "GET /api/genres",
        "GET /api/genre?genre=Tentacles&page=1",
        "GET /api/browse?page=1&sort=Most Recent&genre=Tentacles",
        "GET /api/series/:slug",
        "GET /api/episode/:slug",
        "GET /api/search?q=query&limit=40",
      ],
      health: "GET /health",
    },
  });
});

// 404
app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));

app.listen(PORT, () => {
  console.log(`[taroflix-api] listening on :${PORT} (source: ${SITE_URL}, CORS: ${ALLOWED_ORIGIN}${API_KEY ? ", API key: on" : ""})`);
});
