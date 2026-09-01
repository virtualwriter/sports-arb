#!/usr/bin/env python3
"""Fetch NYC Central Park (KNYC) official daily highs into a local JSON store.

Primary source: IEM CLI JSON (official NWS CLINYC climate reports — the same
numbers Kalshi settles KXHIGHNY on). Fallback: IEM climodat NY5801 dailies.

The store is an idempotent date->record map; re-runs upsert recent days, so a
daily timer that fetches the current (and previous, near New Year) year keeps
the store complete.

Usage:
  python3 scripts/fetch_central_park_daily_high.py                 # current year
  python3 scripts/fetch_central_park_daily_high.py --year 2025
  python3 scripts/fetch_central_park_daily_high.py --backfill 2025 # 2025..now
  python3 scripts/fetch_central_park_daily_high.py --out /tmp/x.json
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import date
from pathlib import Path

DEFAULT_OUT = Path("/var/lib/sports-arb/data/central-park-daily-highs.json")
CLI_URL = "https://mesonet.agron.iastate.edu/json/cli.py?station=KNYC&year={year}"
CLIMODAT_URL = (
    "https://mesonet.agron.iastate.edu/api/1/daily.json"
    "?network=NYCLIMATE&station=NY5801&year={year}&month={month}"
)


def _get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "sports-arb-oleg/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def fetch_cli_year(year: int) -> dict[str, dict]:
    """Official CLI reports: date -> {high, source}."""
    out: dict[str, dict] = {}
    data = _get_json(CLI_URL.format(year=year))
    for row in data.get("results", []):
        high = row.get("high")
        day = row.get("valid")
        if day is None or not isinstance(high, (int, float)):
            continue
        out[day] = {"high_f": float(high), "source": "iem_cli_knyc"}
    return out


def fetch_climodat_year(year: int) -> dict[str, dict]:
    """Climodat NY5801 dailies: date -> {high, source}."""
    out: dict[str, dict] = {}
    for month in range(1, 13):
        try:
            data = _get_json(CLIMODAT_URL.format(year=year, month=month))
        except Exception:
            continue
        for row in data.get("data", []):
            high = row.get("max_tmpf")
            day = row.get("date")
            if day is None or not isinstance(high, (int, float)):
                continue
            out[day] = {"high_f": float(high), "source": "iem_climodat_ny5801"}
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--year", type=int, default=None, help="single year (default: current)")
    ap.add_argument("--backfill", type=int, default=None, help="start year; fetch through now")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    this_year = date.today().year
    if args.backfill:
        years = list(range(args.backfill, this_year + 1))
    else:
        years = [args.year or this_year]

    store: dict[str, dict] = {}
    if args.out.exists():
        try:
            store = json.loads(args.out.read_text())
        except json.JSONDecodeError:
            print(f"[warn] corrupt store at {args.out}, rebuilding", file=sys.stderr)

    added = updated = 0
    for year in years:
        cli = fetch_cli_year(year)
        climodat = fetch_climodat_year(year)
        # CLI (official) wins; climodat fills gaps.
        merged = {**climodat, **cli}
        for day, rec in merged.items():
            prev = store.get(day)
            if prev is None:
                added += 1
            elif prev != rec:
                # Never downgrade an official CLI value to climodat.
                if prev.get("source") == "iem_cli_knyc" and rec["source"] != "iem_cli_knyc":
                    continue
                updated += 1
            else:
                continue
            store[day] = rec

    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(dict(sorted(store.items())), indent=1))
    tmp.replace(args.out)
    print(f"[central-park-highs] {args.out}: {len(store)} days (+{added} new, ~{updated} updated)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
