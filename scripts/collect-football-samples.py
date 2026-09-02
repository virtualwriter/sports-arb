#!/usr/bin/env python3
"""Distil football captures into a settled backtest sample file.

The MLB collectors encode a hypothesis: they know what a softball looks like
and extract those moments. Football has no such hypothesis yet, so this stays
deliberately unopinionated and records the whole ladder at every sampled
moment, settled against the final score. That turns the backtest file into a
calibration table — for a rung D points above the running total, with M
minutes left, offered at P cents, how often did it actually go over — which is
the question that has to be answered before a strategy can be written.

One row per moment rather than per rung: the ladder travels as parallel arrays
so a game costs a few hundred rows instead of a few thousand, and pandas can
explode it at analysis time.

Moments sampled:
  grid        every FOOTBALL_GRID_SEC while the game is live
  score       the tick a scoring play was first seen
  post_score  fixed offsets after a score, to test whether quotes linger
              cheap before the book catches up (the MLB stale-quote thesis)

Usage:
  python3 scripts/collect-football-samples.py            # yesterday (ET)
  python3 scripts/collect-football-samples.py 2026-09-05 # explicit date
  python3 scripts/collect-football-samples.py --all      # every uncollected capture
"""
import glob
import gzip
import json
import os
import re
import shutil
import sys
from bisect import bisect_right
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SPORTS_ARB_DATA_DIR") or ROOT / "data")
REPO_DIR = DATA_DIR / "backtest"
SAMPLES = REPO_DIR / "football-samples.jsonl"
GAMES = REPO_DIR / "football-games.jsonl"
ET = ZoneInfo("America/New_York")

GRID_SEC = int(os.environ.get("FOOTBALL_GRID_SEC", "30"))
# Offsets probed after each scoring play. The first few are sub-second because
# that is where the MLB work found whatever edge exists.
POST_SCORE_MS = [int(x) for x in os.environ.get(
    "FOOTBALL_POST_SCORE_MS", "250,1000,3000,10000,30000").split(",")]
PRE_SCORE_MS = int(os.environ.get("FOOTBALL_PRE_SCORE_MS", "2000"))
COMPRESS = os.environ.get("FOOTBALL_COLLECT_COMPRESS", "1") == "1"


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def jopen(path):
    """Open plain or gzipped JSONL transparently."""
    return gzip.open(path, "rt") if str(path).endswith(".gz") else open(path)


def target_date() -> str:
    for arg in sys.argv[1:]:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", arg):
            return arg
    return (datetime.now(ET) - timedelta(days=1)).date().isoformat()


def collected_captures() -> set:
    """Capture filenames already collected, so a re-run cannot double-append."""
    out = set()
    if not GAMES.exists():
        return out
    with open(GAMES) as fh:
        for line in fh:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("capture"):
                out.add(row["capture"])
    return out


class Ladder:
    """Running top-of-book per strike, replayed from kalshi_ladder ticks."""

    def __init__(self):
        self.yes = {}   # line -> (bid, ask, bidSize, askSize)

    def apply(self, row: dict) -> None:
        if row.get("side") != "yes":
            return
        line = row.get("line")
        if line is None:
            return
        self.yes[line] = (
            row.get("bestBid"), row.get("bestAsk"),
            row.get("bestBidSize"), row.get("bestAskSize"),
        )

    def snapshot(self) -> dict:
        lines = sorted(l for l, q in self.yes.items() if q[1] is not None)
        return {
            "lines": lines,
            "bids": [self.yes[l][0] for l in lines],
            "asks": [self.yes[l][1] for l in lines],
            "bidSizes": [self.yes[l][2] for l in lines],
            "askSizes": [self.yes[l][3] for l in lines],
        }


def iter_rows(path: str):
    """Stream a capture row by row, tolerating a truncated final line."""
    with jopen(path) as fh:
        for line in fh:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue  # a recorder killed mid-write leaves a partial line


def scan_capture(path: str):
    """First pass: the little that has to be known before sampling can start.

    Captures run to hundreds of megabytes, so nothing here retains a row —
    only the scoring timestamps, the settling score, and the start of the
    clock. Holding a whole game in memory would put the MLB daemon at risk of
    an OOM kill on a shared 3.8 GB box.
    """
    target = None
    score_ts = []
    final_state = last_state = None
    first_t = None
    for row in iter_rows(path):
        t = row.get("t")
        if first_t is None and t is not None:
            first_t = t
        kind = row.get("kind")
        if kind == "target":
            target = row
        elif kind == "football_score" and (row.get("delta") or 0) > 0:
            score_ts.append(t)
        elif kind == "football_game_state":
            last_state = (row.get("scoreAway"), row.get("scoreHome"))
            if row.get("final"):
                final_state = last_state
    return target, score_ts, final_state, last_state, first_t


def settle(final_state, last_state) -> tuple:
    """(finalTotal, away, home, confident) — unconfident if the whistle was missed."""
    if final_state is not None:
        return final_state[0] + final_state[1], final_state[0], final_state[1], True
    if last_state is not None:
        # Recorder died before the whistle: usable, but flagged so analysis
        # can exclude it rather than settle against a partial score.
        return last_state[0] + last_state[1], last_state[0], last_state[1], False
    return None, None, None, False


