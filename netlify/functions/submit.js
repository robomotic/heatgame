// POST /api/submit
// Identity = Supabase Auth user (Google or GitHub OAuth).
// The client sends its Supabase access_token in the Authorization header.
// Server verifies it, then upserts: INSERT on first play, PATCH if new score beats personal best.
//
// Requires env vars: SUPABASE_URL, SUPABASE_SECRET_KEY

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const VALID_COUNTRIES = new Set(['UK', 'FR', 'DE', 'ES']);

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

  // Verify the Supabase access token from the Authorization header
  const authHeader = event.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return {
      statusCode: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Sign in with Google or GitHub to submit your score.' }),
    };
  }
  const userToken = authHeader.slice(7);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey:        SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${userToken}`,
    },
  });
  if (!userRes.ok) {
    return {
      statusCode: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Session expired — please sign in again.' }),
    };
  }
  const userData = await userRes.json();
  const userId = userData.id; // stable UUID from Supabase Auth

  // Parse and validate request body
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
  const safeScore  = Math.max(0, Math.min(10000, Math.round(Number(score)    || 0)));
  const safeDeaths = Math.max(0, Math.min(1e6,   Math.round(Number(deaths)   || 0)));
  const safeCo2    = Math.max(0, Math.min(10000, Math.round(Number(co2Pct)   || 0)));
  const safeEcon   = Math.max(0, Math.min(1e6,   Math.round(Number(econLoss) || 0)));
  const safeAppr   = Math.max(0, Math.min(100,   Math.round(Number(approval) || 0)));
  const safeEnding = String(ending || 'Unknown').slice(0, 80);

  const sbHeaders = {
    apikey:         SUPABASE_SERVICE_KEY,
    Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer:         'return=representation',
  };

  try {
    // Look up existing row for this user + country
    const existRes = await fetch(
      `${SUPABASE_URL}/rest/v1/scores?select=id,score&user_id=eq.${encodeURIComponent(userId)}&country=eq.${encodeURIComponent(country)}&limit=1`,
      { headers: sbHeaders }
    );
    const existing = existRes.ok ? await existRes.json() : [];

    if (existing.length > 0) {
      const row = existing[0];

      if (safeScore <= row.score) {
        // Not a personal best — return current rank without writing to DB
        const rankRes = await fetch(
          `${SUPABASE_URL}/rest/v1/scores?select=id&score=gt.${row.score}`,
          { headers: sbHeaders }
        );
        const above = rankRes.ok ? (await rankRes.json()).length : 0;
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            score:   row.score,
            rank:    above + 1,
            updated: false,
            message: `Your personal best is ${row.score.toLocaleString()} — this run wasn't higher. You rank #${above + 1}.`,
          }),
        };
      }

      // New personal best — update the row
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
          }),
        }
      );
      if (!patchRes.ok) throw new Error(await patchRes.text());

    } else {
      // First submission for this user + country — insert
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
          user_id:   userId,
        }),
      });
      if (!insertRes.ok) throw new Error(await insertRes.text());
    }

    // Return global rank
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
