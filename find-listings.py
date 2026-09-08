#!/usr/bin/env python3
"""
Runs site:-scoped Google searches (via Serper, which proxies real Google
results) across your target job titles, filters out blacklisted companies
and previously-seen postings, and appends anything new to the leads ledger
for the review app (review-app/) to serve.

One-time setup:
  1. serper.dev -> sign up -> copy the API key from the dashboard.
  2. Create .env (gitignored) alongside this script, or at the repo root, with:
       SERPER_API_KEY=...
  3. Copy config.example.json to config.json and edit titles/sites/dataDir.

Run manually:
  python3 find-listings.py

With the example config (8 titles x 3 ATS sites), this runs 24 queries/run.
Deliberately exhaustive per-title rather than consolidated into broader
queries (e.g. a bare "product manager") -- Serper's free tier caps each
query at 10 results, and a broad query has far more true matches competing
for those 10 slots, silently dropping most real postings to ranking
truncation. Per-title queries stay narrow enough that the cap rarely binds.
"""

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_FILE = SCRIPT_DIR / "config.json"
SEEN_COLUMNS = ["fingerprint", "first_seen", "last_seen", "company", "title", "url", "snippet", "posted_at", "location", "classified_at"]

SEARCH_ENDPOINT = "https://google.serper.dev/search"


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        print(f"Missing {CONFIG_FILE} -- copy config.example.json to config.json and edit it.", file=sys.stderr)
        sys.exit(1)
    config = json.loads(CONFIG_FILE.read_text())
    config.setdefault("dataDir", "data")
    return config


def resolve_paths(config: dict) -> dict:
    """dataDir is relative to this script, so the same code works whether the
    ledger lives in a sibling data/ dir or somewhere else entirely."""
    data_dir = (SCRIPT_DIR / config["dataDir"]).resolve()
    return {
        "data_dir": data_dir,
        "seen": data_dir / "leads-seen.tsv",
        "blacklist": data_dir / "company-blacklist.md",
    }


def find_env_file() -> Path:
    """Look next to the script first, then walk up -- lets this live either
    standalone or nested inside a larger repo that keeps .env at its root."""
    for candidate in [SCRIPT_DIR, *SCRIPT_DIR.parents]:
        env = candidate / ".env"
        if env.exists():
            return env
    return SCRIPT_DIR / ".env"


def load_env(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def extract_company_slug(url: str) -> str:
    """Pull the company slug out of the ATS URL path — more reliable than
    parsing result titles, since all three ATS platforms embed it directly."""
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower()
    parts = [p for p in parsed.path.split("/") if p]

    if "lever.co" in host or "ashbyhq.com" in host:
        # jobs.lever.co/{company}/... , jobs.ashbyhq.com/{company}/...
        return parts[0] if parts else host
    if "greenhouse.io" in host:
        # boards.greenhouse.io/{company}/... , job-boards.greenhouse.io/{company}/...
        return parts[0] if parts else host
    return host


def resolve_posted_at(relative: str, fetched_at: datetime) -> str:
    """Serper returns a relative string ('3 hours ago') that's only accurate
    at the moment of the search -- displaying it verbatim goes stale (and
    eventually actively misleading) the longer a lead sits unreviewed.
    Convert to an absolute timestamp immediately so the UI can compute an
    always-current 'X ago' at render time instead."""
    m = re.match(r"(\d+)\s+(minute|hour|day|week|month)s?\s+ago", relative.strip().lower())
    if not m:
        return ""
    n, unit = int(m.group(1)), m.group(2)
    per_minute = {"minute": 1, "hour": 60, "day": 1440, "week": 10080, "month": 43200}
    return (fetched_at - timedelta(minutes=n * per_minute[unit])).isoformat()


def strip_tracking_params(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    query = urllib.parse.parse_qsl(parsed.query)
    query = [(k, v) for k, v in query if not k.lower().startswith("utm_") and k.lower() != "gh_src"]
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(query)))


def load_blacklist(path: Path) -> set:
    if not path.exists():
        return set()
    entries = set()
    for line in path.read_text().splitlines():
        m = re.match(r"^\s*-\s+(.+)$", line)
        if m:
            name = normalize(m.group(1))
            if name:
                entries.add(name)
    return entries


