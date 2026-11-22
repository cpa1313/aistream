#!/usr/bin/env python3
"""
Video health checker for fulldrama.stream
=========================================

Replicates what a real browser does when it opens a /watch?slug=... page:

  1. PAGE      - GET /watch?slug=...            -> 200, player markup present, not "Drama Not Found"
  2. SOURCES   - rebuild the site's resolveSources() chain:
                   a) dramadunyam records: baked eps/chunk-dun.js + eps/chunk-dun-<no>.js
                      (window.DB_EPS via DB_EPS_DUN_INDEX slug -> chunk map) outrank everything
                   b) drama.urls (episode m3u8 links baked in data-part-*.js)
                   c) drama.epsChunk -> eps/chunk-<n>.js (window.DB_EPS)
                   d) last mirror: fresh-link resolver https://<proxy>/dun/<id>/<ep>?slug=<slug>
                 Each mirror is a list of episode URLs; candidate = mirror[episode-1].
  3. PLAYBACK  - try candidates in the same order the player does:
                   - hosts listed in SEGMENT_PROXY_HOSTS are routed through the
                     Cloudflare segment proxy (/?u=<encoded url>)
                   - GET playlist -> must be #EXTM3U
                   - if master playlist (#EXT-X-STREAM-INF) -> follow first variant
                   - GET first segment with a Range header -> 200/206 and non-empty
                 First candidate that fully passes wins; failures are recorded.
  4. PROXY     - the worker is NOT a site mirror (it answers 400 on /watch paths):
                   - alive : GET worker root    -> 400 "missing or invalid ?u=" proves it runs
                   - relay : GET /?u=<url>      -> 200, or 403 "host not allowed" (= allowlist working)
                   - dun   : GET /dun/<id>/<ep>?slug=... -> 200/3xx OK,
                             JSON {"error":"no fresh url"} = WARN (upstream challenged,
                             stored links remain the active path), anything else = BROKEN

Exit code: 0 = everything OK (WARN is allowed), 1 = any video BROKEN or proxy BROKEN,
           2 = usage/config error.

Usage:
  python3 scripts/check_videos.py --videos videos.json \
      [--site https://fulldrama.stream] [--proxy https://proxy2....workers.dev] \
      [--results health-results/results.json] [--timeout 30] [--pace 1.0]

Environment (overridden by CLI flags): SITE_BASE_URL, PROXY_BASE_URL, GITHUB_STEP_SUMMARY.
"""

import argparse
import datetime
import http.client
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Constants mirrored from the site's watch page JS (update here if the site
# adds/removes providers from the segment-proxy allowlist).
# ---------------------------------------------------------------------------
SEGMENT_PROXY_HOSTS = [
    "zshipricf.farsunpteltd.net",
    "v.73920582.xyz",
    "v.73920583.xyz",
    "static.livoshort.com",
    "static.miraluneshort.com",
    "static.miralunedrama.com",
    "static.cinerrashort.com",
    "static.rivoshort.com",
    "static.versevoyagetv.com",
]

BROWSER_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    # hls.js always sends the page origin as Referer for playlists/segments
    "Referer": "https://fulldrama.stream/",
}

MAX_EPISODE_BYTES = 131072  # only pull the first 128 KB of a segment

TLS_CTX = ssl.create_default_context()


class Result:
    """One check outcome: OK / WARN / BROKEN plus a human reason."""
    def __init__(self, status, reason=""):
        self.status = status          # "OK" | "WARN" | "BROKEN" | "-" (not applicable)
        self.reason = reason

    def __repr__(self):
        return f"{self.status}" + (f" ({self.reason})" if self.reason else "")


