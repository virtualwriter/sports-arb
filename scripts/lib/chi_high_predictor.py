"""Daily high temperature predictor for Chicago KXHIGHCHI / KXTEMPCHIH markets."""

from __future__ import annotations

import json
import re
import statistics
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from lib.diurnal_got import DiurnalGotTracker

UA = {"User-Agent": "chi-high-predictor/1.0 (research@example.edu)"}
HOURLY_STRIKE_RE = re.compile(r"(\d+)°\s+or above")
DAILY_RANGE_RE = re.compile(r"(\d+)°\s+to\s+(\d+)°")
DAILY_BELOW_RE = re.compile(r"(\d+)°\s+or below")
DAILY_ABOVE_RE = re.compile(r"(\d+)°\s+or above")

# Settlement-adjacent feeds that may raise the day-high floor.
# TWC is intentionally excluded: it leads sometimes but is not NWS CLI and
# can false-print a degree above ASOS/Synoptic (see 2026-08-04).
FLOOR_TRUSTED_SOURCES = frozenset({
    "synoptic_1m",
    "synoptic_1m_backfill",
    "synoptic_station",  # e.g. KNYC (no 1-min mesh)
    "synoptic_backfill",
    "nws_5min",
    "awc_metar",
    "awc_metar_backfill",
    "noaa_tgftp",
    "synoptic_metar",
    "human_knyc",  # optional on-site NYC handheld; NYC monitor only
})

# Refresh more often so HRRR hourly cycles can move the blended peak.
FORECAST_REFRESH_S = 3600


