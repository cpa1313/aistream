// functions/api/view.js — Cloudflare Pages Function
//
// Receives the visitor's batched click payload from counter.js
// (same-origin POST /api/view, body: { views: {slug: n}, tabs: {tab: n} })
// and forwards it to GitHub as a repository_dispatch event at the views
// repo. The PAT is NOT in this file: it lives in the Pages environment
// variable GH_VIEWS_TOKEN (Cloudflare Pages dashboard -> Settings ->
// Environment variables -> add as a Secret, for Production AND Preview).
//
// The token must be a fine-grained PAT scoped to ONLY cpa1313/aistream-views
// with "Contents: read and write" — worst case if it leaks: the counter
// files change, never this site.

const VIEWS_REPO = 'cpa1313/aistream-views';

function json(msg, status) {
    return new Response(JSON.stringify({ ok: status === 200, status: status, msg: msg }), {
        status: status,
        headers: { 'Content-Type': 'application/json' }
    });
}

// Mirror of the workflow's caps: max 100 keys per map, values clamped 1..50,
// keys trimmed to 100 chars. Bounds what any single request can inflate.
function clamp(map) {
    const out = {};
    for (const k of Object.keys(map || {}).slice(0, 100)) {
        const v = Math.max(1, Math.min(50, Math.trunc(Number(map[k]) || 0)));
        if (v >= 1) out[String(k).slice(0, 100)] = v;
    }
    return out;
}

export async function onRequestPost(context) {
    const { request, env } = context;

    if (!env.GH_VIEWS_TOKEN) return json('GH_VIEWS_TOKEN not set', 500);

    // Same-origin only: the browser always sends Origin on POST fetches.
    const origin = request.headers.get('origin') || '';
    const referer = request.headers.get('referer') || '';
    const host = request.headers.get('host') || '';
    const allowed = (u) => { try { return new URL(u).host === host; } catch { return false; } };
    if (origin) { if (!allowed(origin)) return json('bad origin', 403); }
    else if (referer) { if (!allowed(referer)) return json('bad referer', 403); }
    else return json('missing origin/referer', 403);

    let body;
    try { body = await request.json(); } catch { return json('bad body', 400); }

    const payload = {
        views: body && typeof body.views === 'object' ? clamp(body.views) : {},
        tabs: body && typeof body.tabs === 'object' ? clamp(body.tabs) : {}
    };
    if (!Object.keys(payload.views).length && !Object.keys(payload.tabs).length) {
        return json('empty payload', 400);
    }
    if (JSON.stringify(payload).length > 12000) return json('payload too large', 400);

    let r;
    try {
        r = await fetch('https://api.github.com/repos/' + VIEWS_REPO + '/dispatches', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + env.GH_VIEWS_TOKEN,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'User-Agent': 'fulldrama-view-counter'   // GitHub API requires a UA
            },
            body: JSON.stringify({ event_type: 'view-increment', client_payload: payload })
        });
    } catch (e) { return json('github unreachable', 502); }

    if (r.status === 204) return json('accepted', 200);
    return json('dispatch failed: HTTP ' + r.status, 502);
}

// Anything else on this route is a 405.
export async function onRequest(context) {
    return json('use POST', 405);
}
