#!/usr/bin/env node
/**
 * Build site deliverables from:
 *   dramas_raw.jsonl    — dramadog.app scrape (24,243 dramas, with episode URL mirrors)
 *   dun_listing.jsonl   — dramadunyam.com listing scrape (optional; ~72k series, no video URLs)
 *   <arg>               — optional dunyam-videos.json from scraper-dramadunyam-console.js
 *                         (dramadunyam-only series WITH episode URLs)
 *
 * Dedupe: normalized title — dramadog record wins (it already has playable URLs),
 * exactly the "skip the video if we already have it" behaviour.
 *
 * Output (written back where the input came from):
 *   data.js          — merged catalog; newest 300 with inline episode URLs
 *   eps/chunk-N.js   — episode URLs for everything else that has URLs
 *   merged-titles.json — normalized titles of the full catalog (skip-list for the console scraper)
 *
 * Usage: node scripts/build_site.mjs dunyam-videos.json
 *   (run from the package folder — data.js + eps/ + scripts/ side by side)
 */
import fs from 'node:fs';
import path from 'node:path';

// resolve paths relative to this script's own folder (portable)
const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const RAW = path.join(SCRIPTS, 'dramas_raw.jsonl');
const DUN_LISTING = path.join(SCRIPTS, 'dun_listing.jsonl');
const SITE = path.join(SCRIPTS, 'site');
// where data.js + eps/ live: dev layout (scripts/site/) or delivered package
// layout (data.js + eps/ next to scripts/). Outputs go back to the same place.
const DATA_DIR = fs.existsSync(path.join(SITE, 'data.js')) ? SITE : path.join(SCRIPTS, '..');
const EPS_DIR = path.join(DATA_DIR, 'eps');

const INLINE_URL_COUNT = 300;   // newest dramadog dramas get URLs embedded directly in data.js
const CHUNK_TARGET_MB = 8;      // approx max size of one eps chunk file

const normTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------- load dramadog ----------
   Source priority:
   1. dramas_raw.jsonl (full scraper output, mirrors included)
   2. fallback: the CURRENT delivered site files (data.js + eps/chunk-*.js) —
      this lets you rebuild on your own machine without the raw scrape:
      console-scrape dramadunyam → dunyam-videos.json → node build_site.mjs dunyam-videos.json */
const dramadog = [];
if (fs.existsSync(RAW)) {
  for (const line of fs.readFileSync(RAW, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.slug && d.title) dramadog.push(d);
  }
} else if (fs.existsSync(path.join(DATA_DIR, 'data.js'))) {
  const vm = await import('node:vm');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(DATA_DIR, 'data.js'), 'utf8') + '\n;globalThis.__d = dramas;', ctx);
  // load eps chunks so chunked records regain their URLs
  const epsDir = EPS_DIR;
  const DB_EPS = {};
  if (fs.existsSync(epsDir)) {
    for (const f of fs.readdirSync(epsDir).filter((f) => /^chunk-\d+\.js$/.test(f))) {
      const c2 = { window: {} };
      vm.createContext(c2);
      vm.runInContext(fs.readFileSync(path.join(epsDir, f), 'utf8'), c2);
      Object.assign(DB_EPS, c2.window.DB_EPS);
    }
  }
  for (const r of ctx.__d) {
    if (r.source === 'dramadunyam') continue; // rebuilt fresh from listing+videos below
    // normalize mirrors to array-of-arrays (chunk files may store flat or nested arrays)
    let m = r.urls ? r.urls : DB_EPS[r.slug];
    if (!m) m = [];
    if (!Array.isArray(m[0])) m = [m];
    dramadog.push({ ...r, drama_id: r.id, mirrors: m });
  }
  console.log('(source: delivered site files — dramas_raw.jsonl not found)');
}
// newest first (ids increase over time on the source site; dates as tiebreaker)
dramadog.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '') || (b.drama_id || b.id || 0) - (a.drama_id || a.id || 0));
console.log(`dramadog: ${dramadog.length} dramas (${dramadog.filter((d) => d.mirrors && d.mirrors[0] && d.mirrors[0].length).length} with URLs)`);

/* ---------- load dramadunyam listing ---------- */
const dunyam = [];
if (fs.existsSync(DUN_LISTING)) {
  for (const line of fs.readFileSync(DUN_LISTING, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.slug && d.title) dunyam.push(d);
  }
  console.log(`dramadunyam listing: ${dunyam.length} series`);
}

