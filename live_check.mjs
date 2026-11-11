#!/usr/bin/env node
/** Live-verify a random sample of episode URLs from the built data.js + chunks. */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import https from 'node:https';

const SITE = process.argv[2] || path.dirname(new URL(import.meta.url).pathname) + '/site';
const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(SITE, 'data.js'), 'utf8') + '\n;globalThis.__d = dramas;', ctx);
const dramas = ctx.__d;

// pick 18 dramas spread across the catalog (includes chunk-only ones)
const sample = [];
for (let i = 0; i < 18; i++) sample.push(dramas[Math.floor((i + 0.5) * dramas.length / 18)]);

function head(url) {
  // players fetch manifests with Range GETs (expect 200/206); some CDNs reject Range/HEAD → retry plain GET
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', headers: { Range: 'bytes=0-1', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36' }, timeout: 15000 }, (res) => {
      res.resume();
      if (res.statusCode === 403) {
        const req2 = https.request(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36' }, timeout: 15000 }, (r2) => { r2.resume(); resolve(r2.statusCode === 200 ? 206 : r2.statusCode); });
        req2.on('timeout', () => { req2.destroy(); resolve('timeout'); });
        req2.on('error', (e) => resolve('err:' + e.code));
        req2.end();
        return;
      }
      resolve(res.statusCode);
    });
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.on('error', (e) => resolve('err:' + e.code));
    req.end();
  });
}

let ok = 0, bad = [];
for (const d of sample) {
  const urls = d.urls || null;
  let ep1, epN;
  if (urls) { ep1 = urls[0]; epN = urls[urls.length - 1]; }
  else {
    const c2 = { window: {} };
    vm.createContext(c2);
    vm.runInContext(fs.readFileSync(path.join(SITE, 'eps', `chunk-${d.epsChunk}.js`), 'utf8'), c2);
    const rec = c2.window.DB_EPS[d.slug];
    ep1 = rec[0][0]; epN = rec[0][rec[0].length - 1];
  }
  const s1 = await head(ep1);
  const sN = await head(epN);
  const goodOk = (s) => s === 200 || s === 206;
  const good = goodOk(s1) && goodOk(sN);
  if (good) ok++; else bad.push(`${d.slug} ep1=${s1} lastEp=${sN}`);
  console.log(`${good ? 'OK ' : 'BAD'} ${d.platform.padEnd(14)} ${d.slug.padEnd(44)} eps=${d.episodes} ep1=${s1} last=${sN}`);
}
console.log(`\n${ok}/${sample.length} dramas verified live`);
if (bad.length) console.log('BAD:\n' + bad.join('\n'));
