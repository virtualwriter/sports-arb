#!/usr/bin/env python3
"""Report / backfill Chicago daily-high predictor accuracy ledger.

Usage:
  PYTHONPATH=scripts python3 scripts/chi_high_accuracy_report.py
  PYTHONPATH=scripts python3 scripts/chi_high_accuracy_report.py --backfill
  PYTHONPATH=scripts python3 scripts/chi_high_accuracy_report.py --backfill .tmp/chi-weather-26aug04-monitor.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.chi_high_accuracy_log import AccuracyLedger, ledger_path_for_city
from lib.weather_cities import list_cities


def backfill_jsonl(path: Path, ledger: AccuracyLedger) -> str | None:
    day = None
    open_set = False
    last_pred = None
    daily_result = None
    daily_recv = None
    with path.open() as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("type") == "milestone" and r.get("msg") == "MONITOR_START":
                # Keep first day stamp in file; later restarts same day still OK.
                if day is None:
                    day = r.get("day")
            if r.get("type") == "prediction" and day:
                last_pred = r
                ledger.record_prediction(day, r, opening=not open_set)
                open_set = True
            if r.get("type") == "milestone" and r.get("msg") == "DAILY_SETTLED" and day:
                daily_result = {
                    "results": r.get("results") or {},
                    "expiration_value": r.get("expiration_value"),
                }
                daily_recv = r.get("recv")
    if day and last_pred:
        ledger.record_prediction(day, last_pred)
    if day and daily_result:
        ledger.record_daily_result(day, daily_result, recv=daily_recv)
    return day


def print_report(ledger: AccuracyLedger) -> None:
    rows = ledger.summary_rows()
    if not rows:
        print("No days in ledger yet:", ledger.path)
        return
    print(f"Ledger: {ledger.path}")
    print(
        f"{'date':<12} {'day':<10} {'open':<8} {'final':<8} {'settle':<8} "
        f"{'open_hit':<9} {'final_hit':<10} {'open_err':<8} {'final_err':<8}"
    )
    open_hits = final_hits = open_n = final_n = 0
    open_err_sum = final_err_sum = 0
    open_err_n = final_err_n = 0
    for r in rows:
        settle = r["settle_f"]
        settle_s = str(settle) if settle is not None else "—"
        oh = r["open_hit"]
        fh = r["final_hit"]
        if oh is not None:
            open_n += 1
            open_hits += int(bool(oh))
        if fh is not None:
            final_n += 1
            final_hits += int(bool(fh))
        if r["open_err"] is not None:
            open_err_n += 1
            open_err_sum += r["open_err"]
        if r["final_err"] is not None:
            final_err_n += 1
            final_err_sum += r["final_err"]
        print(
            f"{r.get('local_date') or '':<12} {r['day']:<10} "
            f"{str(r.get('open_bin') or '—'):<8} {str(r.get('final_bin') or '—'):<8} "
            f"{settle_s:<8} "
            f"{str(oh):<9} {str(fh):<10} "
            f"{str(r.get('open_err') if r.get('open_err') is not None else '—'):<8} "
            f"{str(r.get('final_err') if r.get('final_err') is not None else '—'):<8}"
        )
    print()
    if open_n:
        print(f"Open bin hit rate:  {open_hits}/{open_n} = {open_hits / open_n:.0%}")
    if final_n:
        print(f"Final bin hit rate: {final_hits}/{final_n} = {final_hits / final_n:.0%}")
    if open_err_n:
        print(f"Open MAE:  {open_err_sum / open_err_n:.2f}°F ({open_err_n} days)")
    if final_err_n:
        print(f"Final MAE: {final_err_sum / final_err_n:.2f}°F ({final_err_n} days)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", default="chicago", help=f"City key: {', '.join(list_cities())}")
    ap.add_argument("--ledger", default=None, help="Path to ledger JSON")
    ap.add_argument(
        "--backfill",
        nargs="*",
        metavar="JSONL",
        help="Backfill from monitor jsonl files (default: city tape glob)",
    )
    args = ap.parse_args()
    ledger = AccuracyLedger(args.ledger or ledger_path_for_city(args.city))

    if args.backfill is not None:
        if args.backfill:
            paths = [Path(p) for p in args.backfill]
        else:
            key = args.city.lower()
            if key in ("chicago", "chi"):
                paths = sorted(Path(".tmp").glob("chi-weather-*-monitor.jsonl"))
            else:
                paths = sorted(Path(".tmp").glob(f"{key}-weather-*-monitor.jsonl"))

        for path in paths:
            if not path.exists() or "restart-test" in path.name or "smoke" in path.name:
                continue
            day = backfill_jsonl(path, ledger)
            row = ledger.load().get("days", {}).get(day or "", {})
            settle = (row.get("settlement") or {}).get("high_f")
            print(
                f"backfilled {path.name}: day={day} "
                f"open={((row.get('open') or {}).get('bin'))} "
                f"final={((row.get('final_pred') or {}).get('bin'))} "
                f"settle={settle}"
            )

    print_report(ledger)


if __name__ == "__main__":
    main()
