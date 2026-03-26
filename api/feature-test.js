// Temporary test endpoint — discovers which Gainsight PX API endpoints
// return per-feature user visit data.

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
    // Read body exactly once as text, then try to parse as JSON
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { path, status, ok: res.ok, body };
  } catch (err) {
    return { path, status: 0, ok: false, body: err.message };
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const results = [];

  const endpoints = [
    `/feature/${COMPLIANCE_ID}/stats`,
    `/feature/${COMPLIANCE_ID}/users`,
    `/feature/${COMPLIANCE_ID}/user-activity`,
    `/analytics/feature/${COMPLIANCE_ID}`,
    `/analytics/feature/${COMPLIANCE_ID}/users`,
    `/analytics/features/${COMPLIANCE_ID}/users`,
    `/usage/feature/${COMPLIANCE_ID}`,
    `/reports/feature/${COMPLIANCE_ID}`,
    `/feature/${COMPLIANCE_ID}/adoption`,
  ];

  for (const ep of endpoints) {
    const result = await tryEndpoint(ep);
    results.push({
      path: result.path,
      status: result.status,
      ok: result.ok,
      // Show keys if object, or first 300 chars if string
      bodyPreview: typeof result.body === 'object' && result.body !== null
        ? { keys: Object.keys(result.body), sample: JSON.stringify(result.body).slice(0, 500) }
        : String(result.body).slice(0, 300),
    });
    await new Promise(r => setTimeout(r, 250));
  }

  return res.status(200).json({ tested: results.length, results });
}
