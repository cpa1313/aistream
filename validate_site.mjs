#!/usr/bin/env node
/** Validate the built site files: data.js parse, chunk integrity, field sanity. */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const SITE = process.argv[2] || path.dirname(new URL(import.meta.url).pathname) + '/site';

// 1. data.js must evaluate and expose a sane `dramas` array
const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(SITE, 'data.js'), 'utf8') + '\n;globalThis.__d = dramas;', ctx);
const dramas = ctx.__d;
console.log(`data.js parses: ${dramas.length} dramas`);

const problems = [];
const slugs = new Set();
const ids = new Set();
for (const d of dramas) {
  if (!d.slug) problems.push('missing slug');
  if (!d.title) problems.push(`missing title: ${d.slug}`);
  if (!d.cover) problems.push(`missing cover: ${d.slug}`);
  if (!Number.isInteger(d.episodes) || d.episodes <= 0) problems.push(`bad episodes: ${d.slug} = ${d.episodes}`);
  if (slugs.has(d.slug)) problems.push(`duplicate slug: ${d.slug}`);
  slugs.add(d.slug);
  if (d.id) ids.add(d.id);
  if (d.urls && d.urls.length !== d.mirrors?.length) { /* inline: urls is flat */ }
}
console.log(`unique slugs: ${slugs.size}, unique ids: ${ids.size}`);
const inline = dramas.filter(d => d.urls);
const chunked = dramas.filter(d => d.epsChunk);
console.log(`inline urls: ${inline.length}, chunked: ${chunked.length}, neither: ${dramas.length - inline.length - chunked.length}`);
if (inline.some(d => d.urls.length === 0)) problems.push('an inline drama has empty urls');
if (chunked.some(d => !Number.isInteger(d.epsChunk))) problems.push('chunked drama missing epsChunk');
console.log(`inline avg eps: ${(inline.reduce((s, d) => s + d.urls.length, 0) / inline.length).toFixed(1)}`);

// 2. every referenced chunk must exist and contain its dramas
const chunkNos = [...new Set(chunked.map(d => d.epsChunk))].sort((a, b) => a - b);
console.log(`chunk numbers referenced: ${chunkNos[0]}..${chunkNos[chunkNos.length - 1]} (${chunkNos.length} files)`);
let chunkKeysTotal = 0;
for (const n of chunkNos) {
  const f = path.join(SITE, 'eps', `chunk-${n}.js`);
  if (!fs.existsSync(f)) { problems.push(`missing file eps/chunk-${n}.js`); continue; }
  const c2 = { window: {} };
  vm.createContext(c2);
  vm.runInContext(fs.readFileSync(f, 'utf8'), c2);
  const keys = Object.keys(c2.window.DB_EPS || {});
  chunkKeysTotal += keys.length;
  const wanted = chunked.filter(d => d.epsChunk === n).map(d => d.slug);
  const keySet = new Set(keys);
  const missing = wanted.filter(s => !keySet.has(s));
  if (missing.length) problems.push(`chunk-${n} missing ${missing.length} slugs, e.g. ${missing.slice(0, 3).join(', ')}`);
}
console.log(`chunk entries total: ${chunkKeysTotal} (expected ${chunked.length})`);

// 3. url shape check on a sample
let badUrl = 0;
for (const d of dramas.slice(0, 500)) {
  const u = (d.urls || [])[0] || '';
  if (u && !/^https:\/\/.+\.m3u8$/.test(u)) badUrl++;
}
console.log(`bad url shape in first 500: ${badUrl}`);

console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.slice(0, 20).join('\n') : '\nALL CHECKS PASSED');
