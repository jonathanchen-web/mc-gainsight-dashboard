// Vercel serverless function — Gainsight PX API proxy with server-side caching
// Fetches users, accounts, features, and feature_match events
// Builds a per-user feature usage map from actual page visit data

const API_KEY = process.env.GAINSIGHT_PX_API_KEY;
const BASE_URL = 'https://api.aptrinsic.com/v1';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Top-level module IDs in Gainsight PX (direct children of app.manifestclimate.com)
const TOP_MODULES = {
  'dcac118f-d496-45e1-b612-ae9c276463ba': 'Workspace',
  'e8f9b98a-3835-44c9-9811-b4b505c5c779': 'Tracker',
  'a2a00aa0-653a-41c5-81fc-ca205f88925b': 'Compliance',
  '691a246d-6f29-402d-a378-c7ea57bee303': 'Resources',
  '1ce3e609-b39e-4af9-8848-8ee19575488d': 'Homepage',
};

let cache = null;
let cacheTime = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Paginate using Gainsight's scrollId mechanism
async function fetchAll(endpoint, key, maxPages = 10) {
  const all = [];
  let scrollId = null;

  for (let page = 0; page < maxPages; page++) {
    const url = scrollId
      ? `${BASE_URL}/${endpoint}?scrollId=${encodeURIComponent(scrollId)}`
      : `${BASE_URL}/${endpoint}?pageSize=200`;

    const res = await fetch(url, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });

    if (!res.ok) throw new Error(`Gainsight /${endpoint} returned ${res.status}`);

    const data = await res.json();
    const items = data[key] || [];
    all.push(...items);

    if (items.length === 0 || !data.scrollId) break;
    scrollId = data.scrollId;
    await sleep(400);
  }

  return all;
}

// Fetch feature_match events (uses same scrollId pagination)
async function fetchFeatureMatchEvents(maxPages = 20) {
  const all = [];
  let scrollId = null;

  for (let page = 0; page < maxPages; page++) {
    const url = scrollId
      ? `${BASE_URL}/events/feature_match?scrollId=${encodeURIComponent(scrollId)}`
      : `${BASE_URL}/events/feature_match?pageSize=200`;

    const res = await fetch(url, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });

    if (!res.ok) {
      // Don't fail the whole request if feature_match fails
      console.error(`feature_match returned ${res.status}`);
      break;
    }

    const data = await res.json();
    const items = data.featureMatchEvents || [];
    all.push(...items);

    if (items.length === 0 || !data.scrollId) break;
    scrollId = data.scrollId;
    await sleep(400);
  }

  return all;
}

// Build a lookup: featureId → top-level module name
// Walks up the parentFeatureId chain to find which top module each feature belongs to
function buildFeatureToModuleMap(features) {
  const byId = {};
  for (const f of features) {
    byId[f.id] = f;
  }

  const featureToModule = {};

  function findTopModule(featureId, visited = new Set()) {
    if (featureToModule[featureId]) return featureToModule[featureId];
    if (TOP_MODULES[featureId]) return TOP_MODULES[featureId];
    if (visited.has(featureId)) return null; // cycle guard
    visited.add(featureId);

    const feat = byId[featureId];
    if (!feat) return null;

    const parentId = feat.parentFeatureId;
    if (!parentId) return null;
    if (TOP_MODULES[parentId]) return TOP_MODULES[parentId];

    const result = findTopModule(parentId, visited);
    if (result) featureToModule[featureId] = result;
    return result;
  }

  for (const f of features) {
    const mod = findTopModule(f.id);
    if (mod) featureToModule[f.id] = mod;
  }

  return featureToModule;
}

// Convert raw feature_match events into compact format for the frontend:
// [{u: identifyId, m: moduleName, d: dateMs}, ...]
// This lets the frontend filter by time period dynamically
function compactFeatureEvents(featureMatchEvents, featureToModule) {
  const events = [];
  for (const evt of featureMatchEvents) {
    const module = featureToModule[evt.featureId];
    if (!evt.identifyId || !module) continue;
    events.push({ u: evt.identifyId, m: module, d: evt.date });
  }
  return events;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const forceRefresh = req.query?.refresh === 'true';

  if (!forceRefresh && cache && (Date.now() - cacheTime) < CACHE_TTL_MS) {
    const ageMin = Math.round((Date.now() - cacheTime) / 60000);
    const nextMin = Math.round((CACHE_TTL_MS - (Date.now() - cacheTime)) / 60000);
    return res.status(200).json({
      users: cache.users,
      accounts: cache.accounts,
      featureEvents: cache.featureEvents,
      cached: true,
      fetchedAt: cacheTime,
      cacheAgeMin: ageMin,
      nextRefreshMin: nextMin,
    });
  }

  if (!API_KEY) {
    return res.status(500).json({ error: 'GAINSIGHT_PX_API_KEY not set' });
  }

  try {
    // 1. Fetch users
    const users = await fetchAll('users', 'users');
    await sleep(500);

    // 2. Fetch accounts
    const accounts = await fetchAll('accounts', 'accounts');
    await sleep(500);

    // 3. Fetch features list (for hierarchy mapping)
    const featuresRes = await fetch(`${BASE_URL}/feature?pageSize=200`, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });
    const featuresData = featuresRes.ok ? await featuresRes.json() : { features: [] };
    const features = featuresData.features || [];
    await sleep(500);

    // 4. Build featureId → top-level module lookup
    const featureToModule = buildFeatureToModuleMap(features);

    // 5. Fetch feature_match events
    const featureMatchEvents = await fetchFeatureMatchEvents(20);

    // 6. Compact events: [{u: userId, m: module, d: dateMs}, ...]
    const featureEvents = compactFeatureEvents(featureMatchEvents, featureToModule);

    cache = { users, accounts, featureEvents };
    cacheTime = Date.now();

    return res.status(200).json({
      users: cache.users,
      accounts: cache.accounts,
      featureEvents: cache.featureEvents,
      cached: false,
      fetchedAt: cacheTime,
      cacheAgeMin: 0,
      nextRefreshMin: 60,
    });
  } catch (err) {
    if (cache) {
      const ageMin = Math.round((Date.now() - cacheTime) / 60000);
      return res.status(200).json({
        users: cache.users,
        accounts: cache.accounts,
        featureEvents: cache.featureEvents || [],
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
