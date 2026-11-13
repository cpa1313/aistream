/**
 * Segment proxy worker — makes flickreels videos play on your hosted site.
 *
 * WHY: flickreels episode playlists point their video segments at
 * zshipricf.farsunpteltd.net, which returns 403 to any request coming from a
 * real browser origin (it allows `Origin: null` — i.e. opening files locally —
 * and non-browser clients, but blocks hosted sites). Fetching the segments
 * from a Cloudflare Worker (server-side, no Origin header) gets a normal 206.
 *
 * DEPLOY (2 minutes, free plan is plenty):
 *   1. Cloudflare Dashboard → Workers & Pages → Create Worker → name it
 *      e.g. "segment-proxy" → Deploy → Edit code → paste this file → Deploy.
 *   2. Copy your worker URL, e.g. https://segment-proxy.yourname.workers.dev
 *   3. In watch.html set:
 *        const SEGMENT_PROXY_BASE = 'https://segment-proxy.yourname.workers.dev/?u=';
 *   4. Commit/push (or paste) the updated watch.html. Done.
 *
 * SECURITY: only hosts in ALLOWED_HOSTS can be fetched, so this can never be
 * abused as an open proxy.
 */
const ALLOWED_HOSTS = [
  'zshipricf.farsunpteltd.net', // flickreels
  // add future blocked hosts here, e.g. 'v3.goodshort.com'
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return new Response('GET only', { status: 405, headers: CORS });

    const target = new URL(request.url).searchParams.get('u');
    let t;
    try { t = new URL(target || ''); } catch { return new Response('missing or invalid ?u=', { status: 400, headers: CORS }); }
    if (t.protocol !== 'https:' || !ALLOWED_HOSTS.includes(t.hostname)) {
      return new Response('host not allowed', { status: 403, headers: CORS });
    }

    // Forward Range (hls.js streams with Range requests) but NOT Origin/Referer
    // — that is the whole point: the upstream sees a clean server-side client.
    const headers = new Headers({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
    });
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);

    let upstream;
    try {
      upstream = await fetch(t.toString(), { headers, redirect: 'follow' });
    } catch (e) {
      return new Response('upstream fetch failed', { status: 502, headers: CORS });
    }

    const out = new Headers();
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set('Access-Control-Allow-Origin', '*');
    out.set('Cache-Control', 'public, max-age=86400'); // segments are immutable; lets CF edge cache them
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