# ---------------------------------------------------------------------------
# Tiny HTTP layer with browser-ish headers and a single polite retry
# ---------------------------------------------------------------------------
def http_get(url, timeout=30, headers=None, attempts=2, max_read=262144):
    """GET url; return (status, body_bytes, final_url, headers) or raise.

    Retries once on network errors / 5xx, never on 4xx (a 403 stays a 403 -
    that is a real answer from the CDN, not noise).
    """
    hdrs = dict(BROWSER_HEADERS)
    if headers:
        hdrs.update(headers)
    last_err = None
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(url, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=TLS_CTX) as r:
                body = r.read(max_read)
                return r.status, body, r.geturl(), dict(r.headers)
        except urllib.error.HTTPError as e:
            if e.code >= 500 and attempt < attempts:
                last_err = e
                time.sleep(2)
                continue
            body = b""
            try:
                body = e.read(max_read)
            except Exception:
                pass
            return e.code, body, getattr(e, "url", url), dict(e.headers or {})
        except (urllib.error.URLError, socket.timeout, http.client.HTTPException,
                ConnectionError, OSError) as e:
            last_err = e
            if attempt < attempts:
                time.sleep(2)
                continue
            raise  # network error -> caller decides (usually BROKEN)
    raise last_err  # pragma: no cover


def net_err_text(exc):
    return f"{type(exc).__name__}: {str(exc)[:120]}"


# ---------------------------------------------------------------------------
# JS data-file parsing helpers (tolerant of spacing / trailing commas)
# ---------------------------------------------------------------------------
def _brace_match(text, start):
    """Return the substring text[start:end] covering the balanced {...} block
    starting at text[start] == '{', skipping braces inside string literals."""
    depth = 0
    in_str = None
    i = start
    while i < len(text):
        c = text[i]
        if in_str:
            if c == "\\":
                i += 2
                continue
            if c == in_str:
                in_str = None
        elif c in "\"'":
            in_str = c
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    return None


def _jsonish(raw):
    """json.loads with trailing-comma tolerance."""
    return json.loads(re.sub(r",\s*([}\]])", r"\1", raw))


def parse_drama_record(text, slug):
    """Find the drama object whose "slug" equals `slug` inside a data-part JS
    blob. Tolerates the slug string also appearing inside descriptions."""
    needle = f'"{slug}"'
    pos = 0
    while True:
        i = text.find(needle, pos)
        if i < 0:
            return None
        pos = i + len(needle)
        start = text.rfind("{", 0, i)
        if start < 0:
            continue
        blob = _brace_match(text, start)
        if not blob:
            continue
        try:
            rec = _jsonish(blob)
        except Exception:
            continue
        if isinstance(rec, dict) and rec.get("slug") == slug:
            return rec


def parse_db_eps_assign(text):
    """Extract the object passed to Object.assign(window.DB_EPS, {...}) or the
    direct window.DB_EPS = {...} assignment in eps/chunk-*.js files."""
    m = re.search(r"Object\.assign\(\s*window\.DB_EPS[^,)]*,\s*", text)
    if m:
        start = text.find("{", m.end() - 1)
        blob = _brace_match(text, start) if start >= 0 else None
        if blob:
            try:
                return _jsonish(blob)
            except Exception:
                pass
    m = re.search(r"window\.DB_EPS\s*=\s*(?!\s*window)\s*", text)
    if m:
        start = text.find("{", m.end() - 1)
        blob = _brace_match(text, start) if start >= 0 else None
        if blob:
            try:
                return _jsonish(blob)
            except Exception:
                pass
    return {}


