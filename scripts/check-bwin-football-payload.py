#!/usr/bin/env python3
"""Report whether football captures hold enough bwin data to write a parser.

The football recorder stores bwin's `ScoreboardSlim` pushes verbatim because
nobody here has seen an American-football one — the MLB parser reads a
baseball-shaped payload and guessing at the football field layout would bake in
a bug that only shows up as a silently wrong score clock.

A parser needs more than "some payloads exist". It needs payloads that straddle
a scoring play, because the only reliable way to identify which field carries
the running score is to watch which one moves when points go on the board. So
readiness means: a game with scoring plays, with bwin pushes on both sides of
at least one of them.

Exit 0 when ready, 2 when not. `--dump DIR` writes the straddling payloads out
for development.

Usage:
  python3 scripts/check-bwin-football-payload.py
  python3 scripts/check-bwin-football-payload.py --dump /tmp/bwin-football
"""
import glob
import gzip
import json
import os
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SPORTS_ARB_DATA_DIR") or ROOT / "data")
# Payloads this close on either side of a scoring play bracket the change.
STRADDLE_MS = int(os.environ.get("BWIN_STRADDLE_MS", "60000"))
MIN_STRADDLED_SCORES = int(os.environ.get("BWIN_MIN_STRADDLED_SCORES", "3"))


def jopen(path):
    return gzip.open(path, "rt") if str(path).endswith(".gz") else open(path)


def scan(path):
    """(bwin pushes, scoring-play timestamps) from one capture."""
    pushes, scores = [], []
    try:
        with jopen(path) as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                kind = row.get("kind")
                if kind == "bwin_score":
                    pushes.append((row.get("t"), row.get("raw")))
                elif kind == "football_score" and (row.get("delta") or 0) > 0:
                    scores.append(row.get("t"))
    except OSError:
        return [], []
    return pushes, scores


def straddling(pushes, scores):
    """Scoring plays with a bwin push both before and after them."""
    out = []
    for st in scores:
        if st is None:
            continue
        before = [p for p in pushes if p[0] is not None and 0 < st - p[0] <= STRADDLE_MS]
        after = [p for p in pushes if p[0] is not None and 0 < p[0] - st <= STRADDLE_MS]
        if before and after:
            out.append((st, before[-1], after[0]))
    return out


def main() -> int:
    dump_dir = None
    if "--dump" in sys.argv:
        dump_dir = Path(sys.argv[sys.argv.index("--dump") + 1])
        dump_dir.mkdir(parents=True, exist_ok=True)

    paths = sorted(glob.glob(str(DATA_DIR / "football-ladder-race-*.jsonl"))
                   + glob.glob(str(DATA_DIR / "football-ladder-race-*.jsonl.gz")))
    if not paths:
        print(f"not ready: no football captures under {DATA_DIR}")
        return 2

    totals = Counter()
    ready_games = []
    for path in paths:
        pushes, scores = scan(path)
        totals["captures"] += 1
        totals["pushes"] += len(pushes)
        totals["scores"] += len(scores)
        hits = straddling(pushes, scores)
        if hits:
            ready_games.append((path, hits))
            totals["straddled"] += len(hits)

    print(f"captures scanned      : {totals['captures']}")
    print(f"bwin pushes seen      : {totals['pushes']}")
    print(f"scoring plays seen    : {totals['scores']}")
    print(f"scores with bwin both sides: {totals['straddled']}")

    if totals["straddled"] < MIN_STRADDLED_SCORES:
        print(f"\nnot ready: need {MIN_STRADDLED_SCORES} straddled scoring plays, "
              f"have {totals['straddled']}")
        if totals["pushes"] == 0:
            print("no bwin pushes at all — check that bwin fixture discovery is "
                  "binding for football (FLR_BWIN_SPORT=11)")
        return 2

    if dump_dir:
        written = 0
        for path, hits in ready_games:
            for st, before, after in hits:
                stem = Path(path).name.split(".")[0]
                target = dump_dir / f"{stem}-score-{st}.json"
                target.write_text(json.dumps({
                    "capture": Path(path).name,
                    "scoreT": st,
                    "before": {"t": before[0], "raw": before[1]},
                    "after": {"t": after[0], "raw": after[1]},
                }, indent=2))
                written += 1
        print(f"\nwrote {written} straddling payload pairs -> {dump_dir}")

    print("\nREADY: enough bwin football payloads to write the parser")
    return 0


if __name__ == "__main__":
    sys.exit(main())
