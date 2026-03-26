// Deep dive on /events/feature_match — get full event shape and test global query

const API_KEY = process.env.GAINSIGHT_PX_API_KEY;
const BASE = 'https://api.aptrinsic.com/v1';

async function tryGet(path) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 500); }
    return { status: res.status, ok: res.ok, body: parsed };
  } catch (err) {
    return { status: 0, ok: false, body: err.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const d = ms => new Promise(r => setTimeout(r, ms));

  // Test 1: Get feature_match events WITHOUT identifyId (global query)
  const globalResult = await tryGet('/events/feature_match?pageSize=5');
  await d(300);

  // Test 2: Get feature_match events for a specific user
  const userResult = await tryGet('/events/feature_match?identifyId=0c7bb52a-c2de-47e0-a906-d3ba1fa346ef&pageSize=5');
  await d(300);

  // Test 3: Check if date filtering works
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const dateResult = await tryGet(`/events/feature_match?pageSize=5&dateRangeStart=${thirtyDaysAgo}`);

  // Format: show full first event object for shape analysis
  const output = {
    globalQuery: {
      status: globalResult.status,
      ok: globalResult.ok,
      totalHits: globalResult.body?.totalHits,
      hasScrollId: !!globalResult.body?.scrollId,
      eventCount: globalResult.body?.featureMatchEvents?.length,
      firstEventFull: globalResult.body?.featureMatchEvents?.[0] || null,
      allEventKeys: globalResult.body?.featureMatchEvents?.[0]
        ? Object.keys(globalResult.body.featureMatchEvents[0])
        : [],
    },
    userQuery: {
      status: userResult.status,
      ok: userResult.ok,
      totalHits: userResult.body?.totalHits,
      eventCount: userResult.body?.featureMatchEvents?.length,
      firstEventFull: userResult.body?.featureMatchEvents?.[0] || null,
    },
    dateFilteredQuery: {
      status: dateResult.status,
      ok: dateResult.ok,
      totalHits: dateResult.body?.totalHits,
      eventCount: dateResult.body?.featureMatchEvents?.length,
      firstEventFull: dateResult.body?.featureMatchEvents?.[0] || null,
    },
  };

  return res.status(200).json(output);
}
