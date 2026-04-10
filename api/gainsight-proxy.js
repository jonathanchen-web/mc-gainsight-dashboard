// Vercel serverless function — Gainsight PX API proxy with server-side caching
// Fetches users, accounts, and custom "View Page" events for usage tracking

const API_KEY = process.env.GAINSIGHT_PX_API_KEY;
const BASE_URL = 'https://api.aptrinsic.com/v1';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Map custom event names to top-level product modules.
// Kept as a FALLBACK classifier — primary classification is URL-based
// (see urlToModule below) which matches Gainsight PX's native top-level
// module hierarchy: workspace, tracker, compliance, integrations.
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

// URL-path classifier. Mirrors Gainsight PX's native MODULE hierarchy:
//   MODULE:workspace   → climateprofile, climate action, progress,
//                        disclosureindex, workspace summary, climate action details
//   MODULE:tracker     → data, insights, pdfviewer, best practices
//   MODULE:compliance  → disclosure-search, compare, runassessment, details,
//                        assessment, summary, disclosures
//   MODULE:integrations (top-level if routed under /integrations)
// "Time on Page" custom events carry the real page URL in attributes.URL,
// which lets us classify ANY navigation — not just the 18 curated
// "View Page - ..." events we used to hardcode.
//
// Each entry:  [prefix, moduleName, subFeatureName]
// The sub-feature names match the dashboard's SUB_TO_PARENT / FEATURE_HIERARCHY.subs
// so that filtered sub-feature counts roll up to the correct top-level module.
const URL_PREFIX_TO_MODULE = [
  // Workspace
  ['/workspace/climateaction',  'Workspace',    'ClimateAction'],
  ['/workspace/climate-action', 'Workspace',    'ClimateAction'],
  ['/workspace/takeaction',     'Workspace',    'ClimateAction'],
  ['/workspace/disclosureindex','Workspace',    'DisclosureIndex'],
  ['/workspace/climateprofile', 'Workspace',    'ClimateProfile'],
  ['/workspace/climatestory',   'Workspace',    'ClimateProfile'],
  ['/workspace/progress',       'Workspace',    'Progress'],
  ['/workspace/summary',        'Workspace',    'ClimateProfile'],
  ['/workspace',                'Workspace',    'ClimateAction'],
  ['/climateaction',            'Workspace',    'ClimateAction'],
  ['/climate-action',           'Workspace',    'ClimateAction'],
  ['/climateprofile',           'Workspace',    'ClimateProfile'],
  ['/disclosureindex',          'Workspace',    'DisclosureIndex'],
  ['/progress',                 'Workspace',    'Progress'],
  // Tracker
  ['/tracker/data',             'Tracker',      'Data'],
  ['/tracker/insights',         'Tracker',      'Insights'],
  ['/tracker/bestpractices',    'Tracker',      'BestPractices'],
  ['/tracker/best-practices',   'Tracker',      'BestPractices'],
  ['/tracker/pdfviewer',        'Tracker',      'BestPractices'],
  ['/tracker',                  'Tracker',      'Data'],
  ['/data',                     'Tracker',      'Data'],
  ['/insights',                 'Tracker',      'Insights'],
  ['/bestpractices',            'Tracker',      'BestPractices'],
  ['/best-practices',           'Tracker',      'BestPractices'],
  ['/pdfviewer',                'Tracker',      'BestPractices'],
  // Compliance
  ['/compliance/disclosure-search','Compliance','DisclosureSearch'],
  ['/compliance/compare',       'Compliance',   'Compare'],
  ['/compliance/runassessment', 'Compliance',   'Assessments'],
  ['/compliance/assessment',    'Compliance',   'Assessments'],
  ['/compliance/details',       'Compliance',   'Assessments'],
  ['/compliance/summary',       'Compliance',   'Assessments'],
  ['/compliance/disclosures',   'Compliance',   'Assessments'],
  ['/compliance',               'Compliance',   'Assessments'],
  ['/disclosure-search',        'Compliance',   'DisclosureSearch'],
  ['/disclosures',              'Compliance',   'Assessments'],
  ['/assessment',               'Compliance',   'Assessments'],
  ['/runassessment',            'Compliance',   'Assessments'],
  ['/summary',                  'Compliance',   'Assessments'],
  ['/compare',                  'Compliance',   'Compare'],
  ['/details',                  'Compliance',   'Assessments'],
  // Integrations
  ['/integrations',             'Integrations', 'Integrations'],
  ['/integration',              'Integrations', 'Integrations'],
  ['/mcp',                      'Integrations', 'Integrations'],
  // Homepage
  ['/dashboard',                'Homepage',     null],
  ['/home',                     'Homepage',     null],
];

