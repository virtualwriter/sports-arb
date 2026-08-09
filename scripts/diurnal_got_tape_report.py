#!/usr/bin/env python3
"""Offline shadow replay: GOT diurnal vs live predictor peak on monitor tapes.

Does not change live routing — scores how the parallel stream would have
called the day's high vs the existing model, using Synoptic prints + the
tape's forecast_peak_* as NWP seeds.

Usage:
  PYTHONPATH=scripts python3 scripts/diurnal_got_tape_report.py --day 26AUG08
  PYTHONPATH=scripts python3 scripts/diurnal_got_tape_report.py --day 26AUG08 --city austin
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.diurnal_got import DiurnalGotTracker
from lib.weather_cities import get_city, list_cities
from lib.weather_hourly_hedge_filter import default_tape_path, _settle_temp_f, _parse_tape


def replay_city(city_key: str, day: str) -> dict | None:
    city = get_city(city_key)
    path = default_tape_path(city_key, day)
    if not path.exists():
        # monitor filenames use city.key (austin/miami/la) or chi
        alt = Path(f".tmp/{city.key}-weather-{day.lower()}-monitor.jsonl")
        path = alt if alt.exists() else path
    if not path.exists():
        return None

    tape = _parse_tape(path)
    preds = tape.get("preds") or []
    temps = tape.get("temps") or []
    if not preds and not temps:
        return None

    tz = ZoneInfo(city.local_tz)
    got = DiurnalGotTracker(lat=city.lat, lon=city.lon, local_tz=city.local_tz)

    # Seed from first prediction row that has NWP peak.
    seeded = False
    live_final = None
    diurnal_final = None
    path_live: list[int] = []
    path_got: list[int] = []

    # Merge synoptic temps + prediction timestamps chronologically.
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

        # prediction row
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

        if seeded:
            recv = ev.get("recv")
            try:
                now = datetime.fromisoformat(str(recv).replace("Z", "+00:00")).astimezone(tz)
            except (TypeError, ValueError):
                continue
            snap = got.snapshot(now, floor_f=ev.get("floor_f"))
            g = snap.get("predicted_high_f")
            if g is not None:
                if not path_got or path_got[-1] != g:
                    path_got.append(int(g))
                diurnal_final = int(g)

    settle = _settle_temp_f(tape, preds)
    settle_i = int(round(settle)) if settle is not None else None

    def err(pred: int | None) -> int | None:
        if pred is None or settle_i is None:
            return None
        return abs(pred - settle_i)

    return {
        "city": city.key,
        "day": day,
        "settle_f": settle,
        "live_final": live_final,
        "diurnal_final": diurnal_final,
        "live_err": err(live_final),
        "diurnal_err": err(diurnal_final),
        "live_path": path_live,
        "diurnal_path": path_got,
        "seeded": seeded,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--day", required=True)
    ap.add_argument("--city", action="append", dest="cities")
    args = ap.parse_args()
    cities = args.cities or list_cities()
    print(f"Diurnal GOT shadow replay @ {args.day}")
    print(f"{'City':<8} {'Settle':>7} {'Live':>6} {'GOT':>6} {'|L|':>5} {'|G|':>5}  paths")
    print("-" * 72)
    for key in cities:
        r = replay_city(key, args.day)
        if not r:
            print(f"{key:<8} (no tape)")
            continue
        settle = f"{r['settle_f']:.0f}°" if r["settle_f"] is not None else "—"
        print(
            f"{r['city']:<8} {settle:>7} "
            f"{str(r['live_final'] or '—'):>6} {str(r['diurnal_final'] or '—'):>6} "
            f"{str(r['live_err'] if r['live_err'] is not None else '—'):>5} "
            f"{str(r['diurnal_err'] if r['diurnal_err'] is not None else '—'):>5}  "
            f"L:{'→'.join(map(str, r['live_path'][-6:]))}  "
            f"G:{'→'.join(map(str, r['diurnal_path'][-6:]))}"
        )


if __name__ == "__main__":
    main()
