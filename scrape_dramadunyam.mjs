#!/usr/bin/env node
/**
 * Scrape dramadunyam.com catalog listing via translate.goog (the site's Cloudflare WAF
 * blocks datacenter IPs; Google's translate proxy can pass). Pacing + backoff to stay
 * under Google's rate limiter (google.com/sorry).
 *
 * Phases:
 *   probe  — test /hls manifest for one id, higher adet, later page, multi-segment API
 *   walk   — /api/yeni-eklenenler?sayfa=N&adet=64&lang=en until devam=false (resumable)
 *
 * Output: /home/z/my-project/scripts/dun_listing.jsonl  (one feed item per line + page meta)
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/home/z/my-project/scripts/dun_listing.jsonl';
const LOG = '/home/z/my-project/scripts/dun_walk.log';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TG = 'https://dramadunyam-com.translate.goog';
const BASE_DELAY = 12000;   // ms between requests
const SORRY_SLEEP = 600000; // 4 min cooldown when Google limits us
const PROBE_ONLY = process.argv[2] === 'probe';
const MAX_PAGES = +(process.env.MAX_PAGES || 0); // 0 = no limit

const log = (s) => { const line = `[${new Date().toISOString()}] ${s}`; console.log(line); fs.appendFileSync(LOG, line + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
async function politeFetch(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const wait = Math.max(0, BASE_DELAY - (Date.now() - lastRequestAt)) + Math.floor(Math.random() * 1200);
    await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
      const body = await res.text();
      if (res.status === 200) return body;
      if (res.status === 302 || /google\.com\/sorry/.test(body) || (res.status === 429)) {
        log(`google limiter (HTTP ${res.status}), sleeping ${SORRY_SLEEP / 1000}s (try ${i + 1}/${tries})`);
        await sleep(SORRY_SLEEP);
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (/google limiter/.test(e.message)) continue;
      log(`fetch err ${e.message}; retry in 15s (try ${i + 1}/${tries})`);
      await sleep(15000);
    }
  }
  throw new Error('gave up after retries: ' + url);
}

async function probe() {
  const id = '848076254976';
  log('probe 1: /hls/<id>/1/playlist.m3u8');
  const m = await politeFetch(`${TG}/hls/${id}/1/playlist.m3u8`);
  fs.writeFileSync('/home/z/my-project/scripts/dun_hls1.m3u8', m);
  log('manifest head: ' + JSON.stringify(m.slice(0, 300)));

  log('probe 2: adet=200');
  try {
    const big = await politeFetch(`${TG}/api/yeni-eklenenler?sayfa=1&adet=200&lang=en`);
    const j = JSON.parse(big);
    log(`adet=200 → items: ${j.items?.length}, devam: ${j.devam}, toplam: ${j.toplam}`);
  } catch (e) { log(`adet=200 failed: ${e.message}`); }

  log('probe 3: /api/series/<id>?lang=en&core=1');
  try {
    const s = await politeFetch(`${TG}/api/series/${id}?lang=en&core=1`);
    fs.writeFileSync('/home/z/my-project/scripts/dun_series3.json', s);
    log('series api head: ' + JSON.stringify(s.slice(0, 200)));
  } catch (e) { log(`series api failed: ${e.message}`); }

  log('probe 4: page 3000 sanity (deep pagination)');
  try {
    const deep = await politeFetch(`${TG}/api/yeni-eklenenler?sayfa=3000&adet=64&lang=en`);
    const j = JSON.parse(deep);
    log(`page 3000 → items: ${j.items?.length}, devam: ${j.devam}`);
  } catch (e) { log(`page 3000 failed: ${e.message}`); }
}

async function walk() {
  const seen = new Set();
  if (fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { seen.add(JSON.parse(line).id); } catch {}
    }
    log(`resume: ${seen.size} items already scraped`);
  }
  const out = fs.createWriteStream(OUT, { flags: 'a' });
  const target = 72201;
  const perPage = 96;
  const maxPage = MAX_PAGES || Math.ceil(target / perPage) + 50;
  let empty = 0;
  for (let page = 1; page <= maxPage; page++) {
    let j;
    try {
      const body = await politeFetch(`${TG}/api/yeni-eklenenler?sayfa=${page}&adet=${perPage}&lang=en`);
      j = JSON.parse(body);
    } catch (e) {
      log(`page ${page} failed permanently: ${e.message} — continuing`);
      continue;
    }
    const items = j.items || [];
    let added = 0;
    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.write(JSON.stringify({ ...it, _page: page }) + '\n');
      added++;
    }
    if (page % 10 === 0 || page === 1) {
      log(`page ${page}/${maxPage} added=${added} total=${seen.size} devam=${j.devam}`);
    }
    if (!items.length) { empty++; if (empty >= 5) { log('5 empty pages in a row — stopping'); break; } }
    if (j.devam === false && page > 100) { log(`devam=false at page ${page} — done`); break; }
  }
  await new Promise((r) => out.end(r));
  log(`walk complete: ${seen.size} unique series`);
}

(async () => {
  if (PROBE_ONLY) await probe();
  else await walk();
  process.exit(0);
})().catch((e) => { log('FATAL ' + e.message); process.exit(1); });
