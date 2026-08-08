#!/usr/bin/env python3
"""Dual-stream model-roll P&L report for daily-high weather monitor tapes.

Usage:
  PYTHONPATH=scripts python3 scripts/weather_hourly_hedge_report.py --day 26AUG05
  PYTHONPATH=scripts python3 scripts/weather_hourly_hedge_report.py --day 26AUG05 --city austin
  npm run weather:hourly-hedge -- --day 26AUG05 --verbose

Streams (both rolled $1k, same-row mid ≥5¢, no stale buy walk-back):
  raw   — predictor bin as published
  aware — thrash + fat-book filter (anti_thrash + sticky book_lead) on that path
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.weather_cities import list_cities
from lib.weather_hourly_hedge_filter import evaluate_city_day, default_tape_path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--day", required=True, help="Kalshi day stamp, e.g. 26AUG05")
    ap.add_argument("--city", action="append", dest="cities", help="Repeatable; default all 5")
    ap.add_argument("--json", action="store_true", help="Emit JSON instead of table")
    ap.add_argument("--verbose", action="store_true", help="Show paths + notes")
    args = ap.parse_args()

    cities = args.cities or list_cities()
    results = []
    for key in cities:
        path = default_tape_path(key, args.day)
        res = evaluate_city_day(key, path)
        if res is None:
            print(f"{key}: no tape/preds at {path}", file=sys.stderr)
            continue
        results.append(res)

    if args.json:
        payload = []
        for r in results:
            pols = {
                m: {
                    "pnl": round(p.pnl, 2),
                    "path": p.path,
                    "switches": p.switches,
                    "held": p.held,
                    "won": p.won,
                    "notes": p.notes,
                }
                for m, p in r.policies.items()
            }
            payload.append({
                "city": r.city,
                "day": r.day,
                "open_bin": r.open_bin,
                "open_bin_aware": r.open_bin_aware,
                "fav_bin": r.fav_bin,
                "settle_f": r.settle_f,
                "raw_pnl": round(r.baseline_pnl, 2),
                "raw_path": r.baseline_path,
                "aware_pnl": round(r.aware_pnl, 2),
                "aware_path": r.aware_path,
                "delta_aware_vs_raw": round(r.delta, 2),
                "policies": pols,
            })
        print(json.dumps({"day": args.day, "cities": payload}, indent=2))
        return

    print(f"Dual model roll @ {args.day}")
    print(
        "raw = predictor bin; aware = anti_thrash + sticky book_lead. "
        "Buys need same-row mid ≥5¢.\n"
    )
    print(
        f"{'City':<8} {'Open':<8} {'Aware0':<8} {'Fav':<8} {'Settle':>7} "
        f"{'Raw':>8} {'Aware':>8} {'Δ':>8}"
    )
    print("-" * 72)
    tr = ta = 0.0
    for r in results:
        settle = f"{r.settle_f:.0f}°" if r.settle_f is not None else "—"
        print(
            f"{r.city:<8} {r.open_bin or '—':<8} {r.open_bin_aware or '—':<8} "
            f"{r.fav_bin or '—':<8} {settle:>7} "
            f"{r.baseline_pnl:>+8.0f} {r.aware_pnl:>+8.0f} {r.delta:>+8.0f}"
        )
        tr += r.baseline_pnl
        ta += r.aware_pnl
        if args.verbose:
            print(f"         raw:   {' → '.join(r.baseline_path) or '—'}  ({r.baseline_pnl:+.0f})")
            print(f"         aware: {' → '.join(r.aware_path) or '—'}  ({r.aware_pnl:+.0f})")
            for n in r.notes:
                if n.startswith(("anti_thrash", "book_lead", "book_aware:")):
                    print(f"         · {n}")

    print("-" * 72)
    print(
        f"{'TOTAL':<8} {'':<8} {'':<8} {'':<8} {'':>7} "
        f"{tr:>+8.0f} {ta:>+8.0f} {ta - tr:>+8.0f}"
    )
    print(f"\naware vs raw: {ta - tr:+.0f}")


if __name__ == "__main__":
    main()
