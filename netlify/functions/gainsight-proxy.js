// Netlify serverless function — Gainsight PX API proxy with server-side caching
// Runs on Netlify's servers (no CORS, no browser rate limits)
// All visitors share one server-side cache that refreshes every hour

const API_KEY = 'da04b75e-f96a-4eab-bdcb-dd9cb0f7e2f0';
const BASE_URL = 'https://api.aptrinsic.com/v1';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// In-memory server cache — shared across all visitors on the same warm instance
let cache = null;
let cacheTime = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Force-refresh query param: /.netlify/functions/gainsight-proxy?refresh=true
  const forceRefresh = event.queryStringParameters?.refresh === 'true';

  // Return cached data if still fresh
  if (!forceRefresh && cache && (Date.now() - cacheTime) < CACHE_TTL_MS) {
    const ageMin = Math.round((Date.now() - cacheTime) / 60000);
    const nextMin = Math.round((CACHE_TTL_MS - (Date.now() - cacheTime)) / 60000);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        users: cache.users,
        accounts: cache.accounts,
        cached: true,
        fetchedAt: cacheTime,
        cacheAgeMin: ageMin,
        nextRefreshMin: nextMin,
      }),
    };
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        users: cache.users,
        accounts: cache.accounts,
        cached: false,
        fetchedAt: cacheTime,
        cacheAgeMin: 0,
        nextRefreshMin: 60,
      }),
    };
  } catch (err) {
    // If we have stale cache, return it rather than failing
    if (cache) {
      const ageMin = Math.round((Date.now() - cacheTime) / 60000);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          users: cache.users,
          accounts: cache.accounts,
          cached: true,
          stale: true,
          fetchedAt: cacheTime,
          cacheAgeMin: ageMin,
          error: err.message,
        }),
      };
    }

    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
