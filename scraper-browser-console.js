/**
 * DramaStream scraper v2 — paste into the DevTools console ON https://dramadog.app/
 * (F12 → Console → paste → Enter). Output matches the data.js format used by
 * index.html / watch.html ( DramaStream v2 ).
 *
 * What changed vs the old scraper:
 *  - Real episode URLs come from /api/eps/<drama_id> (one signed m3u8 per episode,
 *    all mirrors). The old scraper GUESSED a v.dramadog.app/hls/... pattern that
 *    returns 404 — that is why videos would not load.
 *  - Story/About text is read from the <div class="story"> blocks (the old
 *    nextElementSibling walk skipped the <p> tags nested inside the div, so
 *    descriptions came out truncated).
 *  - Genres come from the JSON-LD block instead of the "See all" trope links.
 *  - The output already contains "urls" (episode URLs), ready to paste into data.js.
 *
 * Tips:
 *  - limit = 50 by default (newest first on /new). Raise it for more.
 *  - Add ?ep=N to a watch.html URL is NOT needed — all episodes are included.
 */
async function scrapeDramaStream(limit = 50) {
  const dramas = [];
  log('Fetching /new ...');

  const homeRes = await fetch('/new');
  const homeHtml = await homeRes.text();
  const doc = new DOMParser().parseFromString(homeHtml, 'text/html');
  const links = [...new Set([...doc.querySelectorAll('a[href^="/drama/"]')].map(a => a.getAttribute('href')))];
  log(`Found ${links.length} drama links, scraping first ${Math.min(limit, links.length)}...`);

  for (const href of links.slice(0, limit)) {
    const slug = href.split('/').pop();
    try {
      const html = await (await fetch(href)).text();
      const pageDoc = new DOMParser().parseFromString(html, 'text/html');

      // --- ids / totals (window.__DB) ---
      const dbMatch = html.match(/window\.__DB\s*=\s*(\{[^<]*?\})\s*;?\s*<\/script>/);
      let db = {};
      if (dbMatch) { try { db = JSON.parse(dbMatch[1]); } catch (e) {} }
      const id = db.drama_id || 0;
      const total = db.total || 0;
      if (!id) { log(`skip ${slug}: no drama_id`); continue; }

      // --- title / genres / cover / date from JSON-LD ---
      const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map(m => { try { return JSON.parse(m[1]); } catch (e) { return null; } })
        .filter(Boolean);
      const tv = ld.find(o => o['@type'] === 'TVSeries') || {};
      const faq = ld.find(o => o['@type'] === 'FAQPage') || {};

      const title = tv.name || pageDoc.title.replace(/ Full Episodes Free.*$/i, '').trim();
      let episodes = tv.numberOfEpisodes || total;
      if (!episodes) {
        const em = ((faq.mainEntity || [])[0] || {}).acceptedAnswer?.text?.match(/has (\d+) episodes/);
        episodes = em ? +em[1] : 0;
      }
      const cover = (tv.image || (id ? `/c/${id}.webp` : ''));
      const coverAbs = cover.startsWith('http') ? cover : location.origin + cover;
      const genres = (tv.genre || []).filter(g => g && g !== 'See all');
      const releaseDate = tv.datePublished || '';

      // --- Story (full description) & About paragraphs ---
      const paras = (rootEl) => [...rootEl.querySelectorAll('p')].map(p => p.textContent.trim()).join(' ').replace(/\s+/g, ' ').trim();
      const sectionAfter = (h2Text) => {
        const h2 = [...pageDoc.querySelectorAll('h2')].find(h => h.textContent.toLowerCase().startsWith(h2Text));
        if (!h2) return null;
        let el = h2.nextElementSibling;
        while (el && el.tagName !== 'SECTION') {
          if (el.querySelectorAll && el.querySelectorAll('p').length) return el;
          el = el.nextElementSibling;
        }
        return null;
      };
      const storyEl = sectionAfter('story');
      const aboutEl = sectionAfter('about');
      const description = storyEl ? paras(storyEl) : (tv.description || '');
      const about = aboutEl ? paras(aboutEl) : description;

      // --- rating from the About text ---
      const rm = (about || '').match(/rate it (\d+(?:\.\d+)?) out of 10/i);
      const rating = rm ? parseFloat(rm[1]) : null;

      // --- platform: from the About text ("originally released on ReelShort in ...") ---
      let platform = 'other';
      const pm = (about || '').match(/originally released on ([A-Za-z0-9 &]+?) in [A-Z]/i);
      if (pm) platform = pm[1].trim().toLowerCase().replace(/\s+/g, '');

      // --- REAL episode URLs from the same API the site's own player uses ---
      const mirrors = await (await fetch('/api/eps/' + id)).json();
      const urls = (mirrors[0] && mirrors[0].urls) || [];
      if (!urls.length) { log(`skip ${slug}: /api/eps returned no URLs`); continue; }

      dramas.push({
        id: +id,
        title,
        slug,
        platform,
        episodes: +episodes || urls.length,
        cover: coverAbs,
        description,
        about,
        genres,
        rating,
        releaseDate,
        urls,
      });
      log(`ok ${title} — ${urls.length} episode URLs`);
    } catch (e) {
      log(`ERR ${slug}: ${e.message}`);
    }
  }

  const json = JSON.stringify(dramas, null, 2);
  const banner = 'const dramas = ';
  const out = banner + json + ';';
  console.log(`\nDone: ${dramas.length} dramas. Copy the object below into data.js (replace its contents).\n`);
  console.log(out);
  try { await navigator.clipboard.writeText(out); log('Copied to clipboard!'); }
  catch (e) { log('Clipboard blocked — copy manually from the output above.'); }

  function log(s) { console.log('[scraper] ' + s); }
  return dramas;
}
scrapeDramaStream(50);
