#!/usr/bin/env python3
"""
Video link rescuer for fulldrama.stream
=======================================

Runs AFTER check_videos.py flagged a video as BROKEN. For each broken video it:

  1. finds the drama's record in new-videos.json (repo catalog - the schema is
     left exactly as-is; only the episode-link array is touched)
  2. solves watchdramareels.com's proof-of-work "bilet" ticket
     (GET /api/b -> sha256(s:n) with z leading zero bits -> POST /api/b -> cookie)
  3. calls GET /api/play/{id}/{ep} for EVERY episode (same endpoint the site's
     own player uses), polling while durum="bekle" and refreshing the ticket on 412
  4. VERIFIES each returned link end-to-end (m3u8 playlist -> first segment)
     before trusting it; on a dead link it uses the site's own recheck trick
     (?recheck={etiket}) to get a fresh one and verifies that too
  5. patches new-videos.json IN PLACE with byte-precise text surgery: only the
     target record's link array is rewritten, preserving the file's exact
     indentation style - every other record and byte stays untouched
  6. writes a rescue report (stdout + GITHUB_STEP_SUMMARY + rescue.json)

Exit codes: 0 = every broken video got a verified fresh link (and the proxy
worker from the check results is not down) -> workflow stays green;
            1 = at least one video could not be rescued, or the worker is down.

Note: watchdramareels signs idrama.video links per request and the player
itself treats them as stale after ~2 minutes, so a rescued link is the
FRESHEST possible snapshot - your pipeline should consume new-videos.json
promptly after the workflow commits it.

Usage:
  python3 scripts/rescue_videos.py \
      --results health-results/results.json \
      --catalog new-videos.json \
      --report health-results/rescue.json \
      [--slugs slug-a,slug-b]   # override: rescue these slugs instead
      [--site https://watchdramareels.com]
      [--max-eps 0]             # 0 = every episode the catalog record lists
      [--budget-seconds 1200]   # global time budget for scraping
"""

import argparse
import datetime
import hashlib
import http.cookiejar
import json
import os
import random
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_videos import (  # noqa: E402
    BROWSER_HEADERS, MAX_EPISODE_BYTES, http_get, net_err_text,
)

TLS_CTX = ssl.create_default_context()

WAF_MARKERS = re.compile(
    r"<html|attention required|just a moment|cf-chl|access denied", re.I)


