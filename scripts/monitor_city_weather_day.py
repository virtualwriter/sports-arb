#!/usr/bin/env python3
"""Full-day city weather + Kalshi monitor (daily high + hourlies).

Cities: chicago, nyc, miami, austin, la — each is a separate process/entity.

Usage:
  PYTHONUNBUFFERED=1 python3 scripts/monitor_city_weather_day.py --city chicago
  PYTHONUNBUFFERED=1 python3 scripts/monitor_city_weather_day.py --city nyc --day 26AUG05

Env: SYNOPTIC_TOKEN (optional, demo token fetched if unset)

NYC only — optional human KNYC sensor:
  On-site handheld readings may be appended via scripts/nyc_human_reading.py
  (file: .tmp/nyc-human-knyc-readings.jsonl, source=human_knyc). They are
  trusted floor updates like other obs. If no human readings are provided,
  NYC continues on automated feeds alone — human data is never required.

NYC only — peak window:
  Model peak is the hour leading up to forecast_peak_hour and the hour after
  it (inclusive of the peak hour). In that window the predictor uses Kalshi
  hourly ≥-strike data (market mode), not the NWP peak alone.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.chi_high_accuracy_log import AccuracyLedger, ledger_path_for_city
from lib.chi_high_predictor import DailyHighPredictor, FLOOR_TRUSTED_SOURCES, significant_change
from lib.settlement_track import is_hourly_51, kalshi_strike_label
from lib.weather_cities import WeatherCity, get_city, list_cities
from lib.weather_feeds import (
    fetch_synoptic_token,
    make_feed_pollers,
    metar_day_max,
    settle_from_ob,
    synoptic_day_max,
)
from lib.weather_hourly_hedge_filter import BookAwareBinTracker
from lib.nyc_human_sensor import NycHumanSensorCursor

KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
UA = {"User-Agent": "city-weather-day-monitor/1.0"}


def recv_ts() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def get_json(url: str) -> dict | list:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def safe_get(url: str, tag: str) -> dict | list | None:
    try:
        return get_json(url)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            time.sleep(1.0)
        return None
    except Exception:
        return None


class Monitor:
    def __init__(
        self,
        city: WeatherCity,
        day: str,
        hours: list[int],
        out_path: str,
        hard_stop: datetime | None,
    ):
        self.city = city
        self.day = day
        self.hours = hours
        self.out_path = out_path
        self.hard_stop = hard_stop
        self.out = open(out_path, "a", buffering=1)
        # Demo-token fetch can flake (connection refused); never crash the monitor.
        try:
            self.token = fetch_synoptic_token(required=False) or ""
        except Exception as exc:
            self.token = ""
            print(f"WARN synoptic token unavailable at start: {exc}", flush=True)
        if not self.token:
            print("WARN starting without Synoptic token; METAR/NWS/TWC still run", flush=True)
        self.feed_pollers = make_feed_pollers(city)

        self.hourly_events = [f"{city.hourly_series}-{day}{h:02d}" for h in hours]
        self.daily_event = f"{city.daily_series}-{day}"

        self.seen_trades: set[str] = set()
        self.summary_hash: dict[str, str] = {}
        self.book_hash: dict[str, str] = {}
        self.feed_last: dict[str, tuple[int | None, float | None]] = {}
        self.pending: list[dict] = []
        self.hour_max: dict[str, dict] = {}
        self.day_high = {"max_f": -999, "tenths": None, "source": "", "obs_ts": ""}
        self.official_51: dict[str, dict] = {}
        self.hour_results: dict[str, dict] = {}
        self.daily_result: dict | None = None
        self.daily_book_sig = ""

        self.last_feed_poll = 0.0
        self.last_metar_poll = 0.0
        self.last_synoptic_backfill = 0.0
        self.last_metar_backfill = 0.0

        self.predictor = DailyHighPredictor(
            local_tz=city.local_tz,
            lat=city.lat,
            lon=city.lon,
            city_key=city.key,
        )
        self.last_prediction: dict | None = None
        self.last_emitted_prediction: dict | None = None
        self.cycle_milestone = False
        self._synoptic_fail_streak = 0
        self._startup_prediction_done = False
        self.accuracy = AccuracyLedger(ledger_path_for_city(city.key))
        # Dual stream: raw predictor bin + thrash/fat-book aware bin.
        self.book_aware = BookAwareBinTracker()
        # NYC-only optional on-site human KNYC sensor (no-op if file absent).
        self.nyc_human: NycHumanSensorCursor | None = (
            NycHumanSensorCursor() if city.key == "nyc" else None
        )

    def log(self, rec: dict) -> None:
        rec["recv"] = recv_ts()
        self.out.write(json.dumps(rec, separators=(",", ":")) + "\n")

    def milestone(self, msg: str, **extra) -> None:
        self.log({"type": "milestone", "msg": msg, **extra})
        print(f"MILESTONE {recv_ts()} {msg}" + (f" {json.dumps(extra)}" if extra else ""), flush=True)

    def slim_markets(self, mk: list[dict]) -> list[dict]:
        out = []
        for m in sorted(mk, key=lambda x: float(x.get("floor_strike") or 0)):
            out.append({
                "tk": m["ticker"],
                "strike": m.get("floor_strike"),
                "status": m.get("status"),
                "bid": m.get("yes_bid_dollars"),
                "ask": m.get("yes_ask_dollars"),
                "bid_sz": m.get("yes_bid_size_fp"),
                "ask_sz": m.get("yes_ask_size_fp"),
                "last": m.get("last_price_dollars"),
                "vol": m.get("volume_fp"),
                "result": m.get("result") or "",
                "exp": m.get("expiration_value") or "",
                "subtitle": m.get("yes_sub_title") or "",
            })
        return out

    def book_sig(self, slim: list[dict]) -> str:
        return "|".join(
            f"{m['strike']}:{m.get('bid')}/{m.get('ask')}" for m in slim if m.get("status") == "active"
        )

    def poll_event(self, event: str, *, series: str) -> list[dict]:
        d = safe_get(f"{KALSHI}/markets?event_ticker={event}&limit=50", "summary")
        if not d:
            return []
        mk = d.get("markets") or []
        slim = self.slim_markets(mk)
        h = hashlib.md5(json.dumps(slim).encode()).hexdigest()
        sig = self.book_sig(slim)
        prev_sig = self.summary_hash.get(f"sig:{event}", "")
        if self.summary_hash.get(event) != h:
            self.summary_hash[event] = h
            self.log({"type": "summary", "event": event, "series": series, "markets": slim, "book_sig": sig})
            if prev_sig and sig != prev_sig:
                self.log({
                    "type": "book_move",
                    "event": event,
                    "series": series,
                    "from_sig": prev_sig,
                    "to_sig": sig,
                })
                self.milestone("BOOK_MOVE", event=event, series=series)
        self.summary_hash[f"sig:{event}"] = sig

        if series == self.city.hourly_series:
            res = {m["tk"].split("-")[-1]: m["result"] for m in slim if m["result"]}
            exp = next((m["exp"] for m in slim if m["exp"]), "")
            if res and event not in self.hour_results:
                self.hour_results[event] = {"results": res, "expiration_value": exp}
                self.milestone("HOURLY_SETTLED", event=event, expiration_value=exp, results=res)
                self.cycle_milestone = True
                # Settled hourly expiration values prove a floor on the day high
                # (covers cold starts where earlier :51 prints were never seen live).
                try:
                    ev_f = float(exp)
                    self.predictor.on_metar_51(int(round(ev_f)), ev_f)
                except (TypeError, ValueError):
                    pass
        elif series == self.city.daily_series and not self.daily_result:
            res = {m["tk"].split("-")[-1]: m["result"] for m in slim if m["result"]}
            exp = next((m["exp"] for m in slim if m["exp"]), "")
            if res:
                self.daily_result = {"results": res, "expiration_value": exp}
                self.milestone("DAILY_SETTLED", event=event, expiration_value=exp, results=res)
                try:
                    self.accuracy.record_daily_result(self.day, self.daily_result, recv=recv_ts())
                    if self.last_prediction:
                        self.accuracy.record_prediction(self.day, self.last_prediction)
                    self.milestone("ACCURACY_SETTLEMENT_LOGGED", expiration_value=exp)
                except Exception as exc:
                    self.log({"type": "error", "tag": "accuracy_ledger", "err": str(exc)[:160]})

        if series == self.city.daily_series and sig != self.daily_book_sig:
            if self.daily_book_sig:
                self.log({"type": "daily_book_move", "event": event, "from": self.daily_book_sig, "to": sig})
            self.daily_book_sig = sig

        if series == self.city.daily_series:
            self.predictor.on_daily_summary(slim)
        elif series == self.city.hourly_series and event == self.active_hourly_event():
            self.predictor.on_hourly_summary(event, slim)

        return slim

    def active_tickers(self, slim: list[dict], n: int = 4) -> list[str]:
        out = []
        for m in slim:
            try:
                b = float(m.get("bid") or 0)
                a = float(m.get("ask") or 1)
                vol = float(m.get("vol") or 0)
            except (TypeError, ValueError):
                continue
            if vol > 20 or (0.03 < b and a < 0.97):
                out.append(m["tk"])
        return out[:n]

    def poll_book(self, tk: str) -> None:
        d = safe_get(f"{KALSHI}/markets/{tk}/orderbook?depth=12", "book")
        if not d:
            return
        ob = d.get("orderbook_fp") or d.get("orderbook") or {}
        h = hashlib.md5(json.dumps(ob, sort_keys=True).encode()).hexdigest()
        if self.book_hash.get(tk) != h:
            self.book_hash[tk] = h
            self.log({"type": "book", "tk": tk, "ob": ob})

    def poll_trades(self, tk: str) -> list[dict]:
        d = safe_get(f"{KALSHI}/markets/trades?ticker={tk}&limit=50", "trades")
        if not d:
            return []
        new = []
        for t in d.get("trades") or []:
            tid = t.get("trade_id")
            if tid in self.seen_trades:
                continue
            self.seen_trades.add(tid)
            row = {
                "id": tid,
                "tk": t.get("ticker"),
                "px": t.get("yes_price_dollars"),
                "n": t.get("count_fp"),
                "taker": t.get("taker_side"),
                "ct": t.get("created_time"),
            }
            new.append(row)
        if new:
            self.log({"type": "trades", "tk": tk, "new": new})
        return new

    def note_day_high(self, ob: dict) -> None:
        sf, tf = settle_from_ob(ob)
        if sf is None and ob.get("temp_f") is not None:
            sf = int(ob["temp_f"])
            tf = ob.get("temp_f_precise") or ob.get("tenths_f")
        if sf is None:
            return
        src = ob.get("source", "?")
        obs_ts = ob.get("obs_ts") or ob.get("valid_local") or ""
        trusted = src in FLOOR_TRUSTED_SOURCES or src.endswith("_backfill")
        # Tape still records TWC day-high prints, but only trusted feeds move
        # the predictor floor (TWC must be confirmed by Synoptic/METAR/NWS).
        if sf > self.day_high["max_f"] or (sf == self.day_high["max_f"] and tf and (self.day_high["tenths"] is None or tf > self.day_high["tenths"])):
            prev = dict(self.day_high)
            self.day_high = {"max_f": sf, "tenths": tf, "source": src, "obs_ts": obs_ts}
            self.log({
                "type": "day_high",
                "temp_f": sf,
                "tenths_f": tf,
                "source": src,
                "obs_ts": obs_ts,
                "trusted_floor": trusted,
                "prev_max_f": prev["max_f"] if prev["max_f"] > -900 else None,
            })
            self.milestone(
                "DAY_HIGH",
                temp_f=sf,
                tenths_f=tf,
                source=src,
                obs_ts=obs_ts,
                trusted_floor=trusted,
            )
            if trusted:
                self.predictor.on_obs_high(sf, tf if isinstance(tf, (int, float)) else None)
                self.cycle_milestone = True
            elif src == "twc":
                self.milestone(
                    "TWC_UNCONFIRMED_HIGH",
                    temp_f=sf,
                    trusted_floor_f=self.predictor.day_high_f,
                    twc_hits=self.predictor.twc_high_hits,
                )

    def note_hour_max(self, event: str, ob: dict) -> None:
        sf, tf = settle_from_ob(ob)
        if sf is None and ob.get("temp_f") is not None:
            sf = int(ob["temp_f"])
            tf = ob.get("temp_f_precise")
        if sf is None:
            return
        cur = self.hour_max.get(event, {"max_f": -999})
        if sf > cur["max_f"]:
            self.hour_max[event] = {"max_f": sf, "tenths": tf, "source": ob.get("source"), "obs_ts": ob.get("obs_ts")}
            self.log({"type": "hour_max", "event": event, "temp_f": sf, "tenths_f": tf, "source": ob.get("source")})

    def active_hourly_event(self) -> str | None:
        """Kalshi hour ticker uses Eastern clock labels, not local hour."""
        now_mkt = datetime.now(ZoneInfo(self.city.market_tz))
        return f"{self.city.hourly_series}-{self.day}{now_mkt.hour:02d}"

    def peak_hourly_event(self) -> str | None:
        """Market-tz hourly ticker for the forecast peak hour (city local)."""
        peak_local = self.predictor.forecast_peak_hour
        if peak_local is None:
            return None
        now_local = datetime.now(ZoneInfo(self.city.local_tz))
        peak_dt = now_local.replace(hour=int(peak_local) % 24, minute=0, second=0, microsecond=0)
        mkt_h = peak_dt.astimezone(ZoneInfo(self.city.market_tz)).hour
        return f"{self.city.hourly_series}-{self.day}{mkt_h:02d}"

    def kalshi_hours_to_poll(self) -> set[int]:
        """Market-tz hours for live book + forecast-peak window."""
        now_mkt = datetime.now(ZoneInfo(self.city.market_tz))
        hours = {now_mkt.hour, (now_mkt.hour - 1) % 24, (now_mkt.hour + 1) % 24}
        peak_ev = self.peak_hourly_event()
        if peak_ev:
            ph = int(peak_ev[-2:])
            hours.add(ph)
            hours.add((ph + 1) % 24)
            hours.add((ph - 1) % 24)
        return hours

    def backfill_synoptic_day_high(self) -> None:
        try:
            ob = synoptic_day_max(self.city, self.token)
        except Exception as exc:
            self.log({"type": "error", "tag": "synoptic_backfill", "err": str(exc)[:160]})
            return
        if not ob:
            self.milestone("SYNOPTIC_BACKFILL", ok=False)
            return
        sf = int(ob["temp_f"])
        tf = ob.get("temp_f_precise")
        self.note_day_high(ob)
        slope_src = "synoptic_1m" if self.city.synoptic_1m_stid else "synoptic_station"
        self.predictor.on_temp({
            "source": slope_src,
            "temp_f": sf,
            "tenths_f": tf,
            "obs_ts": ob.get("obs_ts"),
        })
        self.milestone(
            "SYNOPTIC_BACKFILL",
            ok=True,
            temp_f=sf,
            tenths_f=tf,
            obs_ts=ob.get("obs_ts"),
            n_obs=ob.get("n_obs"),
            stid=ob.get("stid"),
        )
        self.last_synoptic_backfill = time.time()

    def backfill_metar_day_high(self) -> None:
        """Raise floor from today's AWC METAR max (survives mid-day restarts)."""
        try:
            ob = metar_day_max(self.city)
        except Exception as exc:
            self.log({"type": "error", "tag": "metar_backfill", "err": str(exc)[:160]})
            return
        if not ob:
            self.milestone("METAR_BACKFILL", ok=False, icao=self.city.icao)
            return
        sf = int(ob["temp_f"])
        tf = ob.get("temp_f_precise")
        self.note_day_high(ob)
        self.predictor.on_temp({
            "source": "awc_metar_backfill",
            "temp_f": sf,
            "tenths_f": tf,
            "obs_ts": ob.get("obs_ts"),
        })
        self.milestone(
            "METAR_BACKFILL",
            ok=True,
            temp_f=sf,
            tenths_f=tf,
            obs_ts=ob.get("obs_ts"),
            n_obs=ob.get("n_obs"),
            icao=ob.get("icao") or self.city.icao,
            hours_lookback=ob.get("hours_lookback"),
        )
        self.last_metar_backfill = time.time()

    def backfill_day_highs(self) -> None:
        """Synoptic 1-min + AWC METAR day-max; METAR often settles a degree higher."""
        self.backfill_synoptic_day_high()
        self.backfill_metar_day_high()

    def poll_nyc_human(self) -> None:
        """Ingest optional on-site KNYC readings (NYC only; no-op otherwise)."""
        if self.nyc_human is None:
            return
        try:
            new = self.nyc_human.poll_new()
        except Exception as exc:
            self.log({"type": "error", "tag": "human_knyc", "err": str(exc)[:120]})
            return
        if not new:
            return
        active = self.active_hourly_event()
        for ob in new:
            self.log({"type": "temp", **ob})
            self.note_day_high(ob)
            if active:
                self.note_hour_max(active, ob)
            self.milestone(
                "HUMAN_KNYC",
                temp_f=ob.get("temp_f"),
                tenths_f=ob.get("tenths_f"),
                obs_ts=ob.get("obs_ts"),
                note=ob.get("note") or "",
            )
            self.cycle_milestone = True

    def poll_feeds(self) -> None:
        recv = recv_ts()
        active = self.active_hourly_event()
        self.poll_nyc_human()
        for name, fn in self.feed_pollers:
            try:
                ob = fn(self.token)
                if name.startswith("synoptic"):
                    self._synoptic_fail_streak = 0
            except Exception as exc:
                self.log({"type": "error", "tag": name, "err": str(exc)[:120]})
                if name.startswith("synoptic"):
                    self._synoptic_fail_streak += 1
                    if self._synoptic_fail_streak >= 3:
                        tok = fetch_synoptic_token(required=False)
                        if tok:
                            self.token = tok
                            self.milestone("SYNOPTIC_TOKEN_REFRESH", streak=self._synoptic_fail_streak)
                            self._synoptic_fail_streak = 0
                        else:
                            self.log({
                                "type": "error",
                                "tag": "synoptic_token",
                                "err": "refresh failed; continuing without Synoptic",
                            })
                            self._synoptic_fail_streak = 0
                continue
            if not ob:
                continue
            sf, tf = settle_from_ob(ob)
            if sf is None and ob.get("temp_f") is not None:
                sf = int(ob["temp_f"])
                tf = ob.get("temp_f_precise")
            if sf is None:
                continue

            prev = self.feed_last.get(name)
            changed = prev is not None and (prev[0] != sf or prev[1] != tf)
            f_changed = prev is not None and prev[0] != sf
            self.feed_last[name] = (sf, tf)

            row = {
                "type": "temp",
                "source": name,
                "obs_ts": ob.get("obs_ts") or ob.get("valid_local"),
                "temp_f": sf,
                "tenths_f": tf,
                "tgroup": ob.get("tgroup"),
                "raw": (ob.get("raw") or "")[:120],
                "active_hourly": active,
            }
            if changed:
                row["changed"] = True
                row["from_f"] = prev[0]
                row["to_f"] = sf
            self.log(row)
            self.predictor.on_temp(row)
            # Raise day high from every feed (not only METAR T-group).
            self.note_day_high(ob)
            if active:
                self.note_hour_max(active, ob)

            if name in ("awc_metar", "noaa_tgftp") and is_hourly_51(ob) and ob.get("tgroup"):
                self.official_51[active or ""] = {
                    "source": name,
                    "temp_f": sf,
                    "tenths_f": tf,
                    "obs_ts": ob.get("obs_ts"),
                    "strike": kalshi_strike_label(sf),
                }
                self.milestone("METAR_51", event=active, temp_f=sf, tenths_f=tf, source=name, strike=kalshi_strike_label(sf))
                self.predictor.on_metar_51(sf, tf)
                self.cycle_milestone = True

            if f_changed:
                self.pending.append({
                    "source": name,
                    "print_seen_ts": recv,
                    "obs_ts": ob.get("obs_ts"),
                    "f_from": prev[0] if prev else None,
                    "f_to": sf,
                    "tenths_f": tf,
                    "active_hourly": active,
                    "daily_event": self.daily_event,
                    "first_trade_ts": None,
                    "first_book_move_ts": None,
                    "first_trade": None,
                })
                self.milestone("TEMP_MOVE", source=name, f_from=prev[0] if prev else None, f_to=sf, hourly=active)

    def flush_reactions(self, book_moved_events: set[str], new_trades: list[dict]) -> None:
        recv = recv_ts()
        still = []
        for p in self.pending:
            if p["first_trade_ts"] is None and new_trades:
                t = sorted(new_trades, key=lambda x: x.get("ct") or "")[0]
                p["first_trade_ts"] = recv
                p["first_trade"] = t
                try:
                    p0 = datetime.fromisoformat(p["print_seen_ts"].replace("Z", "+00:00"))
                    p1 = datetime.fromisoformat(recv.replace("Z", "+00:00"))
                    p["trade_lag_s"] = round((p1 - p0).total_seconds(), 1)
                except Exception:
                    pass
            ev = p.get("active_hourly")
            if p["first_book_move_ts"] is None and ev and ev in book_moved_events:
                p["first_book_move_ts"] = recv
                try:
                    p0 = datetime.fromisoformat(p["print_seen_ts"].replace("Z", "+00:00"))
                    p1 = datetime.fromisoformat(recv.replace("Z", "+00:00"))
                    p["book_lag_s"] = round((p1 - p0).total_seconds(), 1)
                except Exception:
                    pass
            age = 0.0
            try:
                p0 = datetime.fromisoformat(p["print_seen_ts"].replace("Z", "+00:00"))
                p1 = datetime.now(timezone.utc)
                age = (p1 - p0).total_seconds()
            except Exception:
                pass
            if p.get("first_trade_ts") or age > 600:
                self.log({"type": "reaction", **p})
            else:
                still.append(p)
        self.pending = still

    def cycle_intervals(self) -> tuple[float, float, float]:
        utc = datetime.now(timezone.utc)
        local = utc.astimezone(ZoneInfo(self.city.local_tz))
        hm = local.hour * 60 + local.minute
        near_51 = any(abs(hm - (h * 60 + 51)) <= 8 for h in self.hours)
        # Feed interval is what matters for Synoptic/METAR freshness.
        if near_51:
            return 2.0, 5.0, 15.0
        if 11 <= local.hour <= 18:
            return 5.0, 10.0, 20.0
        return 10.0, 20.0, 45.0

    def emit_prediction(self, pred: dict, *, force: bool = False) -> None:
        aware_bin, aware_notes = self.book_aware.update(
            pred.get("bin"), pred.get("daily_implied") or {}
        )
        pred = {
            **pred,
            "bin_book_aware": aware_bin,
            "book_aware_notes": aware_notes,
        }
        should_emit = force or self.cycle_milestone or significant_change(self.last_emitted_prediction, pred)
        if should_emit:
            self.log({"type": "prediction", **pred})
            self.milestone(
                "PREDICTION",
                predicted_high_f=pred["predicted_high_f"],
                bin=pred["bin"],
                bin_book_aware=aware_bin,
                phase=pred["phase"],
                is_edge=pred["is_edge"],
                floor_f=pred.get("floor_f"),
                forecast_peak_f=pred.get("forecast_peak_f"),
            )
            if pred["is_edge"] and (
                self.last_emitted_prediction is None or not self.last_emitted_prediction.get("is_edge")
            ):
                self.milestone("EDGE_FLAG", **(pred.get("divergence") or {}), bin=pred["bin"])
            try:
                opening = not self._startup_prediction_done
                self.accuracy.record_prediction(self.day, pred, opening=opening or force)
            except Exception as exc:
                self.log({"type": "error", "tag": "accuracy_ledger", "err": str(exc)[:160]})
            self.last_emitted_prediction = pred
        self.last_prediction = pred
        self.cycle_milestone = False

    def run(self) -> None:
        self.milestone(
            "MONITOR_START",
            city=self.city.key,
            city_name=self.city.name,
            icao=self.city.icao,
            day=self.day,
            hourly=self.hourly_events,
            daily=self.daily_event,
            out=self.out_path,
            local_tz=self.city.local_tz,
            market_tz=self.city.market_tz,
        )

        # Cold start: forecast + day-max backfills so mid-day restarts keep
        # morning Synoptic / METAR peaks as the floor.
        self.predictor.maybe_refresh_forecast()
        self.backfill_day_highs()
        self.poll_event(self.daily_event, series=self.city.daily_series)
        for h in sorted(self.kalshi_hours_to_poll()):
            self.poll_event(f"{self.city.hourly_series}-{self.day}{h:02d}", series=self.city.hourly_series)
        self.poll_feeds()
        self.last_feed_poll = time.time()
        self.predictor.maybe_refresh_forecast()
        # Wire the live market-tz hourly book into the predictor.
        active = self.active_hourly_event()
        if active:
            slim = self.poll_event(active, series=self.city.hourly_series)
            self.predictor.on_hourly_summary(active, slim)
        pred0 = self.predictor.predict()
        self.emit_prediction(pred0, force=True)
        self._startup_prediction_done = True

        while True:
            t0 = time.time()
            if self.hard_stop and datetime.now(timezone.utc) >= self.hard_stop:
                self.milestone("HARD_STOP")
                break

            cycle, feed_iv, _ = self.cycle_intervals()
            book_moved: set[str] = set()
            all_new_trades: list[dict] = []

            # Daily always
            daily_slim = self.poll_event(self.daily_event, series=self.city.daily_series)
            for tk in self.active_tickers(daily_slim, n=6):
                self.poll_book(tk)
                all_new_trades.extend(self.poll_trades(tk))

            # Hourlies: market-tz live hour + forecast-peak window.
            recent_hours = self.kalshi_hours_to_poll()
            active = self.active_hourly_event()
            peak_ev = self.peak_hourly_event()
            peak_slim: list[dict] | None = None
            active_slim: list[dict] | None = None
            for event in self.hourly_events:
                h = int(event[-2:])
                if h not in recent_hours and event in self.hour_results:
                    continue
                prev_sig = self.summary_hash.get(f"sig:{event}", "")
                slim = self.poll_event(event, series=self.city.hourly_series)
                new_sig = self.summary_hash.get(f"sig:{event}", "")
                if prev_sig and new_sig != prev_sig:
                    book_moved.add(event)
                if event == active:
                    active_slim = slim
                if peak_ev and event == peak_ev:
                    peak_slim = slim
                if event in self.hour_results:
                    continue
                for tk in self.active_tickers(slim):
                    self.poll_book(tk)
                    all_new_trades.extend(self.poll_trades(tk))

            # Hourly ≥-strike book used by peak_hour phase (market mode).
            # Default: prefer forecast-peak hour while still open; else live hour.
            # NYC peak window (lead + peak + after): prefer the live hour's book
            # so those flanking hours drive on that hour's data; fall back to peak.
            implied_before = dict(self.predictor.hourly_implied)
            nyc_peak_window = False
            if self.city.key == "nyc" and self.predictor.forecast_peak_hour is not None:
                now_local_h = datetime.now(ZoneInfo(self.city.local_tz)).hour
                ph = int(self.predictor.forecast_peak_hour)
                nyc_peak_window = (ph - 1) <= now_local_h <= (ph + 1)
            if nyc_peak_window:
                if active_slim and active:
                    self.predictor.on_hourly_summary(active, active_slim)
                if self.predictor.hourly_implied == implied_before and peak_slim and peak_ev:
                    self.predictor.on_hourly_summary(peak_ev, peak_slim)
            else:
                if peak_slim and peak_ev:
                    self.predictor.on_hourly_summary(peak_ev, peak_slim)
                if self.predictor.hourly_implied == implied_before and active_slim and active:
                    self.predictor.on_hourly_summary(active, active_slim)

            if t0 - self.last_feed_poll >= feed_iv:
                self.poll_feeds()
                self.last_feed_poll = t0

            # Re-scan Synoptic + AWC METAR history so DNS/outage/restarts
            # cannot permanently miss the day's true peak.
            if t0 - self.last_synoptic_backfill >= 1800:
                self.backfill_day_highs()

            self.flush_reactions(book_moved, all_new_trades)

            self.predictor.maybe_refresh_forecast()
            pred = self.predictor.predict()
            self.emit_prediction(pred)

            if self.daily_result and all(e in self.hour_results for e in self.hourly_events[-3:]):
                self.write_summary()
                self.milestone("MONITOR_DONE")
                break

            time.sleep(max(0.3, cycle - (time.time() - t0)))

        self.out.close()

    def write_summary(self) -> None:
        summary = {
            "generated": recv_ts(),
            "city": self.city.key,
            "icao": self.city.icao,
            "day": self.day,
            "daily_event": self.daily_event,
            "day_high": self.day_high,
            "hour_results": self.hour_results,
            "daily_result": self.daily_result,
            "official_51": self.official_51,
            "hour_max": self.hour_max,
            "last_prediction": self.last_prediction,
        }
        path = self.out_path.replace(".jsonl", "-summary.json")
        with open(path, "w") as f:
            json.dump(summary, f, indent=2)
        self.milestone("SUMMARY_WRITTEN", path=path)
        try:
            if self.last_prediction:
                self.accuracy.record_prediction(self.day, self.last_prediction)
            if self.daily_result:
                self.accuracy.record_daily_result(self.day, self.daily_result, recv=recv_ts())
            self.milestone("ACCURACY_LEDGER", path=str(self.accuracy.path))
        except Exception as exc:
            self.log({"type": "error", "tag": "accuracy_ledger", "err": str(exc)[:160]})


