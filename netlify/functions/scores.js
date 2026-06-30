// GET /api/scores?country=UK&limit=10
// Reads from Supabase. Requires env vars:
//   SUPABASE_URL       — your project URL, e.g. https://xxxx.supabase.co
//   SUPABASE_ANON_KEY  — public anon key (safe to expose, RLS protects writes)

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return {
      statusCode: 503,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Leaderboard not configured — set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in Netlify env vars.' }),
    };
  }

  const { country, limit = '10' } = event.queryStringParameters || {};
  const lim = Math.min(50, Math.max(1, parseInt(limit) || 10));

  let url = `${SUPABASE_URL}/rest/v1/scores`
    + `?select=player,country,score,ending,deaths`
    + `&order=score.desc`
    + `&limit=${lim}`;

  if (country && country !== 'ALL') {
    url += `&country=eq.${encodeURIComponent(country)}`;
  }

  try {
    const res = await fetch(url, {
      headers: {
        apikey:        SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const scores = await res.json();
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scores }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Database error', detail: err.message }),
    };
  }
};