# ---------------------------------------------------------------------------
# watchdramareels client: PoW ticket cookie + /api/play
# ---------------------------------------------------------------------------
class WdrClient:
    def __init__(self, base, timeout=45, cookie_path=None):
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.cookie_path = cookie_path
        self._last_b = 0.0            # last /api/b touch (rate-limit pacing)
        if cookie_path and os.path.exists(cookie_path):
            self.jar = http.cookiejar.MozillaCookieJar(cookie_path)
            try:
                self.jar.load(ignore_discard=True, ignore_expires=False)
            except Exception:
                self.jar = http.cookiejar.CookieJar()
        else:
            self.jar = (http.cookiejar.MozillaCookieJar(cookie_path)
                        if cookie_path else http.cookiejar.CookieJar())
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=TLS_CTX),
        )
        self.ua = BROWSER_HEADERS["User-Agent"]

    def _get(self, path, headers=None):
        h = {"User-Agent": self.ua, "Accept": "application/json"}
        if headers:
            h.update(headers)
        req = urllib.request.Request(self.base + path, headers=h)
        try:
            with self.opener.open(req, timeout=self.timeout) as r:
                return r.status, r.read(262144).decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            try:
                return e.code, e.read(262144).decode("utf-8", "replace")
            except Exception:
                return e.code, ""
        except Exception as e:
            raise OSError(net_err_text(e))

    def _post(self, path, payload):
        origin = urllib.parse.urlsplit(self.base)
        base = f"{origin.scheme}://{origin.netloc}"
        body = json.dumps(payload).encode()
        req = urllib.request.Request(self.base + path, data=body, method="POST", headers={
            "User-Agent": self.ua, "Content-Type": "application/json",
            "Accept": "application/json", "Origin": base, "Referer": base + "/",
            "X-Requested-With": "XMLHttpRequest",
        })
        try:
            with self.opener.open(req, timeout=self.timeout) as r:
                return r.status, r.read(262144).decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            try:
                return e.code, e.read(262144).decode("utf-8", "replace")
            except Exception:
                return e.code, ""
        except Exception as e:
            raise OSError(net_err_text(e))

    @staticmethod
    def _leading_zero_bits(digest):
        n = 0
        for b in digest:
            if b == 0:
                n += 8
            else:
                for bit in (0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01):
                    if b & bit:
                        return n
                    n += 1
        return n

    def _has_fresh_ticket(self):
        """True when a __Host-b cookie is stored with >2 h left (browser keeps
        the ticket ~10-12 h; the site rate-limits ticket issuance, so reuse)."""
        now = time.time()
        for c in self.jar:
            if c.name == "__Host-b" and (c.expires or 0) > now + 2 * 3600:
                return True
        return False

    def visit(self, url):
        """Land on the series page like a browser does (collects any session
        cookies before the ticket/play flow)."""
        try:
            self._get(urllib.parse.urlsplit(url).path + ("?" + urllib.parse.urlsplit(url).query
                      if urllib.parse.urlsplit(url).query else ""),
                      headers={"Accept": "text/html,application/xhtml+xml"})
        except Exception:
            pass

    def ticket(self, log=lambda s: None, force=False):
        """Solve the PoW and store the __Host-b cookie (12 h validity).
        Paced + retried once: the site rate-limits ticket issuance."""
        if not force and self._has_fresh_ticket():
            log("ticket cookie still fresh - reusing (no new PoW)")
            return
        gap = 4.0 - (time.time() - self._last_b)
        if self._last_b and gap > 0:
            time.sleep(gap)
        st, body = self._get("/api/b")
        self._last_b = time.time()
        if st != 200:
            raise OSError(f"/api/b HTTP {st}")
        ch = json.loads(body)
        s, z = ch["s"], int(ch.get("z", 12))
        n, t0 = 0, time.time()
        while True:
            d = hashlib.sha256(f"{s}:{n}".encode()).digest()
            if self._leading_zero_bits(d) >= z:
                break
            n += 1
        st, body = self._post("/api/b", {"s": s, "n": str(n)})
        self._last_b = time.time()
        if st != 200:                       # one paced retry before giving up
            time.sleep(4)
            st, body = self._post("/api/b", {"s": s, "n": str(n)})
            self._last_b = time.time()
        if st != 200:
            raise OSError(f"/api/b POST HTTP {st}: {body[:80]}")
        log(f"ticket solved (z={z}, n={n}, {time.time() - t0:.2f}s) "
            f"cookies={[c.name for c in self.jar]}")
        if self.cookie_path:
            try:
                self.jar.save(ignore_discard=True, ignore_expires=True)
            except Exception as e:
                log(f"warn: could not save cookie file: {e}")

    def play(self, drama_id, ep, referer, poll_seconds=45, log=lambda s: None,
             extra_q=""):
        """Call /api/play/{id}/{ep}[?extra_q]. Handles the site's non-
        deterministic 412s: retry with the same cookie first (the browser does
        the same), then force a paced re-ticket. Polls 'bekle' states.
        Returns (url_or_None, etag_or_None, note)."""
        deadline = time.time() + poll_seconds
        ticket_tries = 0
        replay_tries = 0
        notes = []
        attempt_q = extra_q
        while True:
            st, body = self._get(f"/api/play/{drama_id}/{ep}{attempt_q}",
                                 headers={"Referer": referer})
            if st in (403, 503) or WAF_MARKERS.search(body[:300]):
                notes.append(f"HTTP {st}/WAF")
                return None, None, "; ".join(notes)
            if st == 412:
                # the ticket sometimes bounces a request - a same-cookie retry
                # often succeeds; only re-solve the PoW when it keeps failing
                if replay_tries < 2:
                    replay_tries += 1
                    notes.append(f"412 -> replay #{replay_tries}")
                    time.sleep(1.5)
                    continue
                if ticket_tries < 2:
                    ticket_tries += 1
                    notes.append(f"412 -> reticket #{ticket_tries}")
                    try:
                        self.ticket(log=log, force=True)
                    except OSError as e:
                        notes.append(f"reticket failed: {e}")
                        time.sleep(2)
                        continue
                    continue
                if time.time() >= deadline:
                    notes.append("412 persisted")
                    return None, None, "; ".join(notes)
                time.sleep(2)
                continue
            try:
                j = json.loads(body)
            except Exception:
                notes.append(f"HTTP {st} non-JSON")
                return None, None, "; ".join(notes)
            durum = j.get("durum")
            if durum == "hazir" and j.get("url"):
                url = j["url"]
                if not re.match(r"^https?://", url):
                    url = self.base + ("" if url.startswith("/") else "/") + url
                return url, j.get("etiket"), "; ".join(notes)
            if durum == "yok":
                notes.append(f"yok ({j.get('neden') or 'unavailable'})")
                return None, None, "; ".join(notes)
            # durum == 'bekle': upstream still preparing
            if time.time() >= deadline:
                notes.append(f"timeout waiting ({j.get('neden') or 'bekle'})")
                return None, None, "; ".join(notes)
            wait = min(5.0, max(1.0, float(j.get("bekle") or 2)))
            time.sleep(wait)