def parse_hours(spec: str | None) -> list[int]:
    if not spec:
        return list(range(24))
    if "-" in spec:
        a, b = spec.split("-", 1)
        return list(range(int(a), int(b) + 1))
    return [int(x) for x in spec.split(",")]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--city",
        default="chicago",
        help=f"City key: {', '.join(list_cities())}",
    )
    ap.add_argument("--day", default=None, help="Kalshi day stamp e.g. 26JUL28 (default: today local)")
    ap.add_argument("--hours", default=None, help="Hour range 0-23 or 6-22")
    ap.add_argument("--out", default=None)
    ap.add_argument("--stop-after-hours", type=float, default=None, help="Stop N hours from now")
    args = ap.parse_args()

    city = get_city(args.city)
    day = args.day
    if not day:
        now_local = datetime.now(ZoneInfo(city.local_tz))
        months = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split()
        day = f"{str(now_local.year)[2:]}{months[now_local.month - 1]}{now_local.day:02d}"

    hours = parse_hours(args.hours)
    out = args.out or f".tmp/{city.key}-weather-{day.lower()}-monitor.jsonl"
    # Preserve legacy Chicago path so existing LaunchAgent/tape keep working.
    if city.key == "chicago" and args.out is None:
        out = f".tmp/chi-weather-{day.lower()}-monitor.jsonl"
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    hard_stop = None
    if args.stop_after_hours:
        hard_stop = datetime.now(timezone.utc) + timedelta(hours=args.stop_after_hours)

    mon = Monitor(city, day, hours, out, hard_stop)
    mon.run()


if __name__ == "__main__":
    main()
