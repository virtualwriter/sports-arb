"""GOT-style piecewise diurnal temperature model (separate process / tape).

Göttsche & Olesen family:
  Daytime:  T(t) = T0 + Ta * cos(π/ω * (t - tm))
  dT/dt:    -Ta * (π/ω) * sin(π/ω * (t - tm))   [°F / hour]
  Night:    exponential decay after free-attenuation time ts
            (trough targeting comes next; peak is locked once vertex is in)

Smoothing: Stage B refits (T0, Ta, tm) by least squares to recent Synoptic
points — not an arbitrary EMA on peak height. Peak = T0 + Ta from that fit.
NWP only seeds the morning prior. Emitted market bins apply a 1°F edge
hold-band (sticky_bin_for_peak) so sub-degree LS wobble does not thrash
adjacent Kalshi buckets.

Runs via scripts/monitor_city_diurnal_got.py (own tape). Does not live inside
the active DailyHighPredictor and does not drive live bins / book_aware.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

MIN_OMEGA_HR = 8.0
MAX_OMEGA_HR = 16.0
# Fit window and tm search.
FIT_WINDOW_HR = 4.0
MIN_FIT_POINTS = 8
TM_GRID_STEP_HR = 0.25
TM_PRIOR_WEIGHT = 0.15  # mild pull of tm toward NWP/current prior (hours² in SSE)
# After this many Synoptic updates, ignore NWP peak re-seeds for height.
NWP_PEAK_LOCKOUT_UPDATES = 3
# Discrete Kalshi bins are ~2°F wide; LS peak wobble of <1°F near an edge
# should not thrash the emitted bin (research rolls / path). Peak °F itself
# stays unsmoothed — only the bin mapping is sticky.
BIN_HOLD_F = 1.0


def sticky_bin_for_peak(
    peak_f: float | None,
    labels: list[str] | tuple[str, ...] | None,
    held_bin: str | None,
    *,
    hold_f: float = BIN_HOLD_F,
) -> tuple[str | None, str | None]:
    """Map peak → bin with an edge deadband so adjacent-bin chatter is filtered.

    Returns ``(sticky_bin, raw_bin)``. Stays on ``held_bin`` until continuous
    peak clears the held interval by ``hold_f`` °F (default 1°F). Floor/obs
    ratchets that push peak clearly into the next bucket still flip.
    """
    # Local import avoids a hard cycle at module load with hedge helpers.
    from lib.weather_hourly_hedge_filter import bin_for_temp, bin_hi, bin_lo

    if peak_f is None:
        return held_bin, None
    raw = bin_for_temp(float(peak_f), labels)
    if held_bin is None:
        return raw, raw
    if raw is None:
        return held_bin, None
    if raw == held_bin:
        return held_bin, raw
    # Held bin gone from strip (market reshaped) → accept raw.
    if labels and held_bin not in labels:
        return raw, raw

    lo, hi = bin_lo(held_bin), bin_hi(held_bin)
    if lo is None or hi is None:
        return raw, raw

    peak = float(peak_f)
    band = max(0.0, float(hold_f))
    # Open-ended low (e.g. <=88): only leave upward past hi + band.
    if lo == -999:
        if peak > hi + band:
            return raw, raw
        return held_bin, raw
    # Open-ended high (>=N / N+): only leave downward past lo - band.
    if held_bin.startswith(">=") or held_bin.endswith("+"):
        if peak < lo - band:
            return raw, raw
        return held_bin, raw
    # Closed 2° bucket: leave only when peak clears either edge by band.
    if peak > hi + band or peak < lo - band:
        return raw, raw
    return held_bin, raw


def day_length_hours(lat_deg: float, on: date) -> float:
    """Approximate sunrise→sunset length (hours) from lat + day-of-year."""
    doy = on.timetuple().tm_yday
    decl = math.radians(23.45 * math.sin(math.radians(360.0 / 365.0 * (doy - 81))))
    lat = math.radians(lat_deg)
    cos_ha = -math.tan(lat) * math.tan(decl)
    cos_ha = max(-1.0, min(1.0, cos_ha))
    ha = math.acos(cos_ha)
    return max(MIN_OMEGA_HR, min(MAX_OMEGA_HR, 2.0 * math.degrees(ha) / 15.0))


def _local_hour(dt_utc: datetime, tz: ZoneInfo) -> float:
    local = dt_utc.astimezone(tz)
    return local.hour + local.minute / 60.0 + local.second / 3600.0


def fit_daytime_cosine(
    samples: list[tuple[float, float]],
    *,
    omega: float,
    tm_prior: float,
    tm_lo: float,
    tm_hi: float,
) -> tuple[float, float, float, float] | None:
    """Least-squares fit T0, Ta for each tm on a grid; pick best SSE.

    Model: T(t) = T0 + Ta * cos(π/ω * (t - tm))
    Returns (T0, Ta, tm, sse) or None if under-determined.
    """
    if len(samples) < MIN_FIT_POINTS:
        return None
    omega = max(MIN_OMEGA_HR, float(omega))
    best: tuple[float, float, float, float] | None = None  # T0, Ta, tm, sse

    tm = tm_lo
    while tm <= tm_hi + 1e-9:
        cs = [math.cos(math.pi / omega * (t - tm)) for t, _ in samples]
        ys = [y for _, y in samples]
        n = len(samples)
        sum_c = sum(cs)
        sum_y = sum(ys)
        sum_c2 = sum(c * c for c in cs)
        sum_cy = sum(c * y for c, y in zip(cs, ys))
        # Normal equations for [T0, Ta]
        det = n * sum_c2 - sum_c * sum_c
        if abs(det) < 1e-8:
            tm += TM_GRID_STEP_HR
            continue
        T0 = (sum_y * sum_c2 - sum_c * sum_cy) / det
        Ta = (n * sum_cy - sum_c * sum_y) / det
        if Ta < 0.25:
            # Degenerate / inverted amplitude — skip
            tm += TM_GRID_STEP_HR
            continue
        sse = 0.0
        for c, y in zip(cs, ys):
            err = y - (T0 + Ta * c)
            sse += err * err
        # Mild prior: prefer tm near NWP/current guess (smooth day-to-day).
        sse += TM_PRIOR_WEIGHT * (tm - tm_prior) ** 2 * n
        if best is None or sse < best[3]:
            best = (T0, Ta, tm, sse)
        tm += TM_GRID_STEP_HR
    return best


@dataclass
class DiurnalParams:
    T0: float
    Ta: float
    tm_hour: float  # local fractional hour of vertex
    omega: float  # daylight half-wave width (hours) ≈ day length
    ts_hour: float  # start of free attenuation (local hour)
    k: float  # nighttime cooling constant (hours)
    delta_T: float = 0.0
    tmin_f: float | None = None
    tmax_f: float | None = None  # fitted / locked peak
    nwp_tmax_f: float | None = None
    nwp_tm_hour: float | None = None

    def as_public(self) -> dict[str, Any]:
        d = asdict(self)
        for k, v in list(d.items()):
            if isinstance(v, float):
                d[k] = round(v, 3)
        return d


class DiurnalGotTracker:
    """Per-city shadow diurnal curve: NWP morning seed, LS-smoothed Synoptic fit."""

    def __init__(self, *, lat: float, lon: float, local_tz: str) -> None:
        self.lat = lat
        self.lon = lon
        self.tz = ZoneInfo(local_tz)
        self.params: DiurnalParams | None = None
        self.day: date | None = None
        self._obs: list[tuple[datetime, float]] = []  # UTC, °F
        self._n_updates = 0
        self._obs_high_f: float | None = None
        self._vertex_locked = False
        self.last_rate_obs: float | None = None
        self.last_rate_model: float | None = None
        self.last_residual_f: float | None = None
        self.last_peak_method: str | None = None
        self.last_fit_sse: float | None = None
        self.last_fit_n: int = 0

    def reset_if_new_day(self, now_local: datetime) -> None:
        d = now_local.date()
        if self.day is not None and d != self.day:
            self.params = None
            self._obs.clear()
            self._n_updates = 0
            self._obs_high_f = None
            self._vertex_locked = False
            self.last_rate_obs = None
            self.last_rate_model = None
            self.last_residual_f = None
            self.last_peak_method = None
            self.last_fit_sse = None
            self.last_fit_n = 0
        self.day = d

    def init_from_nwp(
        self,
        *,
        now_local: datetime,
        tmax_f: float | None,
        tmin_f: float | None,
        tm_hour: float | None,
    ) -> None:
        """Stage A: morning prior from NWP max/min + first-guess peak time."""
        self.reset_if_new_day(now_local)
        if tmax_f is None:
            return
        tmax = float(tmax_f)
        if tmin_f is None:
            tmin = tmax - 20.0
        else:
            tmin = float(tmin_f)
        if tmin > tmax:
            tmin, tmax = tmax, tmin

        omega = day_length_hours(self.lat, now_local.date())
        if tm_hour is None:
            tm = 14.0
        else:
            tm = float(tm_hour) + 0.5

        Ta = max(0.5, (tmax - tmin) / 2.0)
        T0 = tmax - Ta
        sunrise = 12.0 - omega / 2.0
        sunset = sunrise + omega
        ts = max(tm + 0.5, sunset - 0.25)
        k = max(1.0, (sunset + 2.0 - ts))

        new = DiurnalParams(
            T0=T0,
            Ta=Ta,
            tm_hour=tm,
            omega=omega,
            ts_hour=ts,
            k=k,
            delta_T=0.0,
            tmin_f=tmin,
            tmax_f=tmax,
            nwp_tmax_f=tmax,
            nwp_tm_hour=tm,
        )
        if self.params is None or self._n_updates == 0:
            self.params = new
            self.last_peak_method = "nwp_prior"
            return

        # Later refreshes: geometry + NWP priors only — never overwrite fitted peak
        # once Synoptic LS has taken over (unless still in lockout warmup).
        self.params.nwp_tmax_f = tmax
        self.params.nwp_tm_hour = tm
        self.params.omega = omega
        self.params.ts_hour = ts
        self.params.tmin_f = tmin
        if self._n_updates < NWP_PEAK_LOCKOUT_UPDATES and not self._vertex_locked:
            # Warmup: gentle blend of prior into fit
            self.params.tm_hour = 0.7 * self.params.tm_hour + 0.3 * tm
            if self.params.tmax_f is None:
                self.params.tmax_f = tmax
            self.params.T0 = (self.params.tmax_f) - self.params.Ta
        else:
            # Keep fitted peak; only soft-nudge tm toward new NWP timing.
            self.params.tm_hour = 0.9 * self.params.tm_hour + 0.1 * tm

    def on_obs(self, obs_ts_utc: datetime, temp_f: float) -> None:
        """Stage B: Synoptic point → LS refit of daytime cosine (smooth peak)."""
        if obs_ts_utc.tzinfo is None:
            return
        local = obs_ts_utc.astimezone(self.tz)
        self.reset_if_new_day(local)
        T = float(temp_f)
        self._obs.append((obs_ts_utc, T))
        if len(self._obs) > 1600:
            self._obs = self._obs[-1600:]
        self._obs_high_f = T if self._obs_high_f is None else max(self._obs_high_f, T)

        if self.params is None:
            self.init_from_nwp(
                now_local=local,
                tmax_f=T + 5.0,
                tmin_f=T - 5.0,
                tm_hour=14.0,
            )
            if self.params is None:
                return

        t_hr = _local_hour(obs_ts_utc, self.tz)
        T_model = self.temperature(t_hr)
        self.last_residual_f = T - T_model if T_model is not None else None
        self.last_rate_obs = self._empirical_rate_f_per_hr(obs_ts_utc)
        self.last_rate_model = self.rate(t_hr)

        # Past free-attenuation / locked vertex: high is obs floor; trough later.
        if self._vertex_locked or t_hr >= self.params.ts_hour:
            self._lock_peak_to_obs_high("post_peak_floor")
            self._n_updates += 1
            return

        # Detect vertex from sustained non-positive slope after mid-morning.
        if (
            self.last_rate_obs is not None
            and self.last_rate_obs <= 0.05
            and t_hr >= 10.0
            and (self._obs_high_f or T) >= (self.params.tmax_f or T) - 1.5
        ):
            self._vertex_locked = True
            self.params.tm_hour = min(self.params.tm_hour, t_hr)
            self._lock_peak_to_obs_high("vertex_lock")
            self._n_updates += 1
            return

        fitted = self._refit_from_synoptic(obs_ts_utc)
        if fitted:
            T0, Ta, tm, sse = fitted
            peak = T0 + Ta
            # Physical clamps
            peak = max(peak, self._obs_high_f or T)
            if self.params.nwp_tmax_f is not None:
                peak = min(peak, float(self.params.nwp_tmax_f) + 2.0)
            # Re-anchor amplitude so T(tm)=peak with fitted Ta scale.
            self.params.Ta = max(0.5, Ta if Ta > 0 else (peak - (self.params.tmin_f or peak - 20)) / 2)
            self.params.T0 = peak - self.params.Ta
            self.params.tm_hour = tm
            self.params.tmax_f = peak
            self.last_fit_sse = sse
            self.last_peak_method = "ls_fit"
        elif self.last_residual_f is not None and self._n_updates < NWP_PEAK_LOCKOUT_UPDATES:
            # Sparse early data: small residual nudge only (no EMA peak thrash).
            cur = self.params.tmax_f or (self.params.T0 + self.params.Ta)
            peak = max(self._obs_high_f or T, cur + 0.25 * self.last_residual_f)
            if self.params.nwp_tmax_f is not None:
                peak = min(peak, float(self.params.nwp_tmax_f) + 2.0)
            self.params.tmax_f = peak
            self.params.T0 = peak - self.params.Ta
            self.last_peak_method = "residual_warmup"
        else:
            self.last_peak_method = "hold"

        self._n_updates += 1

    def _refit_from_synoptic(
        self, now_utc: datetime
    ) -> tuple[float, float, float, float] | None:
        assert self.params is not None
        cutoff = now_utc - timedelta(hours=FIT_WINDOW_HR)
        samples: list[tuple[float, float]] = []
        for dt, temp in self._obs:
            if dt < cutoff:
                continue
            t_hr = _local_hour(dt, self.tz)
            if t_hr >= self.params.ts_hour:
                continue
            samples.append((t_hr, temp))
        self.last_fit_n = len(samples)
        if len(samples) < MIN_FIT_POINTS:
            return None

        sunrise = 12.0 - self.params.omega / 2.0
        sunset = sunrise + self.params.omega
        tm_prior = self.params.nwp_tm_hour or self.params.tm_hour
        tm_lo = max(sunrise + 1.0, tm_prior - 2.5)
        tm_hi = min(sunset - 0.5, tm_prior + 2.5)
        # Also allow fit to follow obs if prior is stale.
        tm_lo = min(tm_lo, max(samples, key=lambda x: x[1])[0] - 0.5)
        tm_hi = max(tm_hi, min(sunset - 0.5, _local_hour(now_utc, self.tz) + 3.0))
        if tm_lo > tm_hi:
            tm_lo, tm_hi = tm_hi - 1.0, tm_hi

        return fit_daytime_cosine(
            samples,
            omega=self.params.omega,
            tm_prior=tm_prior,
            tm_lo=tm_lo,
            tm_hi=tm_hi,
        )

    def _lock_peak_to_obs_high(self, method: str) -> None:
        assert self.params is not None
        peak = self._obs_high_f
        if peak is None:
            return
        self.params.tmax_f = max(self.params.tmax_f or peak, peak)
        self.params.T0 = self.params.tmax_f - self.params.Ta
        self.last_peak_method = method

    def temperature(self, t_hr: float) -> float | None:
        p = self.params
        if p is None:
            return None
        if t_hr <= p.ts_hour:
            return p.T0 + p.Ta * math.cos(math.pi / p.omega * (t_hr - p.tm_hour))
        T_ts = p.T0 + p.Ta * math.cos(math.pi / p.omega * (p.ts_hour - p.tm_hour))
        return p.T0 + p.delta_T + (T_ts - p.T0 - p.delta_T) * math.exp(-(t_hr - p.ts_hour) / p.k)

    def rate(self, t_hr: float) -> float | None:
        p = self.params
        if p is None:
            return None
        if t_hr <= p.ts_hour:
            return -p.Ta * (math.pi / p.omega) * math.sin(math.pi / p.omega * (t_hr - p.tm_hour))
        T_ts = p.T0 + p.Ta * math.cos(math.pi / p.omega * (p.ts_hour - p.tm_hour))
        amp = T_ts - p.T0 - p.delta_T
        return -(amp / p.k) * math.exp(-(t_hr - p.ts_hour) / p.k)

    def predicted_peak(self, floor_f: float | None = None) -> tuple[float | None, float | None]:
        p = self.params
        if p is None:
            return None, None
        peak = p.tmax_f if p.tmax_f is not None else (p.T0 + p.Ta)
        if self._obs_high_f is not None:
            peak = max(peak, self._obs_high_f)
        if floor_f is not None:
            peak = max(peak, float(floor_f))
        return peak, p.tm_hour

    def snapshot(self, now_local: datetime, floor_f: float | None = None) -> dict[str, Any]:
        self.reset_if_new_day(now_local)
        t_hr = now_local.hour + now_local.minute / 60.0 + now_local.second / 3600.0
        peak_f, tm = self.predicted_peak(floor_f)
        T_now = self.temperature(t_hr)
        r_now = self.rate(t_hr)
        phase = "no_data"
        if self.params is not None:
            if self._vertex_locked or t_hr > self.params.tm_hour + 0.5:
                phase = "post_peak" if t_hr >= self.params.ts_hour or self._vertex_locked else "peak_window"
            elif t_hr < self.params.tm_hour - 0.5:
                phase = "pre_peak"
            else:
                phase = "peak_window"
        predicted_i = int(round(peak_f)) if peak_f is not None else None
        return {
            "stream": "diurnal_got",
            "predicted_high_f": predicted_i,
            "predicted_peak_f": round(peak_f, 2) if peak_f is not None else None,
            "predicted_peak_hour": round(tm, 2) if tm is not None else None,
            "peak_method": self.last_peak_method,
            "phase": phase,
            "vertex_locked": self._vertex_locked,
            "fit_sse": round(self.last_fit_sse, 2) if self.last_fit_sse is not None else None,
            "fit_n": self.last_fit_n,
            "T_model_now_f": round(T_now, 2) if T_now is not None else None,
            "dTdt_model_f_per_hr": round(r_now, 3) if r_now is not None else None,
            "dTdt_obs_f_per_hr": round(self.last_rate_obs, 3)
            if self.last_rate_obs is not None
            else None,
            "residual_f": round(self.last_residual_f, 2)
            if self.last_residual_f is not None
            else None,
            "nwp_tmax_f": round(self.params.nwp_tmax_f, 2)
            if self.params and self.params.nwp_tmax_f is not None
            else None,
            "n_obs": len(self._obs),
            "n_updates": self._n_updates,
            "params": self.params.as_public() if self.params else None,
        }

    def _empirical_rate_f_per_hr(self, now_utc: datetime) -> float | None:
        """Least-squares slope over ~60 min (vertex detection / diagnostics)."""
        cutoff = now_utc - timedelta(minutes=60)
        recent = [(dt, t) for dt, t in self._obs if dt >= cutoff]
        if len(recent) < 4:
            return None
        t0 = recent[0][0]
        xs = [(dt - t0).total_seconds() / 3600.0 for dt, _ in recent]
        ys = [t for _, t in recent]
        if xs[-1] - xs[0] < 0.25:
            return None
        n = len(xs)
        x_bar = sum(xs) / n
        y_bar = sum(ys) / n
        var_x = sum((x - x_bar) ** 2 for x in xs)
        if var_x < 1e-6:
            return None
        cov = sum((x - x_bar) * (y - y_bar) for x, y in zip(xs, ys))
        return cov / var_x
