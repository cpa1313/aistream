#!/usr/bin/env node
/**
 * refresh_eps_from_home.mjs — v2 (2026-11-22)
 *
 * WHY v2: v1 sent every id to dramadunyam.com/play — but the catalog's dun
 * titles use WATCHDRAMAREELS ids (10-12 digits), and dramadunyam answers
 * "yok" to ids it doesn't know → the first run baked 0/100. The worker's /dun
 * resolver solves this exact problem with a hashcash ticket on
 * watchdramareels.com — v2 ports that flow here, running from your HOME IP
 * (residential → the resolver accepts it; datacenter classes get istemci).
 *
 * RUN ON YOUR HOME MACHINE (Node 18+, no dependencies):
 *   1. dun_titles.json (v2 — 685 catalog titles) + views.json in the repo ROOT
 *      views.json = curl "https://viewscounter.webmasterjamezzz13.workers.dev/views" -o views.json
 *   2. DELETE any old state.json (v1 marked 100 titles done with zero links)
 *   3. node refresh_eps_from_home.mjs --limit 30      (test, ~5 min)
 *   4. node refresh_eps_from_home.mjs                 (full: 685 titles ≈ 4-6 h)
 *   5. commit eps/chunk-dun*.js AND the updated watch.html (v5.5.2 — REQUIRED:
 *      without it the site never reads the baked files), push, done.
 *
 * Resumable via state.json. Views-first ordering. Hard-stops on WAF
 * challenges (VPN on?) or 3 consecutive client-class blocks.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WDR = 'https://watchdramareels.com';
const DUN = 'https://dramadunyam.com';
const BASE_DELAY = 1200;
const CHALLENGE_LIMIT = 3;   // consecutive CF-challenge answers → hard stop
const CLIENT_LIMIT = 3;      // consecutive istemci/kaynak → hard stop
const TITLES_PER_CHUNK = 1500;
const TICKET_MAX_AGE = 11 * 60 * 60 * 1000;  // cookie is 12h; refresh early
const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- args ---------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const TITLES_FILE = arg('--titles', 'dun_titles.json');
const VIEWS_FILE = arg('--views', 'views.json');
const OUT_DIR = arg('--out', 'eps');
const MAX_EPS = Number(arg('--max-eps', 20)) || 20;
const LIMIT = Number(arg('--limit', 0)) || 0;
const MIN_VIEWS = Number(arg('--min-views', 0)) || 0;

const here = process.cwd();
const stateFile = path.join(here, 'state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { done: {}, links: {} };
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state));

// ---- wdr ticket (hashcash) — ported from proxy2-worker v5.5.1 -----
let ticket = { cookie: '', exp: 0 };

const wdrHeaders = (cookie) => {
  const h = {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Referer': WDR + '/',
    'Origin': WDR,
    'X-Requested-With': 'fetch',
  };
  if (cookie) h['Cookie'] = cookie;
  return h;
};

const zeroBits = (buf) => {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    for (let s = 7; s >= 0; s--) {
      if ((byte >> s) & 1) return bits;
      bits++;
    }
  }
  return bits;
};

async function solveTicket() {
  const r1 = await fetch(WDR + '/api/b', { headers: wdrHeaders(''), cache: 'no-store' });
  if (!r1.ok) throw new Error('challenge ' + r1.status);
  const ch = await r1.json();
  const z = Number(ch.z) || 12;
  const cap = 1 << Math.min(z + 8, 24);
  let n = 0;
  for (; n < cap; n++) {
    const d = crypto.createHash('sha256').update(ch.s + ':' + n).digest();
    if (zeroBits(d) >= z) break;
  }
  if (n >= cap) throw new Error('pow too hard (z=' + z + ')');
  const r2 = await fetch(WDR + '/api/b', {
    method: 'POST',
    headers: { ...wdrHeaders(''), 'Content-Type': 'application/json' },
    body: JSON.stringify({ s: ch.s, n: String(n) }),
  });
  if (!r2.ok) throw new Error('ticket ' + r2.status);
  const sc = (r2.headers.getSetCookie && r2.headers.getSetCookie()[0]) || r2.headers.get('set-cookie') || '';
  const m = sc.match(/__Host-b=[^;]+/);
  if (!m) throw new Error('no ticket cookie');
  ticket = { cookie: m[0], exp: Date.now() + TICKET_MAX_AGE };
  return ticket.cookie;
}

async function ticketCookie() {
  if (ticket.cookie && Date.now() < ticket.exp) return ticket.cookie;
  return await solveTicket();
}

// ---- upstream fetch with challenge detection -----------------------
let challengeStreak = 0, clientStreak = 0;

const looksChallenge = (status, text) =>
  status === 403 || status === 503 ||
  /just a moment|challenge-platform|cf-browser-verification|Attention Required/i.test(text.slice(0, 600));

async function politeFetch(url, opts = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { cache: 'no-store', redirect: 'follow', ...opts });
      const text = await r.text().catch(() => '');
      if (looksChallenge(r.status, text)) {
        challengeStreak++;
        return { status: r.status, text, challenge: true };
      }
      challengeStreak = 0;
      return { status: r.status, text };
    } catch (e) {
      log(`net err ${e.message}; retry 15s (${i + 1}/${tries}) ${url.slice(-40)}`);
      await sleep(15000);
    }
  }
  return { status: 0, text: '' };
}

// ---- resolve one episode ------------------------------------------
// wdr taxonomy (verified against the worker, 2026-11-21/22):
//   412 bekle/bilet   → settle, then renew ticket
//   durum hazir + url → WIN
//   yok + istemci     → client class blocked (never clears by retrying)
//   yok + kaynak      → Origin/Referer rejected
//   plain yok         → genuinely missing; one fresh-ticket retry, then null
async function wdrResolve(id, ep) {
  for (let round = 0; round < 2; round++) {
    const cookie = await ticketCookie();
    for (let i = 0; i < 3; i++) {
      const r = await politeFetch(`${WDR}/api/play/${id}/${ep}`, { headers: wdrHeaders(cookie) });
      if (r.challenge) return { waf: true };
      if (r.status === 412) {
        if (i < 1) { await sleep(3000); continue; }   // same cookie, settle
        ticket = { cookie: '', exp: 0 };              // force renew next round
        break;
      }
      let j;
      try { j = JSON.parse(r.text); } catch { return {}; }
      if (j.durum === 'hazir' && j.url) {
        clientStreak = 0;
        return { url: /^https?:\/\//i.test(j.url) ? j.url : WDR + (j.url.startsWith('/') ? '' : '/') + j.url };
      }
      if (j.durum === 'yok' && (j.neden === 'istemci' || j.neden === 'kaynak')) {
        clientStreak++;
        log(`  ${id}/${ep}: yok:${j.neden} — upstream rejects this client class; ${clientStreak}/${CLIENT_LIMIT}`);
        return { blocked: true };
      }
      if (j.durum === 'yok') {
        await sleep(1500);
        continue;   // plain yok → try again (next i)
      }
      await sleep(Math.min(Number(j.bekle) || 2, 6) * 1000);   // bekle/mesgul
    }
    // plain-yok round done → renew the ticket once and try again
    ticket = { cookie: '', exp: 0 };
  }
  return {};
}

// legacy dramadunyam legs — kept for short (native) ids; the v2 title list
// contains none of them, but this costs nothing and hedges future lists.
async function dunResolve(id, ep) {
  const play = await politeFetch(`${DUN}/play/${id}/${ep}`, { headers: { 'User-Agent': UA } });
  if (play.challenge) return { waf: true };
  if (play.status === 200) {
    try {
      const j = JSON.parse(play.text);
      if (j && j.url && !j.mesgul && !j.yok && !j.hazirlaniyor && !j.iptal) {
        return { url: /^https?:\/\//i.test(j.url) ? j.url : DUN + (j.url.startsWith('/') ? '' : '/') + j.url };
      }
    } catch { /* fall through to /hls */ }
  }
  const hls = await politeFetch(`${DUN}/hls/${id}/${ep}/playlist.m3u8`, { headers: { 'User-Agent': UA } });
  if (hls.challenge) return { waf: true };
  if (hls.status === 200 && hls.text.includes('#EXTM3U')) {
    return { url: `${DUN}/hls/${id}/${ep}/playlist.m3u8` };
  }
  return {};
}

