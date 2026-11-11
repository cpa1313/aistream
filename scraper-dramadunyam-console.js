/**
 * DramaDünyam scraper — paste into DevTools Console ON https://dramadunyam.com/
 * (F12 → Console → paste → Enter). Same-origin, so the WAF / proxies don't matter.
 *
 * Produces JSON in the same format as data.js records, with "urls" = one HLS URL
 * per episode, ready for the merge script (merge_dramadunyam.mjs).
 *
 * HOW TO RUN
 *   1. Probe first (1 series, prints raw API shapes):
 *        await probeDun();
 *      → Check the printed /play + /api/series responses. If urls look like
 *        "/vr/..." short-lived relay links, save them anyway but note they may
 *        rotate; if they are provider .m3u8 URLs (like dramadog's), they are stable.
 *   2. Small run (50 newest series that are NOT in the dramadog skip list):
 *        await scrapeDun(50);
 *   3. Full run (everything the feed exposes, skipping dramadog duplicates):
 *        await scrapeDun(Infinity);
 *   4. One specific title by name (searches the site, no feed walk needed):
 *        await scrapeDunTitle("definitely not the dragon god");
 *      An exact title match is picked automatically; otherwise it prints a
 *      numbered match table — call again with the 1-based number, e.g.
 *        await scrapeDunTitle("dragon god", 2)
 *      If it ever returns [] without scraping, expand the last console entry
 *      (click the ▸ triangle) to read the [dun-title] log lines, or run the
 *      raw diagnostic and read what it prints:
 *        await dunDiagnose("dragon god")
 *      Every scraped record accumulates in DUN_RESULTS, so you can run the
 *      search-based scrape for any number of missing titles and then run
 *      copyDun() once to copy everything to the clipboard.
 *   The result is copied to your clipboard AND printed. Save it as
 *   dunyam-videos.json (append to the array if you already have one) and run:
 *        node scripts/build_site.mjs dunyam-videos.json
 *
 * OPTIONAL: paste a skip-list of normalized titles to avoid duplicates before running:
 *   DUN_SKIP_TITLES = ["the divorce gift", "wet therapy", ...];
 * (merge_dramadunyam.mjs prints this list for you as dunyam-skip-titles.json.)
 */
/* global DUN_SKIP_TITLES */

