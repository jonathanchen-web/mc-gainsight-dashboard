// Vercel serverless function — Gainsight PX API proxy with server-side caching
// Fetches users, accounts, features, and feature_match events for usage tracking
// Falls back to custom "View Page" events if feature_match returns insufficient data

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

// Fallback: map custom event names to modules (used if feature_match fails)
const EVENT_TO_MODULE = {
  'View Page - Workspace V2': 'Workspace',
  'View Page - Climate Profile': 'Workspace',
  'View Page - Climate Actions': 'Workspace',
  'View Page - Disclosure Index': 'Workspace',
  'View Page - Profile': 'Workspace',
  'View Page - All Disclosures': 'Compliance',
  'View Page - Disclosure Details': 'Compliance',
  'View Page - Select Standard(s)': 'Compliance',
  'View Page - Summary': 'Compliance',
  'View Page - Disclosure Search': 'Compliance',
  'View Page - Comparison View': 'Compliance',
  'View Page - Compliance Summary': 'Compliance',
  'View Page - Tracker Data View': 'Tracker',
  'View Page - Tracker Dashboard': 'Tracker',
  'View Page - Details Data': 'Tracker',
  'View Page - Details Your References': 'Tracker',
  'View Page - Details Notes': 'Tracker',
  'View Page - Home': 'Homepage',
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
    await sleep(250);
  }

  return all;
}

// Build a lookup: featureId → top-level module name
function buildFeatureToModuleMap(features) {
  const byId = {};
  for (const f of features) byId[f.id] = f;

  const featureToModule = {};

  function findTopModule(featureId, visited = new Set()) {
    if (featureToModule[featureId]) return featureToModule[featureId];
    if (TOP_MODULES[featureId]) return TOP_MODULES[featureId];
    if (visited.has(featureId)) return null;
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

// Fetch feature_match events with explicit 6-month date range
async function fetchFeatureMatchEvents(maxPages = 20) {
  const all = [];
  let scrollId = null;
  const now = Date.now();
  const sixMonthsAgo = now - (180 * 24 * 60 * 60 * 1000);

  for (let page = 0; page < maxPages; page++) {
    const url = scrollId
      ? `${BASE_URL}/events/feature_match?scrollId=${encodeURIComponent(scrollId)}`
      : `${BASE_URL}/events/feature_match?pageSize=500&dateRangeStart=${sixMonthsAgo}&dateRangeEnd=${now}`;

    const res = await fetch(url, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });

    if (!res.ok) {
      console.error(`feature_match returned ${res.status}`);
      break;
    }

    const data = await res.json();
    const items = data.featureMatchEvents || [];
    all.push(...items);

    if (items.length === 0 || !data.scrollId) break;
    scrollId = data.scrollId;
    await sleep(250);
  }

  console.log(`[proxy] feature_match: fetched ${all.length} raw events`);
  return all;
}

// Convert feature_match events to compact format using hierarchy mapping
function compactFeatureEvents(featureMatchEvents, featureToModule) {
  const events = [];
  let noModule = 0;
  for (const evt of featureMatchEvents) {
    if (!evt.identifyId) continue;
    const module = featureToModule[evt.featureId];
    if (!module) { noModule++; continue; }
    events.push({ u: evt.identifyId, m: module, d: evt.date });
  }
  console.log(`[proxy] feature_match compacted: ${events.length} mapped, ${noModule} unmapped`);
  return events;
}

// Fallback: fetch custom "View Page" events mapped to modules
async function fetchCustomPageViewEvents(maxPages = 15) {
  const events = [];
  let scrollId = null;
  let totalRaw = 0;
  const now = Date.now();
  const sixMonthsAgo = now - (180 * 24 * 60 * 60 * 1000);

  for (let page = 0; page < maxPages; page++) {
    const url = scrollId
      ? `${BASE_URL}/events/custom?scrollId=${encodeURIComponent(scrollId)}`
      : `${BASE_URL}/events/custom?pageSize=1000&dateRangeStart=${sixMonthsAgo}&dateRangeEnd=${now}`;

    const res = await fetch(url, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });

    if (!res.ok) { console.error(`custom events returned ${res.status}`); break; }

    const data = await res.json();
    const items = data.customEvents || [];
    totalRaw += items.length;

    for (const evt of items) {
      const module = EVENT_TO_MODULE[evt.eventName];
      if (module && evt.identifyId) {
        events.push({ u: evt.identifyId, m: module, d: evt.date });
      }
    }

    if (items.length === 0 || !data.scrollId) break;
    scrollId = data.scrollId;
    await sleep(250);
  }

  console.log(`[proxy] Custom events fallback: ${totalRaw} raw, ${events.length} mapped`);
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
    await sleep(300);

    // 2. Fetch accounts
    const accounts = await fetchAll('accounts', 'accounts');
    await sleep(300);

    // 3. Fetch ALL features (paginated) for hierarchy mapping
    const featuresRes1 = await fetch(`${BASE_URL}/feature?pageSize=200&pageNumber=0`, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });
    const fd1 = featuresRes1.ok ? await featuresRes1.json() : { features: [], isLastPage: true };
    const features = fd1.features || [];
    if (!fd1.isLastPage) {
      await sleep(250);
      const featuresRes2 = await fetch(`${BASE_URL}/feature?pageSize=200&pageNumber=1`, {
        headers: { 'X-APTRINSIC-API-KEY': API_KEY },
      });
      if (featuresRes2.ok) {
        const fd2 = await featuresRes2.json();
        features.push(...(fd2.features || []));
      }
    }
    console.log(`[proxy] Fetched ${features.length} features`);

    // 4. Build featureId → module lookup
    const featureToModule = buildFeatureToModuleMap(features);
    await sleep(300);

    // 5. Try feature_match events first (matches Gainsight PX UI)
    let featureEvents = [];
    let dataSource = 'feature_match';
    const featureMatchEvents = await fetchFeatureMatchEvents(20);

    if (featureMatchEvents.length > 0) {
      featureEvents = compactFeatureEvents(featureMatchEvents, featureToModule);
    }

    // 6. If feature_match returned too little data, fall back to custom events
    if (featureEvents.length < 20) {
      console.log(`[proxy] feature_match only returned ${featureEvents.length} events, falling back to custom events`);
      await sleep(300);
      featureEvents = await fetchCustomPageViewEvents(15);
      dataSource = 'custom_events';
    }

    // Debug: count per module
    const moduleCounts = {};
    const uniqueUsers = new Set();
    for (const evt of featureEvents) {
      moduleCounts[evt.m] = (moduleCounts[evt.m] || 0) + 1;
      uniqueUsers.add(evt.u);
    }
    console.log(`[proxy] Final (${dataSource}): ${JSON.stringify(moduleCounts)}, ${uniqueUsers.size} users`);

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
      _debug: { dataSource, mappedEvents: featureEvents.length, uniqueUsers: uniqueUsers.size, moduleCounts, features: features.length },
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