# ---------------------------------------------------------------------------
# link verification (same bar as check_videos.py: playlist + first segment)
# ---------------------------------------------------------------------------
def verify_link(url, timeout=30):
    """Return (ok, detail). ok=True only if playlist AND first segment load."""
    try:
        status, body, final, _ = http_get(url, timeout=timeout)
        text = body.decode("utf-8", "replace")
        if status != 200:
            return False, f"playlist HTTP {status}"
        if "#EXTM3U" not in text[:200]:
            return False, "not an M3U8 playlist"
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        if "#EXT-X-STREAM-INF" in text:          # master -> follow first variant
            variant = None
            for k, l in enumerate(lines):
                if l.startswith("#EXT-X-STREAM-INF") and k + 1 < len(lines):
                    variant = lines[k + 1]
                    break
            if not variant or variant.startswith("#"):
                return False, "master playlist without variant"
            status, body, final, _ = http_get(
                urllib.parse.urljoin(final, variant), timeout=timeout)
            text = body.decode("utf-8", "replace")
            if status != 200 or "#EXTM3U" not in text[:200]:
                return False, f"variant HTTP {status}"
            lines = [l.strip() for l in text.splitlines() if l.strip()]
        seg = next((l for l in lines if not l.startswith("#")), None)
        if not seg:
            m = re.search(r'#EXT-X-MAP:.*?URI="([^"]+)"', text)
            seg = m.group(1) if m else None
        if not seg:
            return False, "playlist lists no segments"
        seg_abs = urllib.parse.urljoin(final, seg)
        status, body, _, _ = http_get(seg_abs, timeout=timeout,
                                      headers={"Range": f"bytes=0-{MAX_EPISODE_BYTES - 1}"},
                                      max_read=MAX_EPISODE_BYTES)
        if status in (200, 206) and len(body) > 0:
            return True, f"playlist+segment OK ({len(body)}B)"
        return False, f"segment HTTP {status}"
    except Exception as e:
        return False, net_err_text(e)


# ---------------------------------------------------------------------------
# new-videos.json text surgery (schema- and style-preserving)
# ---------------------------------------------------------------------------
def _match(text, start, open_ch="{", close_ch="}"):
    """String-aware bracket matcher; returns end index of the matching close."""
    depth, in_str, esc = 0, False, False
    i = start
    while i < len(text):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def find_record_span(raw, slug):
    """Locate the record object whose slug matches; returns (start, end)."""
    needle = f'"{slug}"'
    pos = 0
    while True:
        i = raw.find(needle, pos)
        if i < 0:
            return None
        pos = i + len(needle)
        s = raw.rfind("{", 0, i)
        if s < 0:
            continue
        e = _match(raw, s)
        if e < 0:
            continue
        try:
            rec = json.loads(raw[s:e + 1])
        except Exception:
            continue
        if rec.get("slug") == slug:
            return s, e + 1