function urlToClassification(url) {
  if (!url) return null;
  let u = String(url).toLowerCase().trim();
  // Strip query string and fragment
  const qIdx = u.indexOf('?'); if (qIdx >= 0) u = u.slice(0, qIdx);
  const hIdx = u.indexOf('#'); if (hIdx >= 0) u = u.slice(0, hIdx);
  // Strip hash-route prefix "/#/..." → "/..."
  if (u.startsWith('/#/')) u = u.slice(2);
  // Normalize to always start with /
  if (!u.startsWith('/')) u = '/' + u;
  for (const [prefix, mod, sub] of URL_PREFIX_TO_MODULE) {
    if (u === prefix || u.startsWith(prefix + '/') || u.startsWith(prefix + '?')) {
      return { m: mod, s: sub };
    }
  }
  if (u === '/' || u === '') return { m: 'Homepage', s: null };
  return null;
}

function classifyEvent(evt) {
  // 1) URL-based (covers "Time on Page" and any event with a URL attr)
  const url = (evt.attributes && (evt.attributes.URL || evt.attributes.url)) || evt.url;
  const byUrl = urlToClassification(url);
  if (byUrl) return byUrl;
  // 2) Event-name fallback
  const mod = EVENT_TO_MODULE[evt.eventName];
  if (mod) return { m: mod, s: null };
  return null;
}

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

    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url, {
        headers: { 'X-APTRINSIC-API-KEY': API_KEY },
      });
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
        const waitMs = retryAfter ? retryAfter * 1000 : (attempt + 1) * 5000;
        console.log(`Rate limited on /${endpoint}, waiting ${waitMs}ms (attempt ${attempt + 1}/3)`);
        await sleep(waitMs);
        continue;
      }
      break;
    }

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

// Fetch custom events (Time on Page + View Page + anything else) and
// classify each one into a top-level product module via URL path first,
// event-name map second. Captures a much broader usage signal than the
// legacy 18-event hardcoded map.
async function fetchCustomPageViewEvents(maxPages = 40) {
  const events = [];
  let scrollId = null;
  let totalRaw = 0;
  let totalClassified = 0;
  const perModule = {};
  const now = Date.now();
  const sixMonthsAgo = now - (180 * 24 * 60 * 60 * 1000);

  for (let page = 0; page < maxPages; page++) {
    const url = scrollId
      ? `${BASE_URL}/events/custom?scrollId=${encodeURIComponent(scrollId)}`
      : `${BASE_URL}/events/custom?pageSize=1000&dateRangeStart=${sixMonthsAgo}&dateRangeEnd=${now}`;

    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url, {
        headers: { 'X-APTRINSIC-API-KEY': API_KEY },
      });
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
        const waitMs = retryAfter ? retryAfter * 1000 : (attempt + 1) * 3000;
        console.log(`[proxy] 429 on events/custom, waiting ${waitMs}ms (attempt ${attempt + 1}/3)`);
        await sleep(waitMs);
        continue;
      }
      break;
    }

    if (!res || !res.ok) {
      console.error(`[proxy] custom events returned ${res ? res.status : 'no-response'} on page ${page}`);
      break;
    }

    const data = await res.json();
    const items = data.customEvents || [];
    totalRaw += items.length;

    for (const evt of items) {
      if (!evt.identifyId) continue;
      const cls = classifyEvent(evt);
      if (!cls) continue;
      totalClassified++;
      perModule[cls.m] = (perModule[cls.m] || 0) + 1;
      events.push({
        u: evt.identifyId,
        m: cls.m,
        s: cls.s || null,
        e: evt.eventName,
        d: evt.date,
      });
    }

    if (items.length === 0 || !data.scrollId) break;
    scrollId = data.scrollId;
    await sleep(150);
  }

  console.log(`[proxy] Custom events: ${totalRaw} raw, ${totalClassified} classified, perModule=${JSON.stringify(perModule)}`);
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

    // 3. Fetch custom events (Time on Page + View Page + others) and
    //    classify via URL path → top-level module.
    const featureEvents = await fetchCustomPageViewEvents(40);

    // Debug: count per module
    const moduleCounts = {};
    const uniqueUsers = new Set();
    for (const evt of featureEvents) {
      moduleCounts[evt.m] = (moduleCounts[evt.m] || 0) + 1;
      uniqueUsers.add(evt.u);
    }
    console.log(`[proxy] Final: ${JSON.stringify(moduleCounts)}, ${uniqueUsers.size} users`);

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
      _debug: { dataSource: 'custom_events', mappedEvents: featureEvents.length, uniqueUsers: uniqueUsers.size, moduleCounts },
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
