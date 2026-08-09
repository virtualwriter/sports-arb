"""GOT-style piecewise diurnal temperature model (shadow / parallel stream).

Göttsche & Olesen family:
  Daytime:  T(t) = T0 + Ta * cos(π/ω * (t - tm))
  dT/dt:    -Ta * (π/ω) * sin(π/ω * (t - tm))   [°F / hour]
  Night:    exponential decay after free-attenuation time ts

Peak forecast is **slope-implied**, not locked to NWP:
  given current T and observed dT/dt, remaining rise to tm follows the
  cosine identity
      T_peak = T + r * (ω/π) * (1 - cos α) / sin α
  with α = π (tm − t) / ω.

NWP max/min + peak hour only seed the morning prior. Synoptic prints
drive the hourly peak call. Shadow-only — does not drive live bins.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

GAIN_TM_HR = 0.10  # hours per (°F/hr) rate residual vs model shape
MAX_TM_SHIFT_HR = 2.5
MIN_OMEGA_HR = 8.0
MAX_OMEGA_HR = 16.0
# Soft blend of new slope-implied peak into running estimate (per obs).
PEAK_BLEND = 0.25
# Cap noisy ASOS stair-step rates used for projection (°F/hr).
R_OBS_CAP = 3.0
# After this many Synoptic updates, ignore NWP peak re-seeds for height.
NWP_PEAK_LOCKOUT_UPDATES = 3


def day_length_hours(lat_deg: float, on: date) -> float:
    """Approximate sunrise→sunset length (hours) from lat + day-of-year."""
    doy = on.timetuple().tm_yday
    decl = math.radians(23.45 * math.sin(math.radians(360.0 / 365.0 * (doy - 81))))
    lat = math.radians(lat_deg)
    cos_ha = -math.tan(lat) * math.tan(decl)
    cos_ha = max(-1.0, min(1.0, cos_ha))
    ha = math.acos(cos_ha)
    return max(MIN_OMEGA_HR, min(MAX_OMEGA_HR, 2.0 * math.degrees(ha) / 15.0))


def slope_implied_peak(
    T_now: float,
    r_obs: float,
    *,
    hours_to_peak: float,
    omega: float,
) -> float:
    """Project T_peak from current temp + rate along a GOT cosine into tm.

    Before the vertex, r > 0 and φ = tm − t > 0:
      r = Ta (π/ω) sin(α),  T_peak − T = Ta (1 − cos α),  α = π φ / ω
      ⇒ T_peak = T + r (ω/π) (1 − cos α) / sin α
    """
    if r_obs <= 0.05:
        # Flat / falling: peak is here (or already in).
        return float(T_now)
    phi = max(0.15, float(hours_to_peak))
    omega = max(MIN_OMEGA_HR, float(omega))
    alpha = math.pi * phi / omega
    # Cap so sin(α) stays healthy (φ ≲ ~0.9 ω).
    alpha = min(alpha, math.pi * 0.85)
    sin_a = math.sin(alpha)
    if sin_a < 1e-3:
        return float(T_now)
    rise = r_obs * (omega / math.pi) * (1.0 - math.cos(alpha)) / sin_a
    # Physical cap: remaining rise in a warm-season afternoon is rarely > 15°F.
    rise = max(0.0, min(15.0, rise))
    return float(T_now) + rise


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
    # Slope-implied (or NWP-seeded) peak — NOT kept glued to NWP after updates.
    tmax_f: float | None = None
    nwp_tmax_f: float | None = None  # prior only

    def as_public(self) -> dict[str, Any]:
        d = asdict(self)
        for k, v in list(d.items()):
            if isinstance(v, float):
                d[k] = round(v, 3)
        return d


class DiurnalGotTracker:
    """Per-city shadow diurnal curve: NWP morning seed, slope-driven peak."""

    def __init__(self, *, lat: float, lon: float, local_tz: str) -> None:
        self.lat = lat
        self.lon = lon
        self.tz = ZoneInfo(local_tz)
        self.params: DiurnalParams | None = None
        self.day: date | None = None
        self._obs: list[tuple[datetime, float]] = []  # UTC, °F
        self._n_updates = 0
        self._obs_high_f: float | None = None
        self.last_rate_obs: float | None = None
        self.last_rate_model: float | None = None
        self.last_residual_f: float | None = None
        self.last_peak_method: str | None = None
        self._last_project_hour: int | None = None

    def reset_if_new_day(self, now_local: datetime) -> None:
        d = now_local.date()
        if self.day is not None and d != self.day:
            self.params = None
            self._obs.clear()
            self._n_updates = 0
            self._obs_high_f = None
            self.last_rate_obs = None
            self.last_rate_model = None
            self.last_residual_f = None
            self.last_peak_method = None
            self._last_project_hour = None
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
            tm = float(tm_hour) + 0.5  # NWP hour label → mid-hour

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
        )
        if self.params is None or self._n_updates < NWP_PEAK_LOCKOUT_UPDATES:
            # Early day: accept NWP prior (or full replace before slope has spoken).
            if self.params is None or self._n_updates == 0:
                self.params = new
            else:
                # Geometry refresh only — do not yank slope-implied tmax back to NWP.
                self.params.nwp_tmax_f = tmax
                self.params.tmin_f = tmin
                self.params.omega = omega
                self.params.ts_hour = ts
                self.params.tm_hour = 0.7 * self.params.tm_hour + 0.3 * tm
                self._sync_curve_to_peak(self.params.tmax_f or tmax)
        else:
            # After slope is live: NWP may nudge tm gently, never overwrite peak height.
            self.params.nwp_tmax_f = tmax
            self.params.omega = omega
            self.params.ts_hour = ts
            self.params.tm_hour = 0.85 * self.params.tm_hour + 0.15 * tm
            self._sync_curve_to_peak(self.params.tmax_f or tmax)

    def on_obs(self, obs_ts_utc: datetime, temp_f: float) -> None:
        """Stage B: Synoptic point → rate → slope-implied peak for this hour."""
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

        t_hr = local.hour + local.minute / 60.0 + local.second / 3600.0
        T_model = self.temperature(t_hr)
        self.last_residual_f = T - T_model if T_model is not None else None

        r_obs = self._empirical_rate_f_per_hr(obs_ts_utc)
        r_model = self.rate(t_hr)
        self.last_rate_obs = r_obs
        self.last_rate_model = r_model

        # Night branch: cool k only.
        if t_hr >= self.params.ts_hour:
            self.last_peak_method = "post_peak_floor"
            if self._obs_high_f is not None:
                self.params.tmax_f = max(self.params.tmax_f or 0.0, self._obs_high_f)
                self._sync_curve_to_peak(self.params.tmax_f)
            if r_obs is not None and r_obs < -0.1:
                delta = max(0.5, abs((self.params.T0 + self.params.delta_T) - T))
                k_hat = delta / max(0.05, -r_obs)
                self.params.k = 0.9 * self.params.k + 0.1 * max(0.5, min(8.0, k_hat))
            self._n_updates += 1
            return

        # --- Adjust tm from rate error (shape), then project peak from slope ---
        if r_obs is not None and r_model is not None and t_hr < self.params.tm_hour:
            rate_err = r_obs - r_model
            shift = max(-0.4, min(0.4, GAIN_TM_HR * rate_err))
            center = self.params.tm_hour
            tm_new = max(center - MAX_TM_SHIFT_HR, min(center + MAX_TM_SHIFT_HR, center + shift))
            sunrise = 12.0 - self.params.omega / 2.0
            sunset = sunrise + self.params.omega
            self.params.tm_hour = max(sunrise + 1.0, min(sunset - 0.5, tm_new))

        peak_hat = self._peak_from_slope(t_hr, T, r_obs)
        prev = self.params.tmax_f
        if prev is None:
            self.params.tmax_f = peak_hat
        else:
            self.params.tmax_f = (1.0 - PEAK_BLEND) * prev + PEAK_BLEND * peak_hat

        self._sync_curve_to_peak(self.params.tmax_f)
        self._n_updates += 1

    def _peak_from_slope(
        self, t_hr: float, T: float, r_obs: float | None
    ) -> float:
        """Hourly peak call from current temp + capped observed slope."""
        assert self.params is not None
        r_use = None if r_obs is None else max(-R_OBS_CAP, min(R_OBS_CAP, r_obs))

        if r_use is not None:
            if r_use <= 0.05 or t_hr >= self.params.tm_hour:
                peak_hat = max(T, self._obs_high_f or T)
                if r_use <= 0.0:
                    self.params.tm_hour = min(self.params.tm_hour, t_hr + 0.05)
                self.last_peak_method = "slope_flat"
            else:
                phi = max(0.15, self.params.tm_hour - t_hr)
                peak_hat = slope_implied_peak(
                    T, r_use, hours_to_peak=phi, omega=self.params.omega
                )
                # Also never exceed linear remaining-rise with capped rate.
                peak_hat = min(peak_hat, T + r_use * phi)
                self.last_peak_method = "slope_project"
        elif self.last_residual_f is not None:
            cur = (
                self.params.tmax_f
                if self.params.tmax_f is not None
                else (self.params.T0 + self.params.Ta)
            )
            peak_hat = cur + 0.5 * self.last_residual_f
            self.last_peak_method = "residual"
        else:
            peak_hat = self.params.tmax_f or (self.params.T0 + self.params.Ta)
            self.last_peak_method = "prior"

        peak_hat = max(peak_hat, self._obs_high_f or T)
        # May sit below NWP; only allow modest overshoot vs guidance.
        if self.params.nwp_tmax_f is not None:
            peak_hat = min(peak_hat, float(self.params.nwp_tmax_f) + 2.0)
        return peak_hat

    def _sync_curve_to_peak(self, peak_f: float) -> None:
        """Keep T(tm) = peak and a sensible amplitude from tmin/obs."""
        p = self.params
        if p is None:
            return
        peak = float(peak_f)
        tmin = p.tmin_f
        if tmin is None:
            tmin = peak - 2.0 * max(p.Ta, 5.0)
        # Amplitude from diurnal range, but allow compression when peak falls.
        Ta = max(0.5, (peak - float(tmin)) / 2.0)
        # If peak collapsed toward current obs high, keep Ta from level match later.
        p.Ta = Ta
        p.T0 = peak - Ta
        p.tmax_f = peak

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
        """Return (slope-implied peak_f, tm_hour), floored by trusted obs high."""
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
        # Once per local hour: republish peak from the latest slope (no per-tick ratchet).
        hr = now_local.hour
        if (
            self.params is not None
            and self.last_rate_obs is not None
            and self._obs
            and t_hr < self.params.ts_hour
            and self._last_project_hour != hr
        ):
            T_now = self._obs[-1][1]
            hat = self._peak_from_slope(t_hr, T_now, self.last_rate_obs)
            prev = self.params.tmax_f or hat
            self.params.tmax_f = (1.0 - PEAK_BLEND) * prev + PEAK_BLEND * hat
            self._sync_curve_to_peak(self.params.tmax_f)
            self._last_project_hour = hr
            self.last_peak_method = (self.last_peak_method or "slope") + "_hour"

        peak_f, tm = self.predicted_peak(floor_f)
        T_now = self.temperature(t_hr)
        r_now = self.rate(t_hr)
        phase = "no_data"
        if self.params is not None:
            if t_hr < self.params.tm_hour - 0.5:
                phase = "pre_peak"
            elif t_hr <= self.params.ts_hour:
                phase = "peak_window"
            else:
                phase = "post_peak"
        predicted_i = int(round(peak_f)) if peak_f is not None else None
        return {
            "stream": "diurnal_got",
            "predicted_high_f": predicted_i,
            "predicted_peak_f": round(peak_f, 2) if peak_f is not None else None,
            "predicted_peak_hour": round(tm, 2) if tm is not None else None,
            "peak_method": self.last_peak_method,
            "phase": phase,
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
        """Least-squares slope over ~60 min (resists 1°F ASOS stair-steps)."""
        cutoff = now_utc - timedelta(minutes=60)
        recent = [(dt, t) for dt, t in self._obs if dt >= cutoff]
        if len(recent) < 4:
            return None
        t0 = recent[0][0]
        xs = [(dt - t0).total_seconds() / 3600.0 for dt, _ in recent]
        ys = [t for _, t in recent]
        hours = xs[-1] - xs[0]
        if hours < 0.25:  # need ≥15 min span
            return None
        n = len(xs)
        x_bar = sum(xs) / n
        y_bar = sum(ys) / n
        var_x = sum((x - x_bar) ** 2 for x in xs)
        if var_x < 1e-6:
            return None
        cov = sum((x - x_bar) * (y - y_bar) for x, y in zip(xs, ys))
        return cov / var_x
