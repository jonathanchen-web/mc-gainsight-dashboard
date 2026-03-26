// Vercel serverless function — Gainsight PX API proxy with server-side caching
// Runs on Vercel's servers (no CORS, no browser rate limits)
// All visitors share one server-side cache that refreshes every hour

const API_KEY = process.env.GAINSIGHT_PX_API_KEY;
const BASE_URL = 'https://api.aptrinsic.com/v1';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Top-level feature module IDs in Gainsight PX (under app.manifestclimate.com)
const FEATURE_MODULES = {
  Workspace:  'dcac118f-d496-45e1-b612-ae9c276463ba',
  Tracker:    'e8f9b98a-3835-44c9-9811-b4b505c5c779',
  Compliance: 'a2a00aa0-653a-41c5-81fc-ca205f88925b',
};

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

// Fetch feature match data for a module — tries /feature/{id}/stats endpoint
// Returns { userCount, visitCount, users } or null if endpoint doesn't exist
async function fetchFeatureStats(featureId) {
  try {
    // Try the feature stats/users endpoint
    const url = `${BASE_URL}/feature/${featureId}/stats`;
    const res = await fetch(url, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });
    if (res.ok) {
      return await res.json();
    }
    return null;
  } catch {
    return null;
  }
}

// Fetch all feature match events for a specific feature module
// Uses the /analytics/feature/featureMatch endpoint
async function fetchFeatureUsers(featureId) {
  try {
    const url = `${BASE_URL}/analytics/features/${featureId}/users?pageSize=500`;
    const res = await fetch(url, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });
    if (res.ok) {
      return await res.json();
    }
    return null;
  } catch {
    return null;
  }
}

// Fetch the full features list to build the hierarchy tree
async function fetchFeatures() {
  const url = `${BASE_URL}/feature?pageSize=200`;
  const res = await fetch(url, {
    headers: { 'X-APTRINSIC-API-KEY': API_KEY },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.features || [];
}

// Build a map of userId → [top-level feature names] based on feature hierarchy
// Walks the tree: for each child feature of a top module, fetch its users
async function buildFeatureUserMap(features) {
  const featureUserMap = {}; // userId → Set of top-level feature names
  const debugInfo = { endpoints_tried: [], endpoints_worked: [] };

  for (const [moduleName, moduleId] of Object.entries(FEATURE_MODULES)) {
    // Get all descendant feature IDs for this module
    const descendantIds = getAllDescendants(features, moduleId);
    descendantIds.push(moduleId); // include the module itself

    // Try fetching users for the module-level feature
    await sleep(300);
    const statsResult = await fetchFeatureStats(moduleId);
    debugInfo.endpoints_tried.push(`/feature/${moduleId}/stats`);
    if (statsResult) {
      debugInfo.endpoints_worked.push({ endpoint: `/feature/${moduleId}/stats`, result: statsResult });
    }

    await sleep(300);
    const usersResult = await fetchFeatureUsers(moduleId);
    debugInfo.endpoints_tried.push(`/analytics/features/${moduleId}/users`);
    if (usersResult) {
      debugInfo.endpoints_worked.push({ endpoint: `/analytics/features/${moduleId}/users`, keys: Object.keys(usersResult) });
      // Try to extract user IDs from the response
      const userIds = extractUserIds(usersResult);
      for (const uid of userIds) {
        if (!featureUserMap[uid]) featureUserMap[uid] = new Set();
        featureUserMap[uid].add(moduleName);
      }
    }
  }

  // Convert Sets to arrays for JSON serialization
  const serializable = {};
  for (const [uid, feats] of Object.entries(featureUserMap)) {
    serializable[uid] = [...feats];
  }

  return { featureUserMap: serializable, debugInfo };
}

function getAllDescendants(features, parentId) {
  const children = features.filter(f => f.parentFeatureId === parentId);
  const ids = children.map(c => c.id);
  for (const child of children) {
    ids.push(...getAllDescendants(features, child.id));
  }
  return ids;
}

function extractUserIds(data) {
  // Try various response shapes
  if (Array.isArray(data)) return data.map(u => u.identifyId || u.userId || u.id).filter(Boolean);
  if (data.users) return data.users.map(u => u.identifyId || u.userId || u.id).filter(Boolean);
  if (data.results) return data.results.map(u => u.identifyId || u.userId || u.id).filter(Boolean);
  return [];
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
      featureUserMap: cache.featureUserMap || {},
      featureDebug: cache.featureDebug || {},
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

    await sleep(600);

    // Fetch features list and try to build feature-user mapping
    const features = await fetchFeatures();

    await sleep(600);

    const { featureUserMap, debugInfo } = await buildFeatureUserMap(features);

    // Store in server cache
    cache = { users, accounts, featureUserMap, featureDebug: debugInfo };
    cacheTime = Date.now();

    return res.status(200).json({
      users: cache.users,
      accounts: cache.accounts,
      featureUserMap: cache.featureUserMap,
      featureDebug: cache.featureDebug,
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
        featureUserMap: cache.featureUserMap || {},
        featureDebug: cache.featureDebug || {},
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
