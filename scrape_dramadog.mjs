#!/usr/bin/env node
/**
 * Scrape all dramas from dramadog.app (the user's own site) into raw JSONL.
 *
 * Sources:
 *  - sitemaps/*.xml  : full list of /drama/<slug> URLs per platform
 *  - /drama/<slug>   : window.__DB (drama_id, total), JSON-LD (title, genres,
 *                      description, image, datePublished), Story/About sections, rating
 *  - /api/eps/<id>   : mirrors[] = [{ host, urls: [per-episode m3u8] }]
 *
 * Usage:
 *   node scrape_dramadog.mjs sample          # 40 random dramas, print stats
 *   node scrape_dramadog.mjs full            # scrape everything (resumable via JSONL)
 *   node scrape_dramadog.mjs slugs <file>    # scrape only slugs listed in file (one per line)
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://dramadog.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const CONCURRENCY = 12;
const TIMEOUT_MS = 20000;
const RETRIES = 3;

// resolve everything relative to this script's own folder (portable)
const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const SITEMAP_DIR = path.join(SCRIPTS, 'sitemaps');
const OUT_JSONL = path.join(SCRIPTS, 'dramas_raw.jsonl');
const OUT_FAIL = path.join(SCRIPTS, 'dramas_failed.txt');

const mode = process.argv[2] || 'sample';

/* ---------- ensure sitemap files exist (download on first run) ---------- */
async function ensureSitemaps() {
  fs.mkdirSync(SITEMAP_DIR, { recursive: true });
  if (fs.readdirSync(SITEMAP_DIR).some((f) => /^sitemap-.*\.xml$/.test(f))) return;
  console.log('Downloading sitemaps (first run)...');
  const indexXml = await getText(`${BASE}/sitemap.xml`);
  const names = [...new Set([...indexXml.matchAll(/https:\/\/dramadog\.app\/(sitemap-[^<]+\.xml)<\/loc>/g)].map((m) => m[1]))]
    .filter((n) => n !== 'sitemap-pages.xml');
  await Promise.all(names.map(async (n) => {
    const xml = await getText(`${BASE}/${n}`);
    fs.writeFileSync(path.join(SITEMAP_DIR, n), xml);
  }));
  console.log(`Saved ${names.length} sitemaps to ${SITEMAP_DIR}`);
}

/* ---------- tiny fetch with timeout + retries ---------- */
async function getText(url, tries = RETRIES) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Referer': BASE + '/' },
        signal: ac.signal,
        redirect: 'follow',
      });
      clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

function getJson(url) {
  return getText(url).then((t) => JSON.parse(t));
}

/* ---------- sitemap → drama list ---------- */
function loadDramaList() {
  const files = fs.readdirSync(SITEMAP_DIR).filter((f) => /^sitemap-.*\.xml$/.test(f) && !f.includes('sitemap-pages'));
  const seen = new Set();
  const list = [];
  for (const f of files) {
    const platform = f.replace(/^sitemap-(.*)\.xml$/, '$1');
    const xml = fs.readFileSync(path.join(SITEMAP_DIR, f), 'utf8');
    const locs = [...xml.matchAll(/<loc>(https:\/\/dramadog\.app\/drama\/([^<]+))<\/loc>/g)];
    for (const [, url, slug] of locs) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      list.push({ url, slug, platform });
    }
  }
  return list;
}

/* ---------- parse one drama page ---------- */
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'");
}

