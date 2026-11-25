/* counter.js — site click counter (v5.13). No third-party service, and the
   GitHub token is NOT in this file: clicks are batched during this visit and
   sent ONCE to the site's own /api/view endpoint (a Pages Function in
   functions/api/view.js). The function holds the token server-side (env var
   GH_VIEWS_TOKEN, set in the Cloudflare Pages dashboard) and fires the
   repository_dispatch event at the views repo. The views.yml Action in the
   views repo applies the batch to views.json / tab-views.json and commits.
   A batch that cannot be delivered (offline, rate limit) stays in
   localStorage and is re-sent on the next visit — nothing lost, no double
   counting.

   Counting rules (same as always):
     countView(slug)  — one call per EPISODE START (watch.html loadVideo)
     countTab(name)   — one call per TAB OPEN (index.html setSort + boot)
   No IP dedup: every click counts. */
(function () {
    'use strict';
    var QUEUE_KEY = 'clickQueue';
    var FLUSH_DELAY = 8000;   // ms after the first click of a visit
    var MAX_QUEUED = 1000;    // cap undelivered clicks (this is a counter, not a bank)

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
        if (!slug || total(queued) >= MAX_QUEUED) return;
        add(pending.views, slug);
        schedule();
    }
    function countTab(name) {
        if (!name || total(queued) >= MAX_QUEUED) return;
        add(pending.tabs, name);
        schedule();
    }
    function schedule() { if (!timer) timer = setTimeout(flush, FLUSH_DELAY); }
    function flush() {
        clearTimeout(timer);
        timer = null;
        merge(pending, queued);          // earlier failures ride along
        merge(pending, load());          // pick up clicks saved since page load
        queued = { views: {}, tabs: {} };
        if (!total(pending)) { save(); return; }
        var payload = pending;
        pending = { views: {}, tabs: {} };
        save();                          // queued drained before sending — a
        // crash here can lose one batch but can never double-count it
        fetch('/api/view', {             // same-origin Pages Function; token stays server-side
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true              // survives page close (small body)
        }).then(function (r) {
            if (r.ok) save();
            else fail(payload);
        }).catch(function () { fail(payload); });
    }
    function fail(payload) { merge(queued, payload); save(); }

    // Leaving the page flushes immediately (fast bounce visits still count).
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    // Leftovers from an earlier failed visit go out right away.
    if (total(queued)) setTimeout(flush, 1500);

    window.siteCounter = { countView: countView, countTab: countTab, flushNow: flush };
})();