class DailyHighPredictor:
    def __init__(
        self,
        local_tz: str = "America/Chicago",
        lat: float = 41.786,
        lon: float = -87.752,
    ) -> None:
        self.local_tz = local_tz
        self.lat = lat
        self.lon = lon
        self.tz = ZoneInfo(local_tz)

        # Primary series kept for back-compat (NWS when available, else Open-Meteo).
        self.forecast: list[tuple[datetime, int]] = []
        self.forecast_peak_f: int | None = None
        self.forecast_peak_hour: int | None = None
        self._forecast_fetched_at: datetime | None = None
        self.forecast_error: str | None = None
        # Per-model peaks: {"nws": {"peak_f", "peak_hour", "n_hours"}, "open_meteo_hrrr": {...}}
        self.forecast_sources: dict[str, dict[str, Any]] = {}

        self.day_high_f: int | None = None
        self.day_high_tenths: float | None = None
        # TWC-only candidate high — never becomes floor until a trusted feed confirms.
        self.twc_high_f: int | None = None
        self.twc_high_hits: int = 0
        self.twc_confirmed: bool = False

        self._synoptic: deque[tuple[datetime, float]] = deque(maxlen=120)
        self.slope_f_per_hr: float | None = None

        self.hourly_implied: dict[int, float] = {}
        # Daily bins parsed from subtitles: {"lo", "hi", "label", "bid", "ask", "mid"}.
        # lo/hi are inclusive whole °F; tails use -999 / 999.
        self.daily_bins: list[dict] = []

        # Shadow GOT diurnal stream (Synoptic-honed). Does not drive live bins.
        self.diurnal = DiurnalGotTracker(lat=lat, lon=lon, local_tz=local_tz)

    def on_obs_high(self, temp_f: int, tenths_f: float | None = None) -> None:
        """Raise the observed day-high floor (Synoptic / NWS / METAR / hourly settle)."""
        try:
            if self.day_high_f is None or temp_f > self.day_high_f:
                self.day_high_f = int(temp_f)
                self.day_high_tenths = tenths_f if tenths_f is not None else float(temp_f)
            elif temp_f == self.day_high_f and tenths_f is not None:
                cur = self.day_high_tenths if self.day_high_tenths is not None else float(temp_f)
                if tenths_f > cur:
                    self.day_high_tenths = tenths_f
            self._maybe_confirm_twc(int(temp_f))
        except Exception:
            pass

    # Back-compat alias used by monitor / hourly settles.
    def on_metar_51(self, temp_f: int, tenths_f: float | None) -> None:
        self.on_obs_high(temp_f, tenths_f)

    def _maybe_confirm_twc(self, trusted_f: int) -> None:
        """Mark TWC candidate confirmed once a trusted feed reaches it."""
        if self.twc_high_f is None:
            return
        if trusted_f >= self.twc_high_f:
            self.twc_confirmed = True

    def on_temp(self, row: dict) -> None:
        try:
            source = row.get("source")
            tenths = row.get("tenths_f")
            if tenths is None:
                tenths = row.get("temp_f_precise")
            temp_f = row.get("temp_f")
            if tenths is None and temp_f is None:
                return
            precise = float(tenths) if tenths is not None else float(temp_f)
            rounded = int(temp_f) if temp_f is not None else round(precise)

            if source == "twc":
                # Lead signal only — do not raise floor until Synoptic/METAR/NWS agrees.
                if self.twc_high_f is None or rounded > self.twc_high_f:
                    self.twc_high_f = rounded
                    self.twc_high_hits = 1
                    self.twc_confirmed = False
                elif rounded == self.twc_high_f:
                    self.twc_high_hits += 1
                # If trusted floor already at/above this TWC print, treat as confirmed.
                if self.day_high_f is not None and self.day_high_f >= rounded:
                    self.twc_confirmed = True
            elif source in FLOOR_TRUSTED_SOURCES:
                self.on_obs_high(rounded, precise)

            if source in ("synoptic_1m", "synoptic_station"):
                obs_ts = row.get("obs_ts")
                if obs_ts:
                    try:
                        dt = datetime.fromisoformat(str(obs_ts).replace("Z", "+00:00"))
                    except ValueError:
                        dt = datetime.now(timezone.utc)
                else:
                    dt = datetime.now(timezone.utc)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                self._synoptic.append((dt, precise))
                self._update_slope(dt)
                try:
                    self.diurnal.on_obs(dt, precise)
                except Exception:
                    pass
        except Exception:
            pass

    def on_hourly_summary(self, event: str, slim: list[dict]) -> None:
        try:
            implied: dict[int, float] = {}
            for m in slim:
                status = m.get("status")
                if status not in ("active", "initialized", "open"):
                    continue
                strike = self._parse_hourly_strike(m)
                if strike is None:
                    continue
                mid = self._mid(m.get("bid"), m.get("ask"))
                # Empty 0/1 books are uninformative — fall back to last trade.
                if mid is not None and 0.02 < mid < 0.98:
                    implied[strike] = mid
                else:
                    last = self._parse_price(m.get("last") or m.get("last_price_dollars"))
                    if last is not None and 0.02 < last < 0.98:
                        implied[strike] = last
            if implied:
                self.hourly_implied = implied
        except Exception:
            pass

    def on_daily_summary(self, slim: list[dict]) -> None:
        try:
            bins: list[dict] = []
            for m in slim:
                if m.get("status") != "active":
                    continue
                parsed = self._parse_daily_bin(m.get("subtitle") or "")
                if parsed is None:
                    continue
                lo, hi, label = parsed
                bid = self._parse_price(m.get("bid"))
                ask = self._parse_price(m.get("ask"))
                if bid is None or ask is None:
                    continue
                bins.append({"lo": lo, "hi": hi, "label": label, "bid": bid, "ask": ask, "mid": (bid + ask) / 2})
            bins.sort(key=lambda b: b["lo"])
            self.daily_bins = bins
        except Exception:
            pass

    @staticmethod
    def _parse_daily_bin(subtitle: str) -> tuple[int, int, str] | None:
        m = DAILY_RANGE_RE.search(subtitle)
        if m:
            lo, hi = int(m.group(1)), int(m.group(2))
            return lo, hi, f"{lo}-{hi}"
        m = DAILY_BELOW_RE.search(subtitle)
        if m:
            hi = int(m.group(1))
            return -999, hi, f"<={hi}"
        m = DAILY_ABOVE_RE.search(subtitle)
        if m:
            lo = int(m.group(1))
            return lo, 999, f">={lo}"
        return None

    def maybe_refresh_forecast(self) -> None:
        now = datetime.now(timezone.utc)
        if self._forecast_fetched_at is not None:
            age = (now - self._forecast_fetched_at).total_seconds()
            if age < FORECAST_REFRESH_S:
                return

        sources: dict[str, dict[str, Any]] = {}
        errors: list[str] = []

        nws_series, nws_err = self._fetch_nws_hourly()
        if nws_series:
            peak_f, peak_hour = self._peak_from_series(nws_series, now)
            if peak_f is not None:
                sources["nws"] = {
                    "peak_f": peak_f,
                    "peak_hour": peak_hour,
                    "n_hours": len(nws_series),
                }
                self.forecast = nws_series
        elif nws_err:
            errors.append(f"nws:{nws_err}")

        om_series, om_err = self._fetch_open_meteo_hrrr()
        if om_series:
            peak_f, peak_hour = self._peak_from_series(om_series, now)
            if peak_f is not None:
                sources["open_meteo_hrrr"] = {
                    "peak_f": peak_f,
                    "peak_hour": peak_hour,
                    "n_hours": len(om_series),
                }
                if not self.forecast:
                    self.forecast = om_series
        elif om_err:
            errors.append(f"open_meteo_hrrr:{om_err}")

        self.forecast_sources = sources
        self._forecast_fetched_at = now
        if sources:
            self._blend_forecast_peaks()
            self.forecast_error = "; ".join(errors) if errors else None
            self._seed_diurnal_from_forecast(now)
        else:
            self.forecast_peak_f = None
            self.forecast_peak_hour = None
            self.forecast_error = "; ".join(errors) if errors else "no forecast sources"

    def _fetch_nws_hourly(self) -> tuple[list[tuple[datetime, int]], str | None]:
        try:
            url = f"https://api.weather.gov/points/{self.lat},{self.lon}"
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode())
            hourly_url = (data.get("properties") or {}).get("forecastHourly")
            if not hourly_url:
                return [], "no forecastHourly URL"
            req2 = urllib.request.Request(hourly_url, headers=UA)
            with urllib.request.urlopen(req2, timeout=15) as resp2:
                hourly = json.loads(resp2.read().decode())
            periods = hourly.get("properties", {}).get("periods") or []
            forecast: list[tuple[datetime, int]] = []
            for p in periods:
                start = p.get("startTime")
                temp = p.get("temperature")
                if start is None or temp is None:
                    continue
                try:
                    dt = datetime.fromisoformat(str(start))
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=self.tz)
                    forecast.append((dt, int(temp)))
                except (ValueError, TypeError):
                    continue
            return forecast, None
        except urllib.error.URLError as exc:
            return [], str(exc)[:120]
        except Exception as exc:
            return [], str(exc)[:120]

    def _fetch_open_meteo_hrrr(self) -> tuple[list[tuple[datetime, int]], str | None]:
        """NOAA HRRR via Open-Meteo GFS endpoint (HRRR blended over CONUS)."""
        try:
            qs = urllib.parse.urlencode(
                {
                    "latitude": self.lat,
                    "longitude": self.lon,
                    "hourly": "temperature_2m",
                    "temperature_unit": "fahrenheit",
                    "timezone": self.local_tz,
                    "forecast_days": 2,
                }
            )
            url = f"https://api.open-meteo.com/v1/gfs?{qs}"
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode())
            hourly = data.get("hourly") or {}
            times = hourly.get("time") or []
            temps = hourly.get("temperature_2m") or []
            forecast: list[tuple[datetime, int]] = []
            for t, temp in zip(times, temps):
                if temp is None:
                    continue
                try:
                    dt = datetime.fromisoformat(str(t))
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=self.tz)
                    else:
                        dt = dt.astimezone(self.tz)
                    forecast.append((dt, int(round(float(temp)))))
                except (ValueError, TypeError):
                    continue
            if not forecast:
                return [], "empty hourly"
            return forecast, None
        except urllib.error.URLError as exc:
            return [], str(exc)[:120]
        except Exception as exc:
            return [], str(exc)[:120]

    def _peak_from_series(
        self, series: list[tuple[datetime, int]], now_utc: datetime
    ) -> tuple[int | None, int | None]:
        today = now_utc.astimezone(self.tz).date()
        todays = [(dt, t) for dt, t in series if dt.astimezone(self.tz).date() == today]
        if not todays:
            return None, None
        peak_temp = max(t for _, t in todays)
        peak_hours = [dt.astimezone(self.tz).hour for dt, t in todays if t == peak_temp]
        return peak_temp, (min(peak_hours) if peak_hours else None)

    def _blend_forecast_peaks(self) -> None:
        """Blend NWP peaks: median °F, hour from source nearest that peak."""
        peaks = [
            (name, int(info["peak_f"]), info.get("peak_hour"))
            for name, info in self.forecast_sources.items()
            if info.get("peak_f") is not None
        ]
        if not peaks:
            self.forecast_peak_f = None
            self.forecast_peak_hour = None
            return
        vals = [p for _, p, _ in peaks]
        blended = int(round(statistics.median(vals)))
        self.forecast_peak_f = blended
        # Prefer peak hour from the source closest to the blended peak.
        best = min(peaks, key=lambda x: (abs(x[1] - blended), x[0]))
        hour = best[2]
        if hour is None:
            hours = [h for _, _, h in peaks if h is not None]
            hour = int(round(statistics.median(hours))) if hours else None
        self.forecast_peak_hour = hour

    def _tmin_from_forecast(self, now_utc: datetime) -> float | None:
        """Today's overnight/morning min from the blended forecast series."""
        if not self.forecast:
            return None
        today = now_utc.astimezone(self.tz).date()
        todays = [
            t
            for dt, t in self.forecast
            if dt.astimezone(self.tz).date() == today
        ]
        if not todays:
            return None
        return float(min(todays))

    def _seed_diurnal_from_forecast(self, now_utc: datetime) -> None:
        try:
            local = now_utc.astimezone(self.tz)
            self.diurnal.init_from_nwp(
                now_local=local,
                tmax_f=float(self.forecast_peak_f)
                if self.forecast_peak_f is not None
                else None,
                tmin_f=self._tmin_from_forecast(now_utc),
                tm_hour=float(self.forecast_peak_hour)
                if self.forecast_peak_hour is not None
                else None,
            )
        except Exception:
            pass

    def predict(self, now_utc: datetime | None = None) -> dict:
        try:
            return self._predict_impl(now_utc)
        except Exception:
            return {
                "predicted_high_f": None,
                "bin": None,
                "candidates": {},
                "phase": "no_data",
                "floor_f": self.day_high_f,
                "forecast_peak_f": self.forecast_peak_f,
                "forecast_peak_hour": self.forecast_peak_hour,
                "forecast_sources": dict(self.forecast_sources),
                "synoptic_slope_f_per_hr": None,
                "hourly_implied": {},
                "daily_implied": {},
                "divergence": None,
                "is_edge": False,
                "rationale": "prediction error",
                "forecast_error": self.forecast_error,
                "diurnal": None,
            }

    def _predict_impl(self, now_utc: datetime | None) -> dict:
        now = now_utc or datetime.now(timezone.utc)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        now_local = now.astimezone(self.tz)

        floor = self.day_high_f
        peak_hour = self.forecast_peak_hour
        peak_f = self.forecast_peak_f
        slope = self.slope_f_per_hr

        if peak_f is None and floor is None:
            return self._record(
                predicted=None,
                bin_label=None,
                candidates={},
                phase="no_data",
                floor=floor,
                slope=slope,
                rationale="no data",
                now_local=now_local,
            )

        base = peak_f if peak_f is not None else floor

        if peak_hour is None:
            phase = "peak_hour"
        elif now_local.hour < peak_hour:
            phase = "pre_peak"
        elif abs(now_local.hour - peak_hour) <= 1:
            phase = "peak_hour"
        elif now_local.hour > peak_hour + 1 and (slope is None or slope <= 0):
            phase = "post_peak"
        else:
            phase = "peak_hour"

        predicted: int | None = None
        rationale_parts: list[str] = []

        if phase == "pre_peak":
            predicted = max(floor or -999, peak_f if peak_f is not None else (floor or -999))
            # Stalling may trim forecast optimism, but never below the observed
            # day-high floor — that print is a permanent lower bound on settle.
            if (
                slope is not None
                and slope < 0.3
                and peak_hour is not None
                and (peak_hour - now_local.hour) <= 2
                and (floor is None or predicted - 1 >= floor)
            ):
                predicted -= 1
                rationale_parts.append("stalling early")
            if slope is not None and slope > 1.5:
                rationale_parts.append("rapid rise capped at forecast")
            if not rationale_parts:
                rationale_parts.append("pre-peak forecast")
        elif phase == "peak_hour":
            market_mode = self._market_mode()
            predicted = max(floor or -999, market_mode if market_mode is not None else (base or -999))
            touch = self._recent_synoptic_touch(now, floor)
            if touch is not None and predicted < touch:
                predicted = touch
                rationale_parts.append(f"synoptic touched {touch}°F")
            if market_mode is not None:
                rationale_parts.append(f"hourly mode {market_mode}°")
            else:
                rationale_parts.append("peak hour blend")
        elif phase == "post_peak":
            predicted = floor
            rationale_parts.append("post-peak locked to floor")
        else:
            predicted = base

        if predicted is None:
            return self._record(
                predicted=None,
                bin_label=None,
                candidates={},
                phase=phase,
                floor=floor,
                slope=slope,
                rationale="no data",
                now_local=now_local,
            )

        predicted = int(predicted)
        # Observed day high is monotonic: prediction cannot sit below floor.
        if floor is not None and predicted < floor:
            predicted = int(floor)
            rationale_parts.append("floor lock")

        candidates = self._candidate_bins(predicted, phase)
        bin_label = self._bin_label(predicted)
        divergence, is_edge = self._divergence(floor, phase)

        rationale = "; ".join(rationale_parts) if rationale_parts else f"predicted {predicted}°F"
        if is_edge and divergence:
            rationale += f"; edge {divergence['hourly_minus_daily_ask']:.0%} at {divergence['strike']}°"

        return self._record(
            predicted=predicted,
            bin_label=bin_label,
            candidates=candidates,
            phase=phase,
            floor=floor,
            slope=slope,
            divergence=divergence,
            is_edge=is_edge,
            rationale=rationale,
            now_local=now_local,
        )

    def _record(
        self,
        *,
        predicted: int | None,
        bin_label: str | None,
        candidates: dict[str, float],
        phase: str,
        floor: int | None,
        slope: float | None,
        divergence: dict | None = None,
        is_edge: bool = False,
        rationale: str = "",
        now_local: datetime | None = None,
    ) -> dict:
        twc_unconfirmed = None
        if (
            self.twc_high_f is not None
            and not self.twc_confirmed
            and (floor is None or self.twc_high_f > floor)
        ):
            twc_unconfirmed = self.twc_high_f
        try:
            local = now_local or datetime.now(timezone.utc).astimezone(self.tz)
            diurnal_snap = self.diurnal.snapshot(local, floor_f=floor)
        except Exception:
            diurnal_snap = None
        return {
            "predicted_high_f": predicted,
            "bin": bin_label,
            "candidates": candidates,
            "phase": phase,
            "floor_f": floor,
            "forecast_peak_f": self.forecast_peak_f,
            "forecast_peak_hour": self.forecast_peak_hour,
            "forecast_sources": {
                k: {"peak_f": v.get("peak_f"), "peak_hour": v.get("peak_hour")}
                for k, v in self.forecast_sources.items()
            },
            "synoptic_slope_f_per_hr": round(slope, 2) if slope is not None else None,
            "hourly_implied": self._filter_implied(self.hourly_implied),
            "daily_implied": self._filter_daily_bins(),
            "twc_high_f": self.twc_high_f,
            "twc_high_hits": self.twc_high_hits,
            "twc_unconfirmed_high_f": twc_unconfirmed,
            "divergence": divergence,
            "is_edge": is_edge,
            "rationale": rationale,
            "forecast_error": self.forecast_error,
            "diurnal": diurnal_snap,
        }

    def _update_slope(self, now_utc: datetime) -> None:
        cutoff = now_utc - timedelta(minutes=45)
        recent = [(dt, t) for dt, t in self._synoptic if dt >= cutoff]
        if len(recent) < 3:
            self.slope_f_per_hr = None
            return
        t0, v0 = recent[0]
        t1, v1 = recent[-1]
        hours = (t1 - t0).total_seconds() / 3600.0
        if hours <= 0:
            self.slope_f_per_hr = None
            return
        self.slope_f_per_hr = (v1 - v0) / hours

    def _parse_hourly_strike(self, m: dict) -> int | None:
        subtitle = m.get("subtitle") or ""
        match = HOURLY_STRIKE_RE.search(subtitle)
        if match:
            return int(match.group(1))
        strike = m.get("strike")
        if strike is not None:
            try:
                return int(float(strike))
            except (TypeError, ValueError):
                pass
        return None

    @staticmethod
    def _parse_price(val) -> float | None:
        if val is None:
            return None
        try:
            return float(val)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _mid(bid, ask) -> float | None:
        b = DailyHighPredictor._parse_price(bid)
        a = DailyHighPredictor._parse_price(ask)
        if b is None or a is None:
            return None
        return (b + a) / 2

    def _market_mode(self) -> int | None:
        mode: int | None = None
        for strike, mid in sorted(self.hourly_implied.items()):
            if mid >= 0.5:
                mode = strike
        return mode

    def _recent_synoptic_touch(self, now_utc: datetime, floor: int | None) -> int | None:
        cutoff = now_utc - timedelta(minutes=10)
        threshold = (floor or 0) + 1
        touched: float | None = None
        for dt, temp in self._synoptic:
            if dt >= cutoff and temp >= threshold:
                touched = max(touched or temp, temp)
        if touched is None:
            return None
        return int(touched)

    def _bin_for_temp(self, temp: int) -> dict | None:
        for b in self.daily_bins:
            if b["lo"] <= temp <= b["hi"]:
                return b
        return None

    def _bin_label(self, temp: int) -> str:
        b = self._bin_for_temp(temp)
        if b is not None:
            return b["label"]
        even_floor = temp - (temp % 2)
        return f"{even_floor}-{even_floor + 1}"

    def _candidate_bins(self, predicted: int, phase: str) -> dict[str, float]:
        center = self._bin_for_temp(predicted)
        if center is None:
            return {self._bin_label(predicted): 1.0}

        idx = self.daily_bins.index(center)
        below = self.daily_bins[idx - 1] if idx > 0 else None
        above = self.daily_bins[idx + 1] if idx + 1 < len(self.daily_bins) else None

        center_prob = 0.6
        if phase == "post_peak" or center["mid"] > 0.6:
            center_prob = 0.8
        remainder = 1.0 - center_prob

        candidates: dict[str, float] = {center["label"]: round(center_prob, 3)}
        adj = [b for b in (below, above) if b is not None]
        if adj:
            total_w = sum(b["mid"] for b in adj) or len(adj)
            for b in adj:
                candidates[b["label"]] = round(remainder * (b["mid"] / total_w), 3)
        else:
            candidates[center["label"]] = 1.0
        return candidates

    def _daily_ask_for_strike(self, strike: int) -> float | None:
        b = self._bin_for_temp(strike)
        return b["ask"] if b is not None else None

    def _divergence(self, floor: int | None, phase: str) -> tuple[dict | None, bool]:
        best_strike: int | None = None
        best_edge = 0.0
        floor_val = floor if floor is not None else -999
        for strike, hourly_mid in self.hourly_implied.items():
            if strike <= floor_val:
                continue
            daily_ask = self._daily_ask_for_strike(strike)
            if daily_ask is None:
                continue
            edge = hourly_mid - daily_ask
            if edge > best_edge:
                best_edge = edge
                best_strike = strike
        if best_strike is None or best_edge <= 0:
            return None, False
        div = {"strike": best_strike, "hourly_minus_daily_ask": round(best_edge, 3)}
        is_edge = best_edge >= 0.15 and phase in ("peak_hour", "pre_peak")
        return div, is_edge

    def _filter_implied(self, implied: dict[int, float]) -> dict[str, float]:
        if not implied:
            return {}
        filtered = {k: v for k, v in implied.items() if 0.02 < v < 0.98}
        if not filtered:
            filtered = dict(implied)
        by_mid = sorted(implied.items(), key=lambda kv: abs(kv[1] - 0.5))
        for k, v in by_mid[:2]:
            filtered[k] = v
        return {str(k): round(v, 3) for k, v in sorted(filtered.items(), key=lambda kv: int(kv[0]))}

    def _filter_daily_bins(self) -> dict[str, float]:
        if not self.daily_bins:
            return {}
        keep = [b for b in self.daily_bins if 0.02 < b["mid"] < 0.98]
        by_mid = sorted(self.daily_bins, key=lambda b: abs(b["mid"] - 0.5))
        for b in by_mid[:2]:
            if b not in keep:
                keep.append(b)
        keep.sort(key=lambda b: b["lo"])
        return {b["label"]: round(b["mid"], 3) for b in keep}


def significant_change(prev: dict | None, cur: dict) -> bool:
    if prev is None:
        return True
    if prev.get("predicted_high_f") != cur.get("predicted_high_f"):
        return True
    if prev.get("bin") != cur.get("bin"):
        return True
    if prev.get("bin_book_aware") != cur.get("bin_book_aware"):
        return True
    if prev.get("is_edge") != cur.get("is_edge"):
        return True
    # Shadow diurnal stream: emit when its peak call moves by ≥1°F.
    prev_d = (prev.get("diurnal") or {}).get("predicted_high_f")
    cur_d = (cur.get("diurnal") or {}).get("predicted_high_f")
    if prev_d != cur_d:
        return True
    prev_c = prev.get("candidates") or {}
    cur_c = cur.get("candidates") or {}
    all_bins = set(prev_c) | set(cur_c)
    for b in all_bins:
        if abs(prev_c.get(b, 0) - cur_c.get(b, 0)) > 0.10:
            return True
    return False
