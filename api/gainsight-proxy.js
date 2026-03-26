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
    // Fetch users
    const usersRes = await fetch(`${BASE_URL}/users?pageSize=200`, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });
    if (!usersRes.ok) {
      throw new Error(`Gainsight /users returned ${usersRes.status}`);
    }
    const usersData = await usersRes.json();

    await sleep(600);

    // Fetch accounts
    const accountsRes = await fetch(`${BASE_URL}/accounts?pageSize=200`, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });
    if (!accountsRes.ok) {
      throw new Error(`Gainsight /accounts returned ${accountsRes.status}`);
    }
    const accountsData = await accountsRes.json();

    // Store in server cache
    cache = {
      users: usersData.users || [],
      accounts: accountsData.accounts || [],
    };
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