const resolveEpisode = (id, ep) =>
  String(id).length >= 10 ? wdrResolve(id, ep) : dunResolve(id, ep);

// ---- main ---------------------------------------------------------
log(`refresh_eps_from_home v2 — wdr hashcash flow`);
let titles = [];
try { titles = JSON.parse(fs.readFileSync(path.join(here, TITLES_FILE), 'utf8')); }
catch (e) { log(`FATAL: cannot read ${TITLES_FILE}: ${e.message}`); process.exit(1); }
log(`titles: ${titles.length} (wdr-id population — hashcash flow)`);

let views = {};
if (fs.existsSync(path.join(here, VIEWS_FILE))) {
  try { views = JSON.parse(fs.readFileSync(path.join(here, VIEWS_FILE), 'utf8')) || {}; log(`views loaded: ${Object.keys(views).length} slugs`); }
  catch { log('views.json unreadable — continuing without priority order'); }
} else {
  log('views.json not found — optional; most-watched titles will not be prioritized');
}

titles.sort((a, b) => (views[b.slug] || 0) - (views[a.slug] || 0) || (a.slug < b.slug ? -1 : 1));
const todo = titles.filter(t => !state.done[t.slug] && (!MIN_VIEWS || (views[t.slug] || 0) >= MIN_VIEWS));
if (LIMIT) todo.length = Math.min(todo.length, LIMIT);
log(`to resolve now: ${todo.length} (state.json has ${Object.keys(state.done).length} done)`);