function parsePage(html, slug, platform) {
  const drama = { slug, platform };

  // window.__DB = {...}
  const db = html.match(/window\.__DB\s*=\s*(\{[^<]*?\})\s*;?\s*<\/script>/);
  if (db) {
    try { Object.assign(drama, JSON.parse(db[1])); } catch {}
  }

  // JSON-LD blocks
  const lds = [];
  const ldRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = ldRe.exec(html))) {
    try { lds.push(JSON.parse(m[1])); } catch {}
  }
  const tv = lds.find((o) => o['@type'] === 'TVSeries');
  const faq = lds.find((o) => o['@type'] === 'FAQPage');

  if (tv) {
    drama.title = tv.name;
    drama.episodes = tv.numberOfEpisodes || drama.total || 0;
    drama.cover = tv.image || '';
    drama.releaseDate = tv.datePublished || '';
    drama.genres = (tv.genre || []).filter((g) => g && g !== 'See all');
    drama.shortDesc = tv.description || '';
  }

  // Story section (full description): <h2>Story</h2> ... <div class="story ..."><p>..</p>..</div>
  const storyMatch = html.match(/<h2>Story<\/h2>([\s\S]*?)<\/section>/);
  let story = '';
  if (storyMatch) {
    const ps = [...storyMatch[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((x) => decodeEntities(x[1].trim()));
    story = ps.join(' ').replace(/\s+/g, ' ').trim();
  }
  drama.description = story || decodeEntities(drama.shortDesc || '');

  // About section: <h2>About ...</h2> <div class="story"><p>...</p></div>
  const aboutMatch = html.match(/<h2>About [\s\S]*?<\/h2>\s*<div class="story">([\s\S]*?)<\/div>/);
  let about = '';
  if (aboutMatch) {
    const ps = [...aboutMatch[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((x) => decodeEntities(x[1].trim()));
    about = ps.join(' ').replace(/\s+/g, ' ').trim();
  }
  drama.about = about || drama.description;

  // rating from about text
  const rm = (about || '').match(/rate it (\d+(?:\.\d+)?) out of 10/i);
  drama.rating = rm ? parseFloat(rm[1]) : null;

  // fallbacks
  if (!drama.title) drama.title = decodeEntities(slug.replace(/-/g, ' '));
  if (!drama.episodes) {
    const em = (faq?.mainEntity?.[0]?.acceptedAnswer?.text || '').match(/has (\d+) episodes/);
    drama.episodes = em ? +em[1] : 0;
  }
  if (!drama.cover && drama.drama_id) drama.cover = `${BASE}/c/${drama.drama_id}.webp`;
  return drama;
}

/* ---------- scrape one drama ---------- */
async function scrapeOne({ url, slug, platform }) {
  const html = await getText(url);
  const drama = parsePage(html, slug, platform);
  const id = drama.drama_id;
  if (!id) throw new Error('no drama_id');
  const eps = await getJson(`${BASE}/api/eps/${id}`);
  // mirrors: [{host, urls:[...]}] → keep url arrays only
  const mirrors = (Array.isArray(eps) ? eps : []).map((mi) => mi.urls || []).filter((u) => u.length);
  drama.mirrors = mirrors;
  drama.epCount = mirrors[0] ? mirrors[0].length : 0;
  return drama;
}

/* ---------- concurrency runner ---------- */
async function runPool(items, worker, size = CONCURRENCY) {
  let idx = 0, done = 0, failed = 0;
  const fails = [];
  async function lane() {
    while (idx < items.length) {
      const item = items[idx++];
      try {
        await worker(item);
      } catch (e) {
        failed++;
        fails.push(item.slug + '\t' + e.message);
      }
      done++;
      if (done % 500 === 0 || done === items.length) {
        console.log(`  progress ${done}/${items.length} failed=${failed} @${new Date().toISOString()}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
  return fails;
}

/* ---------- modes ---------- */
async function main() {
  await ensureSitemaps();
  let list = loadDramaList();
  console.log(`Sitemap dramas (unique): ${list.length}`);

  if (mode === 'sample') {
    // 40 spread across platforms
    const byPlat = {};
    for (const d of list) (byPlat[d.platform] ||= []).push(d);
    list = [];
    for (const keys = Object.keys(byPlat); list.length < 40;) {
      let added = false;
      for (const p of keys) {
        const arr = byPlat[p];
        if (arr.length) { list.push(arr.shift()); added = true; if (list.length >= 40) break; }
      }
      if (!added) break;
    }
  } else if (mode === 'slugs') {
    const wanted = new Set(fs.readFileSync(process.argv[3], 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
    list = list.filter((d) => wanted.has(d.slug));
    console.log(`Selected by slug filter: ${list.length}`);
  }

  // resumable: skip slugs already scraped
  const doneSlugs = new Set();
  if (fs.existsSync(OUT_JSONL) && mode !== 'sample') {
    for (const line of fs.readFileSync(OUT_JSONL, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { doneSlugs.add(JSON.parse(line).slug); } catch {}
    }
    const before = list.length;
    list = list.filter((d) => !doneSlugs.has(d.slug));
    console.log(`Already scraped: ${before - list.length}, remaining: ${list.length}`);
  }

  const t0 = Date.now();
  const out = fs.createWriteStream(OUT_JSONL, { flags: mode === 'sample' ? 'w' : 'a' });
  let bytes = 0, epTotal = 0, mirrorCount = {};

  const fails = await runPool(list, async (item) => {
    const drama = await scrapeOne(item);
    const line = JSON.stringify(drama);
    bytes += line.length;
    epTotal += drama.epCount;
    mirrorCount[drama.mirrors.length] = (mirrorCount[drama.mirrors.length] || 0) + 1;
    out.write(line + '\n');
  });

  await new Promise((r) => out.end(r));
  fs.writeFileSync(OUT_FAIL, fails.join('\n'));

  const n = list.length;
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(` scraped OK: ${n - fails.length}/${n}`);
  console.log(` raw bytes: ${(bytes / 1e6).toFixed(1)} MB  (~${n ? ((bytes / n) / 1024).toFixed(1) : 0} KB/drama)`);
  console.log(` total episode URLs: ${epTotal}`);
  console.log(` mirror-count histogram: ${JSON.stringify(mirrorCount)}`);
  if (fails.length) console.log(` failures written to ${OUT_FAIL} (first 5: ${fails.slice(0, 5).join(' | ')})`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
