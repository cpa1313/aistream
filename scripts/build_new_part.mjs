#!/usr/bin/env node
/**
 * build_new_part.mjs — regenerate data-part-3.js (the "new additions" part file)
 * from new-videos.json (the append-only additions log).
 *
 * Merge rules:
 *   - records already inside data-part-3.js are kept as-is (their dateAdded survives)
 *   - records from new-videos.json are merged in; on a slug clash the new-videos.json
 *     version wins (re-adding a slug = updating it)
 *   - slugs already present in data-part-1/2.js are skipped with a warning (no duplicates)
 *   - records missing dateAdded get today's UTC timestamp stamped automatically — that is
 *     what puts new additions at the top of the site (data.js sorts dateAdded-first)
 *   - output order: dateAdded desc; ties -> higher id first. Both keys are intrinsic
 *     to the record, so re-running never reorders anything (idempotent output).
 *
 * Layout: works both when the data files sit next to scripts/ (GitHub repo root)
 * and when they sit in download/ next to it (dev layout).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');

const CANDIDATE_DIRS = [root, path.join(root, 'download')];
const dataDir = CANDIDATE_DIRS.find(d => fs.existsSync(path.join(d, 'data-part-1.js')));
if (!dataDir) {
    console.error('ERROR: cannot find data-part-1.js (looked in: ' + CANDIDATE_DIRS.join(', ') + ')');
    process.exit(1);
}
const jsonPath = path.join(dataDir, 'new-videos.json');
if (!fs.existsSync(jsonPath)) {
    console.error('ERROR: ' + jsonPath + ' not found — nothing to add.');
    process.exit(1);
}

const read = f => fs.readFileSync(path.join(dataDir, f), 'utf8');

// Parse the record objects inside an existing data-part-*.js push( ... ) block.
// Depth-scans for top-level { ... } objects; only double-quoted strings are
// skipped over so braces/commas inside titles or URLs never break the split.
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

// Slugs already in the main catalog (part-1 + part-2) — never duplicate them.
const mainSlugs = new Set();
for (const f of ['data-part-1.js', 'data-part-2.js']) {
    for (const m of read(f).matchAll(/"slug"\s*:\s*"([^"]+)"/g)) mainSlugs.add(m[1]);
}

const existing = parsePartRecords(read('data-part-3.js'));
const additions = JSON.parse(read('new-videos.json'));
if (!Array.isArray(additions)) {
    console.error('ERROR: new-videos.json must be an array of records (starting with [ ).');
    process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 19) + 'Z'; // e.g. 2026-11-13T09:15:32Z
const bySlug = new Map();
for (const r of existing) bySlug.set(r.slug, r);

let added = 0, updated = 0, skipped = 0;
additions.forEach((r, idx) => {
    if (!r || !r.slug || !r.title) {
        console.warn(`WARN: addition #${idx + 1} in new-videos.json has no slug/title — skipped`);
        skipped++; return;
    }
    if (mainSlugs.has(r.slug)) {
        console.warn(`WARN: "${r.title}" (${r.slug}) is already in the main catalog — skipped`);
        skipped++; return;
    }
    // Updates inherit the original add date; only genuinely new records get stamped.
    const prev = bySlug.get(r.slug);
    if (prev && prev.dateAdded) r.dateAdded = prev.dateAdded;
    if (!r.dateAdded) r.dateAdded = stamp;
    if (!Array.isArray(r.urls) || r.urls.length === 0) console.warn(`WARN: "${r.title}" has no episode URLs`);
    if (bySlug.has(r.slug)) updated++; else added++;
    bySlug.set(r.slug, r);
});

// dateAdded desc (full timestamps beat plain dates); ties -> higher id first.
const recs = [...bySlug.values()]
    .sort((a, b) => String(b.dateAdded || b.releaseDate || '').localeCompare(String(a.dateAdded || a.releaseDate || ''))
        || (Number(b.id) || 0) - (Number(a.id) || 0));

const out = 'window.DB_DRAMAS_P3=window.DB_DRAMAS_P3||[];\nwindow.DB_DRAMAS_P3.push(\n'
    + recs.map(r => JSON.stringify(r, null, 1)).join(',\n') + '\n);\n';
fs.writeFileSync(path.join(dataDir, 'data-part-3.js'), out);

console.log(`data-part-3.js: ${recs.length} record(s) — ${added} added, ${updated} updated, ${skipped} skipped`);
console.log('First on site: ' + (recs[0] ? `${recs[0].title} [${recs[0].dateAdded || recs[0].releaseDate || 'no date'}]` : '(empty)'));
if (recs.length > 1) console.log('Second:        ' + `${recs[1].title} [${recs[1].dateAdded || recs[1].releaseDate || 'no date'}]`);
