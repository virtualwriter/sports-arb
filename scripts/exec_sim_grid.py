#!/usr/bin/env python3
"""Grid-search GOT roll execution policy through the exec-aware simulator.

Sweeps ExecOpts knobs over recorded city-days (real books, fees, poll
cadence) and ranks configs by total exec PnL + robustness. Answers: is there
any execution policy under which GOT survives real books?

Usage (on the VPS):
  PYTHONPATH=scripts python3 scripts/exec_sim_grid.py --from 26AUG15 --to 26AUG31
  PYTHONPATH=scripts python3 scripts/exec_sim_grid.py --from 26AUG15 --to 26AUG31 --top 25
"""

from __future__ import annotations

import argparse
import itertools
import json
import time
from dataclasses import replace
from pathlib import Path

from lib.weather_cities import get_city, list_cities
from lib.weather_exec_sim import (
    BookTape,
    ExecOpts,
    got_stream_from_tape,
    simulate_exec_roll,
)
from lib.weather_hourly_hedge_filter import _parse_tape, _settle_temp_f
from weather_paper_scoreboard import day_range, got_tape_path, tape_path

# Grid axes (deployed defaults first in each list).
CONFIRM_TICKS = [1, 3, 5, 10]
MAX_ROLLS = [0, 1, 2, 3]
MIN_BUY_MID = [0.05, 0.10, 0.15, 0.20]
MIN_ROLL_NOTIONAL = [5.0, 10.0, 15.0]
MIN_ENTRY_BID_DEPTH = [0.0, 50.0]


def build_configs() -> list[ExecOpts]:
    out = []
    for ct, mr, mbm, mrn, mebd in itertools.product(
        CONFIRM_TICKS, MAX_ROLLS, MIN_BUY_MID, MIN_ROLL_NOTIONAL, MIN_ENTRY_BID_DEPTH
    ):
        out.append(
            ExecOpts(
                confirm_ticks=ct,
                max_rolls_per_day=mr,
                min_buy_mid=mbm,
                min_roll_notional_usd=mrn,
                min_entry_bid_depth=mebd,
            )
        )
    return out


def cfg_key(o: ExecOpts) -> str:
    return (
        f"ct={o.confirm_ticks} mr={o.max_rolls_per_day} "
        f"mid>={o.min_buy_mid:.2f} rn>={o.min_roll_notional_usd:.0f} "
        f"bd>={o.min_entry_bid_depth:.0f}"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--from", dest="frm", required=True)
    ap.add_argument("--to", dest="to", required=True)
    ap.add_argument("--poll-ms", type=int, default=2000)
    ap.add_argument("--top", type=int, default=15)
    ap.add_argument("--out", type=Path, default=None, help="write full results JSON")
    args = ap.parse_args()

    days = day_range(args.frm, args.to)
    configs = build_configs()
    print(f"grid: {len(configs)} configs x days {args.frm}..{args.to}")

    # results[cfg_idx] -> {day: pnl_sum_across_cities}
    results: list[dict[str, float]] = [dict() for _ in configs]
    n_city_days = 0
    t0 = time.time()

    for day in days:
        for city_key in list_cities():
            wx = tape_path(city_key, day)
            gt = got_tape_path(city_key, day)
            if wx is None or gt is None:
                continue
            city = get_city(city_key)
            stream = got_stream_from_tape(gt, poll_ms=args.poll_ms)
            if not stream:
                continue
            tape = _parse_tape(wx)
            settle = _settle_temp_f(tape, tape.get("preds") or [])
            if settle is None:
                continue
            books = BookTape.from_weather_tape(wx, city.daily_series)
            n_city_days += 1
            for i, cfg in enumerate(configs):
                r = simulate_exec_roll(
                    stream, books, city.daily_series, day, settle, cfg
                )
                results[i][day] = results[i].get(day, 0.0) + r.pnl
        print(f"  {day} done ({time.time() - t0:.0f}s)")

    print(f"\nscored {n_city_days} city-days in {time.time() - t0:.0f}s\n")

    rows = []
    for i, cfg in enumerate(configs):
        day_pnls = list(results[i].values())
        if not day_pnls:
            continue
        total = sum(day_pnls)
        pos_days = sum(1 for p in day_pnls if p > 0)
        rows.append(
            {
                "cfg": cfg_key(cfg),
                "total": total,
                "pos_days": pos_days,
                "n_days": len(day_pnls),
                "worst_day": min(day_pnls),
                "best_day": max(day_pnls),
            }
        )

    rows.sort(key=lambda r: -r["total"])
    base = next((r for r in rows if r["cfg"] == cfg_key(ExecOpts())), None)

    print(f"{'rank':>4} {'total$':>9} {'pos/n':>6} {'worst':>8} {'best':>8}  config")
    print("-" * 90)
    for rank, r in enumerate(rows[: args.top], 1):
        print(
            f"{rank:>4} {r['total']:9.2f} {r['pos_days']:>3}/{r['n_days']:<2} "
            f"{r['worst_day']:8.2f} {r['best_day']:8.2f}  {r['cfg']}"
        )
    print("...")
    for rank, r in enumerate(rows[-3:], len(rows) - 2):
        print(
            f"{rank:>4} {r['total']:9.2f} {r['pos_days']:>3}/{r['n_days']:<2} "
            f"{r['worst_day']:8.2f} {r['best_day']:8.2f}  {r['cfg']}"
        )
    if base:
        print(
            f"\ndeployed defaults: total={base['total']:.2f} "
            f"pos={base['pos_days']}/{base['n_days']} worst={base['worst_day']:.2f} "
            f"({base['cfg']})"
        )
    n_pos = sum(1 for r in rows if r["total"] > 0)
    print(f"configs with positive total: {n_pos}/{len(rows)}")

    if args.out:
        args.out.write_text(json.dumps(rows, indent=1))
        print(f"full results -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
