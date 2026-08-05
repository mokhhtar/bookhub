"""
scripts/promote_books_batch.py — staged indexing rollout for book pages.

    python scripts/promote_books_batch.py --min-score 7 --limit 5 --dry-run
    python scripts/promote_books_batch.py --min-score 7 --limit 5 --batch auto

MOVED HERE from bookhub-api (2026-08-05). It only ever read and wrote this
repo's `_books/*.md` — it had no API, network or Redis dependency — and living
in the other repo meant the weekly workflow would have needed a cross-repo PAT
that does not exist as an Actions secret. Here, the built-in GITHUB_TOKEN can
commit the result. There is deliberately ONE copy: two would drift, which is
the mistake `assets/js/game-stats.js` documents at the top of itself.

The engagement-based promoter in bookhub-api (`tools/indexing.py`, nightly)
still exists and is unchanged. The two are complementary: that one promotes a
page real readers engaged with, this one bootstraps pages nobody can engage
with *because* they are not indexed yet.

Turning 88 unindexed pages on at once is not the risk people assume — Google
does not penalise volume; news sites publish hundreds a day. But on a NEW
domain with no established trust, a sudden mass arrival of similar pages is a
poor first impression, and the real danger is letting THIN pages into the
index, where they drag the whole site's quality classification. So the gate
here is completeness, not count, and the drip exists so that a bad batch is
five pages of damage rather than ninety.

Scoring uses what a page actually carries, because prose length turned out to
be useless as a discriminator — across all pages the median body is ~713 words
and the spread between the richest and thinnest is barely 20 words. The
structured fields are what differ:

    free Gutenberg text   3   (a standalone reason to visit, and the reason
                               github_publisher's v3 rule grants indexing)
    verified quotes       2
    characters            2
    pre-generated quiz    1
    ratings               1
    chapter list          1
    body >= 1200 words    2   (>= 800 words: 1)

Writes the same three lines tools/indexing.py writes when a page earns
indexing through engagement, inserted the same way — immediately before the
closing front-matter delimiter, everything else byte-identical. Safe against a
later republish because github_publisher._carried_index_state carries an
existing page's indexing state forward instead of recomputing it.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import re

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOKS_DIR = os.path.join(REPO_ROOT, "_books")


def _field(head: str, key: str) -> str:
    m = re.search(rf"^{key}:\s*(.*)$", head, re.M)
    return m.group(1).strip() if m else ""


def score(markdown: str) -> int:
    head = markdown.split("---", 2)[1] if markdown.count("---") >= 2 else markdown
    body = markdown.split("---", 2)[2] if markdown.count("---") >= 2 else ""
    words = len(re.sub(r"<[^>]+>", " ", body).split())

    points = 0
    if "project_gutenberg" in _field(head, "free_ebook"):
        points += 3
    if _field(head, "quotes") not in ("", "{}", "null"):
        points += 2
    if _field(head, "characters") not in ("", "[]"):
        points += 2
    if _field(head, "quiz") not in ("", "[]"):
        points += 1
    if _field(head, "ratings") not in ("", "{}", "null"):
        points += 1
    if _field(head, "chapters") not in ("", "[]"):
        points += 1
    points += 2 if words >= 1200 else (1 if words >= 800 else 0)
    return points


def already_indexed(markdown: str) -> bool:
    return bool(re.search(r"^noindex:\s*false\s*$", markdown, re.M))


def next_batch_number() -> int:
    """One past the highest `batch N` already recorded in the collection.

    Read from the pages rather than kept in a counter file: the pages ARE the
    record, and a counter could disagree with them after a revert.
    """
    highest = 0
    for name in os.listdir(BOOKS_DIR):
        if not name.endswith(".md"):
            continue
        with open(os.path.join(BOOKS_DIR, name), encoding="utf-8") as fh:
            m = re.search(r"^index_promoted:\s*batch\s+(\d+)\b", fh.read(), re.M)
        if m:
            highest = max(highest, int(m.group(1)))
    return highest + 1


def promote(path: str, markdown: str, batch: str) -> str:
    """Same surgical insert as tools/indexing.py's _mark_indexable."""
    head, sep, rest = markdown.partition("\n---\n")
    if not sep:
        raise ValueError(f"no front-matter delimiter in {path}")
    return (head
            + "\nnoindex: false"
            + "\nsitemap: true"
            + f"\nindex_promoted: batch {batch} {dt.date.today().isoformat()}"
            + sep + rest)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-score", type=int, default=9)
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--batch", default="1",
                    help='batch label, or "auto" to use the next unused number')
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    batch = str(next_batch_number()) if args.batch == "auto" else args.batch

    candidates, skipped = [], 0
    for name in sorted(os.listdir(BOOKS_DIR)):
        if not name.endswith(".md"):
            continue
        path = os.path.join(BOOKS_DIR, name)
        markdown = open(path, encoding="utf-8").read()
        if already_indexed(markdown):
            skipped += 1
            continue
        s = score(markdown)
        if s >= args.min_score:
            candidates.append((s, name, path, markdown))

    candidates.sort(key=lambda c: (-c[0], c[1]))
    chosen = candidates[:args.limit]

    print(f"{skipped} page(s) already indexed | {len(candidates)} qualify at "
          f"score >= {args.min_score} | promoting {len(chosen)} as batch {batch}"
          f"{' (DRY RUN)' if args.dry_run else ''}\n")
    for s, name, path, markdown in chosen:
        print(f"  [{s:>2}] {name[:-3]}")
        if not args.dry_run:
            open(path, "w", encoding="utf-8").write(promote(path, markdown, batch))

    left = len(candidates) - len(chosen)
    if left:
        print(f"\n{left} more qualify but were held back for a later batch.")
    if not chosen:
        print("Nothing to promote.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