async function probeDun(id) {
  id = id || null;
  const log = (...a) => console.log('%c[dun-probe]', 'color:#ff6b35', ...a);

  // 1. take one id from the new-releases feed
  if (!id) {
    const feed = await fetch('/api/yeni-eklenenler?sayfa=1&adet=5&lang=en').then(r => r.json());
    log('feed toplam =', feed.toplam, '| first item =', JSON.stringify(feed.items[0]));
    id = feed.items[0].id;
  }

  // 2. series detail
  let d = null;
  try {
    const res = await fetch('/api/series/' + encodeURIComponent(id) + '?core=1&lang=en');
    const text = await res.text();
    log('/api/series status', res.status, 'body head:', text.slice(0, 400));
    d = JSON.parse(text);
  } catch (e) { log('/api/series FAILED:', e.message); }

  // 3. play link for ep1 (exactly what the site's player does)
  let y = null;
  try {
    const res = await fetch('/play/' + encodeURIComponent(id) + '/1', {
      credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-DD-Native-MP4': '1' },
    });
    const text = await res.text();
    log('/play status', res.status, 'body head:', text.slice(0, 400));
    y = JSON.parse(text);
  } catch (e) { log('/play FAILED:', e.message); }

  // 4. what does the returned url look like? (stable provider URL vs signed relay)
  if (y && y.url) {
    const abs = y.url.startsWith('http') ? y.url : location.origin + y.url;
    log('resolved source url =', abs, '| kind =', y.kind);
    try {
      const m = await fetch(abs, { credentials: 'omit' });
      const t = await m.text();
      log('manifest fetch status', m.status, '| head:', JSON.stringify(t.slice(0, 200)));
      if (/#EXT-X-KEY/.test(t)) log('⚠ manifest contains EXT-X-KEY (encrypted segments) — baked URLs will NOT play off-site without the key server');
      else log('✓ plain HLS manifest (no encryption markers)');
    } catch (e) { log('manifest fetch failed:', e.message); }
  }

  // 5. is the legacy /hls path alive? (stable URLs if yes)
  try {
    const r = await fetch('/hls/' + encodeURIComponent(id) + '/1/playlist.m3u8', { credentials: 'omit' });
    log('/hls/<id>/1/playlist.m3u8 status =', r.status, r.ok ? '← legacy path ALIVE, stable URLs possible' : '(retired)');
    if (r.ok) console.log((await r.text()).slice(0, 200));
  } catch (e) { log('/hls probe failed:', e.message); }

  return { id, detail: d, play: y };
}

const normTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// shared record accumulator — every scraped series lands here, so you can mix
// feed-walk runs (scrapeDun) and search-based runs (scrapeDunTitle), then copy
// everything at once with copyDun()
if (!Array.isArray(self.DUN_RESULTS)) self.DUN_RESULTS = [];

// scrape ONE series: detail + one /play call per episode → record in data.js format
async function scrapeOneDun(it, log) {
  const d = await fetch('/api/series/' + encodeURIComponent(it.id) + '?core=1&lang=en').then(r => r.json());
  if (d.yakinda || d.oynatilamaz) return null;                 // coming soon / unplayable

  const total = Number(it.available_episodes || it.total_episodes || d.available_episodes || 0);
  const urls = [];
  for (let n = 1; n <= total; n++) {
    try {
      const y = await fetch('/play/' + encodeURIComponent(it.id) + '/' + n, {
        credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-DD-Native-MP4': '1' },
      }).then(r => r.json());
      if (y && y.url && !y.mesgul && !y.yok && !y.hazirlaniyor && !y.iptal) {
        urls.push(y.url.startsWith('http') ? y.url : location.origin + y.url);
      } else { urls.push(''); } // keep episode positions aligned
    } catch (e) { urls.push(''); }
    if (n % 10 === 0) log(it.title, ': ep', n, '/', total);
  }

  return {
    id: parseInt(it.id, 10) || it.id,
    title: d.title || it.title,
    slug: it.slug,
    platform: (d.platform || it.platform || 'other').toLowerCase().replace(/\s+/g, ''),
    episodes: total,
    cover: (it.cover || '').startsWith('http') ? it.cover : location.origin + (it.cover || ''),
    description: d.description || d.aciklama || '',
    about: d.about || '',
    genres: d.tags || d.genres || it.tags || [],
    rating: d.rating || null,
    releaseDate: d.release_date || d.datePublished || '',
    dubbed: !!it.dublaj,
    source: 'dramadunyam',
    urls,
  };
}

async function scrapeDun(limit = 50) {
  const log = (...a) => console.log('%c[dun]', 'color:#ff6b35', ...a);
  const skip = new Set((self.DUN_SKIP_TITLES || []).map(normTitle));
  const out = [];
  const seen = new Set();
  const perPage = 64;
  let page = 1, empty = 0;

  // walk the new-releases feed (it covers the whole catalog, newest first)
  while (true) {
    let feed;
    try {
      feed = await fetch(`/api/yeni-eklenenler?sayfa=${page}&adet=${perPage}&lang=en`).then(r => r.json());
    } catch (e) { log('feed failed at page', page, e.message); break; }
    const items = feed.items || [];
    if (!items.length) { empty++; if (empty >= 3) break; page++; continue; }
    empty = 0;

    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      if (skip.has(normTitle(it.title))) { continue; }        // duplicate of dramadog catalog
      if (out.length >= limit) break;

      try {
        const rec = await scrapeOneDun(it, log);
        if (!rec) continue;
        out.push(rec);
        self.DUN_RESULTS.push(rec);
        log(`ok ${out.length}: ${it.title} (${rec.episodes} eps)`);
      } catch (e) { log('ERR', it.slug, e.message); }
    }
    if (out.length >= limit || feed.devam === false || (limit !== Infinity && out.length >= limit)) break;
    page++;
    if (page > 2000) break;
  }

  const json = JSON.stringify(out, null, 1);
  console.log(`\nDONE: ${out.length} series this run (${self.DUN_RESULTS.length} total in DUN_RESULTS).\nSave as dunyam-videos.json (append to the array if you already have one), then:\n  node scripts/build_site.mjs dunyam-videos.json\n`);
  try { await navigator.clipboard.writeText(JSON.stringify(self.DUN_RESULTS, null, 1)); log('Copied DUN_RESULTS (' + self.DUN_RESULTS.length + ' records) to clipboard!'); } catch (e) {}
  return out;
}

