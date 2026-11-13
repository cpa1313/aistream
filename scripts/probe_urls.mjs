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
 * Network errors / 502-504 are retried once; 403/404/410 and other statuses fail.
 * Empty URL strings are warned about and skipped (the player falls through mirrors).
 *
 * Exit 1 if any probed URL fails; the workflow then stops before the rebuild
 * commit, leaving the deployed site untouched.
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
    toProbe.push(r);
}

if (toProbe.length === 0) {
    console.log('PROBE: no new or updated episode URLs to check.');
    process.exit(0);
}

// --- probing ---
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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
const failures = [];
let checked = 0, emptyUrls = 0;

for (const r of toProbe) {
    const urls = Array.isArray(r.urls) ? r.urls : [];
    console.log(`Probing "${r.title}" (${urls.length} episode URL(s))…`);
    const results = await pool(urls, (u) => {
        if (!u) return { empty: true };
        return probeUrl(u);
    });
    let okCount = 0;
    results.forEach((res, idx) => {
        if (res.empty) {
            emptyUrls++;
            console.log(`  ⚠ WARN "${r.title}" ep ${idx + 1}/${urls.length}: empty URL (skipped — player will fall through mirrors)`);
        } else if (res.status >= 200 && res.status < 300) {
            okCount++;
        } else {
            const why = res.error ? res.error : `HTTP ${res.status}`;
            failures.push({ title: r.title, ep: idx + 1, total: urls.length, why, url: urls[idx] });
            console.log(`  ✗ FAIL "${r.title}" ep ${idx + 1}/${urls.length} → ${why}`);
            console.log(`      ${urls[idx]}`);
        }
    });
    checked += urls.length;
    if (okCount === urls.length && okCount > 0) {
        okRecs++;
        console.log(`  ✓ "${r.title}": ${okCount}/${urls.length} URLs OK`);
    }
}

console.log(`\nPROBE RESULT: ${toProbe.length} record(s), ${checked} URL(s) checked — `
    + `${okRecs} record(s) fully OK, ${failures.length} failed, ${emptyUrls} empty (skipped)`);

if (failures.length > 0) {
    console.log('\nPROBE FAILED — the catalog was NOT rebuilt and the site was NOT changed.');
    console.log('Fix the listed episode URLs in new-videos.json (or remove that record) and commit again.');
    process.exit(1);
}
