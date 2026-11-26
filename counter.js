/* counter.js — site click counter (v5.14, Firebase Realtime Database).
   No GitHub, no token, no Actions: each count is a tiny number in a
   Firebase Realtime Database, updated over its plain REST API from the
   page. The database rules (firebase-rules.json / VIEWS-SETUP.md) allow
   public READ and ONLY "+1" writes on keys that look like slugs or tab
   names — counts can never be reset, overwritten or deleted, and this
   file holds no secret.

   Counting rules (same as always):
     countView(slug)  — one call per EPISODE START (watch.html loadVideo)
     countTab(name)   — one call per TAB OPEN (index.html setSort + boot)
   No IP dedup: every click counts.

   Clicks are batched during the visit and flushed ONCE per visit (8s
   after the first click, or when the page is hidden/closed). A batch that
   cannot be delivered (offline, Firebase hiccup) stays in localStorage
   and is re-sent on the next visit. Setup: paste your database URL into
   DB_URL below — see VIEWS-SETUP.md. */
(function () {
    'use strict';
    // Your Realtime Database URL from the Firebase console, e.g.
    // 'https://fulldrama-views-default-rtdb.firebaseio.com' — NO trailing
    // slash. Empty string = counting off: the pages keep working, counts
    // just stop until you fill it in.
    var DB_URL = 'https://fulldrama-views-default-rtdb.firebaseio.com';
    var QUEUE_KEY = 'clickQueue';
    var FLUSH_DELAY = 8000;   // ms after the first click of a visit
    var MAX_QUEUED = 1000;    // cap undelivered clicks (this is a counter, not a bank)
    var BUMP_RETRIES = 3;     // "+1" conflicts (two viewers wrote at once) re-read and retry

    var pending = { views: {}, tabs: {} };  // this visit's clicks
    var queued = load();                    // undelivered from earlier visits
    var timer = null;

    function load() {
        try {
            var q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}');
            return { views: (q && q.views) || {}, tabs: (q && q.tabs) || {} };
        } catch (e) { return { views: {}, tabs: {} }; }
    }
    function save() {
        try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queued)); } catch (e) {}
    }
    function add(map, k, n) { map[k] = (Number(map[k]) || 0) + (n || 1); }
    function total(p) {
        var n = 0, k;
        for (k in p.views) n += Number(p.views[k]) || 0;
        for (k in p.tabs) n += Number(p.tabs[k]) || 0;
        return n;
    }
    function merge(a, b) {
        var k;
        for (k in (b.views || {})) add(a.views, k, b.views[k]);
        for (k in (b.tabs || {})) add(a.tabs, k, b.tabs[k]);
    }
    function countView(slug) {
        if (!DB_URL || !slug || total(queued) >= MAX_QUEUED) return;
        add(pending.views, slug);
        schedule();
    }
    function countTab(name) {
        if (!DB_URL || !name || total(queued) >= MAX_QUEUED) return;
        add(pending.tabs, name);
        schedule();
    }
    function schedule() { if (!timer) timer = setTimeout(flush, FLUSH_DELAY); }

    // One "+1" for <node>/<key>: GET the current number (null when the key
    // is new), PUT current+1. The server rejects anything that is not
    // exactly current+1 — that is what keeps two simultaneous viewers from
    // losing a count: the loser gets a 401, re-reads and retries.
    function bump(node, key, tries) {
        var url = DB_URL + '/' + node + '/' + encodeURIComponent(key) + '.json';
        return fetch(url)
            .then(function (r) { if (!r.ok) throw new Error('read ' + r.status); return r.json(); })
            .then(function (n) {
                return fetch(url, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify((Number(n) || 0) + 1),
                    keepalive: true              // survives page close (tiny body)
                });
            })
            .then(function (r) {
                if (r.ok) return true;
                if (r.status === 401 && tries < BUMP_RETRIES) {
                    return new Promise(function (res) { setTimeout(res, 250 * (tries + 1)); })
                        .then(function () { return bump(node, key, tries + 1); });
                }
                throw new Error('write ' + r.status);
            });
    }

    function flush() {
        clearTimeout(timer);
        timer = null;
        if (!DB_URL) return;
        merge(pending, queued);          // earlier failures ride along
        merge(pending, load());          // pick up clicks saved since page load
        queued = { views: {}, tabs: {} };
        if (!total(pending)) { save(); return; }
        var payload = pending;
        pending = { views: {}, tabs: {} };
        save();                          // queued drained before sending — a
        // crash here can lose one batch but can never double-count it
        var sent = { views: {}, tabs: {} };  // what actually landed
        var jobs = [];
        Object.keys(payload.views).forEach(function (slug) {
            jobs.push(bump('views', slug, 0).then(
                function () { sent.views[slug] = payload.views[slug]; },
                function () { }          // failure: stays in localStorage for the next visit
            ));
        });
        Object.keys(payload.tabs).forEach(function (tab) {
            jobs.push(bump('tabs', tab, 0).then(
                function () { sent.tabs[tab] = payload.tabs[tab]; },
                function () { }
            ));
        });
        Promise.all(jobs).then(function () {
            // Re-read what is on disk NOW (another tab may have queued clicks
            // while this flush was in flight) and subtract only the amount
            // that actually landed — the rest retries on the next visit.
            var leftover = load();
            merge(queued, leftover);
            var k;
            for (k in sent.views) {
                if (queued.views[k]) {
                    queued.views[k] -= sent.views[k];
                    if (queued.views[k] <= 0) delete queued.views[k];
                }
            }
            for (k in sent.tabs) {
                if (queued.tabs[k]) {
                    queued.tabs[k] -= sent.tabs[k];
                    if (queued.tabs[k] <= 0) delete queued.tabs[k];
                }
            }
            save();
            // v5.14 — tell the page what actually landed (index.html uses
            // this to tick the chips up without waiting for the next read).
            try { if (window.siteCounter && window.siteCounter.onFlushed) window.siteCounter.onFlushed(sent); } catch (e) {}
        });
    }

    // Leaving the page flushes immediately (fast bounce visits still count).
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    // Leftovers from an earlier failed visit go out right away.
    if (total(queued)) setTimeout(flush, 1500);

    window.siteCounter = {
        countView: countView,
        countTab: countTab,
        flushNow: flush,
        onFlushed: null,          // v5.14 — page hook: called with the sent batch after each flush
        dbUrl: DB_URL             // index.html reads this for the display fetch
    };
})();
