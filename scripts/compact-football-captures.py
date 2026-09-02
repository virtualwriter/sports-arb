#!/usr/bin/env python3
"""Gzip finished football captures and prune old archives.

The MLB collector compacts its own `ladder-lag-race-*` files, but football
recordings use a separate prefix and would otherwise accumulate untouched. A
college Saturday puts ~24 games on disk at roughly 30 MB apiece, so this runs
daily rather than weekly.

Files still being written are left alone: a recorder can sit on a game for
hours, so anything modified within COMPACT_MIN_AGE_MIN is skipped.

Usage:
  python3 scripts/compact-football-captures.py
"""
import glob
import gzip
import os
import shutil
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SPORTS_ARB_DATA_DIR") or ROOT / "data")
PATTERN = "football-ladder-race-*.jsonl"
MIN_AGE_MIN = int(os.environ.get("COMPACT_MIN_AGE_MIN", "90"))
RETAIN_DAYS = int(os.environ.get("FOOTBALL_RETAIN_DAYS", "45"))


def main() -> int:
    if not DATA_DIR.is_dir():
        print(f"no data dir: {DATA_DIR}")
        return 0

    now = datetime.now().timestamp()
    cutoff = now - MIN_AGE_MIN * 60
    compressed = skipped = failed = 0
    freed = 0

    for path in sorted(glob.glob(str(DATA_DIR / PATTERN))):
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if mtime > cutoff:
            skipped += 1
            continue
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as src, gzip.open(path + ".gz", "wb", compresslevel=6) as dst:
                shutil.copyfileobj(src, dst)
            os.remove(path)
            freed += size - os.path.getsize(path + ".gz")
            compressed += 1
        except Exception as exc:
            print(f"compress failed for {path}: {exc}")
            failed += 1

    pruned = 0
    prune_before = (datetime.now() - timedelta(days=RETAIN_DAYS)).timestamp()
    for path in glob.glob(str(DATA_DIR / (PATTERN + ".gz"))):
        try:
            if os.path.getmtime(path) < prune_before:
                os.remove(path)
                pruned += 1
        except OSError:
            continue

    print(
        f"compacted {compressed} (skipped {skipped} in-flight, {failed} failed), "
        f"reclaimed {freed / 1e6:.1f} MB, pruned {pruned} archives older than {RETAIN_DAYS}d"
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
