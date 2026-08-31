#!/usr/bin/env python3
"""Daily-high paper scoreboard: live / aware / GOT rolls (+ Oleg NYC shadow).

Scores each city-day tape with simulate_roll_policy (mode=model, same-row mid,
min_buy_mid), plus two NYC-only Oleg columns:

  oleg-hold: conditioned Oleg picks its highest-probability bin at the day's
             first prediction snapshot; buy $STAKE at same-row mid, hold.
  oleg-edge: at the same snapshot, buy the bin with max (oleg_prob - mid) if
             the edge >= --oleg-edge (else pass). Hold to settle.

Oleg conditioning uses official KNYC highs strictly *before* each trade day
(no lookahead). Requires the central-park-daily-highs store.

Usage (on the VPS):
  PYTHONPATH=scripts python3 scripts/weather_paper_scoreboard.py --from 26AUG15 --to 26AUG25
  PYTHONPATH=scripts python3 scripts/weather_paper_scoreboard.py --from 26AUG15 --to 26AUG25 --oleg-sigma 2.5
"""

from __future__ import annotations

import argparse
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from lib.diurnal_got import DiurnalGotTracker
from lib.oleg import DEFAULT_HIGHS_STORE, forecast_conditioned, load_highs
from lib.weather_cities import get_city, list_cities
from lib.weather_hourly_hedge_filter import (
    MIN_BUY_MID,
    _parse_tape,
    _settle_temp_f,
    apply_book_aware_bins,
    bin_contains,
    bin_for_temp,
    preds_as_bin_stream,
    simulate_roll_policy,
)

DATA_DIRS = [
    Path("/var/lib/sports-arb/data/weather-city-monitors"),
    Path("/opt/sports-arb/.tmp"),
    Path(".tmp"),
]

_DAY_RE = re.compile(r"^26([A-Z]{3})(\d{2})$")
_MONTHS = {m.upper(): i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1
)}


def day_key_to_date(day: str) -> date:
    m = _DAY_RE.match(day.upper())
    if not m:
        raise ValueError(f"bad day key: {day}")
    return date(2026, _MONTHS[m.group(1)], int(m.group(2)))


def date_to_day_key(d: date) -> str:
    inv = {v: k for k, v in _MONTHS.items()}
    return f"26{inv[d.month]}{d.day:02d}"


def day_range(frm: str, to: str) -> list[str]:
    a, b = day_key_to_date(frm), day_key_to_date(to)
    out = []
    d = a
    while d <= b:
        out.append(date_to_day_key(d))
        d += timedelta(days=1)
    return out


def tape_path(city_key: str, day: str) -> Path | None:
    city = get_city(city_key)
    fk = "chi" if city.key == "chicago" else city.key
    name = f"{fk}-weather-{day.lower()}-monitor.jsonl"
    best = None
    for d in DATA_DIRS:
        p = d / name
        if p.exists() and (best is None or p.stat().st_size > best.stat().st_size):
            best = p
    return best


def rebuild_got(city_key: str, tape: dict) -> list[dict]:
    """Replay the GOT diurnal tracker over the tape's temps + pred mids."""
    city = get_city(city_key)
    preds = tape.get("preds") or []
    temps = tape.get("temps") or []
    tz = ZoneInfo(city.local_tz)
    got = DiurnalGotTracker(lat=city.lat, lon=city.lon, local_tz=city.local_tz)
    events: list[tuple[str, int, dict]] = []
    for r in temps:
        if r.get("source") not in ("synoptic_1m", "synoptic_station"):
            continue
        events.append((str(r.get("obs_ts") or r.get("recv") or ""), 0, r))
    for r in preds:
        events.append((str(r.get("recv") or ""), 1, r))
    events.sort(key=lambda x: (x[0], x[1]))

    seeded = False
    last_di: dict = {}
    last_floor = None
    stream: list[dict] = []

    def emit(now_local: datetime, recv: str) -> None:
        snap = got.snapshot(now_local, floor_f=last_floor)
        peak_f = snap.get("predicted_peak_f")
        if peak_f is None:
            peak_f = snap.get("predicted_high_f")
        b = bin_for_temp(float(peak_f), list(last_di)) if peak_f is not None else None
        if b:
            stream.append({"recv": recv, "bin": b, "daily_implied": dict(last_di)})

    for ts, _, ev in events:
        is_temp = ev.get("type") == "temp" or (
            ev.get("source") in ("synoptic_1m", "synoptic_station")
            and ev.get("type") != "prediction"
        )
        if is_temp:
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except ValueError:
                continue
            tenths = ev.get("tenths_f") or ev.get("temp_f_precise") or ev.get("temp_f")
            if tenths is None:
                continue
            got.on_obs(dt, float(tenths))
            if last_di:
                seeded = True
            if seeded:
                emit(dt.astimezone(tz), ts)
            continue
        di = ev.get("daily_implied") or {}
        if di:
            last_di = di
        fl = ev.get("floor_f")
        if fl is not None:
            try:
                last_floor = float(fl)
            except (TypeError, ValueError):
                pass
        recv = str(ev.get("recv") or ts)
        try:
            dt = datetime.fromisoformat(recv.replace("Z", "+00:00"))
        except ValueError:
            continue
        if last_di:
            seeded = True
            emit(dt.astimezone(tz), recv)
    return stream


