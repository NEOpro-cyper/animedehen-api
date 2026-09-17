// ─── cache.js ───
// Tiny in-memory TTL cache with statistics and periodic sweeping.
// Replaces Next.js `fetch revalidate` semantics outside of Next.

const store = new Map(); // key -> { value, expires }
const stats = { hits: 0, misses: 0 };

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) {
    stats.misses++;
    return undefined;
  }
  if (Date.now() > entry.expires) {
    store.delete(key);
    stats.misses++;
    return undefined;
  }
  stats.hits++;
  return entry.value;
}

export function cacheSet(key, value, ttlSeconds) {
  if (!value) return;
  store.set(key, {
    value,
    expires: Date.now() + Math.max(1, ttlSeconds) * 1000,
  });
}

/** Get-or-compute with in-flight request deduplication. */
const inflight = new Map();

export async function cached(key, ttlSeconds, producer) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    try {
      const value = await producer();
      cacheSet(key, value, ttlSeconds);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

export function cacheStats() {
  return {
    entries: store.size,
    inflight: inflight.size,
    hits: stats.hits,
    misses: stats.misses,
  };
}

// Periodic sweep of expired entries (every 10 minutes, never keeps the process alive)
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expires) store.delete(key);
  }
}, SWEEP_INTERVAL_MS);
if (sweeper.unref) sweeper.unref();
