"""
scripts/gsc_index_status.py — ask Google what it actually did with our pages.

    GSC_SERVICE_ACCOUNT="$(cat key.json)" python scripts/gsc_index_status.py
    ... --limit 5 --out status.json

Reads the LIVE sitemaps (not the built ones) because the question being asked
is "what has Google seen", and the live files are what Google fetches. A local
build can be ahead of production by a deploy, which would make a page look
undiscovered when it simply is not published yet.

WHY THIS AND NOT THE INDEXING API. Google's Indexing API is restricted to
"pages with either JobPosting or BroadcastEvent embedded in a VideoObject" —
book pages are not eligible, and using it for them anyway is a policy
violation, not a shortcut. There is no supported API that asks Google to index
an ordinary page.

That turns out not to matter much, because re-requesting is rarely the fix.
"Crawled - currently not indexed" means Google fetched the page and decided it
was not worth indexing; asking again does not change a judgement about value.
Knowing WHICH pages sit in that state — as opposed to merely "Discovered",
which is a queue and needs patience — is what tells us whether to wait or to
improve the page. That is the whole point of this script.

Quota: 2,000 inspections per property per day, 600/minute. We inspect the
sitemap URLs only (~41), so quota is not a constraint and no caching layer is
needed to stay inside it.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
import time
import urllib.request

SITEMAP_INDEX = "https://litheca.com/sitemap.xml"
SITES_URL = "https://www.googleapis.com/webmasters/v3/sites"
INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"]


def _fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "litheca-index-status"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def sitemap_urls() -> list[str]:
    """Every <loc> in every child sitemap of the index."""
    index = _fetch(SITEMAP_INDEX)
    children = re.findall(r"<loc>(.*?)</loc>", index)
    urls: list[str] = []
    for child in children:
        try:
            urls += re.findall(r"<loc>(.*?)</loc>", _fetch(child))
        except Exception as e:
            print(f"  ! could not read {child}: {e}", file=sys.stderr)
    # Deduplicate but keep order, so a repeated URL cannot silently double our
    # quota spend.
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def credentials():
    from google.oauth2 import service_account  # noqa: PLC0415

    raw = os.environ.get("GSC_SERVICE_ACCOUNT", "").strip()
    if not raw:
        sys.exit("GSC_SERVICE_ACCOUNT is empty — set it to the service-account JSON.")
    try:
        info = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit(f"GSC_SERVICE_ACCOUNT is not valid JSON ({e}). Paste the whole key file.")
    return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)


def resolve_property(session) -> str:
    """Find our property, and do NOT guess its form.

    Search Console has two kinds — a Domain property is addressed as
    `sc-domain:litheca.com`, a URL-prefix one as `https://litheca.com/` — and
    the wrong string returns 403, which reads like a permissions problem and
    sends you back to re-check the service account for no reason. Asking
    sites.list removes the guess entirely.
    """
    r = session.get(SITES_URL, timeout=30)
    if r.status_code == 403:
        sys.exit("403 from sites.list — the service account is not a user on any "
                 "property. Add its email in Search Console → Settings → Users "
                 "and permissions, with FULL access (Restricted is not enough).")
    r.raise_for_status()
    entries = r.json().get("siteEntry", [])
    if not entries:
        sys.exit("The service account can see no properties. Check it was added "
                 "to the litheca.com property.")
    for e in entries:
        if "litheca.com" in e.get("siteUrl", ""):
            print(f"Property: {e['siteUrl']}  (permission: {e.get('permissionLevel')})")
            return e["siteUrl"]
    sys.exit("No litheca.com property among: "
             + ", ".join(e.get("siteUrl", "?") for e in entries))


def inspect(session, site_url: str, page_url: str) -> dict:
    r = session.post(INSPECT_URL, json={
        "inspectionUrl": page_url,
        "siteUrl": site_url,
        "languageCode": "en-US",
    }, timeout=60)
    if r.status_code != 200:
        return {"url": page_url, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
    idx = (r.json().get("inspectionResult") or {}).get("indexStatusResult") or {}
    return {
        "url": page_url,
        "verdict": idx.get("verdict"),
        "coverage": idx.get("coverageState"),
        "robots": idx.get("robotsTxtState"),
        "indexing": idx.get("indexingState"),
        "fetch": idx.get("pageFetchState"),
        "last_crawl": idx.get("lastCrawlTime"),
        "google_canonical": idx.get("googleCanonical"),
        "user_canonical": idx.get("userCanonical"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="inspect at most N URLs (0 = all)")
    ap.add_argument("--out", default="", help="write the full result as JSON here")
    args = ap.parse_args()

    import google.auth.transport.requests  # noqa: PLC0415
    import requests  # noqa: PLC0415

    session = requests.Session()
    creds = credentials()
    creds.refresh(google.auth.transport.requests.Request())
    session.headers["Authorization"] = f"Bearer {creds.token}"

    site_url = resolve_property(session)

    urls = sitemap_urls()
    if args.limit:
        urls = urls[:args.limit]
    print(f"Inspecting {len(urls)} sitemap URL(s)\n")

    results = []
    for i, u in enumerate(urls, 1):
        row = inspect(session, site_url, u)
        results.append(row)
        state = row.get("error") or row.get("coverage") or "?"
        print(f"  [{i:>3}/{len(urls)}] {state:<42} {u}")
        time.sleep(0.15)  # ~7/s, far under the 600/min ceiling

    buckets = collections.Counter(r.get("error") and "ERROR" or (r.get("coverage") or "unknown")
                                  for r in results)
    print("\n--- Summary ---")
    for state, n in buckets.most_common():
        print(f"  {n:>4}  {state}")

    if args.out:
        payload = {"site": site_url, "checked": len(results),
                   "summary": dict(buckets), "pages": results}
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
        print(f"\nWrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
