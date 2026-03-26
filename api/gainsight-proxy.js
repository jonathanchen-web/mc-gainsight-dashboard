// Vercel serverless function — Gainsight PX API proxy with server-side caching
// Fetches users, accounts, and custom "View Page" events for feature usage tracking

const API_KEY = process.env.GAINSIGHT_PX_API_KEY;
const BASE_URL = 'https://api.aptrinsic.com/v1';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Map custom event names to top-level product modules
// These are "View Page - *" events fired by the Manifest Climate app
const EVENT_TO_MODULE = {
  // Workspace
  'View Page - Workspace V2': 'Workspace',
  'View Page - Climate Profile': 'Workspace',
  'View Page - Climate Actions': 'Workspace',
  'View Page - Disclosure Index': 'Workspace',
  'View Page - Profile': 'Workspace',
  // Compliance
  'View Page - All Disclosures': 'Compliance',
  'View Page - Disclosure Details': 'Compliance',
  'View Page - Select Standard(s)': 'Compliance',
  'View Page - Summary': 'Compliance',
  'View Page - Disclosure Search': 'Compliance',
  'View Page - Comparison View': 'Compliance',
  'View Page - Compliance Summary': 'Compliance',
  // Tracker
  'View Page - Tracker Data View': 'Tracker',
  'View Page - Tracker Dashboard': 'Tracker',
  'View Page - Details Data': 'Tracker',
  'View Page - Details Your References': 'Tracker',
  'View Page - Details Notes': 'Tracker',
  // Homepage
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

// Fetch custom events and extract "View Page" events mapped to modules
// Uses scrollId pagination; default 30-day window from the API
async function fetchPageViewEvents(maxPages = 15) {
  const events = [];
  let scrollId = null;
  let totalRaw = 0;
  let unmapped = 0;
  const unmappedNames = new Set();

  for (let page = 0; page < maxPages; page++) {
    const url = scrollId
      ? `${BASE_URL}/events/custom?scrollId=${encodeURIComponent(scrollId)}`
      : `${BASE_URL}/events/custom?pageSize=1000`;

    const res = await fetch(url, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });

    if (!res.ok) {
      console.error(`custom events returned ${res.status}`);
      break;
    }

    const data = await res.json();
    const items = data.customEvents || [];
    totalRaw += items.length;

    // Only keep "View Page" events that map to a known module
    for (const evt of items) {
      const module = EVENT_TO_MODULE[evt.eventName];
      if (module && evt.identifyId) {
        events.push({ u: evt.identifyId, m: module, d: evt.date });
      } else if (evt.eventName && evt.eventName.startsWith('View Page') && !EVENT_TO_MODULE[evt.eventName]) {
        unmapped++;
        unmappedNames.add(evt.eventName);
      }
    }

    if (items.length === 0 || !data.scrollId) break;
    scrollId = data.scrollId;
    await sleep(250);
  }

  console.log(`[proxy] Custom events: ${totalRaw} raw, ${events.length} mapped page views`);
  if (unmappedNames.size > 0) {
    console.log(`[proxy] Unmapped View Page events (${unmapped}): ${[...unmappedNames].join(', ')}`);
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
    await sleep(300);

    // 2. Fetch accounts
    const accounts = await fetchAll('accounts', 'accounts');
    await sleep(300);

    // 3. Fetch custom "View Page" events mapped to modules
    const featureEvents = await fetchPageViewEvents(15);

    // Count events per module for debugging
    const moduleCounts = {};
    const uniqueUsers = new Set();
    for (const evt of featureEvents) {
      moduleCounts[evt.m] = (moduleCounts[evt.m] || 0) + 1;
      uniqueUsers.add(evt.u);
    }
    console.log(`[proxy] Module counts: ${JSON.stringify(moduleCounts)}, unique users: ${uniqueUsers.size}`);

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
      _debug: { mappedEvents: featureEvents.length, uniqueUsers: uniqueUsers.size, moduleCounts },
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
