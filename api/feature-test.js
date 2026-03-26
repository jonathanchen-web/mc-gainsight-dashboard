// Single call to /events/feature_match to get full event shape

const API_KEY = process.env.GAINSIGHT_PX_API_KEY;
const BASE = 'https://api.aptrinsic.com/v1';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    const r = await fetch(`${BASE}/events/feature_match?pageSize=10`, {
      headers: { 'X-APTRINSIC-API-KEY': API_KEY },
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 1000); }

    return res.status(200).json({
      status: r.status,
      totalHits: body?.totalHits,
      hasScrollId: !!body?.scrollId,
      eventCount: body?.featureMatchEvents?.length,
      allKeysOnFirstEvent: body?.featureMatchEvents?.[0]
        ? Object.keys(body.featureMatchEvents[0])
        : [],
      firstThreeEvents: (body?.featureMatchEvents || []).slice(0, 3),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