def patch_urls_array(raw, slug, new_urls):
    """Replace the LAST "urls" array of the record with new_urls, preserving
    the file's indentation style. Returns (new_raw, old_urls, style_note)."""
    span = find_record_span(raw, slug)
    if not span:
        raise LookupError(f"slug {slug!r} not found in catalog")
    s, e = span
    j = raw.rfind('"urls"', s, e)
    if j < 0:
        raise LookupError("record has no urls key")
    k = raw.find("[", j, e)
    close = _match(raw, k, "[", "]")
    if close < 0 or close >= e:
        raise ValueError("urls array spans past record bounds")

    # style detection: indent of the "urls" key line, of items, of the closing ]
    line_start = raw.rfind("\n", 0, j) + 1
    key_indent = re.match(r"[ ]*", raw[line_start:j]).group(0)
    inner = raw[k + 1:close]
    m_item = re.match(r"\n([ ]*)\"", inner)
    item_indent = m_item.group(1) if m_item else key_indent + " "
    m_close = re.search(r"\n([ ]*)\]\s*$", inner)
    close_indent = m_close.group(1) if m_close else key_indent

    old_urls = None
    try:
        rec = json.loads(raw[s:e])
        old_urls = rec.get("urls")
    except Exception:
        pass

    # keep whatever sits between the key and the bracket (spacing preservation)
    key_part = raw[j:k]
    items = ",\n".join(f"{item_indent}{json.dumps(u, ensure_ascii=False)}"
                       for u in new_urls)
    if new_urls:
        new_frag = f"{key_part}[\n{items}\n{close_indent}]"
    else:
        new_frag = f"{key_part}[]"
    patched = raw[:j] + new_frag + raw[close + 1:]
    return patched, old_urls, f"key@{len(key_indent)}sp items@{len(item_indent)}sp close@{len(close_indent)}sp"


# ---------------------------------------------------------------------------
# rescue pipeline
# ---------------------------------------------------------------------------
def rescue_video(entry, catalog_raw, client, site, args, log):
    """Rescue one video. Returns dict result (never raises for expected failures)."""
    slug = entry["slug"]
    flagged_ep = int(entry.get("episode") or 1)
    out = {"slug": slug, "episode": flagged_ep, "status": None, "id": None,
           "episodes_total": 0, "verified": 0, "kept_old": 0, "failed_eps": [],
           "detail": []}

    span = find_record_span(catalog_raw, slug)
    if not span:
        out["status"] = "FAILED"
        out["detail"].append("record not found in new-videos.json - add it first")
        return out
    rec = json.loads(catalog_raw[span[0]:span[1]])
    out["id"] = rec.get("id")
    total = int(rec.get("episodes") or len(rec.get("urls") or []) or 0)
    if args.max_eps:
        total = min(total, args.max_eps)
    if total <= 0 or not isinstance(rec.get("id"), int):
        out["status"] = "FAILED"
        out["detail"].append(f"catalog record unusable (id={rec.get('id')}, episodes={total})")
        return out
    out["episodes_total"] = total

    # resolve links per episode; keep the old link where upstream has none
    old_urls = rec.get("urls") or []
    new_urls = list(old_urls) + [""] * max(0, total - len(old_urls))
    new_urls = new_urls[:total]
    referer = f"{site}/series/{slug}"
    client.visit(referer)                     # land on the series page first
    budget_until = time.time() + args.budget_seconds
    waf_streak = 0
    verified = 0
    failed = {}                               # ep -> why
    scraped = set()                           # eps verified this run

    def try_ep(ep, reason_prefix=""):
        """Scrape + verify one episode; returns True on verified fresh link."""
        nonlocal verified, waf_streak
        url, etag, note = client.play(rec["id"], ep, referer,
                                      poll_seconds=args.poll_seconds, log=log)
        if note:
            out["detail"].append(f"ep{ep}: {reason_prefix}{note}")
        if url is None:
            if "WAF" in (note or "") or "403" in (note or ""):
                waf_streak += 1
            failed[ep] = note or "no link"
            return False
        waf_streak = 0
        ok, detail = verify_link(url, timeout=args.timeout)
        if not ok and etag:
            # the site's own trick: ask the server to re-verify and re-sign
            q = f"?recheck={urllib.parse.quote(str(etag), safe='')}"
            url2, _, note2 = client.play(rec["id"], ep, referer,
                                         poll_seconds=args.poll_seconds, log=log,
                                         extra_q=q)
            if note2:
                out["detail"].append(f"ep{ep} recheck: {note2}")
            if url2 and url2 != url:
                ok, detail = verify_link(url2, timeout=args.timeout)
                if ok:
                    url = url2
        if ok:
            new_urls[ep - 1] = url
            verified += 1
            scraped.add(ep)
            failed.pop(ep, None)
            log(f"{slug} ep{ep}: VERIFIED {url[:80]}...")
            return True
        failed[ep] = f"link unusable: {detail}"
        out["detail"].append(f"ep{ep}: unusable ({detail})")
        return False

    # pass 1: every episode
    for ep in range(1, total + 1):
        if time.time() > budget_until:
            failed[ep] = "time budget exhausted"
            continue
        if waf_streak >= 3:
            failed[ep] = "WAF hard stop"
            continue
        try_ep(ep)
        time.sleep(args.pace + random.uniform(0, 0.4))

    # pass 2: one retry per failed episode, flagged episode first
    if failed and time.time() < budget_until and waf_streak < 3:
        log(f"second pass for {len(failed)} failed episode(s)")
        retry_order = [flagged_ep] + [e for e in sorted(failed) if e != flagged_ep]
        for ep in retry_order:
            if ep not in failed or time.time() > budget_until or waf_streak >= 3:
                continue
            if try_ep(ep, reason_prefix="retry: "):
                time.sleep(args.pace + random.uniform(0, 0.4))

    out["failed_eps"] = [{"ep": e, "why": w} for e, w in sorted(failed.items())]
    out["verified"] = verified
    out["kept_old"] = sum(1 for fe in out["failed_eps"]
                          if 0 < fe["ep"] <= len(new_urls) and new_urls[fe["ep"] - 1])
    out["flagged_ok"] = flagged_ep in scraped
    if verified == 0:
        out["status"] = "FAILED"
        out["detail"].append("no episode link could be verified")
        return out
    if not out["flagged_ok"]:
        out["status"] = "PARTIAL"
        out["detail"].append(f"flagged ep{flagged_ep} has no verified fresh link "
                             f"({verified} other episode(s) verified)")
        return out

    # patch the catalog (only when something actually changed)
    if new_urls == old_urls[:total] and len(old_urls) == total:
        out["status"] = "RESCUED"
        out["detail"].append("urls already up to date - file untouched")
        return out
    try:
        patched, _, style = patch_urls_array(catalog_raw, slug, new_urls)
    except Exception as e:
        out["status"] = "FAILED"
        out["detail"].append(f"catalog patch failed: {net_err_text(e)}")
        return out
    # sanity: JSON still parses, and ONLY the target record changed
    old_data = json.loads(catalog_raw)
    new_data = json.loads(patched)
    target_idx = next((i for i, r in enumerate(old_data)
                       if isinstance(r, dict) and r.get("slug") == slug), None)
    bad = (target_idx is None
           or len(new_data) != len(old_data)
           or any(a != b for i, (a, b) in enumerate(zip(old_data, new_data)) if i != target_idx))
    if bad:
        out["status"] = "FAILED"
        out["detail"].append("patch safety check failed - file not written")
        return out
    out["new_raw"] = patched
    out["style"] = style
    out["status"] = "RESCUED"
    return out


