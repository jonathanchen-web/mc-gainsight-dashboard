// Temporary test endpoint to discover which Gainsight PX API endpoints
// return per-feature user visit data. Deploy, hit /api/feature-test, check response.

const API_KEY = process.env.GAINSIGHT_PX_API_KEY;
const BASE = 'https://api.aptrinsic.com/v1';

// Compliance module ID in Gainsight PX
const COMPLIANCE_ID = 'a2a00aa0-653a-41c5-81fc-ca205f88925b';

async function tryEndpoint(path) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });
    const status = res.status;
    let body = null;
    try { body = await res.json(); } catch { body = await res.text(); }
    return { path, status, ok: res.ok, body };
  } catch (err) {
    return { path, error: err.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const results = [];

  // Try various possible endpoints for feature usage data
  const endpoints = [
    `/feature/${COMPLIANCE_ID}/stats`,
    `/feature/${COMPLIANCE_ID}/users`,
    `/feature/${COMPLIANCE_ID}/user-activity`,
    `/feature/stats?featureId=${COMPLIANCE_ID}`,
    `/analytics/feature/${COMPLIANCE_ID}`,
    `/analytics/feature/${COMPLIANCE_ID}/users`,
    `/analytics/features/${COMPLIANCE_ID}/users`,
    `/analytics/feature/usage?featureId=${COMPLIANCE_ID}`,
    `/feature/${COMPLIANCE_ID}/event-count`,
    `/feature/${COMPLIANCE_ID}/adoption`,
    `/usage/feature/${COMPLIANCE_ID}`,
    `/reports/feature/${COMPLIANCE_ID}`,
  ];

  for (const ep of endpoints) {
    const result = await tryEndpoint(ep);
    results.push(result);
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  return res.status(200).json({
    tested: results.length,
    working: results.filter(r => r.ok).map(r => ({ path: r.path, keys: typeof r.body === 'object' ? Object.keys(r.body || {}) : null })),
    all: results.map(r => ({ path: r.path, status: r.status, ok: r.ok, bodyPreview: typeof r.body === 'object' ? Object.keys(r.body || {}).join(', ') : String(r.body || r.error).slice(0, 200) })),
  });
}
