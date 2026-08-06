"""
scripts/retag_amazon_links.py — move published pages onto a new Associates tag.

    python scripts/retag_amazon_links.py --dry-run
    python scripts/retag_amazon_links.py

`amazon_url` is baked into every published `_books/*.md` at publish time, and
publishing is create-only, so changing the tag in _config.yml and the API fixes
only what is generated NEXT. The pages already committed — the permanent layer
— keep the old tag until something rewrites them. This is that something.

It does not lose or move money: the old and new tags share one Associates
account. What it fixes is REPORTING. Amazon reports per tracking ID, so a
Litheca link left on the old tag is counted in another site's column, which
understates Litheca — and a half-finished migration produces exactly the
blurred numbers the migration was meant to remove.

Deliberately a string replacement of the tag PARAMETER and nothing else. Not a
republish: republishing would re-run resolvers and could change a summary, a
quiz or a free-ebook link as a side effect of an accounting change. The
narrowest edit that can be correct is the one to make.
"""
from __future__ import annotations

import argparse
import os
import re
import sys

OLD_TAG = "oceansidehair-20"
NEW_TAG = "litheca-20"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COLLECTIONS = ("_books", "_authors", "_characters")

# Only inside a tag= query parameter, so the bare word could never be replaced
# somewhere it happens to appear in prose.
PATTERN = re.compile(r"(?<=tag=)" + re.escape(OLD_TAG) + r"\b")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    changed, total_subs, scanned = [], 0, 0
    for coll in COLLECTIONS:
        d = os.path.join(REPO_ROOT, coll)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith(".md"):
                continue
            path = os.path.join(d, name)
            with open(path, encoding="utf-8") as fh:
                before = fh.read()
            scanned += 1
            after, n = PATTERN.subn(NEW_TAG, before)
            if not n:
                continue

            # Prove the edit touched nothing but the tag: putting the old value
            # back must reproduce the original file byte for byte. A rewrite of
            # 100+ committed pages should not be trusted to a regex on faith.
            if after.replace(NEW_TAG, OLD_TAG) != before.replace(NEW_TAG, OLD_TAG):
                sys.exit(f"{path}: edit changed more than the tag — aborting, nothing written")

            changed.append((os.path.join(coll, name), n))
            total_subs += n
            if not args.dry_run:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(after)

    print(f"scanned {scanned} page(s) | {len(changed)} to change | "
          f"{total_subs} link(s){' (DRY RUN)' if args.dry_run else ''}")
    for p, n in changed[:10]:
        print(f"  {n}x  {p}")
    if len(changed) > 10:
        print(f"  ... and {len(changed) - 10} more")

    if not args.dry_run and changed:
        leftover = 0
        for coll in COLLECTIONS:
            d = os.path.join(REPO_ROOT, coll)
            if not os.path.isdir(d):
                continue
            for name in os.listdir(d):
                if name.endswith(".md"):
                    with open(os.path.join(d, name), encoding="utf-8") as fh:
                        leftover += fh.read().count(OLD_TAG)
        print(f"\nremaining occurrences of {OLD_TAG}: {leftover}")
        if leftover:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
