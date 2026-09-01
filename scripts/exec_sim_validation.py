#!/usr/bin/env python3
"""Validate the exec-aware GOT sim against real live fills (Aug 11-13 2026).

Replays the same GOT tapes the live daemon consumed through
lib/weather_exec_sim with the deployed daemon defaults, then compares
per-city cash flow / fees / roll counts / final position against the actual
fills recorded in weather-got-roll-orders.jsonl (including rotated .gz).

If sim ≈ live here, the sim's numbers on other days can be trusted.

Usage (on the VPS):
  PYTHONPATH=scripts python3 scripts/exec_sim_validation.py --day 26AUG13
"""

from __future__ import annotations

import argparse
import gzip
import json
from collections import defaultdict
from pathlib import Path

from lib.weather_cities import get_city, list_cities
from lib.weather_exec_sim import (
    BookTape,
    ExecOpts,
    got_stream_from_tape,
    simulate_exec_roll,
)
from lib.weather_hourly_hedge_filter import _parse_tape, _settle_temp_f

ORDERS_GLOB = "weather-got-roll-orders.jsonl*"
DATA_DIR = Path("/var/lib/sports-arb/data")
GOT_DIR = Path("/opt/sports-arb/.tmp")
WX_DIRS = [DATA_DIR / "weather-city-monitors", GOT_DIR]


def fk(city_key: str) -> str:
    return "chi" if city_key == "chicago" else city_key


def load_live_orders(day: str) -> dict[str, dict]:
    """Actual fills per city for `day` from the orders log (incl. rotations)."""
    out: dict[str, dict] = defaultdict(
        lambda: {"cash": 0.0, "fees": 0.0, "rolls": 0, "opens": 0, "buys": 0.0, "sells": 0.0}
    )
    for path in sorted(DATA_DIR.glob(ORDERS_GLOB)):
        opener = gzip.open if path.suffix == ".gz" else open
        try:
            with opener(path, "rt") as f:
                for line in f:
                    if '"weather_got_roll_order"' not in line:
                        continue
                    try:
                        o = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if o.get("day") != day:
                        continue
                    c = o["city"]
                    n = float(o.get("fillCount") or 0)
                    px = float(o.get("avgFill") or 0)
                    fee = float((o.get("resp") or {}).get("average_fee_paid") or 0) * n
                    rec = out[c]
                    rec["fees"] += fee
                    if o.get("side") == "bid":
                        rec["cash"] -= n * px + fee
                        rec["buys"] += n * px
                        if (o.get("plan") or {}).get("action") == "open":
                            rec["opens"] += 1
                    elif o.get("side") == "ask":
                        rec["cash"] += n * px - fee
                        rec["sells"] += n * px
                        if (o.get("plan") or {}).get("action") == "roll":
                            rec["rolls"] += 1
        except OSError:
            continue
    return dict(out)


def wx_tape_path(city_key: str, day: str) -> Path | None:
    name = f"{fk(city_key)}-weather-{day.lower()}-monitor.jsonl"
    best = None
    for d in WX_DIRS:
        for cand in (d / name, d / (name + ".gz")):
            if cand.exists() and (best is None or cand.stat().st_size > best.stat().st_size):
                best = cand
    return best


def got_tape_path(city_key: str, day: str) -> Path | None:
    name = f"{fk(city_key)}-diurnal-got-{day.lower()}-monitor.jsonl"
    for cand in (GOT_DIR / name, GOT_DIR / (name + ".gz")):
        if cand.exists():
            return cand
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--day", default="26AUG13")
    ap.add_argument("--poll-ms", type=int, default=2000,
                    help="emulate daemon poll cadence (0 = process every row)")
    args = ap.parse_args()
    day = args.day.upper()

    live = load_live_orders(day)
    opts = ExecOpts()

    print(f"Exec-sim validation vs live fills @ {day}")
    print(
        f"{'city':>8} | {'simCash':>8} {'liveCash':>9} {'d':>6} | "
        f"{'simFee':>7} {'liveFee':>8} | {'simRolls':>8} {'liveRolls':>9} | note"
    )
    print("-" * 100)
    tot_sim = tot_live = 0.0
    for city_key in list_cities():
        gt = got_tape_path(city_key, day)
        wx = wx_tape_path(city_key, day)
        lv = live.get(city_key)
        if gt is None or wx is None:
            print(f"{city_key:>8} | missing tapes (got={bool(gt)}, wx={bool(wx)})")
            continue
        city = get_city(city_key)
        stream = got_stream_from_tape(gt, poll_ms=args.poll_ms)
        books = BookTape.from_weather_tape(wx, city.daily_series)
        tape = _parse_tape(wx)
        settle = _settle_temp_f(tape, tape.get("preds") or [])
        r = simulate_exec_roll(stream, books, city.daily_series, day, settle, opts)
        lv_cash = lv["cash"] if lv else 0.0
        lv_fee = lv["fees"] if lv else 0.0
        lv_rolls = lv["rolls"] if lv else 0
        tot_sim += r.cash
        tot_live += lv_cash
        note = (
            f"held {r.held_bin}×{r.held_contracts:.0f}@{r.avg_entry:.2f} "
            f"settle={settle if settle is not None else '?'} won={r.won}"
        )
        print(
            f"{city_key:>8} | {r.cash:8.2f} {lv_cash:9.2f} {r.cash - lv_cash:+6.2f} | "
            f"{r.fees:7.2f} {lv_fee:8.2f} | {r.rolls:8d} {lv_rolls:9d} | {note}"
        )
    print("-" * 100)
    print(f"{'TOTAL':>8} | {tot_sim:8.2f} {tot_live:9.2f} {tot_sim - tot_live:+6.2f}")
    print()
    print("cash = all fills incl fees, before settlement. Sim uses deployed daemon defaults.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
