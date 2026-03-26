// Test event-related endpoints — community confirms REST API can return
// raw feature match events. Find the correct endpoint.

const API_KEY = process.env.GAINSIGHT_PX_API_KEY;
const BASE = 'https://api.aptrinsic.com/v1';

// A known user ID to test with
const TEST_USER = '0c7bb52a-c2de-47e0-a906-d3ba1fa346ef';
const COMPLIANCE_ID = 'a2a00aa0-653a-41c5-81fc-ca205f88925b';

async function tryGet(path) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 300); }
    return { path, status: res.status, ok: res.ok, body: parsed };
  } catch (err) {
    return { path, status: 0, ok: false, body: err.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const results = [];
  const d = ms => new Promise(r => setTimeout(r, ms));

  // Event-related endpoints (the community says raw feature match events are accessible)
  const endpoints = [
    // Custom events endpoint (what our MCP uses)
    `/events/custom?identifyId=${TEST_USER}&pageSize=5`,
    // Try different event type paths
    `/events?identifyId=${TEST_USER}&pageSize=5`,
    `/events/featureMatch?identifyId=${TEST_USER}&pageSize=5`,
    `/events/feature-match?identifyId=${TEST_USER}&pageSize=5`,
    `/events/feature_match?identifyId=${TEST_USER}&pageSize=5`,
    `/events/pageview?identifyId=${TEST_USER}&pageSize=5`,
    `/events/page-view?identifyId=${TEST_USER}&pageSize=5`,
    `/events/session?identifyId=${TEST_USER}&pageSize=5`,
    `/events/identify?identifyId=${TEST_USER}&pageSize=5`,
    `/events/segment?identifyId=${TEST_USER}&pageSize=5`,
    // Maybe it's under raw-events
    `/raw-events?identifyId=${TEST_USER}&pageSize=5`,
    `/raw-events/featureMatch?identifyId=${TEST_USER}&pageSize=5`,
    // Maybe under user path
    `/users/${TEST_USER}/events?pageSize=5`,
    `/users/${TEST_USER}/feature-events?pageSize=5`,
    `/users/${TEST_USER}/activity?pageSize=5`,
    // Maybe it's /event (singular)
    `/event?identifyId=${TEST_USER}&pageSize=5`,
    `/event/featureMatch?identifyId=${TEST_USER}&pageSize=5`,
  ];

  for (const ep of endpoints) {
    const result = await tryGet(ep);
    // Truncate body for readability
    let preview;
    if (typeof result.body === 'object' && result.body !== null) {
      const keys = Object.keys(result.body);
      const sample = JSON.stringify(result.body).slice(0, 300);
      preview = { keys, sample };
    } else {
      preview = String(result.body).slice(0, 200);
    }
    results.push({ path: result.path, status: result.status, ok: result.ok, preview });
    await d(200);
  }

  return res.status(200).json({ tested: results.length, results });
}