def load_seen(path: Path) -> dict:
    seen = {}
    if not path.exists():
        return seen
    lines = path.read_text().splitlines()
    for line in lines[1:]:
        if not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) < 6:
            continue
        cols += [""] * (len(SEEN_COLUMNS) - len(cols))  # back-compat for pre-snippet/posted rows
        fingerprint = cols[0]
        seen[fingerprint] = dict(zip(SEEN_COLUMNS[1:], cols[1:]))
    return seen


def save_seen(path: Path, seen: dict) -> None:
    lines = ["\t".join(SEEN_COLUMNS)]
    for fingerprint, row in sorted(seen.items(), key=lambda kv: kv[1]["first_seen"]):
        lines.append("\t".join([fingerprint] + [row.get(c, "") for c in SEEN_COLUMNS[1:]]))
    path.write_text("\n".join(lines) + "\n")


def serper_search(query: str, api_key: str) -> list:
    # tbs=qdr:d restricts to the past day. Google's default (no date filter)
    # ranks by relevance, not recency -- for a common title on a huge ATS
    # platform that surfaces the same static top-10 "authoritative" postings
    # every run and can bury genuinely new ones below the 10-result free-tier
    # cap indefinitely. A recency window keeps the true-match pool small
    # enough to actually fit under that cap -- qdr:d tested at 6/10 results
    # for the highest-volume query (Senior PM x Greenhouse), vs. qdr:w
    # sitting right at the 10-cap already. Cron runs daily without gaps, so
    # there's no missed-day risk to buffer against with a wider window.
    body = json.dumps({"q": query, "num": 10, "tbs": "qdr:d"}).encode()
    req = urllib.request.Request(
        SEARCH_ENDPOINT,
        data=body,
        method="POST",
        headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        err_body = e.read().decode(errors="replace")
        print(f"  ! HTTP {e.code} for query {query!r}: {err_body[:300]}", file=sys.stderr)
        return []
    except urllib.error.URLError as e:
        print(f"  ! network error for query {query!r}: {e}", file=sys.stderr)
        return []
    except Exception as e:
        # Catch-all is deliberate: this is an unattended daily job, and one
        # query's transient failure (e.g. a bare socket.timeout during a
        # slow SSL read, which surfaces outside URLError) previously crashed
        # the whole run uncaught, silently losing an entire day's leads
        # (2026-09-07). Skipping one query is far cheaper than that.
        print(f"  ! unexpected error for query {query!r}: {e!r}", file=sys.stderr)
        return []
    return data.get("organic", [])


def main() -> int:
    env_file = find_env_file()
    env = load_env(env_file)
    api_key = env.get("SERPER_API_KEY")
    if not api_key:
        print(f"Missing SERPER_API_KEY in {env_file}", file=sys.stderr)
        return 1

    config = load_config()
    paths = resolve_paths(config)
    paths["data_dir"].mkdir(parents=True, exist_ok=True)

    blacklist = load_blacklist(paths["blacklist"])
    seen = load_seen(paths["seen"])
    fetched_at = datetime.now()
    today = date.today().isoformat()

    added = 0

    for title in config["titles"]:
        for site in config["sites"]:
            query = f'site:{site} "{title}"'
            print(f"Searching: {query}")
            items = serper_search(query, api_key)
            for item in items:
                link = strip_tracking_params(item.get("link", ""))
                result_title = item.get("title", "").strip()
                snippet = item.get("snippet", "").strip().replace("\n", " ").replace("\t", " ")
                posted_at = resolve_posted_at(item.get("date", ""), fetched_at)
                if not link or not result_title:
                    continue

                company_slug = extract_company_slug(link)
                company_norm = normalize(company_slug)
                fingerprint = f"{company_norm}|{normalize(result_title)}"

                if any(b and (b in company_norm or company_norm in b) for b in blacklist):
                    continue

                if fingerprint in seen:
                    seen[fingerprint]["last_seen"] = today
                    continue

                seen[fingerprint] = {
                    "first_seen": today,
                    "last_seen": today,
                    "company": company_slug,
                    "title": result_title,
                    "url": link,
                    "snippet": snippet,
                    "posted_at": posted_at,
                }
                added += 1

    save_seen(paths["seen"], seen)
    print(f"\n{added} new lead(s) added to {paths['seen']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
