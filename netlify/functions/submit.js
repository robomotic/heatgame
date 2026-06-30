// POST /api/submit
// Identity is the browser fingerprint (32-char hex). Logic:
//   - New fingerprint+country  → INSERT
//   - Known fingerprint+country → UPDATE only if new score is higher (personal best)
// Username is a display name only — not a unique key.
//
// Requires env vars: SUPABASE_URL, SUPABASE_SECRET_KEY

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const VALID_COUNTRIES = new Set(['UK', 'FR', 'DE', 'ES']);
const FP_RE = /^[0-9a-f]{32}$/;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return {
      statusCode: 503,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Leaderboard not configured.' }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { player, country, deaths, co2Pct, econLoss, approval, ending, score, fingerprint } = body;

  if (!player || typeof player !== 'string') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'player required' }) };
  }
  if (!VALID_COUNTRIES.has(country)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid country' }) };
  }
  if (!fingerprint || !FP_RE.test(fingerprint)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid fingerprint' }) };
  }

  // Sanitise all values server-side
  const safeName   = player.replace(/[<>&"']/g, '').trim().slice(0, 16) || 'Anonymous';
  const safeScore  = Math.max(0, Math.min(10000, Math.round(Number(score)    || 0)));
  const safeDeaths = Math.max(0, Math.min(1e6,   Math.round(Number(deaths)   || 0)));
  const safeCo2    = Math.max(0, Math.min(10000, Math.round(Number(co2Pct)   || 0)));
  const safeEcon   = Math.max(0, Math.min(1e6,   Math.round(Number(econLoss) || 0)));
  const safeAppr   = Math.max(0, Math.min(100,   Math.round(Number(approval) || 0)));
  const safeEnding = String(ending || 'Unknown').slice(0, 80);
  const ip = (event.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();

  const sbHeaders = {
    apikey:         SUPABASE_SERVICE_KEY,
    Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer:         'return=representation',
  };

  try {
    // Look up existing record for this fingerprint + country
    const existRes = await fetch(
      `${SUPABASE_URL}/rest/v1/scores?select=id,score&fingerprint=eq.${fingerprint}&country=eq.${encodeURIComponent(country)}&limit=1`,
      { headers: sbHeaders }
    );
    const existing = existRes.ok ? await existRes.json() : [];

    if (existing.length > 0) {
      const row = existing[0];

      if (safeScore <= row.score) {
        // New score is not an improvement — return current rank without touching DB
        const rankRes = await fetch(
          `${SUPABASE_URL}/rest/v1/scores?select=id&score=gt.${row.score}`,
          { headers: sbHeaders }
        );
        const above = rankRes.ok ? (await rankRes.json()).length : 0;
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            score: row.score,
            rank: above + 1,
            updated: false,
            message: `Your previous score (${row.score.toLocaleString()}) was higher — leaderboard not changed. You rank #${above + 1}.`,
          }),
        };
      }

      // New personal best — update the existing row
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/scores?id=eq.${row.id}`,
        {
          method: 'PATCH',
          headers: sbHeaders,
          body: JSON.stringify({
            player:    safeName,
            deaths:    safeDeaths,
            co2_pct:   safeCo2,
            econ_loss: safeEcon,
            approval:  safeAppr,
            ending:    safeEnding,
            score:     safeScore,
            player_ip: ip,
          }),
        }
      );
      if (!patchRes.ok) throw new Error(await patchRes.text());

    } else {
      // First submission for this fingerprint + country — insert
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/scores`, {
        method:  'POST',
        headers: sbHeaders,
        body: JSON.stringify({
          player:      safeName,
          country,
          deaths:      safeDeaths,
          co2_pct:     safeCo2,
          econ_loss:   safeEcon,
          approval:    safeAppr,
          ending:      safeEnding,
          score:       safeScore,
          fingerprint,
          player_ip:   ip,
        }),
      });
      if (!insertRes.ok) throw new Error(await insertRes.text());
    }

    // Return rank (position among all scores above this one + 1)
    const rankRes = await fetch(
      `${SUPABASE_URL}/rest/v1/scores?select=id&score=gt.${safeScore}`,
      { headers: sbHeaders }
    );
    const above = rankRes.ok ? (await rankRes.json()).length : 0;

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: safeScore, rank: above + 1, updated: true }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Database error', detail: err.message }),
    };
  }
};