let okTitles = 0, emptyTitles = 0, requests = 0, stopped = '';
for (const t of todo) {
  const eps = Math.max(1, Math.min(Number(t.eps) || 20, MAX_EPS));
  const links = [];
  for (let ep = 1; ep <= eps; ep++) {
    requests++;
    const r = await resolveEpisode(t.id, ep);
    if (r.waf) {
      stopped = `HARD STOP: Cloudflare challenge — your IP is being challenged (VPN on? protection tightened?). Nothing lost — state.json resumes.`;
      break;
    }
    if (r.blocked && clientStreak >= CLIENT_LIMIT) {
      stopped = `HARD STOP: ${CLIENT_LIMIT} consecutive client-class rejections — home IP unexpectedly flagged. Wait an hour, re-run.`;
      break;
    }
    if (r.url) links.push({ ep, url: r.url });
    await sleep(BASE_DELAY + Math.floor(Math.random() * 500));
  }
  if (stopped) break;
  // store by episode number so baked arrays are episode-aligned
  if (links.length) {
    const arr = [];
    for (const l of links) arr[l.ep - 1] = l.url;
    state.links[t.slug] = arr;
    okTitles++;
    log(`${t.slug}: ${links.length}/${eps} episodes baked`);
  } else {
    emptyTitles++;
    log(`${t.slug}: nothing resolved upstream (all null) — skipped`);
  }
  state.done[t.slug] = true;
  saveState();
}

// ---- write chunk files (same format watch.html consumes) ----------
if (Object.keys(state.links).length) {
  fs.mkdirSync(path.join(here, OUT_DIR), { recursive: true });
  const slugs = Object.keys(state.links).sort();
  const nChunks = Math.ceil(slugs.length / TITLES_PER_CHUNK);
  const perChunk = Math.ceil(slugs.length / nChunks);
  const index = {};
  for (let c = 1; c <= nChunks; c++) {
    const slice = slugs.slice((c - 1) * perChunk, c * perChunk);
    if (!slice.length) break;
    const map = {};
    // keep null holes: watch.html indexes mirrors[ep-1] positionally —
    // filtering would shift unresolved episodes onto wrong numbers.
    for (const s of slice) map[s] = state.links[s];
    const file = path.join(OUT_DIR, `chunk-dun-${c}.js`);
    fs.writeFileSync(file, `window.DB_EPS=window.DB_EPS||{};Object.assign(window.DB_EPS,${JSON.stringify(map)});\n`);
    for (const s of slice) index[s] = c;
    log(`wrote ${file} (${slice.length} titles)`);
  }
  const idxFile = path.join(OUT_DIR, 'chunk-dun.js');
  fs.writeFileSync(idxFile, `window.DB_EPS_DUN_INDEX=window.DB_EPS_DUN_INDEX||{};Object.assign(window.DB_EPS_DUN_INDEX,${JSON.stringify(index)});\n`);
  log(`wrote ${idxFile} (${Object.keys(index).length} entries)`);
  fs.writeFileSync(path.join(OUT_DIR, 'README.txt'),
    `Upload every chunk-dun*.js in this folder next to watch.html (into the eps/ folder\n` +
    `of the repo), commit, push — CF Pages deploys automatically.\n` +
    `IMPORTANT: also deploy the updated watch.html (v5.5.2) — without it the site\n` +
    `never reads these files for epsChunk-carrying dun records.\n`);
}

log(stopped || `DONE: ${okTitles} titles baked, ${emptyTitles} empty, ${requests} upstream requests this run.`);
log(`Re-run any time — state.json resumes; the eps/ folder is rewritten with everything known so far.`);