def collect_capture(path: str, out_fh) -> tuple:
    """Stream one capture, writing settled samples. Returns (count, game)."""
    target, score_ts, final_state, last_state, first_t = scan_capture(path)
    if target is None:
        return 0, None
    slug = target.get("slug") or Path(path).stem
    fin_total, fin_away, fin_home, confident = settle(final_state, last_state)
    if fin_total is None:
        return 0, None

    ladder = Ladder()
    state = None
    written = 0

    # Each scoring play schedules a pre-snapshot and several post-snapshots.
    due = []
    for t0 in score_ts:
        due.append((t0 - PRE_SCORE_MS, "pre_score", -PRE_SCORE_MS, t0))
        due.append((t0, "score", 0, t0))
        for off in POST_SCORE_MS:
            due.append((t0 + off, "post_score", off, t0))
    due.sort(key=lambda x: x[0])
    due_i = 0
    next_grid = first_t or 0

    def emit(t: int, trigger: str, since_ms, score_t) -> None:
        nonlocal written
        if state is None:
            return
        snap = ladder.snapshot()
        if not snap["lines"]:
            return
        cur_total = state["scoreAway"] + state["scoreHome"]
        out_fh.write(json.dumps({
            "kind": "football_sample",
            "slug": slug,
            "league": target.get("league"),
            "espnEventId": target.get("espnEventId"),
            "dateEt": target.get("dateEt"),
            "kalshiEvent": target.get("kalshiEvent"),
            "t": t,
            "trigger": trigger,
            "sinceScoreMs": since_ms,
            "scoreT": score_t,
            "live": state.get("live"),
            "scoreAway": state["scoreAway"],
            "scoreHome": state["scoreHome"],
            "curTotal": cur_total,
            "period": state.get("period"),
            "clock": state.get("clock"),
            "minutesLeft": state.get("minutesLeft"),
            "possession": state.get("possession"),
            "down": state.get("down"),
            "distance": state.get("distance"),
            **snap,
            # Distance of each rung above the running total, the axis the MLB
            # strategy is defined on.
            "dists": [round(l - cur_total, 1) for l in snap["lines"]],
            "finalTotal": fin_total,
            "hits": [1 if fin_total > l else 0 for l in snap["lines"]],
            "settleConfident": confident,
        }) + "\n")
        written += 1

    for row in iter_rows(path):
        t = row.get("t", 0)
        # Flush any scheduled samples that this row's timestamp has passed.
        while due_i < len(due) and due[due_i][0] <= t:
            dt, trig, off, score_t = due[due_i]
            emit(dt, trig, off, score_t)
            due_i += 1
        while state is not None and state.get("live") and next_grid <= t:
            emit(next_grid, "grid", None, None)
            next_grid += GRID_SEC * 1000
        kind = row.get("kind")
        if kind == "kalshi_ladder":
            ladder.apply(row)
        elif kind == "football_game_state":
            state = row
            if not state.get("live"):
                next_grid = max(next_grid, t)  # don't backfill dead time

    game = {
        "kind": "football_game",
        "slug": slug,
        "capture": Path(path).name,
        "league": target.get("league"),
        "espnEventId": target.get("espnEventId"),
        "dateEt": target.get("dateEt"),
        "shortName": target.get("shortName"),
        "kalshiEvent": target.get("kalshiEvent"),
        "finalAway": fin_away,
        "finalHome": fin_home,
        "finalTotal": fin_total,
        "settleConfident": confident,
        "scoringPlays": len(score_ts),
        "samples": written,
        "rungs": len(target.get("rungs") or {}),
        "collectedAt": int(datetime.now().timestamp() * 1000),
    }
    return written, game


def capture_paths(day: str, take_all: bool) -> list:
    pats = [str(DATA_DIR / "football-ladder-race-*.jsonl"),
            str(DATA_DIR / "football-ladder-race-*.jsonl.gz")]
    paths = sorted(p for pat in pats for p in glob.glob(pat))
    if take_all:
        return paths
    # A night game started on `day` can carry the next day's UTC stamp.
    nxt = (datetime.fromisoformat(day) + timedelta(days=1)).date().isoformat()
    return [p for p in paths if day in Path(p).name or nxt in Path(p).name]


def main() -> int:
    take_all = "--all" in sys.argv
    day = target_date()
    REPO_DIR.mkdir(parents=True, exist_ok=True)
    done = collected_captures()

    paths = capture_paths(day, take_all)
    if not paths:
        log(f"no football captures for {day}")
        return 0

    total_samples = 0
    collected = []
    for path in paths:
        name = Path(path).name
        if name in done or name.replace(".gz", "") in done:
            continue
        with open(SAMPLES, "a") as fh:
            written, game = collect_capture(path, fh)
        if game is None:
            log(f"skip {name}: no target row or no settled score")
            continue
        with open(GAMES, "a") as fh:
            fh.write(json.dumps(game) + "\n")
        total_samples += written
        collected.append((path, game))
        flag = "" if game["settleConfident"] else "  (UNSETTLED)"
        log(f"{game['slug']}: {written} samples, final {game['finalTotal']}, "
            f"{game['scoringPlays']} scoring plays{flag}")

    log(f"collected {len(collected)} games, {total_samples} samples -> {SAMPLES}")

    if COMPRESS:
        for path, _ in collected:
            if path.endswith(".gz"):
                continue
            try:
                with open(path, "rb") as src, gzip.open(path + ".gz", "wb", compresslevel=6) as dst:
                    shutil.copyfileobj(src, dst)
                os.remove(path)
            except OSError as exc:
                log(f"compress failed for {path}: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