// search-based single-title scrape — for series beyond the feed snapshot or
// brand-new releases. No walk needed; uses the site's own search API.
//   await scrapeDunTitle("definitely not the dragon god")
//   await scrapeDunTitle("dragon god", 2)   ← pick the 2nd match (1-based)
async function scrapeDunTitle(query, pick) {
  const log = (...a) => console.log('%c[dun-title]', 'color:#ff6b35;font-weight:bold', ...a);
  const q = (query || '').trim();
  if (!q) { log('give a title, e.g.  await scrapeDunTitle("definitely not the dragon god")'); return []; }

  let raw = '', res = null;
  try {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q) + '&page=1&limit=36&lang=en', { credentials: 'same-origin', cache: 'no-store' });
    raw = await r.text();
    log('search HTTP', r.status, '|', raw.length, 'bytes |', (r.headers.get('content-type') || '?'));
    res = JSON.parse(raw);
  } catch (e) {
    log('search FAILED:', e.message);
    log('raw body head:', (raw || '(empty)').slice(0, 400));
    log('→ run  await dunDiagnose("' + q + '")  and read the output');
    return [];
  }
  const items = res.data || res.items || [];
  if (!Array.isArray(items) || !items.length) {
    log('no results parsed. Response keys:', Object.keys(res || {}).join(', ') || '(none)');
    log('raw body head:', raw.slice(0, 400));
    log('→ run  await dunDiagnose("' + q + '")  and read the output');
    return [];
  }

  console.table(items.map((it, i) => ({ n: i + 1, title: it.title, eps: it.available_episodes ?? it.episodes, platform: it.platform, slug: it.slug })));

  // auto-pick an exact (normalized) title match so a full-title query just works
  const target = normTitle(q);
  let chosen = null;
  if (pick != null) {
    chosen = items[Number(pick) - 1];
    if (!chosen) { log('no match #' + pick + ' (1–' + items.length + ') — see the table above'); return []; }
  } else {
    chosen = items.find((it) => normTitle(it.title) === target) || null;
    if (!chosen && items.length === 1) chosen = items[0];
    if (!chosen) {
      log('several matches, none exactly "' + q + '" — pick one with the n column:  await scrapeDunTitle(' + JSON.stringify(q) + ', <n>)');
      return [];
    }
  }
  log('chosen:', chosen.title, '(' + chosen.slug + ')');

  try {
    const rec = await scrapeOneDun(chosen, log);
    if (!rec) { log('skipped (coming soon / unplayable):', chosen.title); return []; }
    self.DUN_RESULTS.push(rec);
    log(`ok: ${rec.title} (${rec.episodes} eps, ${rec.urls.filter(Boolean).length} playable) — DUN_RESULTS now has ${self.DUN_RESULTS.length} record(s)`);
    log('run  await copyDun()  when done, or save now: paste DUN_RESULTS as dunyam-videos.json →  node scripts/build_site.mjs dunyam-videos.json');
    try { await navigator.clipboard.writeText(JSON.stringify(self.DUN_RESULTS, null, 1)); log('Copied DUN_RESULTS to clipboard!'); } catch (e) {}
    return [rec];
  } catch (e) {
    log('ERR', chosen.slug, e.message);
    log('→ run  await probeDun("' + chosen.id + '")  to see the raw /api/series + /play responses for this id');
    return [];
  }
}

// raw diagnostic — run this if scrapeDunTitle returns [] and you want to see
// exactly what the search API answered (both URL variants the site uses):
//   await dunDiagnose("dragon god");
async function dunDiagnose(query) {
  const q = (query || 'dragon god').trim();
  const tries = [
    '/api/search?q=' + encodeURIComponent(q) + '&limit=18',                    // what doSearch() calls
    '/api/search?q=' + encodeURIComponent(q) + '&page=1&limit=36&lang=en',    // what scrapeDunTitle calls
  ];
  for (const u of tries) {
    console.log('%c[dun-diag]', 'color:#ff6b35;font-weight:bold', 'GET', u);
    try {
      const r = await fetch(u, { credentials: 'same-origin', cache: 'no-store' });
      const t = await r.text();
      console.log('status:', r.status, '| content-type:', r.headers.get('content-type'), '| bytes:', t.length);
      console.log('body head:', t.slice(0, 500));
      try {
        const j = JSON.parse(t);
        const items = j.data || j.items || [];
        console.log('parsed keys:', Object.keys(j).join(', '), '| items:', Array.isArray(items) ? items.length : typeof items);
        if (Array.isArray(items) && items.length) {
          console.table(items.slice(0, 5).map((it) => ({ id: it.id, title: it.title, slug: it.slug, eps: it.available_episodes ?? it.episodes, platform: it.platform })));
        }
      } catch { console.log('⚠ body is NOT JSON (see head above — error page / challenge?)'); }
    } catch (e) { console.log('fetch threw:', e.message); }
    await new Promise((rr) => setTimeout(rr, 800));
  }
  console.log('→ copy everything [dun-diag] printed and send it back if the search still does not resolve');
}

// copy everything accumulated so far (from scrapeDun and/or scrapeDunTitle)
async function copyDun() {
  const json = JSON.stringify(self.DUN_RESULTS, null, 1);
  console.log(`DUN_RESULTS: ${self.DUN_RESULTS.length} record(s). JSON printed below; also copied to clipboard.\nSave as dunyam-videos.json, then:  node scripts/build_site.mjs dunyam-videos.json\n`);
  console.log(json);
  try { await navigator.clipboard.writeText(json); console.log('[dun] copied!'); } catch (e) {}
  return self.DUN_RESULTS;
}
