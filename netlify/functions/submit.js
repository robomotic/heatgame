// POST /api/submit  — validates, stores, and returns global rank
// Requires env vars:
//   SUPABASE_URL          — your project URL, e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY  — service-role key (server-side only, never exposed to browser)

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const VALID_COUNTRIES = new Set(['UK', 'FR', 'DE', 'ES']);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return {
      statusCode: 503,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Leaderboard not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify env vars.' }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { player, country, deaths, co2Pct, econLoss, approval, ending, score } = body;

  if (!player || typeof player !== 'string') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'player required' }) };
  }
  if (!VALID_COUNTRIES.has(country)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid country' }) };
  }

  // Sanitise all values server-side (never trust client-submitted scores)
  const safeName   = player.replace(/[<>&"']/g, '').trim().slice(0, 16) || 'Anonymous';
  const safeScore  = Math.max(0, Math.min(10000, Math.round(Number(score)   || 0)));
  const safeDeaths = Math.max(0, Math.min(1e6,   Math.round(Number(deaths)  || 0)));
  const safeCo2    = Math.max(0, Math.min(10000, Math.round(Number(co2Pct)  || 0)));
  const safeEcon   = Math.max(0, Math.min(1e6,   Math.round(Number(econLoss)|| 0)));
  const safeAppr   = Math.max(0, Math.min(100,   Math.round(Number(approval)|| 0)));
  const safeEnding = String(ending || 'Unknown').slice(0, 80);

  const ip = (event.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();

  const sbHeaders = {
    apikey:          SUPABASE_SERVICE_KEY,
    Authorization:   `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type':  'application/json',
    Prefer:          'return=representation',
  };

  try {
    // Rate-limit: one submission per IP per hour (checked via DB)
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const rlRes = await fetch(
      `${SUPABASE_URL}/rest/v1/scores?select=id&player_ip=eq.${encodeURIComponent(ip)}&created_at=gte.${oneHourAgo}&limit=1`,
      { headers: sbHeaders }
    );
    if (rlRes.ok) {
      const rlData = await rlRes.json();
      if (rlData.length > 0) {
        return {
          statusCode: 429,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'One submission per hour per player.' }),
        };
      }
    }

    // Insert the score row
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/scores`, {
      method:  'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        player:    safeName,
        country,
        deaths:    safeDeaths,
        co2_pct:   safeCo2,
        econ_loss: safeEcon,
        approval:  safeAppr,
        ending:    safeEnding,
        score:     safeScore,
        player_ip: ip,
      }),
    });
    if (!insertRes.ok) throw new Error(await insertRes.text());

    // Calculate rank: how many rows have a higher score?
    const rankRes = await fetch(
      `${SUPABASE_URL}/rest/v1/scores?select=id&score=gt.${safeScore}`,
      { headers: sbHeaders }
    );
    const above = rankRes.ok ? (await rankRes.json()).length : 0;

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: safeScore, rank: above + 1 }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Database error', detail: err.message }),
    };
  }
};
