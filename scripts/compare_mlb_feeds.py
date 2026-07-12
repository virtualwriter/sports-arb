#!/usr/bin/env python3
"""Compare MLB feed latency: StatsAPI (production) vs SportsDataIO / The Odds API.

Reads the state-feed shadow jsonl and, for every (event, away-home score) pair,
records the first time each feed reported that score. Reports the lead/lag
distribution so we can decide whether paid feeds are worth it.

Usage:
  python3 scripts/compare_mlb_feeds.py [--shadow PATH]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEFAULT_CANDIDATES = [
    os.environ.get("STATE_FEED_SHADOW_PATH", ""),
    "/var/lib/sports-arb/data/state-feed-shadow.jsonl",
    str(ROOT / "data" / "state-feed-shadow.jsonl"),
]

COMPARE_FEEDS = ("sdio", "oddsapi")


def resolve_shadow() -> Path:
    for cand in DEFAULT_CANDIDATES:
        if cand and Path(cand).exists():
            return Path(cand)
    raise SystemExit("no shadow file found; pass --shadow")


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


SCORE_RE = re.compile(r"^(\d+)-(\d+)")


def score_part(key: str | None) -> str | None:
    if not key:
        return None
    m = SCORE_RE.match(key.split("|")[0])
    return m.group(0) if m else None


def report_lag(label: str, first_seen: dict[tuple[str, str], dict[str, datetime]], feed: str) -> None:
    lags: list[float] = []
    rows: list[tuple[str, str, float]] = []
    for (slug, score), slot in sorted(first_seen.items()):
        if "statsapi" in slot and feed in slot:
            lag = (slot[feed] - slot["statsapi"]).total_seconds()
            lags.append(lag)
            rows.append((slug, score, lag))

    print(f"\n{label} lag vs StatsAPI (positive = StatsAPI first):")
    print(f"  matched (slug, score) pairs: {len(lags)}")
    if not lags:
        print("  not enough overlap yet; let the logger run through some live games")
        return
    print(f"  median: {statistics.median(lags):+.1f}s")
    print(f"  mean:   {statistics.mean(lags):+.1f}s")
    print(f"  min/max: {min(lags):+.1f}s / {max(lags):+.1f}s")
    faster = sum(1 for lag in lags if lag < 0)
    print(f"  {label} first: {faster}/{len(lags)} ({100 * faster / len(lags):.0f}%)")
    print(f"  worst 10 abs lags:")
    for slug, score, lag in sorted(rows, key=lambda r: -abs(r[2]))[:10]:
        print(f"    {slug} {score}: {lag:+.1f}s")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shadow", type=Path, default=None)
    args = ap.parse_args()
    shadow = args.shadow or resolve_shadow()

    # first_seen[(slug, "away-home")] = {"statsapi": dt, "sdio": dt, "oddsapi": dt}
    first_seen: dict[tuple[str, str], dict[str, datetime]] = {}
    counts = {"statsapi": 0, "sdio": 0, "oddsapi": 0}

    with shadow.open() as fh:
        for line in fh:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("asset") != "MLB":
                continue
            kind = row.get("kind")
            ts = row.get("observedAt")
            slug = row.get("eventSlug")
            if not ts or not slug:
                continue
            when = parse_ts(ts)
            if kind in ("snapshot", "score_change"):
                feed = row.get("feed") or {}
                # Only count StatsAPI rows for production baseline.
                if feed.get("source") not in (None, "statsapi"):
                    continue
                sh, sa = feed.get("scoreHome"), feed.get("scoreAway")
                if sh is None or sa is None:
                    continue
                score = f"{sa}-{sh}"
                slot = first_seen.setdefault((slug, score), {})
                if "statsapi" not in slot or when < slot["statsapi"]:
                    slot["statsapi"] = when
                counts["statsapi"] += 1
            elif kind == "sdio_change":
                score = score_part(row.get("sdioKey"))
                if not score:
                    continue
                slot = first_seen.setdefault((slug, score), {})
                if "sdio" not in slot or when < slot["sdio"]:
                    slot["sdio"] = when
                counts["sdio"] += 1
            elif kind == "oddsapi_change":
                score = score_part(row.get("oddsApiKey"))
                if not score:
                    continue
                slot = first_seen.setdefault((slug, score), {})
                if "oddsapi" not in slot or when < slot["oddsapi"]:
                    slot["oddsapi"] = when
                counts["oddsapi"] += 1

    print(f"shadow: {shadow}")
    print(
        f"observations: statsapi={counts['statsapi']} "
        f"sdio_change={counts['sdio']} oddsapi_change={counts['oddsapi']}"
    )
    report_lag("SDIO", first_seen, "sdio")
    report_lag("OddsAPI", first_seen, "oddsapi")


if __name__ == "__main__":
    main()
