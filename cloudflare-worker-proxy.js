/**
 * OPTIONAL — Cloudflare Worker proxy for fresh episode URLs.
 *
 * The DramaDog episode API (/api/eps/<id>) does not send CORS headers to other
 * domains, so a static site cannot call it directly from the browser. If you
 * deploy this tiny Worker and set its URL in watch.html
 * (const EPISODE_PROXY_BASE = 'https://your-worker.workers.dev/api/eps/'),
 * watch.html will fetch fresh, always-valid episode URLs from it whenever a
 * drama has no embedded/chunk URLs — then you don't need to re-run the scraper
 * when source URLs rotate.
 *
 * Deploy: Cloudflare Dashboard → Workers → Create → paste → deploy.
 * (Free plan is plenty for this.)
 */
export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/eps\/(\d+)$/);
    if (!m) return new Response('Not found', { status: 404, headers: cors });

    const upstream = await fetch(`https://dramadog.app/api/eps/${m[1]}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://dramadog.app/' },
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
    });
  },
};