def parse_dun_index(text):
    """Extract {slug: chunkNo} from eps/chunk-dun.js."""
    m = re.search(r"Object\.assign\(\s*window\.DB_EPS_DUN_INDEX\s*,\s*(\{[^{}]*\})\s*\)", text)
    if not m:
        return {}
    try:
        return _jsonish(m.group(1))
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Source resolution (mirror of the site's resolveSources() in watch.html)
# ---------------------------------------------------------------------------
class SiteData:
    """Lazy cache for data-part-*.js and eps/chunk-*.js across videos."""
    def __init__(self, site, timeout):
        self.site = site.rstrip("/")
        self.timeout = timeout
        self._parts = {}        # n -> text (None = fetched, slug not in it)
        self._chunks = {}       # name -> text or None

    def _fetch_text(self, url, cache, key):
        if key in cache:
            return cache[key]
        try:
            # data-part files can be ~20 MB - read them fully
            status, body, _, _ = http_get(url, timeout=self.timeout, max_read=80_000_000)
            cache[key] = body.decode("utf-8", "replace") if status == 200 else None
        except Exception:
            cache[key] = None
        return cache[key]

    def drama_record(self, slug):
        for n in (1, 2, 3):
            txt = self._fetch_text(f"{self.site}/data-part-{n}.js", self._parts, n)
            if not txt or slug not in txt:
                continue
            rec = parse_drama_record(txt, slug)
            if rec:
                return rec, n
        return None, None

    def chunk(self, name):
        return self._fetch_text(f"{self.site}/eps/chunk-{name}.js", self._chunks, str(name))

    def db_eps(self, name):
        txt = self.chunk(name)
        return parse_db_eps_assign(txt) if txt else {}


def normalize_mirrors(base):
    """Normalize whatever DB_EPS/urls produced into [mirror, ...] where each
    mirror is a list of episode URLs."""
    if base is None:
        return []
    if isinstance(base, dict):
        base = base.get("mirrors") or []
    if not isinstance(base, list):
        return []
    mirrors = []
    for m in base:
        if isinstance(m, list):
            mirrors.append([u for u in m if isinstance(u, str) and u])
        elif isinstance(m, str) and m:
            mirrors.append([m])  # tolerate a flat string
    return mirrors


def resolve_sources(data, rec, proxy_origin, slug):
    """Rebuild watch.html resolveSources(): returns (mirrors, notes)."""
    notes = []
    source = rec.get("source", "")
    mirrors = []

    def dun_baked():
        idx_txt = data.chunk("dun")
        if not idx_txt:
            notes.append("eps/chunk-dun.js missing")
            return None
        idx = parse_dun_index(idx_txt)
        no = idx.get(slug)
        if not no:
            notes.append("no baked dun chunk for this slug")
            return None
        eps = data.db_eps(f"dun-{no}")
        rec_dun = eps.get(slug)
        mir = normalize_mirrors(rec_dun)
        if mir:
            notes.append(f"baked dun chunk-dun-{no}.js")
            return mir
        notes.append(f"chunk-dun-{no}.js had no usable links")
        return None

    # 1) baked dun links outrank everything for dramadunyam records
    if source == "dramadunyam":
        baked = dun_baked()
        if baked:
            mirrors = baked

    # 2) urls baked in data-part-*.js
    if not mirrors:
        urls = rec.get("urls")
        if isinstance(urls, list) and urls:
            mirrors = normalize_mirrors([urls])
            notes.append(f"urls from data-part (1 mirror, {len(urls)} eps)")

    # 3) lazy epsChunk
    if not mirrors and rec.get("epsChunk"):
        eps = data.db_eps(str(rec["epsChunk"]))
        mir = normalize_mirrors(eps.get(slug))
        if mir:
            mirrors = mir
            notes.append(f"eps/chunk-{rec['epsChunk']}.js")
        elif source == "dramadunyam":
            baked = dun_baked()
            if baked:
                mirrors = baked

    # 4) last-resort dun path if nothing above matched
    if not mirrors and source == "dramadunyam":
        baked = dun_baked()
        if baked:
            mirrors = baked

    # 5) fresh-link resolver as the LAST mirror (worker 302s to signed relay)
    if source == "dramadunyam" and isinstance(rec.get("id"), (int, float)) \
            and str(int(rec["id"])).isdigit() and proxy_origin:
        count = int(rec.get("episodes") or (mirrors[0] and len(mirrors[0])) or 0)
        if count:
            resolver = [f"{proxy_origin}/dun/{int(rec['id'])}/{i + 1}?slug={urllib.parse.quote(slug)}"
                        for i in range(count)]
            mirrors.append(resolver)
            notes.append(f"resolver mirror appended ({count} eps)")

    return mirrors, notes


# ---------------------------------------------------------------------------
# Playback check (m3u8 -> optional variant -> first segment)
# ---------------------------------------------------------------------------
def candidate_url(url, proxy_base):
    """Route through the segment proxy when the host is on the allowlist."""
    try:
        host = urllib.parse.urlsplit(url).hostname or ""
    except ValueError:
        return url
    if host in SEGMENT_PROXY_HOSTS and proxy_base:
        sep = "&" if urllib.parse.urlsplit(proxy_base).query else "?"
        return f"{proxy_base}{sep}u={urllib.parse.quote(url, safe='')}"
    return url


def fetch_playlist(url, timeout, proxy_base, attempts_log):
    """GET an m3u8. Returns (text, final_url) or raises ValueError with reason."""
    target = candidate_url(url, proxy_base)
    try:
        status, body, final, _ = http_get(target, timeout=timeout)
    except Exception as e:
        attempts_log.append(f"playlist {short(target)}: {net_err_text(e)}")
        raise ValueError(f"network error: {net_err_text(e)}")
    text = body.decode("utf-8", "replace")
    attempts_log.append(f"playlist {short(target)}: HTTP {status}, {len(body)}B")
    if status != 200:
        raise ValueError(f"playlist HTTP {status}")
    if "#EXTM3U" not in text[:200]:
        raise ValueError("response is not an M3U8 playlist")
    return text, final


def first_segment_of(media_text, media_final):
    lines = [l.strip() for l in media_text.splitlines() if l.strip()]
    seg = next((l for l in lines if not l.startswith("#")), None)
    if seg:
        return urllib.parse.urljoin(media_final, seg)
    m = re.search(r'#EXT-X-MAP:.*?URI="([^"]+)"', media_text)
    if m:
        return urllib.parse.urljoin(media_final, m.group(1))
    return None


def check_playback(candidates, episode, timeout, pace, proxy_base):
    """Try candidates in order. Returns dict with status + details."""
    attempts = []
    for idx, url in enumerate(candidates, start=1):
        tag = f"mirror #{idx}"
        try:
            text, final = fetch_playlist(url, timeout, proxy_base, attempts)
        except ValueError as e:
            attempts[-1] += f" -> {e}"
            time.sleep(pace)
            continue

        try:
            # master playlist? follow the first variant like the player does
            if "#EXT-X-STREAM-INF" in text:
                lines = [l.strip() for l in text.splitlines() if l.strip()]
                variant = None
                for k, l in enumerate(lines):
                    if l.startswith("#EXT-X-STREAM-INF") and k + 1 < len(lines):
                        variant = lines[k + 1]
                        break
                if not variant or variant.startswith("#"):
                    attempts.append(f"{tag}: master playlist has no variant URI")
                    time.sleep(pace)
                    continue
                v_url = urllib.parse.urljoin(final, variant)
                v_target = candidate_url(v_url, proxy_base)
                status, body, v_final, _ = http_get(v_target, timeout=timeout)
                v_text = body.decode("utf-8", "replace")
                attempts.append(f"variant {short(v_target)}: HTTP {status}, {len(body)}B")
                if status != 200 or "#EXTM3U" not in v_text[:200]:
                    attempts.append(f"{tag}: variant unusable (HTTP {status})")
                    time.sleep(pace)
                    continue
                text, final = v_text, v_final

            seg = first_segment_of(text, final)
            if not seg:
                attempts.append(f"{tag}: playlist lists no segments")
                time.sleep(pace)
                continue
            seg_target = candidate_url(seg, proxy_base)
            status, body, _, _ = http_get(seg_target, timeout=timeout,
                                          headers={"Range": f"bytes=0-{MAX_EPISODE_BYTES - 1}"},
                                          max_read=MAX_EPISODE_BYTES)
            ok = status in (200, 206) and len(body) > 0
            attempts.append(f"segment {short(seg_target)}: HTTP {status}, {len(body)}B")
            if ok:
                host = urllib.parse.urlsplit(url).hostname or "?"
                return {
                    "status": "OK",
                    "mirror_index": idx,
                    "mirror_host": host,
                    "playlist_url": url,
                    "attempts": attempts,
                    "note": f"mirror #{idx} ({host}) -> playlist 200, segment {len(body)}B",
                }
            time.sleep(pace)
        except Exception as e:
            attempts.append(f"{tag}: {net_err_text(e)}")
            time.sleep(pace)

    return {"status": "BROKEN", "attempts": attempts,
            "note": f"all {len(candidates)} candidate(s) failed for episode {episode}"}


def short(url, n=72):
    return url if len(url) <= n else url[:n - 12] + "..." + url[-9:]


# ---------------------------------------------------------------------------
# Proxy worker checks
# ---------------------------------------------------------------------------
def worker_origin(proxy_base):
    split = urllib.parse.urlsplit(proxy_base)
    return f"{split.scheme}://{split.netloc}"


def check_proxy(proxy_base, sample_url, rec, slug, episode, timeout):
    """Check the Cloudflare worker: alive / relay / dun resolver."""
    out = {"alive": Result("-", ""), "relay": Result("-", ""), "dun": Result("-", "")}
    if not proxy_base:
        return out
    origin = worker_origin(proxy_base)

    # alive: the bare worker answers 400 "missing or invalid ?u=" - any other
    # answer (5xx, exception page, network error) means the worker is down.
    try:
        status, body, _, _ = http_get(origin + "/", timeout=timeout)
        txt = body.decode("utf-8", "replace")
        if 400 <= status < 500 and "missing or invalid" in txt:
            out["alive"] = Result("OK", f"root HTTP {status} (expected)")
        elif status == 200:
            out["alive"] = Result("OK", "root HTTP 200")
        else:
            out["alive"] = Result("BROKEN", f"root HTTP {status}: {txt[:80]!r}")
            return out
    except Exception as e:
        out["alive"] = Result("BROKEN", net_err_text(e))
        return out

    # relay: push a real video URL through /?u=. 200 = relayed; 403 "host not
    # allowed" = worker fine, this provider simply is not on its allowlist.
    if sample_url:
        try:
            target = f"{origin}/?u={urllib.parse.quote(sample_url, safe='')}"
            status, body, _, _ = http_get(target, timeout=timeout)
            txt = body.decode("utf-8", "replace")
            if status == 200:
                out["relay"] = Result("OK", "relayed playlist HTTP 200")
            elif status == 403 and "host not allowed" in txt:
                out["relay"] = Result("OK", "host not on allowlist (worker functioning)")
            elif status == 400 and "RequestTypeError" in txt:
                out["relay"] = Result("WARN", "upstream rejected the sample request (worker alive)")
            else:
                out["relay"] = Result("BROKEN", f"?u= HTTP {status}: {txt[:60]!r}")
        except Exception as e:
            out["relay"] = Result("BROKEN", net_err_text(e))

    # dun resolver: fresh-link fallback for dramadunyam records
    if rec and rec.get("source") == "dramadunyam" and isinstance(rec.get("id"), (int, float)):
        try:
            url = f"{origin}/dun/{int(rec['id'])}/{episode}?slug={urllib.parse.quote(slug)}"
            status, body, final, _ = http_get(url, timeout=timeout, attempts=1)
            txt = body.decode("utf-8", "replace")
            if status in (200, 201) or 300 <= status < 400:
                out["dun"] = Result("OK", f"HTTP {status} (fresh link)")
            elif '"no fresh url"' in txt or '"challenged":true' in txt:
                out["dun"] = Result("WARN", "resolver alive, upstream challenged")
            else:
                out["dun"] = Result("BROKEN", f"HTTP {status}: {txt[:60]!r}")
        except urllib.error.HTTPError as e:
            body_txt = ""
            try:
                body_txt = e.read(200).decode("utf-8", "replace")
            except Exception:
                pass
            if '"no fresh url"' in body_txt or '"challenged"' in body_txt:
                out["dun"] = Result("WARN", "resolver alive, upstream challenged")
            else:
                out["dun"] = Result("BROKEN", f"HTTP {e.code}")
        except Exception as e:
            out["dun"] = Result("BROKEN", net_err_text(e))
    return out


# ---------------------------------------------------------------------------
# Per-video pipeline
# ---------------------------------------------------------------------------
def check_video(entry, data, site, proxy_base, timeout, pace):
    slug = entry["slug"].strip()
    episode = int(entry.get("episode", 1))
    res = {"slug": slug, "episode": episode, "page": None, "sources": None,
           "playback": None, "proxy": None, "overall": None}

    # 1. page
    try:
        status, body, final, _ = http_get(f"{site}/watch?slug={urllib.parse.quote(slug)}",
                                          timeout=timeout)
        html = body.decode("utf-8", "replace")
        if status != 200:
            res["page"] = Result("BROKEN", f"HTTP {status}")
        elif 'id="videoPlayer"' not in html or "data-part-1.js" not in html:
            res["page"] = Result("BROKEN", "player markup or data scripts missing")
        else:
            # note: watch.html is one static page for every slug (the JS renders
            # "Drama Not Found" client-side), so a wrong slug surfaces later at
            # the SOURCES step, not here.
            res["page"] = Result("OK")
    except Exception as e:
        res["page"] = Result("BROKEN", net_err_text(e))

    # 2. sources
    rec, part = data.drama_record(slug)
    if not rec:
        res["sources"] = Result("BROKEN", "slug not found in data-part-1..3.js")
        res["playback"] = Result("BROKEN", "no sources to test")
        res["overall"] = Result("BROKEN", "page/sources/playback failed")
        return res
    res["sources_rec"] = {"id": rec.get("id"), "source": rec.get("source"),
                          "episodes": rec.get("episodes"), "found_in": f"data-part-{part}.js"}
    proxy_origin = worker_origin(proxy_base) if proxy_base else ""
    mirrors, notes = resolve_sources(data, rec, proxy_origin, slug)
    candidates = [m[episode - 1] for m in mirrors
                  if isinstance(m, list) and len(m) >= episode and m[episode - 1]]
    if not candidates:
        res["sources"] = Result("BROKEN",
                                "no candidate URL for episode "
                                f"{episode} ({len(mirrors)} mirror(s); {'; '.join(notes) or 'no notes'})")
        res["playback"] = Result("BROKEN", "nothing to test")
    else:
        res["sources"] = Result("OK",
                                f"{len(mirrors)} mirror(s), {len(candidates)} candidate(s) for ep{episode}"
                                + (f" [{'; '.join(notes)}]" if notes else ""))

        # 3. playback
        pb = check_playback(candidates, episode, timeout, pace, proxy_base)
        res["playback"] = Result(pb["status"], pb.get("note") or "; ".join(pb["attempts"][-3:]))
        res["playback_attempts"] = pb.get("attempts", [])
        res["playback_url"] = pb.get("playlist_url")
        sample_url = pb.get("playlist_url") or candidates[0]

        # 4. proxy worker
        res["proxy"] = check_proxy(proxy_base, sample_url, rec, slug, episode, timeout)

    # 5. overall
    broken_bits = []
    if res["page"].status == "BROKEN":
        broken_bits.append("page")
    if res["sources"].status == "BROKEN":
        broken_bits.append("sources")
    if (res["playback"] or Result("-", "")).status == "BROKEN":
        broken_bits.append("playback")
    if broken_bits:
        res["overall"] = Result("BROKEN", " + ".join(broken_bits) + " failed")
    else:
        res["overall"] = Result("OK")
    return res


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------
def render_summary(checked_at, video_rows, proxy_global, exit_fail):
    lines = []
    lines.append(f"## Video health check — {checked_at}")
    lines.append("")
    if proxy_global and proxy_global["alive"].status != "-":
        bits = [f"alive {proxy_global['alive'].status}"]
        if proxy_global.get("relay") and proxy_global["relay"].status != "-":
            bits.append(f"relay {proxy_global['relay'].status}"
                        + (f" ({proxy_global['relay'].reason})" if proxy_global["relay"].reason else ""))
        lines.append(f"**Proxy worker:** {', '.join(bits)}  ")
        if proxy_global["alive"].status == "BROKEN":
            lines.append(f"- alive failure: {proxy_global['alive'].reason}")
        lines.append("")
    lines.append("| Video | Ep | Page | Sources | Playback | Dun resolver | Overall |")
    lines.append("|---|---|---|---|---|---|---|")

    def cell(r):
        if r is None:
            return "-"
        s = r.status
        if s == "-" :
            return "-"
        reason = f" — {r.reason}" if r.reason else ""
        return f"{s}{reason}" if s != "OK" else "OK"

    for res in video_rows:
        dun = (res.get("proxy") or {}).get("dun")
        lines.append("| {slug} | {ep} | {page} | {src} | {pb} | {dun} | {overall} |".format(
            slug=res["slug"], ep=res["episode"],
            page=cell(res["page"]), src=cell(res["sources"]), pb=cell(res["playback"]),
            dun=cell(dun), overall=cell(res["overall"])))
    lines.append("")
    details = [r for r in video_rows if r["overall"].status != "OK"]
    if details:
        lines.append("### Failure details")
        lines.append("")
        for res in details:
            lines.append(f"**{res['slug']} (ep{res['episode']})** — {res['overall'].reason}")
            if res.get("page") and res["page"].status == "BROKEN":
                lines.append(f"- page: {res['page'].reason}")
            if res.get("sources") and res["sources"].status == "BROKEN":
                lines.append(f"- sources: {res['sources'].reason}")
            for a in res.get("playback_attempts", []):
                lines.append(f"- playback attempt: {a}")
            if res.get("playback") and res["playback"].status == "BROKEN" \
                    and not res.get("playback_attempts"):
                lines.append(f"- playback: {res['playback'].reason}")
        lines.append("")
    n_ok = sum(1 for r in video_rows if r["overall"].status == "OK")
    lines.append(f"**Result: {n_ok}/{len(video_rows)} video(s) healthy"
                 + (" — proxy worker FAILED" if exit_fail and proxy_global
                    and proxy_global["alive"].status == "BROKEN" else "")
                 + "**")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="fulldrama.stream video health checker")
    ap.add_argument("--videos", default="videos.json")
    ap.add_argument("--site", default=os.environ.get("SITE_BASE_URL", "https://fulldrama.stream"))
    ap.add_argument("--proxy", default=os.environ.get("PROXY_BASE_URL", ""))
    ap.add_argument("--results", default=None)
    ap.add_argument("--timeout", type=int, default=30)
    ap.add_argument("--pace", type=float, default=1.0, help="seconds between mirror attempts")
    args = ap.parse_args()

    site = args.site.rstrip("/")
    proxy_base = args.proxy.rstrip("/")
    if proxy_base and not urllib.parse.urlsplit(proxy_base).scheme:
        print(f"CONFIG ERROR: --proxy needs a scheme, got {proxy_base!r}", file=sys.stderr)
        return 2

    try:
        with open(args.videos, encoding="utf-8") as f:
            cfg = json.load(f)
        videos = cfg["videos"] if isinstance(cfg, dict) else cfg
        assert isinstance(videos, list) and videos
        for v in videos:
            assert isinstance(v, dict) and v.get("slug")
    except Exception as e:
        print(f"CONFIG ERROR: cannot read {args.videos}: {e}", file=sys.stderr)
        return 2

    data = SiteData(site, args.timeout)
    checked_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    rows = []
    proxy_alive_broken = False
    for entry in videos:
        res = check_video(entry, data, site, proxy_base, args.timeout, args.pace)
        rows.append(res)
        pr = (res.get("proxy") or {}).get("alive")
        if pr and pr.status == "BROKEN":
            proxy_alive_broken = True
        print(f"[{res['overall'].status}] {res['slug']} ep{res['episode']}: "
              f"page={res['page'].status} sources={res['sources'].status} "
              f"playback={(res['playback'].status if res['playback'] else '-')}", flush=True)

    any_broken = any(r["overall"].status == "BROKEN" for r in rows) or proxy_alive_broken

    summary = render_summary(checked_at, rows,
                             {"alive": rows[0]["proxy"]["alive"],
                              "relay": rows[0]["proxy"]["relay"]} if rows and rows[0].get("proxy")
                             else None,
                             any_broken)
    print("\n" + summary)

    gh = os.environ.get("GITHUB_STEP_SUMMARY")
    if gh:
        try:
            with open(gh, "a", encoding="utf-8") as f:
                f.write(summary + "\n")
        except Exception as e:
            print(f"warn: could not write GITHUB_STEP_SUMMARY: {e}", file=sys.stderr)

    if args.results:
        try:
            os.makedirs(os.path.dirname(args.results) or ".", exist_ok=True)
            with open(args.results, "w", encoding="utf-8") as f:
                json.dump({"checked_at": checked_at, "site": site, "proxy": proxy_base or None,
                           "fail": any_broken,
                           "videos": [{k: v for k, v in r.items() if k != "proxy"}
                                      | {"proxy": {k: {"status": x.status, "reason": x.reason}
                                                   for k, x in (r.get("proxy") or {}).items()}}
                                      for r in rows]},
                          f, indent=2, default=vars)
        except Exception as e:
            print(f"warn: could not write results file: {e}", file=sys.stderr)

    return 1 if any_broken else 0


if __name__ == "__main__":
    sys.exit(main())
