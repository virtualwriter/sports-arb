"""GOT-style piecewise diurnal temperature model (shadow / parallel stream).

Göttsche & Olesen family:
  Daytime:  T(t) = T0 + Ta * cos(π/ω * (t - tm))
  dT/dt:    -Ta * (π/ω) * sin(π/ω * (t - tm))   [°F / hour]
  Night:    exponential decay after free-attenuation time ts

This runs *alongside* DailyHighPredictor — it never drives live bins or
book-aware rolls. Synoptic 1-min/station prints update Ta / tm in real time;
NWP max/min + peak hour seed the day's parameters.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

# Sequential-update gains (Stage B). Kept small so NWP prior dominates early.
GAIN_TA = 0.15
GAIN_TM_HR = 0.08  # hours per (°F/hr) rate residual
MAX_TM_SHIFT_HR = 2.5
MIN_OMEGA_HR = 8.0
MAX_OMEGA_HR = 16.0


def day_length_hours(lat_deg: float, on: date) -> float:
    """Approximate sunrise→sunset length (hours) from lat + day-of-year."""
    # Cooper declination; standard day-length formula.
    doy = on.timetuple().tm_yday
    decl = math.radians(23.45 * math.sin(math.radians(360.0 / 365.0 * (doy - 81))))
    lat = math.radians(lat_deg)
    cos_ha = -math.tan(lat) * math.tan(decl)
    cos_ha = max(-1.0, min(1.0, cos_ha))
    ha = math.acos(cos_ha)  # hour angle at sunrise/sunset (radians)
    return max(MIN_OMEGA_HR, min(MAX_OMEGA_HR, 2.0 * math.degrees(ha) / 15.0))


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
    tmax_f: float | None = None

    def as_public(self) -> dict[str, Any]:
        d = asdict(self)
        for k, v in list(d.items()):
            if isinstance(v, float):
                d[k] = round(v, 3)
        return d


class DiurnalGotTracker:
    """Per-city shadow diurnal curve, seeded by NWP and honed by Synoptic."""

    def __init__(self, *, lat: float, lon: float, local_tz: str) -> None:
        self.lat = lat
        self.lon = lon
        self.tz = ZoneInfo(local_tz)
        self.params: DiurnalParams | None = None
        self.day: date | None = None
        self._obs: list[tuple[datetime, float]] = []  # UTC, °F
        self._n_updates = 0
        self.last_rate_obs: float | None = None
        self.last_rate_model: float | None = None
        self.last_residual_f: float | None = None

    def reset_if_new_day(self, now_local: datetime) -> None:
        d = now_local.date()
        if self.day is not None and d != self.day:
            self.params = None
            self._obs.clear()
            self._n_updates = 0
            self.last_rate_obs = None
            self.last_rate_model = None
            self.last_residual_f = None
        self.day = d

    def init_from_nwp(
        self,
        *,
        now_local: datetime,
        tmax_f: float | None,
        tmin_f: float | None,
        tm_hour: float | None,
    ) -> None:
        """Stage A: fit cosine through NWP max/min with first-guess peak time."""
        self.reset_if_new_day(now_local)
        if tmax_f is None:
            return
        tmax = float(tmax_f)
        if tmin_f is None:
            # Fall back: assume 20°F diurnal range until morning obs arrive.
            tmin = tmax - 20.0
        else:
            tmin = float(tmin_f)
        if tmin > tmax:
            tmin, tmax = tmax, tmin

        omega = day_length_hours(self.lat, now_local.date())
        if tm_hour is None:
            # 2 h after solar-noon proxy in civil time (~14:00 warm season default).
            tm = 14.0
        else:
            tm = float(tm_hour) + 0.5  # NWP hour label → mid-hour

        Ta = max(0.5, (tmax - tmin) / 2.0)
        T0 = tmax - Ta  # so T(tm) = T0 + Ta = tmax
        # Free attenuation near sunset (sunrise ≈ 12 − ω/2 in this approx).
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
        )
        if self.params is None:
            self.params = new
        else:
            # Refresh NWP prior gently — keep Synoptic-honed tm/Ta if we've updated.
            if self._n_updates == 0:
                self.params = new
            else:
                self.params.tmax_f = tmax
                self.params.tmin_f = tmin
                self.params.omega = omega
                self.params.ts_hour = ts
                # Blend NWP peak toward new guidance without wiping obs updates.
                self.params.tm_hour = 0.7 * self.params.tm_hour + 0.3 * tm
                nwp_ta = Ta
                self.params.Ta = 0.7 * self.params.Ta + 0.3 * nwp_ta
                self.params.T0 = (self.params.tmax_f or tmax) - self.params.Ta

    def on_obs(self, obs_ts_utc: datetime, temp_f: float) -> None:
        """Stage B: ingest Synoptic point, update rate residual → Ta / tm."""
        if obs_ts_utc.tzinfo is None:
            return
        local = obs_ts_utc.astimezone(self.tz)
        self.reset_if_new_day(local)
        T = float(temp_f)
        self._obs.append((obs_ts_utc, T))
        # Cap memory to one dense day of 1-min samples.
        if len(self._obs) > 1600:
            self._obs = self._obs[-1600:]

        if self.params is None:
            # Bootstrap from observations alone (flat prior until NWP arrives).
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

        # Only hone during the daytime cosine branch (pre-ts).
        if t_hr >= self.params.ts_hour:
            # Night: nudge cooling constant from rate if we have a clear decay.
            if r_obs is not None and r_obs < -0.1:
                # dT/dt ≈ -Δ/k → k ≈ -Δ / rate; soft update.
                delta = max(0.5, abs((self.params.T0 + self.params.delta_T) - T))
                k_hat = delta / max(0.05, -r_obs)
                self.params.k = 0.9 * self.params.k + 0.1 * max(0.5, min(8.0, k_hat))
            return

        if self.last_residual_f is not None:
            # Matching level: raise/lower Ta (and keep T0+Ta ≈ peak).
            self.params.Ta = max(0.5, self.params.Ta + GAIN_TA * self.last_residual_f)
            peak = (self.params.tmax_f or (self.params.T0 + self.params.Ta))
            # Keep peak = T0 + Ta consistent with the higher of NWP peak and floor-ish.
            self.params.T0 = peak - self.params.Ta

        if r_obs is not None and r_model is not None:
            # Before peak, model rate should be > 0 and falling toward 0 at tm.
            # If observed rise is weaker than model, peak is sooner / lower — pull tm earlier
            # when past the morning; if stronger, push tm later.
            rate_err = r_obs - r_model  # >0 → rising faster than model
            # Sign convention: faster rise ⇒ later / higher vertex.
            shift = GAIN_TM_HR * rate_err
            shift = max(-0.35, min(0.35, shift))
            center = self.params.tm_hour
            tm_new = center + shift
            tm_new = max(center - MAX_TM_SHIFT_HR, min(center + MAX_TM_SHIFT_HR, tm_new))
            sunrise = 12.0 - self.params.omega / 2.0
            sunset = sunrise + self.params.omega
            self.params.tm_hour = max(sunrise + 1.0, min(sunset - 0.5, tm_new))

        # Lift expected tmax if we're already above it (floor-consistent peak).
        if T > (self.params.tmax_f or T):
            self.params.tmax_f = T
            self.params.T0 = T - self.params.Ta

        self._n_updates += 1

    def temperature(self, t_hr: float) -> float | None:
        p = self.params
        if p is None:
            return None
        if t_hr <= p.ts_hour:
            return p.T0 + p.Ta * math.cos(math.pi / p.omega * (t_hr - p.tm_hour))
        # Night branch — continuous with daytime at ts.
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
        """Return (peak_f, tm_hour). Peak is max(T0+Ta, floor)."""
        p = self.params
        if p is None:
            return None, None
        peak = p.T0 + p.Ta
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
            "phase": phase,
            "T_model_now_f": round(T_now, 2) if T_now is not None else None,
            "dTdt_model_f_per_hr": round(r_now, 3) if r_now is not None else None,
            "dTdt_obs_f_per_hr": round(self.last_rate_obs, 3)
            if self.last_rate_obs is not None
            else None,
            "residual_f": round(self.last_residual_f, 2)
            if self.last_residual_f is not None
            else None,
            "n_obs": len(self._obs),
            "n_updates": self._n_updates,
            "params": self.params.as_public() if self.params else None,
        }

    def _empirical_rate_f_per_hr(self, now_utc: datetime) -> float | None:
        cutoff = now_utc - timedelta(minutes=40)
        recent = [(dt, t) for dt, t in self._obs if dt >= cutoff]
        if len(recent) < 3:
            return None
        t0, v0 = recent[0]
        t1, v1 = recent[-1]
        hours = (t1 - t0).total_seconds() / 3600.0
        if hours < 0.08:  # < ~5 min
            return None
        return (v1 - v0) / hours
