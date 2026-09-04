#!/usr/bin/env python3
"""Scan the published pages for content problems and report them to the dashboard.

The indexing feed already answers "what did Google do with this URL". It
cannot answer "is the page any good", and every bug worth catching this week
was the second question: a book page listing nine characters whose character
pages were never published (nine dead links on an indexed page), three pages
offering "5, 28, 47, 68…" under a heading that says Chapters, pages frozen at
an old content_version with no route to a rewrite.

None of that is visible from outside. All of it is visible from the files, so
this reads them — no API calls, no credentials beyond the ingest secret, just
the repo it already runs inside.

Deliberately reports FACTS, not verdicts. An empty chapter list is normal for
a book whose wiki has none, and this says so without calling it broken; only
the shapes that are wrong however you look at them (a link to a page that does
not exist, a chapter list in which nothing is a chapter) are issues.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Same rule as bookhub-api's book_data._TOC_NOT_A_TITLE: an entry carrying no
# title at all. Kept in step by hand; both sides name the other.
_NOT_A_TITLE = re.compile(
    r"^(?:[\divxlc]+\.?"
    r"|(?:vols?|volumes?|v|bks?|books?|parts?|pts?)\.?\s*[\divxlc]*\s*[-–—]?\s*[\divxlc]*\.?)$",
    re.IGNORECASE,
)

_FIELDS = ("title", "author", "content_version", "chapters", "characters",
           "cover_url", "quotes", "free_ebook")

# Cloudflare's browser integrity check refuses urllib's default
# "Python-urllib/3.x" at the edge with 403 error code 1010, so the Worker
# never sees the request and the token is never read. Any ordinary agent
# string passes; this one names the caller.
UA = {"User-Agent": "Litheca-page-integrity/1.0"}


def _field(md: str, name: str) -> str:
    m = re.search(rf"^{name}:\s*(.*)$", md, re.MULTILINE)
    return m.group(1).strip() if m else ""


def _json_field(md: str, name: str):
    raw = _field(md, name)
    if raw in ("", "null", "[]"):
        return [] if raw == "[]" else None
    try:
        return json.loads(raw)
    except Exception:
        return None


def scan(root: Path, current_version: int) -> dict:
    books_dir, chars_dir = root / "_books", root / "_characters"
    have_char_page = {p.stem for p in chars_dir.glob("*.md")} if chars_dir.is_dir() else set()

    books = []
    for path in sorted(books_dir.glob("*.md")):
        md = path.read_text(encoding="utf-8", errors="replace")
        chapters = _json_field(md, "chapters") or []
        characters = _json_field(md, "characters") or []
        quotes = _json_field(md, "quotes")
        free_ebook = _json_field(md, "free_ebook")
        try:
            version = int(_field(md, "content_version") or 1)
        except ValueError:
            version = 1

        issues = []
        dead = [c.get("slug") for c in characters
                if isinstance(c, dict) and c.get("slug")
                and c["slug"] not in have_char_page]
        if dead:
            issues.append({"kind": "dead_character_link",
                           "detail": ", ".join(dead[:6])})
        if chapters and all(_NOT_A_TITLE.match(str(c).strip()) for c in chapters):
            issues.append({"kind": "junk_chapters",
                           "detail": json.dumps(chapters[:5], ensure_ascii=False)})
        if version < current_version:
            issues.append({"kind": "stale_version",
                           "detail": f"v{version} < v{current_version}"})
        if not chapters and not characters and not quotes:
            issues.append({"kind": "empty_page",
                           "detail": "no chapters, characters or quotes"})
        if not _field(md, "cover_url").strip('"'):
            issues.append({"kind": "no_cover", "detail": ""})

        books.append({
            "slug": path.stem,
            "title": _field(md, "title").strip('"'),
            "author": _field(md, "author").strip('"'),
            "version": version,
            "chapters": len(chapters),
            "characters": len(characters),
            "quotes": len((quotes or {}).get("texts") or []) if isinstance(quotes, dict) else 0,
            "free_ebook": bool(free_ebook),
            "issues": issues,
        })

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "current_version": current_version,
        "character_pages": len(have_char_page),
        "books": books,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", type=Path)
    ap.add_argument("--current-version", type=int, default=11,
                    help="github_publisher.PUBLISH_CONTENT_VERSION")
    ap.add_argument("--url", default=os.environ.get("SEO_STATUS_URL", ""))
    ap.add_argument("--print", action="store_true", help="dump the payload, do not send")
    args = ap.parse_args()

    snap = scan(args.root, args.current_version)
    books = snap["books"]
    needy = [b for b in books if not b["chapters"] or not b["characters"]]
    flagged = [b for b in books if b["issues"]]
    print(f"{len(books)} book pages, {snap['character_pages']} character pages")
    print(f"  {len(needy)} missing chapters and/or characters")
    print(f"  {len(flagged)} with at least one integrity issue")
    by_kind = {}
    for b in flagged:
        for i in b["issues"]:
            by_kind[i["kind"]] = by_kind.get(i["kind"], 0) + 1
    for k, n in sorted(by_kind.items(), key=lambda kv: -kv[1]):
        print(f"    {k:22} {n}")

    if args.print:
        print(json.dumps(snap, ensure_ascii=False)[:2000])
        return 0

    secret = os.environ.get("SEO_INGEST_SECRET", "")
    if not args.url or not secret:
        print("SEO_STATUS_URL or SEO_INGEST_SECRET unset — not sending.")
        return 0

    # ?feed=pages, not /ingest/pages: the Cloudflare Access rule in front of
    # this Worker is path-scoped, and a deeper path may fall outside it and be
    # answered by a login page. A query parameter cannot.
    req = urllib.request.Request(
        f"{args.url.rstrip('/')}/ingest?feed=pages",
        data=json.dumps(snap, ensure_ascii=False).encode("utf-8"),
        # **UA IS LOAD-BEARING** — see the constant. The first run of this
        # workflow died here with "HTTP 403 error code 1010", which reads like
        # a rejected secret and is not: Cloudflare blocked urllib's default
        # agent at the edge and the Worker never saw the request. Measured
        # against the live hostname: the default gets 1010, while curl/8.5.0,
        # this agent and a Mozilla string all reach the Worker and draw its
        # own 403 for a bad token.
        headers={**UA,
                 "Content-Type": "application/json",
                 "Authorization": f"Bearer {secret}"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print(f"ingest -> {r.status} {r.read().decode()[:120]}")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        # Three different things answer on this hostname, and each failure
        # looks like a bad secret until you read who sent it.
        if "1010" in body:
            print("::error::Cloudflare blocked this at the edge (code 1010) — a "
                  "User-Agent it refuses. The Worker never saw the request and "
                  "the secret was never read. See the UA note above.")
        elif "text/html" in (e.headers.get("Content-Type") or ""):
            print("::error::Cloudflare Access answered instead of the Worker — "
                  "the request never arrived. Check the path-scoped Access "
                  "application for /ingest; nothing is wrong with the secret.")
        elif e.code == 403:
            print("::error::The Worker refused the token — SEO_INGEST_SECRET "
                  "does not match the Worker's INGEST_SECRET.")
        print(f"::error::ingest failed: HTTP {e.code} {body[:200]}")
        return 1
    except Exception as e:                                        # noqa: BLE001
        print(f"::error::ingest failed: {type(e).__name__}: {e}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
