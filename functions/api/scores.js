// GET /api/scores?country=UK&limit=10
// Returns top scores from D1 database

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const country = url.searchParams.get('country');
  const limit   = Math.min(50, parseInt(url.searchParams.get('limit') || '10', 10));

  try {
    let query, params;
    if (country && country !== 'ALL') {
      query  = `SELECT player, country, deaths, co2_pct, econ_loss, approval, ending, score
                FROM scores WHERE country = ?1
                ORDER BY score DESC LIMIT ?2`;
      params = [country, limit];
    } else {
      query  = `SELECT player, country, deaths, co2_pct, econ_loss, approval, ending, score
                FROM scores ORDER BY score DESC LIMIT ?1`;
      params = [limit];
    }

    const { results } = await env.DB.prepare(query).bind(...params).all();

    return Response.json(
      { scores: results },
      { headers: corsHeaders() }
    );
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