def open_snapshot(preds: list[dict]) -> dict | None:
    """First prediction row with a usable daily_implied strip."""
    for p in preds:
        di = p.get("daily_implied") or {}
        if di:
            return p
    return None


def oleg_day(
    day: str,
    preds: list[dict],
    settle: float | None,
    highs: dict[date, float],
    *,
    stake: float,
    sigma: float | None,
    edge_min: float,
    min_buy_mid: float,
) -> tuple[float | None, str, float | None, str]:
    """Return (hold_pnl, hold_desc, edge_pnl, edge_desc). None pnl = no trade."""
    snap = open_snapshot(preds)
    if snap is None or settle is None:
        return None, "no_snapshot", None, "no_snapshot"
    di: dict = snap["daily_implied"]
    bins = list(di)
    d = day_key_to_date(day)
    fc = forecast_conditioned(d, {k: v for k, v in highs.items() if k < d}, sigma_f=sigma)
    probs = fc.bin_probs(bins)

    def settle_hit(b: str) -> bool:
        return bool(bin_contains(b, settle))

    # oleg-hold: highest-prob bin at open
    hold_pnl: float | None = None
    hold_bin = max(probs.items(), key=lambda kv: kv[1])[0] if probs else None
    if hold_bin is None:
        hold_desc = "no_bins"
    else:
        mid = float(di.get(hold_bin) or 0)
        if mid < min_buy_mid:
            hold_desc = f"{hold_bin} skip(mid={mid:.2f})"
        else:
            contracts = stake / mid
            hold_pnl = contracts * (1.0 if settle_hit(hold_bin) else 0.0) - stake
            hold_desc = f"{hold_bin}@{mid:.2f} p={probs[hold_bin]:.0%}"

    # oleg-edge: max (prob - mid), trade only if >= edge_min
    edge_pnl: float | None = None
    best_edge_bin, best_edge = None, -1.0
    for b in bins:
        mid = float(di.get(b) or 0)
        if mid < min_buy_mid:
            continue
        e = probs.get(b, 0.0) - mid
        if e > best_edge:
            best_edge, best_edge_bin = e, b
    if best_edge_bin is None:
        edge_desc = "no_bins"
    elif best_edge < edge_min:
        edge_desc = f"pass(best {best_edge_bin} {best_edge:+.2f})"
    else:
        mid = float(di[best_edge_bin])
        contracts = stake / mid
        edge_pnl = contracts * (1.0 if settle_hit(best_edge_bin) else 0.0) - stake
        edge_desc = f"{best_edge_bin}@{mid:.2f} edge={best_edge:+.2f}"

    return hold_pnl, hold_desc, edge_pnl, edge_desc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--from", dest="frm", required=True, help="e.g. 26AUG15")
    ap.add_argument("--to", dest="to", required=True, help="e.g. 26AUG25")
    ap.add_argument("--stake", type=float, default=20.0)
    ap.add_argument("--oleg-sigma", type=float, default=None,
                    help="override Oleg sigma (default: model's 6.67F)")
    ap.add_argument("--oleg-edge", type=float, default=0.05,
                    help="min (prob-mid) edge for oleg-edge to trade")
    ap.add_argument("--highs-store", type=Path, default=DEFAULT_HIGHS_STORE)
    args = ap.parse_args()

    days = day_range(args.frm, args.to)
    try:
        highs = load_highs(args.highs_store)
    except FileNotFoundError:
        highs = {}
        print(f"[warn] no highs store at {args.highs_store}; Oleg columns disabled")

    stake = args.stake
    print(
        f"PAPER scoreboard {args.frm}..{args.to} stake=${stake:.0f}/city "
        f"min_buy_mid={MIN_BUY_MID} oleg_sigma={args.oleg_sigma or 'model'} "
        f"oleg_edge>={args.oleg_edge}"
    )
    print("(settle = official if present else provisional obs high; Oleg = NYC only)")
    print()
    hdr = (
        f"{'day':>8} {'city':>8} {'set':>5} {'live$':>8} {'aware$':>8} {'GOT$':>8} "
        f"{'olegH$':>8} {'olegE$':>8}  oleg detail"
    )
    print(hdr)
    print("-" * len(hdr))

    tot = {k: 0.0 for k in ("live", "aware", "got", "oleg_hold", "oleg_edge")}
    n_oleg_hold = n_oleg_edge = 0
    by_day = {d: dict.fromkeys(tot, 0.0) for d in days}
    missing: list[tuple[str, str, str]] = []

    for day in days:
        for city_key in list_cities():
            p = tape_path(city_key, day)
            if not p:
                missing.append((day, city_key, "no_wx_tape"))
                continue
            tape = _parse_tape(p)
            preds = tape.get("preds") or []
            if not preds:
                missing.append((day, city_key, "no_preds"))
                continue
            settle = _settle_temp_f(tape, preds)

            live_s = preds_as_bin_stream(preds, "bin")
            aware_s = preds_as_bin_stream(apply_book_aware_bins(preds), "bin_book_aware")
            got_s = rebuild_got(city_key, tape)

            rl = simulate_roll_policy(live_s, settle, mode="model", stake=stake, min_buy_mid=MIN_BUY_MID)
            ra = simulate_roll_policy(aware_s, settle, mode="model", stake=stake, min_buy_mid=MIN_BUY_MID)
            rg = simulate_roll_policy(got_s, settle, mode="model", stake=stake, min_buy_mid=MIN_BUY_MID)
            for k, r in (("live", rl), ("aware", ra), ("got", rg)):
                tot[k] += r.pnl
                by_day[day][k] += r.pnl

            oleg_cols = f"{'':>8} {'':>8}  "
            if city_key == "nyc" and highs:
                hp, hd, ep, ed = oleg_day(
                    day, preds, settle, highs,
                    stake=stake, sigma=args.oleg_sigma,
                    edge_min=args.oleg_edge, min_buy_mid=MIN_BUY_MID,
                )
                if hp is not None:
                    tot["oleg_hold"] += hp
                    by_day[day]["oleg_hold"] += hp
                    n_oleg_hold += 1
                if ep is not None:
                    tot["oleg_edge"] += ep
                    by_day[day]["oleg_edge"] += ep
                    n_oleg_edge += 1
                hp_s = f"{hp:8.2f}" if hp is not None else f"{'—':>8}"
                ep_s = f"{ep:8.2f}" if ep is not None else f"{'—':>8}"
                oleg_cols = f"{hp_s} {ep_s}  H:{hd} E:{ed}"

            sett_s = f"{settle:.0f}" if settle is not None else "?"
            print(
                f"{day:>8} {city_key:>8} {sett_s:>5} "
                f"{rl.pnl:8.2f} {ra.pnl:8.2f} {rg.pnl:8.2f} {oleg_cols}"
            )

    print("-" * len(hdr))
    print(
        f"{'TOTAL':>8} {'':>8} {'':>5} "
        f"{tot['live']:8.2f} {tot['aware']:8.2f} {tot['got']:8.2f} "
        f"{tot['oleg_hold']:8.2f} {tot['oleg_edge']:8.2f}"
        f"  (oleg-hold n={n_oleg_hold}, oleg-edge trades={n_oleg_edge})"
    )
    print()
    print("By day:")
    print(f"{'day':>8} {'live$':>8} {'aware$':>8} {'GOT$':>8} {'olegH$':>8} {'olegE$':>8}")
    for day in days:
        d = by_day[day]
        print(
            f"{day:>8} {d['live']:8.2f} {d['aware']:8.2f} {d['got']:8.2f} "
            f"{d['oleg_hold']:8.2f} {d['oleg_edge']:8.2f}"
        )
    if missing:
        print()
        print("Missing:")
        for m in missing:
            print(" ", m)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
