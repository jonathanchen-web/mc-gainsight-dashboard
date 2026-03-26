// Vercel serverless function — Gainsight PX API proxy with server-side caching
// Runs on Vercel's servers (no CORS, no browser rate limits)
// All visitors share one server-side cache that refreshes every hour

const API_KEY = process.env.GAINSIGHT_PX_API_KEY;
const BASE_URL = 'https://api.aptrinsic.com/v1';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// In-memory server cache — shared across all visitors on the same warm instance
let cache = null;
let cacheTime = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Paginate through all results using Gainsight's scrollId mechanism
async function fetchAll(endpoint, key) {
  const all = [];
  let scrollId = null;
  const maxPages = 10; // safety limit

  for (let page = 0; page < maxPages; page++) {
    const url = scrollId
      ? `${BASE_URL}/${endpoint}?scrollId=${encodeURIComponent(scrollId)}`
      : `${BASE_URL}/${endpoint}?pageSize=200`;

    const res = await fetch(url, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });

    if (!res.ok) {
      throw new Error(`Gainsight /${endpoint} returned ${res.status}`);
    }

    const data = await res.json();
    const items = data[key] || [];
    all.push(...items);

    // Stop if no more results or no scrollId for next page
    if (items.length === 0 || !data.scrollId) break;
    scrollId = data.scrollId;

    await sleep(400); // rate-limit courtesy
  }

  return all;
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Force-refresh query param: /api/gainsight-proxy?refresh=true
  const forceRefresh = req.query?.refresh === 'true';

  // Return cached data if still fresh
  if (!forceRefresh && cache && (Date.now() - cacheTime) < CACHE_TTL_MS) {
    const ageMin = Math.round((Date.now() - cacheTime) / 60000);
    const nextMin = Math.round((CACHE_TTL_MS - (Date.now() - cacheTime)) / 60000);
    return res.status(200).json({
      users: cache.users,
      accounts: cache.accounts,
      cached: true,
      fetchedAt: cacheTime,
      cacheAgeMin: ageMin,
      nextRefreshMin: nextMin,
    });
  }

  if (!API_KEY) {
    return res.status(500).json({ error: 'GAINSIGHT_PX_API_KEY environment variable not set' });
  }

  try {
    // Fetch ALL users (paginated)
    const users = await fetchAll('users', 'users');

    await sleep(600);

    // Fetch ALL accounts (paginated)
    const accounts = await fetchAll('accounts', 'accounts');

    // Store in server cache
    cache = { users, accounts };
    cacheTime = Date.now();

    return res.status(200).json({
      users: cache.users,
      accounts: cache.accounts,
      cached: false,
      fetchedAt: cacheTime,
      cacheAgeMin: 0,
      nextRefreshMin: 60,
    });
  } catch (err) {
    // If we have stale cache, return it rather than failing
    if (cache) {
      const ageMin = Math.round((Date.now() - cacheTime) / 60000);
      return res.status(200).json({
        users: cache.users,
        accounts: cache.accounts,
        cached: true,
        stale: true,
        fetchedAt: cacheTime,
        cacheAgeMin: ageMin,
        error: err.message,
      });
    }

    return res.status(502).json({ error: err.message });
  }
}
