// src/cache.js
// Redis cache with in-memory fallback

import Redis from "ioredis";

const CACHE_TTL_S = 5 * 60; // 5 minutes

// ─── In-memory fallback ───────────────────────────────────────────────────
const memCache = new Map();

function memGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) { memCache.delete(key); return null; }
  return entry.data;
}

function memSet(key, data) {
  memCache.set(key, { data, expiry: Date.now() + CACHE_TTL_S * 1000 });
}

// ─── Limit in-memory cache size to prevent memory leak ───────────────────
const MAX_MEM_ENTRIES = 200;
function pruneMemCache() {
  if (memCache.size > MAX_MEM_ENTRIES) {
    // Delete 20% oldest entries
    const toPrune = Math.floor(MAX_MEM_ENTRIES * 0.2);
    let pruned = 0;
    for (const key of memCache.keys()) {
      if (pruned >= toPrune) break;
      memCache.delete(key);
      pruned++;
    }
  }
}

// ─── Redis client ─────────────────────────────────────────────────────────
let redis = null;
let redisHealthy = false;

export async function initRedis() {
  const url = process.env.REDIS_URL || "redis://localhost:6379";
  try {
    redis = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false, // Don't queue commands when connection is lost
    });

    redis.on("error", (err) => {
      if (redisHealthy) {
        console.warn(`[Redis] ⚠️ ${err.message} — fallback to memory cache`);
        redisHealthy = false;
      }
    });

    redis.on("connect", () => {
      redisHealthy = true;
      console.log("[Redis] ✅ Reconnected");
    });

    await redis.connect();
    await redis.ping();
    redisHealthy = true;
    console.log("[Redis] ✅ Connected:", url);
    return true;
  } catch (err) {
    console.warn(`[Redis] ❌ Connection failed (${err.message}) — using in-memory cache`);
    redis = null;
    redisHealthy = false;
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────
export async function cacheGet(key) {
  if (redis && redisHealthy) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        console.log(`[Cache HIT Redis] ${key}`);
        return JSON.parse(raw);
      }
    } catch (e) {
      redisHealthy = false;
      console.warn("[Redis] get failed:", e.message);
    }
  }
  const mem = memGet(key);
  if (mem) console.log(`[Cache HIT Mem] ${key}`);
  return mem;
}

export async function cacheSet(key, data) {
  if (redis && redisHealthy) {
    try {
      await redis.set(key, JSON.stringify(data), "EX", CACHE_TTL_S);
      return;
    } catch (e) {
      redisHealthy = false;
      console.warn("[Redis] set failed:", e.message);
    }
  }
  pruneMemCache();
  memSet(key, data);
}
