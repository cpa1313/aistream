#!/usr/bin/env node
/**
 * probe_urls.mjs — pre-flight check for the rebuild workflow: probe the episode
 * URLs of records that are ABOUT TO BE ADDED (or updated) via new-videos.json,
 * so a broken URL turns the run red BEFORE anything is committed or deployed.
 *
 * What gets probed:
 *   - records from new-videos.json whose slug is NOT yet stored in data-part-3.js
 *     (new additions), or whose urls array differs from the stored version (updates)
 *   - everything else is skipped: the main catalog (part 1/2) is never re-probed,
 *     and records already stored unchanged are not re-checked — so signed URLs
 *     expiring later can never block future builds.
 *
 * Reachability = HTTP 2xx on a ranged GET (1 byte) with a browser User-Agent and
 * no Referer — the same conditions under which the site plays videos locally.
 * Network errors / 502-504 are retried once.
 *
 * Exit policy:
 *   FAIL (exit 1) only for STRUCTURAL problems: invalid JSON, missing slug or
 *   title, urls not an array, or a record with no usable episode URL at all —
 *   those mean the scrape itself is broken.
 *   Host-level failures (403/404/410, timeout) only WARN: scraped URLs are
 *   signed and expire fast (cdnvideo.cdreader.com batches rot within a day of
 *   scraping, dramaboxdb Akamai tokens within a week), and one stale batch
 *   must never gate the whole rebuild. Dead links that land anyway are
 *   tracked by scripts/check_link_expiry.py, which produces the re-scrape list.
 *
 * Testing: set PROBE_DATA_DIR=/path/to/fixture-dir to run against a fixture
 * catalog instead of the real one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');

const CANDIDATE_DIRS = process.env.PROBE_DATA_DIR
    ? [process.env.PROBE_DATA_DIR]
    : [root, path.join(root, 'download')];
const dataDir = CANDIDATE_DIRS.find(d => fs.existsSync(path.join(d, 'data-part-1.js')));
if (!dataDir) {
    console.error('ERROR: cannot find data-part-1.js (looked in: ' + CANDIDATE_DIRS.join(', ') + ')');
    process.exit(1);
}
const jsonPath = path.join(dataDir, 'new-videos.json');
if (!fs.existsSync(jsonPath)) {
    console.log('new-videos.json not found — nothing to probe.');
    process.exit(0);
}

const read = f => fs.readFileSync(path.join(dataDir, f), 'utf8');

// Mirrors parsePartRecords() in build_new_part.mjs (kept standalone on purpose:
// each pipeline file is deployed by pasting it separately).
function parsePartRecords(txt) {
    const body = txt.split('.push(\n', 2)[1];
    if (!body) return [];
    const end = body.lastIndexOf('\n);');
    if (end === -1) return [];
    const src = body.slice(0, end);
    const recs = [];
    let depth = 0, start = -1, inStr = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (inStr) {
            if (c === '\\') { i++; continue; }
            if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') { if (depth === 0) start = i; depth++; }
        else if (c === '}') {
            depth--;
            if (depth === 0 && start >= 0) { recs.push(JSON.parse(src.slice(start, i + 1))); start = -1; }
        }
    }
    return recs;
}

// --- which records need probing? ---
const mainSlugs = new Set();
for (const f of ['data-part-1.js', 'data-part-2.js']) {
    for (const m of read(f).matchAll(/"slug"\s*:\s*"([^"]+)"/g)) mainSlugs.add(m[1]);
}
const stored = new Map();
for (const r of parsePartRecords(read('data-part-3.js'))) stored.set(r.slug, r);

const additions = JSON.parse(read('new-videos.json'));
if (!Array.isArray(additions)) {
    console.error('ERROR: new-videos.json must be an array of records (starting with [ ).');
    process.exit(1);
}

// last version of each slug wins
const bySlug = new Map();
for (const r of additions) {
    if (!r || !r.slug || !r.title) continue;
    bySlug.set(r.slug, r);
}

const toProbe = [];
for (const [slug, r] of bySlug) {
    if (mainSlugs.has(slug)) {
        console.log(`— skip "${r.title}" (already in the main catalog; the rebuild will skip it too)`);
        continue;
    }
    const prev = stored.get(slug);
    if (prev && JSON.stringify(prev.urls || []) === JSON.stringify(r.urls || [])) {
        console.log(`— skip "${r.title}" (unchanged since it was added)`);
        continue;
    }
    if ((!Array.isArray(r.urls) || r.urls.length === 0) && r.epsChunk) {
        console.log(`— skip "${r.title}" (epsChunk ${r.epsChunk} — episodes live in eps/chunk-${r.epsChunk}.js, nothing to probe)`);
        continue;
    }
    toProbe.push(r);
}

if (toProbe.length === 0) {
    console.log('PROBE: no new or updated episode URLs to check.');
    process.exit(0);
}

// --- probing ---
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Hosts behind aggressive Cloudflare bot challenges: they return 403 to
// non-browser clients (Actions runners, curl, headless) but stream fine in
// real browsers — the live catalog already plays 680+ URLs from
// dramadunyam.com. A 403/503 from these hosts is reported as a WARN
// ("unverifiable"), NOT a failure — verify those by playback instead.
const BOT_CHALLENGED_HOSTS = ['dramadunyam.com'];
const isBotChallenged = url => {
    try {
        const h = new URL(url).hostname;
        return BOT_CHALLENGED_HOSTS.some(host => h === host || h.endsWith('.' + host));
    } catch { return false; }
};

// Provider-direct signed URLs that expire FAST: dramahue relays were observed
// dead ~20 minutes after scraping (2026-11-16), dramaboxdb Akamai tokens die
// within days. They verify OK at probe time and rot before visitors play them.
// The bakeable variant for these platforms is the site's OWN relay URL —
// 682 dramadunyam.com/vr/... URLs are baked and still play.
const SHORT_TTL_HOSTS = ['dramahue.com', 'dramaboxdb.com'];
const isShortTtl = url => {
    try {
        const h = new URL(url).hostname;
        return SHORT_TTL_HOSTS.some(host => h === host || h.endsWith('.' + host));
    } catch { return false; }
};
let shortTtlUrls = 0;


async function probeUrl(url, { timeout = 10000 } = {}) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        try {
            const res = await fetch(url, {
                method: 'GET',
                headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
                redirect: 'follow',
                signal: ctrl.signal,
            });
            if (res.ok) return { status: res.status };
            if (res.status >= 502 && res.status <= 504 && attempt === 1) continue; // transient — retry once
            return { status: res.status };
        } catch (err) {
            if (attempt === 1) continue; // network error / timeout — retry once
            return { error: err.name === 'AbortError' ? 'timeout after 10s' : (err.message || 'network error') };
        } finally {
            clearTimeout(t);
        }
    }
}

async function pool(items, worker, size = 8) {
    const results = new Array(items.length);
    let i = 0;
    async function run() {
        while (i < items.length) {
            const idx = i++;
            results[idx] = await worker(items[idx], idx);
        }
    }
    await Promise.all(Array.from({ length: Math.min(size, items.length || 1) }, run));
    return results;
}

let okRecs = 0;
const dead = [];           // expired/unreachable episode URLs — WARN, record is added anyway
const structural = [];     // broken scrapes — FAIL the run
let checked = 0, emptyUrls = 0, unverified = 0;

for (const r of toProbe) {
    const urls = Array.isArray(r.urls) ? r.urls : [];
    if (urls.filter(Boolean).length === 0) {
        if (r.epsChunk) {
            console.log(`— skip "${r.title}" (epsChunk ${r.epsChunk} — episodes live in eps/chunk-${r.epsChunk}.js, nothing to probe)`);
            continue;
        }
        structural.push({ title: r.title, why: 'no usable episode URL (urls missing or all slots empty)' });
        console.log(`  ✗ FAIL "${r.title}": no usable episode URL — broken scrape, refusing to add.`);
        continue;
    }
    console.log(`Probing "${r.title}" (${urls.length} episode URL(s))…`);
    const results = await pool(urls, (u) => {
        if (!u) return { empty: true };
        return probeUrl(u);
    });
    let okCount = 0, deadCount = 0;
    results.forEach((res, idx) => {
        if (res.empty) {
            emptyUrls++;
            console.log(`  ⚠ WARN "${r.title}" ep ${idx + 1}/${urls.length}: empty URL (skipped — player will fall through mirrors)`);
        } else if (res.status >= 200 && res.status < 300) {
            okCount++;
            if (isShortTtl(urls[idx])) {
                shortTtlUrls++;
                console.log(`  ⚠ WARN "${r.title}" ep ${idx + 1}/${urls.length}: OK now, but host is a known short-TTL provider relay (observed expiry within ~20 min of scraping) — will likely be dead before visitors play it. Scrape the platform's own relay variant instead.`);
            }
        } else {
            deadCount++;
            const why = res.error ? res.error : `HTTP ${res.status}`;
            const url = urls[idx];
            if (!res.error && (res.status === 403 || res.status === 503) && isBotChallenged(url)) {
                unverified++;
                console.log(`  ⚠ WARN "${r.title}" ep ${idx + 1}/${urls.length} → ${why} — host challenges bots, unverifiable from Actions (verify by playback)`);
            } else {
                dead.push({ title: r.title, ep: idx + 1, total: urls.length, why, url });
                if (isShortTtl(url)) shortTtlUrls++;
                console.log(`  ⚠ DEAD "${r.title}" ep ${idx + 1}/${urls.length} → ${why} — added anyway; re-scrape later`);
                console.log(`      ${url}`);
            }
        }
    });
    checked += urls.length;
    if (okCount === urls.length && okCount > 0) {
        okRecs++;
        console.log(`  ✓ "${r.title}": ${okCount}/${urls.length} URLs OK`);
    } else if (okCount === 0) {
        structural.push({ title: r.title, why: `all ${urls.length} episode URLs unreachable (batch fully expired or bad scrape)` });
        console.log(`  ✗ FAIL "${r.title}": 0/${urls.length} URLs reachable — refusing to add a fully-dead record.`);
    } else {
        console.log(`  ⚠ "${r.title}": ${okCount}/${urls.length} URLs OK, ${deadCount} dead, ${urls.length - okCount - deadCount} empty — added anyway.`);
    }
}

console.log(`\nPROBE RESULT: ${toProbe.length} record(s), ${checked} URL(s) checked — `
    + `${okRecs} record(s) fully OK, ${dead.length} dead URL(s) (WARN — added anyway), ${emptyUrls} empty (skipped), ${unverified} unverifiable (bot-challenged host)`);

if (shortTtlUrls > 0) {
    console.log(`\n⚠ ${shortTtlUrls} URL(s) sit on known short-TTL provider relay hosts (${SHORT_TTL_HOSTS.join(', ')}).`);
    console.log('  They die within minutes-to-days of scraping (dramahue: ~20 min observed 2026-11-16), whether');
    console.log('  they verify OK now or are already dead.');
    console.log('  Bakeable alternative: the platform\'s OWN relay URL (for dramadunyam, /play WITHOUT the');
    console.log('  X-DD-Native-MP4 header returns the dramadunyam.com relay — the variant 682 baked URLs use).');
}

if (structural.length > 0) {
    console.log('\nPROBE FAILED — structural scrape problems:');
    for (const s of structural) console.log(`  ✗ "${s.title}": ${s.why}`);
    console.log('\nThe catalog was NOT rebuilt and the site was NOT changed.');
    console.log('Fix or remove these records in new-videos.json and commit again.');
    process.exit(1);
}
if (dead.length > 0) {
    console.log('\nPROBE PASSED WITH WARNINGS — dead episode URLs were added anyway (expired signed');
    console.log('URLs are a maintenance issue, not a build blocker). Re-scrape the affected titles:');
    console.log('scripts/check_link_expiry.py produces the current re-scrape list.');
}
process.exit(0);