def main():
    ap = argparse.ArgumentParser(description="rescue broken video links via watchdramareels.com")
    ap.add_argument("--results", default=None, help="check_videos.py results.json")
    ap.add_argument("--slugs", default=None, help="comma-separated slugs (overrides --results)")
    ap.add_argument("--catalog", default="new-videos.json")
    ap.add_argument("--report", default=None)
    ap.add_argument("--site", default=os.environ.get("WDR_BASE_URL", "https://watchdramareels.com"))
    ap.add_argument("--cookie-file", default=os.environ.get("WDR_COOKIE_FILE", ""),
                    help="persist the ticket cookie here (avoids re-solving the PoW "
                         "within its 12h validity; the site rate-limits tickets)")
    ap.add_argument("--timeout", type=int, default=30)
    ap.add_argument("--pace", type=float, default=1.4, help="seconds between episode requests")
    ap.add_argument("--poll-seconds", type=int, default=45, help="max wait per /api/play poll")
    ap.add_argument("--max-eps", type=int, default=0, help="cap episodes per video (0 = all)")
    ap.add_argument("--budget-seconds", type=int, default=1200, help="global scrape time budget")
    args = ap.parse_args()

    site = args.site.rstrip("/")

    # which videos need rescuing?
    if args.slugs:
        targets = [{"slug": s.strip(), "episode": 1}
                   for s in args.slugs.split(",") if s.strip()]
        proxy_broken = False
    else:
        try:
            with open(args.results, encoding="utf-8") as f:
                results = json.load(f)
        except Exception as e:
            print(f"RESCUE CONFIG ERROR: cannot read {args.results}: {e}", file=sys.stderr)
            return 2
        targets = [{"slug": v["slug"], "episode": v.get("episode", 1)}
                   for v in results.get("videos", [])
                   if (v.get("overall") or {}).get("status") == "BROKEN"]
        proxy_broken = any((v.get("proxy") or {}).get("alive", {}).get("status") == "BROKEN"
                           for v in results.get("videos", []))

    with open(args.catalog, encoding="utf-8") as f:
        catalog_raw = f.read()

    checked_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    log = lambda s: print(f"[{datetime.datetime.now(datetime.timezone.utc):%H:%M:%S}] {s}", flush=True)

    if not targets and not proxy_broken:
        print("nothing to rescue - all videos healthy, worker up")
        return 0

    client = WdrClient(site, timeout=args.timeout, cookie_path=args.cookie_file or None)
    try:
        client.ticket(log=log)
    except OSError as e:
        print(f"RESCUE FAILED: cannot obtain watchdramareels ticket: {e}\n"
              f"hint: the site limits ticket issuance per IP - retry in a few minutes "
              f"or pass --cookie-file to reuse a recent ticket.", file=sys.stderr)
        return 1

    results_rows = []
    catalog_raw_current = catalog_raw
    for t in targets:
        log(f"rescuing {t['slug']} (flagged ep{t['episode']})...")
        try:
            res = rescue_video(t, catalog_raw_current, client, site, args, log)
        except Exception as e:
            res = {"slug": t["slug"], "episode": t.get("episode", 1), "status": "FAILED",
                   "detail": [f"unexpected: {net_err_text(e)}"], "verified": 0,
                   "episodes_total": 0, "kept_old": 0, "failed_eps": []}
        if res.get("new_raw"):
            catalog_raw_current = res.pop("new_raw")
        print(f"[{res['status']}] {res['slug']}: verified={res.get('verified', 0)}/"
              f"{res.get('episodes_total', 0)} kept_old={res.get('kept_old', 0)}", flush=True)
        results_rows.append(res)

    # persist catalog if anything was patched
    changed = catalog_raw_current != catalog_raw
    if changed:
        with open(args.catalog, "w", encoding="utf-8") as f:
            f.write(catalog_raw_current)
        print(f"new-videos.json updated ({len(catalog_raw_current)} bytes)", flush=True)

    # summary
    def _cell(r, k):
        v = r.get(k)
        return "-" if v is None else str(v)

    lines = [f"## Video link rescue — {checked_at}", ""]
    if changed:
        lines += [f"**new-videos.json patched** ({len(targets)} video(s) rescued)", ""]
    lines.append("| Video | Flagged ep | Eps | Verified fresh | Kept old | Failed eps | Status |")
    lines.append("|---|---|---|---|---|---|---|")
    for r in results_rows:
        lines.append("| {slug} | {ep} | {tot} | {v} | {k} | {f} | **{s}** |".format(
            slug=r["slug"], ep=r["episode"], tot=r.get("episodes_total", 0),
            v=r.get("verified", 0), k=r.get("kept_old", 0),
            f=len(r.get("failed_eps") or []), s=r["status"]))
    if proxy_broken:
        lines.append("")
        lines.append("**Proxy worker was DOWN during the check** - it needs attention "
                     "independently of the rescued links.")
    for r in results_rows:
        if r["status"] == "FAILED" or r.get("failed_eps"):
            lines.append("")
            lines.append(f"### {r['slug']}")
            for d in (r.get("detail") or [])[:12]:
                lines.append(f"- {d}")
    lines.append("")
    all_rescued = all(r["status"] == "RESCUED" for r in results_rows) if results_rows else True
    verdict = "OK" if (all_rescued and not proxy_broken) else "FAILED"
    lines.append(f"**Rescue verdict: {verdict}**"
                 + ("" if all_rescued else " - some videos could not be fully rescued")
                 + (" - proxy worker down" if proxy_broken else ""))
    summary = "\n".join(lines)
    print("\n" + summary)

    gh = os.environ.get("GITHUB_STEP_SUMMARY")
    if gh:
        try:
            with open(gh, "a", encoding="utf-8") as f:
                f.write(summary + "\n")
        except Exception as e:
            print(f"warn: could not write GITHUB_STEP_SUMMARY: {e}", file=sys.stderr)

    if args.report:
        try:
            os.makedirs(os.path.dirname(args.report) or ".", exist_ok=True)
            slim = [{k: v for k, v in r.items() if k != "new_raw"} for r in results_rows]
            with open(args.report, "w", encoding="utf-8") as f:
                json.dump({"checked_at": checked_at, "site": site, "catalog_changed": changed,
                           "proxy_broken": proxy_broken, "verdict": verdict,
                           "videos": slim}, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"warn: could not write report: {e}", file=sys.stderr)

    return 0 if verdict == "OK" else 1


if __name__ == "__main__":
    sys.exit(main())
