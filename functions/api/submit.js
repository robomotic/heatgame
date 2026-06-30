// POST /api/submit
// Body: { player, country, deaths, co2Pct, econLoss, approval, ending, score }
// Returns: { score, rank }

const VALID_COUNTRIES = new Set(['UK', 'FR', 'DE', 'ES']);
const MAX_NAME = 16;

export async function onRequestPost({ request, env }) {
  // Rate limit: 1 submission per IP per hour via KV
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `rl:${ip}`;

  if (env.KV) {
    const existing = await env.KV.get(rlKey);
    if (existing) {
      return Response.json(
        { error: 'Rate limited: one submission per hour per IP.' },
        { status: 429, headers: corsHeaders() }
      );
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders() });
  }

  // Validate
  const { player, country, deaths, co2Pct, econLoss, approval, ending, score } = body;

  if (!player || typeof player !== 'string') {
    return Response.json({ error: 'player required' }, { status: 400, headers: corsHeaders() });
  }
  if (!VALID_COUNTRIES.has(country)) {
    return Response.json({ error: 'Invalid country' }, { status: 400, headers: corsHeaders() });
  }

  // Sanitize
  const safeName   = player.replace(/[<>&"']/g, '').trim().slice(0, MAX_NAME) || 'Anonymous';
  const safeScore  = Math.max(0, Math.min(10000, Math.round(Number(score)   || 0)));
  const safeDeaths = Math.max(0, Math.min(100000, Math.round(Number(deaths) || 0)));
  const safeCo2    = Math.max(0, Math.min(1000,  Math.round(Number(co2Pct) || 0)));
  const safeEcon   = Math.max(0, Math.min(100000, Math.round(Number(econLoss) || 0)));
  const safeAppr   = Math.max(0, Math.min(100,   Math.round(Number(approval) || 0)));
  const safeEnding = String(ending || 'Unknown').slice(0, 60);

  try {
    // Insert
    await env.DB.prepare(
      `INSERT INTO scores (player, country, deaths, co2_pct, econ_loss, approval, ending, score)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(safeName, country, safeDeaths, safeCo2, safeEcon, safeAppr, safeEnding, safeScore).run();

    // Compute rank
    const { results } = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM scores WHERE score > ?1`
    ).bind(safeScore).all();
    const rank = (results[0]?.cnt ?? 0) + 1;

    // Write rate-limit token (1 hour TTL)
    if (env.KV) {
      await env.KV.put(rlKey, '1', { expirationTtl: 3600 });
    }

    return Response.json({ score: safeScore, rank }, { headers: corsHeaders() });
  } catch (err) {
    return Response.json({ error: 'Database error', detail: err.message }, { status: 500, headers: corsHeaders() });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
