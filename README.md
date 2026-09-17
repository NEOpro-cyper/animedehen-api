# TaroFlix Data API

Standalone API server for TaroFlix. Host this on a **heavy VPS** and point the
site at it with a single env var — the site's own server then does **no
scraping at all**, and visitor browsers call this API directly (CORS-enabled).
That splits the load: site VPS = light frontend + accounts, API VPS = all
catalog scraping & caching.

The API fetches [animeidhentai.com](https://animeidhentai.com), decodes its RSC
flight payloads, normalizes the data into the shapes TaroFlix expects, caches
everything in memory (with in-flight request deduplication) and serves JSON.

## Endpoints

| Endpoint | Params | Returns |
|----------|--------|---------|
| `GET /api/home` | — | everything the home page needs (spotlights, trending, latest, most-viewed, top-rated series, upcoming, genres) |
| `GET /api/trending` | — | ~60 trending episodes |
| `GET /api/latest` | `page` | browse page sorted by Most Recent (28/page) |
| `GET /api/viewed` | `page` | browse page sorted by Most Viewed |
| `GET /api/rated` | `page` | browse page sorted by Top Rated |
| `GET /api/upcoming` | — | release-calendar entries |
| `GET /api/genres` | — | ~212 filterable tags with counts |
| `GET /api/genre` | `genre`, `page` | videos of one tag |
| `GET /api/browse` | `page`, `sort`, `genre` (repeatable) | browse with filters (`sort`: Most Recent / Most Viewed / Top Rated) |
| `GET /api/series/:slug` | — | series metadata + all episodes (with embed URLs) |
| `GET /api/episode/:slug` | — | episode + related videos |
| `GET /api/search` | `q`, `limit` | episode search results |
| `GET /health` | — | liveness + cache stats |
| `GET /` | — | endpoint docs |

**Compat:** `GET /api/hentai?action=<action>&...` accepts the exact same
actions (`home`, `trending`, `latest`, `viewed`, `rated`, `upcoming`,
`genres`, `genre`, `browse`, `series`, `episode`, `search`) — this is the
endpoint the TaroFlix site calls.

## Quick start (on the API VPS)

```bash
npm install        # only dependency: express
npm start          # listens on :4000
```

Requires **Node.js 18+** (global fetch).

Test it:

```bash
curl http://localhost:4000/health
curl "http://localhost:4000/api/trending" | head -c 400
curl "http://localhost:4000/api/search?q=kanojo"
```

## Configuration (env vars)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `4000` | listen port |
| `SITE_URL` | `https://animeidhentai.com` | source site to scrape |
| `ALLOWED_ORIGIN` | `*` | CORS origin — set to your site URL in production, e.g. `https://mysite.com` |
| `API_KEY` | *(empty)* | optional; when set every request needs `x-api-key: <key>` header or `?key=` |
| `CACHE_TTL_SHORT` | `300` | series/episode/search cache seconds |
| `CACHE_TTL_MED` | `900` | trending/browse cache seconds |
| `CACHE_TTL_LONG` | `86400` | genres cache seconds |

Copy `.env.example` to `.env` and adjust — the server reads plain environment
variables (use your process manager to load them).

## Keep it running (pick one)

**pm2 (recommended):**

```bash
npm install -g pm2
pm2 start server.js --name taroflix-api
pm2 save && pm2 startup     # auto-restart on reboot
```

**systemd:** create `/etc/systemd/system/taroflix-api.service`:

```ini
[Unit]
Description=TaroFlix Data API
After=network.target

[Service]
WorkingDirectory=/opt/taroflix-api
ExecStart=/usr/bin/node server.js
Environment=PORT=4000
Environment=ALLOWED_ORIGIN=https://your-site.com
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now taroflix-api
```

**Docker:**

```bash
docker build -t taroflix-api .
docker run -d -p 4000:4000 -e ALLOWED_ORIGIN=https://your-site.com --restart unless-stopped --name taroflix-api taroflix-api
```

## Put nginx (or a CDN) in front (optional but recommended)

```nginx
server {
    listen 443 ssl http2;
    server_name api.your-site.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Then `ALLOWED_ORIGIN=https://your-site.com` and point the site at
`https://api.your-site.com`.

## Connect the site (light frontend VPS)

In the **site** project's `.env`:

```env
NEXT_PUBLIC_API_URL="https://api.your-site.com"
```

That's the only configuration the site needs for catalog/stream data. All
browser traffic for browsing/searching/watching goes straight to this API;
the site's Next.js server only renders shells and serves accounts/comments
(its own database).

## Notes

- All catalog/stream data belongs to animeidhentai.com; this API only links to
  and exposes their public data, and caches responses briefly in memory.
- Identical concurrent requests are deduplicated (one upstream fetch, shared
  by all waiters) — protects the source site under load.
- `/health` shows cache hit/miss stats — useful for load monitoring.
