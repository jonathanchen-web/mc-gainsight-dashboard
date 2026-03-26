// Test POST-based query endpoints for feature usage data

const API_KEY = process.env.GAINSIGHT_PX_API_KEY;
const BASE = 'https://api.aptrinsic.com/v1';

const COMPLIANCE_ID = 'a2a00aa0-653a-41c5-81fc-ca205f88925b';

async function tryPost(path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'X-APTRINSIC-API-KEY': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { path, method: 'POST', status: res.status, ok: res.ok, body: parsed };
  } catch (err) {
    return { path, method: 'POST', status: 0, ok: false, body: err.message };
  }
}

async function tryGet(path) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { path, method: 'GET', status: res.status, ok: res.ok, body: parsed };
  } catch (err) {
    return { path, method: 'GET', status: 0, ok: false, body: err.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const results = [];
  const d = ms => new Promise(r => setTimeout(r, ms));

  // 1. POST query endpoints
  results.push(await tryPost('/analytics/query', {
    type: 'feature',
    featureId: COMPLIANCE_ID,
    metrics: ['uniqueUsers', 'totalVisits'],
  }));
  await d(300);

  results.push(await tryPost('/analytics/feature/query', {
    featureId: COMPLIANCE_ID,
  }));
  await d(300);

  results.push(await tryPost('/reports/query', {
    type: 'featureAdoption',
    featureId: COMPLIANCE_ID,
  }));
  await d(300);

  // 2. User search with feature filter
  results.push(await tryPost('/users/query', {
    filter: { featureId: COMPLIANCE_ID },
  }));
  await d(300);

  results.push(await tryPost('/users/search', {
    filter: { featureId: COMPLIANCE_ID },
  }));
  await d(300);

  // 3. Feature match events
  results.push(await tryGet(`/events?eventType=featureMatch&featureId=${COMPLIANCE_ID}&pageSize=5`));
  await d(300);

  results.push(await tryGet(`/feature-match?featureId=${COMPLIANCE_ID}&pageSize=5`));
  await d(300);

  // 4. Aggregate usage endpoint
  results.push(await tryGet(`/aggregate/feature/${COMPLIANCE_ID}`));
  await d(300);

  // 5. Feature with expand parameter
  results.push(await tryGet(`/feature/${COMPLIANCE_ID}?expand=stats,users,usage`));
  await d(300);

  // 6. Activity feed
  results.push(await tryGet(`/activity?type=feature&featureId=${COMPLIANCE_ID}&pageSize=5`));

  // Format output
  const formatted = results.map(r => ({
    endpoint: `${r.method} ${r.path}`,
    status: r.status,
    ok: r.ok,
    preview: typeof r.body === 'object' && r.body !== null
      ? JSON.stringify(r.body).slice(0, 400)
      : String(r.body).slice(0, 400),
  }));

  return res.status(200).json({ tested: formatted.length, results: formatted });
}
