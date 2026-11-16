// Huddle relay helper — a Cloudflare Worker.
//
// Huddle is a static site, so it cannot keep a secret. This tiny helper keeps
// your Cloudflare TURN key on Cloudflare's side and hands the site short-lived
// relay passwords instead. It never sees any audio, video or chat.
//
// It needs two values, set in the Worker's "Variables and Secrets" settings
// (never written in this file):
//   TURN_KEY_ID         the TURN key's Token ID
//   TURN_KEY_API_TOKEN  the TURN key's API token (add it as a Secret)

// Only these sites may ask for relay passwords, so strangers' websites cannot
// spend your free allowance.
const ALLOWED_ORIGINS = [
  'https://dhruvkhemka1.github.io',
  'http://127.0.0.1:8000',
  'http://localhost:8000',
];

const HOURS = 3600;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    if (!allowed) return json({ error: 'origin not allowed' }, 403);
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ error: 'relay is not configured' }, 500);

    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.TURN_KEY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        // Passwords last 12 hours, longer than any study session.
        body: JSON.stringify({ ttl: 12 * HOURS }),
      },
    );
    if (!res.ok) return json({ error: 'relay unavailable' }, 502);

    const data = await res.json();
    // Browsers block port 53, so those addresses only cause timeouts.
    const iceServers = (data.iceServers || []).map((s) => ({
      ...s,
      urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)),
    }));
    return json({ iceServers });
  },
};