/* ---------- optional console-scraper output (dunyam-only with URLs) ---------- */
let dunVideos = [];
if (process.argv[2] && fs.existsSync(process.argv[2])) {
  try { dunVideos = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch { dunVideos = []; }
  console.log(`dramadunyam videos file: ${dunVideos.length} series with URLs`);
}

/* ---------- dedupe: dramadog stays complete (same-title entries there are
   distinct re-releases); dramadunyam titles are deduped against the whole
   dramadog catalog and within themselves ---------- */
const ddTitles = new Set();
const ddRecords = dramadog;
for (const d of dramadog) ddTitles.add(normTitle(d.title));
const dunOnly = [];
let dunDupes = 0, dunSeenSlug = 0;
const dunBySlug = new Map(dunVideos.map((v) => [String(v.slug), v]));
const seenDunSlug = new Set(), seenDunTitle = new Set();
for (const d of dunyam) {
  if (seenDunSlug.has(d.slug)) continue;
  seenDunSlug.add(d.slug);
  dunSeenSlug++;
  const k = normTitle(d.title);
  if (ddTitles.has(k) || seenDunTitle.has(k)) { dunDupes++; continue; }   // duplicate video already in catalog → skip
  seenDunTitle.add(k);
  dunOnly.push(d);
}
console.log(`dramadunyam: ${dunSeenSlug} unique slugs, ${dunDupes} duplicate titles (skipped), ${dunOnly.length} dunyam-only`);

// also merge series that exist only in the videos file (user's console scrape may
// cover more than the sandbox listing) — synthesize listing entries for them
const seenAllSlugs = new Set([...seenDunSlug, ...dunOnly.map((d) => d.slug)]);
let fromVideos = 0;
for (const v of dunVideos) {
  if (!v.slug || seenAllSlugs.has(v.slug)) continue;
  const k = normTitle(v.title);
  if (ddTitles.has(k) || seenDunTitle.has(k)) { dunDupes++; continue; }
  seenDunTitle.add(k);
  seenAllSlugs.add(v.slug);
  dunOnly.push({
    id: v.id, slug: v.slug, title: v.title,
    platform: v.platform || 'other',
    available_episodes: v.episodes || (v.urls ? v.urls.length : 0),
    cover: v.cover || '',
    tags: v.genres || [],
    dublaj: !!v.dubbed,
  });
  fromVideos++;
}
if (fromVideos) console.log(`+ ${fromVideos} series merged from the videos file (not in listing)`);

/* ---------- record cleaners ---------- */
function cleanDD(d) {
  return {
    id: d.drama_id || d.id || 0,
    title: d.title,
    slug: d.slug,
    platform: d.platform || 'other',
    episodes: d.episodes || (d.mirrors && d.mirrors[0] ? d.mirrors[0].length : 0) || 0,
    cover: d.cover || (d.drama_id ? `https://dramadog.app/c/${d.drama_id}.webp` : ''),
    description: d.description || d.about || '',
    about: d.about && d.about !== d.description ? d.about : '',
    genres: d.genres || [],
    rating: d.rating ?? null,
    releaseDate: d.releaseDate || '',
  };
}

function cleanDun(d) {
  const v = dunBySlug.get(d.slug);
  const total = Number(d.available_episodes) || 0;
  const rec = {
    id: parseInt(d.id, 10) || 0,
    title: d.title,
    slug: d.slug,
    platform: (d.platform || 'other').toLowerCase().replace(/\s+/g, ''),
    episodes: total,
    cover: d.cover && d.cover.startsWith('http') ? d.cover : `https://dramadunyam.com${d.cover || ''}`,
    description: ((v && v.description) || '').trim() || `${d.title} is a ${total}-episode series${d.platform ? ` from ${d.platform}` : ''}${d.dublaj ? ' (English dubbed)' : ''}.`,
    about: '',
    genres: ((v && v.genres && v.genres.length ? v.genres : d.tags) || []).filter((g) => g && g !== 'See all'),
    rating: (v && v.rating) ?? null,
    releaseDate: (v && v.releaseDate) || '',
  };
  if (v && Array.isArray(v.urls) && v.urls.length) rec.urls = v.urls.map((u) => u || ''); // keep positions aligned; empty = failed episode
  // genres may come back as objects ({slug,name}) from the series detail API — keep names only
  rec.genres = rec.genres.map((g) => (typeof g === 'string' ? g : (g && (g.name || g.slug)) || '')).filter(Boolean);
  if (d.dublaj) rec.dubbed = true;
  rec.source = 'dramadunyam';
  return rec;
}

fs.mkdirSync(EPS_DIR, { recursive: true });
for (const f of fs.readdirSync(EPS_DIR)) fs.unlinkSync(path.join(EPS_DIR, f)); // renumber chunks in one scheme

const recordsDD = ddRecords.map(cleanDD);
const recordsDun = dunOnly.map(cleanDun);

// attach episode URLs (first mirror) to every dramadog record that has them
for (let i = 0; i < recordsDD.length; i++) {
  const d = ddRecords[i];
  if (d.mirrors && d.mirrors[0] && d.mirrors[0].length) recordsDD[i].urls = d.mirrors[0];
}

// inline URLs: newest dramadog dramas that have URLs
let inlineUsed = 0;
for (let i = 0; i < recordsDD.length && inlineUsed < INLINE_URL_COUNT; i++) {
  if (recordsDD[i].urls) inlineUsed++;
}
const inlineSlugs = new Set(recordsDD.slice(0, INLINE_URL_COUNT).filter((r) => r.urls).map((r) => r.slug));

// chunk assignment for everything with URLs that isn't inline
const payloadOf = (urls, slug) => urls.join('').length + slug.length + 30;
const chunkTarget = CHUNK_TARGET_MB * 1e6;
let chunkNo = 1, chunkBytes = 0;
const chunkMap = {}; // chunkNo -> {slug: urls}
for (const rec of [...recordsDD, ...recordsDun]) {
  if (!rec.urls || !rec.urls.length) { delete rec.urls; continue; }
  if (inlineSlugs.has(rec.slug)) continue; // inline, no chunk needed
  rec.epsChunk = chunkNo;
  (chunkMap[chunkNo] ||= {})[rec.slug] = rec.urls;
  chunkBytes += payloadOf(rec.urls, rec.slug);
  delete rec.urls; // URLs live in the chunk file, not in data.js
  if (chunkBytes >= chunkTarget) { chunkNo++; chunkBytes = 0; }
}
const CHUNK_COUNT = chunkBytes > 0 ? chunkNo : chunkNo - 1;

const records = [...recordsDD, ...recordsDun];
// safety: never overwrite a good catalog with an empty one
if (!records.length) {
  console.error(`ERROR: no source data found. Run this from the package folder (data.js + eps/ next to scripts/), or put dramas_raw.jsonl next to build_site.mjs.`);
  process.exit(1);
}
const dataJs = 'const dramas = [\n' + records.map((r) => JSON.stringify(r)).join(',\n') + '\n];\n';
fs.writeFileSync(path.join(DATA_DIR, 'data.js'), dataJs);
console.log(`data.js: ${records.length} dramas, ${(fs.statSync(path.join(DATA_DIR, 'data.js')).size / 1e6).toFixed(1)} MB, inline=${inlineUsed}  →  ${path.join(DATA_DIR, 'data.js')}`);

let chunkEntries = 0;
for (let c = 1; c <= CHUNK_COUNT; c++) {
  const obj = chunkMap[c];
  if (!obj || !Object.keys(obj).length) continue;
  chunkEntries += Object.keys(obj).length;
  const body = 'window.DB_EPS=window.DB_EPS||{};Object.assign(window.DB_EPS,' + JSON.stringify(obj) + ');';
  fs.writeFileSync(path.join(EPS_DIR, `chunk-${c}.js`), body + '\n');
}
console.log(`eps chunks: ${CHUNK_COUNT} files, ${chunkEntries} dramas, total ${(fs.readdirSync(EPS_DIR).reduce((s, f) => s + fs.statSync(path.join(EPS_DIR, f)).size, 0) / 1e6).toFixed(1)} MB`);

// skip-list for the console scraper (titles already merged — skip them there too)
fs.writeFileSync(path.join(DATA_DIR, 'merged-titles.json'), JSON.stringify(records.map((r) => normTitle(r.title))));
console.log(`merged-titles.json written (${records.length} titles)`);
