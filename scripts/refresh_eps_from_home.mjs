#!/usr/bin/env node
/**
 * refresh_eps_from_home.mjs — bake FRESH dramadunyam episode links from your
 * HOME connection and emit eps/chunk-dun-*.js files for fulldrama.stream.
 *
 * WHY: dramadunyam's Cloudflare WAF blocks datacenter IPs (Workers included)
 * and Google's translate.goog proxy now rejects its API/manifest paths, so
 * the proxy2 /dun resolver cannot fetch fresh links any more. Your HOME IP is
 * residential — the WAF lets it through. This script walks your dun-sourced
 * titles, resolves a fresh signed link per episode, and writes the same
 * window.DB_EPS chunk format watch.html already consumes.
 *
 * RUN IT ON YOUR OWN MACHINE (Node 18+, no dependencies):
 *   1. put this file + dun_titles.json + views.json in one folder
 *      (views.json = curl "https://viewscounter.webmasterjamezzz13.workers.dev/views" -o views.json
 *       — optional but recommended: most-watched titles are resolved first)
 *   2. node refresh_eps_from_home.mjs --limit 100        (test run, ~3 min)
 *   3. node refresh_eps_from_home.mjs                    (full run; resumable —
 *      re-run any time, it continues where it stopped)
 *   4. upload the eps/ folder it creates (chunk-dun*.js) next to watch.html
 *   5. deploy the matching watch.html (loads chunk-dun*.js for dun titles)
 *
 * PACING: ~1.7 s between requests. Per title (20 eps) that is ~35 s, so a
 * full pass over all 6,261 titles ≈ 2.5 days of continuous running — don't.
 * With views.json the most-watched titles go FIRST: a 1.5–2 h session bakes
 * every title that actually has views (≈180 today), which fixes the visible
 * breakage. Run in sessions — state.json resumes where you stopped.
 *
 * HARD STOP: if dramadunyam starts answering 403/WAF pages to your home IP
 * (VPN on? new protection?), the script stops immediately instead of
 * hammering. Nothing is written for a title unless at least one episode
 * resolved.
 */
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DUN = 'https://dramadunyam.com';
const BASE_DELAY = 1200;            // ms between upstream requests (+ jitter)
const WAF_LIMIT = 3;                // consecutive WAF answers → hard stop
const TITLES_PER_CHUNK = 1500;
const log = (s) => console.log(`[${new Date().toISOString()}] ${s}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- args ---------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const has = (name) => argv.includes(name);
const TITLES_FILE = arg('--titles', 'dun_titles.json');
const VIEWS_FILE = arg('--views', 'views.json');
const OUT_DIR = arg('--out', 'eps');
const MAX_EPS = Number(arg('--max-eps', 20)) || 20;   // cap episodes per title (0 = all)
const LIMIT = Number(arg('--limit', 0)) || 0;         // 0 = every title
const MIN_VIEWS = Number(arg('--min-views', 0)) || 0; // skip titles below this

const here = process.cwd();
const stateFile = path.join(here, 'state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { done: {}, links: {} };
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state));

// ---- inputs -------------------------------------------------------
if (!fs.existsSync(TITLES_FILE)) { console.error(`missing ${TITLES_FILE} — see header for where to get it`); process.exit(1); }
const titles = JSON.parse(fs.readFileSync(TITLES_FILE, 'utf8'));
let views = {};
if (fs.existsSync(VIEWS_FILE)) {
  try { views = JSON.parse(fs.readFileSync(VIEWS_FILE, 'utf8')) || {}; log(`views loaded: ${Object.keys(views).length} slugs`); }
  catch { log('views.json unreadable — continuing without priority order'); }
}

// most-watched first (ties: alphabetical) — chunk-dun-1 then holds what
// visitors actually watch, so partial runs still fix the visible breakage.
titles.sort((a, b) => (views[b.slug] || 0) - (views[a.slug] || 0) || (a.slug < b.slug ? -1 : 1));
const pending = titles.filter(t =>
  !state.done[t.slug] && (!MIN_VIEWS || (views[t.slug] || 0) >= MIN_VIEWS));
const todo = LIMIT ? pending.slice(0, LIMIT) : pending;
log(`titles: ${titles.length} total, ${todo.length} to resolve now (state.json has ${Object.keys(state.done).length} done)`);

// ---- upstream -----------------------------------------------------
let wafStreak = 0;
const looksWaf = (status, text) => status === 403 || status === 503 ||
  /<html|attention required|just a moment|cf-chl/i.test(String(text || '').slice(0, 500));

async function politeFetch(url) {
  await sleep(BASE_DELAY + Math.floor(Math.random() * 500));
  for (let i = 0; i < 3; i++) {
    let res, text;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, redirect: 'follow' });
      text = await res.text();
    } catch (e) { log(`net err ${e.message}; retry 15s (${i + 1}/3) ${url.slice(-40)}`); await sleep(15000); continue; }
    if (res.status === 429 || /google\.com\/sorry/.test(text)) { log('rate limited — cooling down 5 min'); await sleep(300000); continue; }
    return { status: res.status, text };
  }
  return { status: 0, text: '' };
}

async function resolveEpisode(id, ep) {
  // 1. the /play JSON API (no special headers → the stable relay variant)
  const play = await politeFetch(`${DUN}/play/${id}/${ep}`);
  if (looksWaf(play.status, play.text)) { wafStreak++; return { waf: true }; }
  wafStreak = 0;
  if (play.status === 200) {
    try {
      const j = JSON.parse(play.text);
      if (j && j.url && !j.mesgul && !j.yok && !j.hazirlaniyor && !j.iptal) {
        return { url: /^https?:\/\//i.test(j.url) ? j.url : DUN + (j.url.startsWith('/') ? '' : '/') + j.url };
      }
    } catch { /* fall through to /hls */ }
  }
  // 2. legacy /hls manifest
  const hls = await politeFetch(`${DUN}/hls/${id}/${ep}/playlist.m3u8`);
  if (looksWaf(hls.status, hls.text)) { wafStreak++; return { waf: true }; }
  wafStreak = 0;
  if (hls.status === 200 && hls.text.includes('#EXTM3U')) {
    return { url: `${DUN}/hls/${id}/${ep}/playlist.m3u8` };
  }
  return {}; // genuinely unavailable upstream
}

// ---- main ---------------------------------------------------------
let okTitles = 0, emptyTitles = 0, requests = 0;
for (const t of todo) {
  if (wafStreak >= WAF_LIMIT) {
    log(`HARD STOP: ${WAF_LIMIT} consecutive WAF answers — your IP is being challenged.`);
    log('Turn off any VPN, try again later, or run from a different home network. Progress is saved.');
    break;
  }
  const eps = MAX_EPS ? Math.min(t.eps, MAX_EPS) : t.eps;
  const urls = [];
  for (let ep = 1; ep <= eps; ep++) {
    const r = await resolveEpisode(t.id, ep);
    requests++;
    if (r.waf) { urls.push(null); continue; }         // keep the slot, keep going
    urls.push(r.url || null);
    if (ep % 10 === 0) process.stdout.write(`  ${t.slug} ep ${ep}/${eps}\r`);
  }
  const got = urls.filter(Boolean);
  if (got.length) {
    state.links[t.slug] = urls;                        // keep null slots — watch.html skips them
    state.done[t.slug] = { id: t.id, eps: t.eps, got: got.length, at: Date.now() };
    okTitles++;
    log(`${t.slug}: ${got.length}/${eps} episodes baked`);
  } else {
    emptyTitles++;
    log(`${t.slug}: nothing resolved upstream (all null) — skipped`);
  }
  if (okTitles % 25 === 0 && okTitles > 0) saveState();  // checkpoint
}
saveState();

// ---- emit chunk files ---------------------------------------------
const withLinks = titles
  .filter(t => state.links[t.slug] && state.links[t.slug].some(Boolean))
  .map(t => ({ slug: t.slug, urls: state.links[t.slug] }));
if (withLinks.length) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const chunks = Math.ceil(withLinks.length / TITLES_PER_CHUNK);
  for (let c = 1; c <= chunks; c++) {
    const slice = withLinks.slice((c - 1) * TITLES_PER_CHUNK, c * TITLES_PER_CHUNK);
    const map = {};
    for (const it of slice) map[it.slug] = it.urls.filter(Boolean);
    const file = path.join(OUT_DIR, `chunk-dun-${c}.js`);
    fs.writeFileSync(file, `window.DB_EPS=window.DB_EPS||{};Object.assign(window.DB_EPS,${JSON.stringify(map)});\n`);
    log(`wrote ${file} (${slice.length} titles)`);
  }
  // slug → chunk index, loaded first by watch.html (small)
  const index = {};
  withLinks.forEach((it, i) => { index[it.slug] = Math.floor(i / TITLES_PER_CHUNK) + 1; });
  const idxFile = path.join(OUT_DIR, 'chunk-dun.js');
  fs.writeFileSync(idxFile, `window.DB_EPS_DUN_INDEX=window.DB_EPS_DUN_INDEX||{};Object.assign(window.DB_EPS_DUN_INDEX,${JSON.stringify(index)});\n`);
  log(`wrote ${idxFile} (${withLinks.length} entries)`);
  fs.writeFileSync(path.join(OUT_DIR, 'README.txt'),
    `Upload every chunk-dun*.js in this folder next to watch.html (into the eps/ folder\n` +
    `on your hosting), and deploy the matching watch.html from the patched archive.\n` +
    `Generated ${new Date().toISOString()} — ${withLinks.length} titles, ${chunks} link chunks.\n`);
}
log(`DONE: ${okTitles} titles baked, ${emptyTitles} empty, ${requests} upstream requests this run.`);
log(`Re-run any time — state.json resumes; the eps/ folder is rewritten with everything known so far.`);
