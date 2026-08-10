#!/usr/bin/env python3
"""Offline shadow replay: GOT diurnal vs live predictor peak on monitor tapes.

Scores two things separately:
  1) Peak skill — final °F error, path MAE, bin hit vs settle
  2) Research roll P&L — $DAILY_STAKE rolls @ same-row mid (≥ MIN_BUY_MID)

Does not change live routing.

Usage:
  PYTHONPATH=scripts python3 scripts/diurnal_got_tape_report.py --day 26AUG08
  PYTHONPATH=scripts python3 scripts/diurnal_got_tape_report.py --day 26AUG08 --city austin
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.diurnal_got import DiurnalGotTracker
from lib.weather_cities import get_city, list_cities
from lib.weather_hourly_hedge_filter import (
    MIN_BUY_MID,
    _parse_tape,
    _settle_temp_f,
    bin_contains,
    bin_for_temp,
    default_tape_path,
    simulate_roll_policy,
)


def _tape_path(city_key: str, day: str) -> Path | None:
    city = get_city(city_key)
    path = default_tape_path(city_key, day)
    if path.exists():
        return path
    alt = Path(f".tmp/{city.key}-weather-{day.lower()}-monitor.jsonl")
    return alt if alt.exists() else None


def _path_mae(path_f: list[int], settle_i: int | None) -> float | None:
    if settle_i is None or not path_f:
        return None
    return sum(abs(x - settle_i) for x in path_f) / len(path_f)


def _path_flips_f(path_f: list[int]) -> int:
    if len(path_f) < 2:
        return 0
    return sum(1 for a, b in zip(path_f, path_f[1:]) if a != b)


def replay_city(city_key: str, day: str) -> dict | None:
    city = get_city(city_key)
    path = _tape_path(city_key, day)
    if path is None:
        return None

    tape = _parse_tape(path)
    preds = tape.get("preds") or []
    temps = tape.get("temps") or []
    if not preds and not temps:
        return None

    tz = ZoneInfo(city.local_tz)
    got = DiurnalGotTracker(lat=city.lat, lon=city.lon, local_tz=city.local_tz)

    seeded = False
    live_final = None
    diurnal_final = None
    path_live: list[int] = []
    path_got: list[int] = []
    live_bin_stream: list[dict] = []
    got_bin_stream: list[dict] = []

    events: list[tuple[str, dict]] = []
    for r in temps:
        if r.get("source") not in ("synoptic_1m", "synoptic_station"):
            continue
        events.append((r.get("obs_ts") or r.get("recv") or "", {"kind": "temp", **r}))
    for r in preds:
        events.append((r.get("recv") or "", {"kind": "pred", **r}))
    events.sort(key=lambda x: x[0])

    for _, ev in events:
        if ev["kind"] == "temp":
            ts = ev.get("obs_ts") or ev.get("recv")
            if not ts:
                continue
            try:
                dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
            except ValueError:
                continue
            tenths = ev.get("tenths_f")
            if tenths is None:
                tenths = ev.get("temp_f_precise")
            if tenths is None:
                tenths = ev.get("temp_f")
            if tenths is None:
                continue
            got.on_obs(dt, float(tenths))
            continue

        if not seeded and ev.get("forecast_peak_f") is not None:
            recv = ev.get("recv")
            try:
                now = datetime.fromisoformat(str(recv).replace("Z", "+00:00")).astimezone(tz)
            except (TypeError, ValueError):
                now = datetime.now(tz)
            got.init_from_nwp(
                now_local=now,
                tmax_f=float(ev["forecast_peak_f"]),
                tmin_f=None,
                tm_hour=float(ev["forecast_peak_hour"])
                if ev.get("forecast_peak_hour") is not None
                else None,
            )
            seeded = True

        live = ev.get("predicted_high_f")
        if live is not None:
            live_i = int(live)
            if not path_live or path_live[-1] != live_i:
                path_live.append(live_i)
            live_final = live_i

        di = ev.get("daily_implied") or {}
        labels = list(di.keys())
        live_bin = ev.get("bin")
        if live_bin:
            live_bin_stream.append(
                {"recv": ev.get("recv"), "bin": live_bin, "daily_implied": di}
            )

        if seeded:
            recv = ev.get("recv")
            try:
                now = datetime.fromisoformat(str(recv).replace("Z", "+00:00")).astimezone(tz)
            except (TypeError, ValueError):
                continue
            snap = got.snapshot(now, floor_f=ev.get("floor_f"))
            g = snap.get("predicted_high_f")
            if g is not None:
                g_i = int(g)
                if not path_got or path_got[-1] != g_i:
                    path_got.append(g_i)
                diurnal_final = g_i
                g_bin = bin_for_temp(g_i, labels)
                if g_bin:
                    got_bin_stream.append(
                        {"recv": recv, "bin": g_bin, "daily_implied": di}
                    )

    settle = _settle_temp_f(tape, preds)
    settle_i = int(round(settle)) if settle is not None else None

    def err(pred: int | None) -> int | None:
        if pred is None or settle_i is None:
            return None
        return abs(pred - settle_i)

    def bin_hit(final_f: int | None, stream: list[dict]) -> bool | None:
        if settle_i is None or not stream:
            return None
        held = stream[-1].get("bin")
        if not held:
            return None
        return bin_contains(held, settle_i)

    live_roll = simulate_roll_policy(
        live_bin_stream, settle, mode="model", min_buy_mid=MIN_BUY_MID
    )
    got_roll = simulate_roll_policy(
        got_bin_stream, settle, mode="model", min_buy_mid=MIN_BUY_MID
    )

    return {
        "city": city.key,
        "day": day,
        "settle_f": settle,
        "live_final": live_final,
        "diurnal_final": diurnal_final,
        "live_err": err(live_final),
        "diurnal_err": err(diurnal_final),
        "live_path_mae": _path_mae(path_live, settle_i),
        "diurnal_path_mae": _path_mae(path_got, settle_i),
        "live_flips": _path_flips_f(path_live),
        "diurnal_flips": _path_flips_f(path_got),
        "live_bin_hit": bin_hit(live_final, live_bin_stream),
        "diurnal_bin_hit": bin_hit(diurnal_final, got_bin_stream),
        "live_path": path_live,
        "diurnal_path": path_got,
        "live_bin_path": live_roll.path,
        "diurnal_bin_path": got_roll.path,
        "live_pnl": live_roll.pnl,
        "diurnal_pnl": got_roll.pnl,
        "live_won": live_roll.won,
        "diurnal_won": got_roll.won,
        "seeded": seeded,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--day", required=True)
    ap.add_argument("--city", action="append", dest="cities")
    args = ap.parse_args()
    cities = args.cities or list_cities()

    print(f"Diurnal GOT shadow @ {args.day}")
    print(f"Research roll = min_buy≥{MIN_BUY_MID:.0%} @ same-row mid (uncapped size)")
    print(
        f"{'City':<8} {'Set':>4} {'Live':>5} {'GOT':>5} "
        f"{'|L|':>3} {'|G|':>3} {'Lmae':>5} {'Gmae':>5} "
        f"{'Lhit':>4} {'Ghit':>4}  "
        f"{'L$':>7} {'G$':>7}"
    )
    print("-" * 78)

    tot = {
        "live_err": 0,
        "got_err": 0,
        "live_hit": 0,
        "got_hit": 0,
        "n": 0,
        "live_pnl": 0.0,
        "got_pnl": 0.0,
    }

    for key in cities:
        r = replay_city(key, args.day)
        if not r:
            print(f"{key:<8} (no tape)")
            continue
        settle = f"{r['settle_f']:.0f}" if r["settle_f"] is not None else "—"
        lmae = f"{r['live_path_mae']:.1f}" if r["live_path_mae"] is not None else "—"
        gmae = f"{r['diurnal_path_mae']:.1f}" if r["diurnal_path_mae"] is not None else "—"
        lhit = (
            "Y"
            if r["live_bin_hit"] is True
            else ("N" if r["live_bin_hit"] is False else "—")
        )
        ghit = (
            "Y"
            if r["diurnal_bin_hit"] is True
            else ("N" if r["diurnal_bin_hit"] is False else "—")
        )
        print(
            f"{r['city']:<8} {settle:>4} "
            f"{str(r['live_final'] or '—'):>5} {str(r['diurnal_final'] or '—'):>5} "
            f"{str(r['live_err'] if r['live_err'] is not None else '—'):>3} "
            f"{str(r['diurnal_err'] if r['diurnal_err'] is not None else '—'):>3} "
            f"{lmae:>5} {gmae:>5} {lhit:>4} {ghit:>4}  "
            f"{r['live_pnl']:>+7.0f} {r['diurnal_pnl']:>+7.0f}"
        )
        print(
            f"         bins L:{'→'.join(r['live_bin_path'][-5:]) or '—'}  "
            f"G:{'→'.join(r['diurnal_bin_path'][-5:]) or '—'}  "
            f"°F L:{'→'.join(map(str, r['live_path'][-6:]))}  "
            f"G:{'→'.join(map(str, r['diurnal_path'][-6:]))}"
        )
        if r["live_err"] is not None and r["diurnal_err"] is not None:
            tot["n"] += 1
            tot["live_err"] += r["live_err"]
            tot["got_err"] += r["diurnal_err"]
            tot["live_hit"] += 1 if r["live_bin_hit"] else 0
            tot["got_hit"] += 1 if r["diurnal_bin_hit"] else 0
            tot["live_pnl"] += r["live_pnl"]
            tot["got_pnl"] += r["diurnal_pnl"]

    if tot["n"]:
        print("-" * 78)
        print(
            f"{'TOTAL':<8} n={tot['n']}  "
            f"MAE L={tot['live_err']/tot['n']:.2f} G={tot['got_err']/tot['n']:.2f}  "
            f"hits L={tot['live_hit']}/{tot['n']} G={tot['got_hit']}/{tot['n']}  "
            f"Σ$ L={tot['live_pnl']:+.0f} G={tot['got_pnl']:+.0f}"
        )


if __name__ == "__main__":
    main()
