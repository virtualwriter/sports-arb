#!/usr/bin/env python3
"""Unit tests: GOT diurnal shadow model (no network)."""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib.diurnal_got import DiurnalGotTracker, day_length_hours, slope_implied_peak
from lib.chi_high_predictor import DailyHighPredictor, significant_change


CHI = ZoneInfo("America/Chicago")
LA = ZoneInfo("America/Los_Angeles")


def test_day_length_chicago_summer():
    dl = day_length_hours(41.786, date(2026, 8, 8))
    assert 12.5 < dl < 15.0, dl


def test_slope_implied_peak_rises_with_rate():
    # Strong rise with 3h to peak → peak well above now.
    p_hi = slope_implied_peak(75.0, 3.0, hours_to_peak=3.0, omega=13.0)
    p_lo = slope_implied_peak(75.0, 0.5, hours_to_peak=3.0, omega=13.0)
    assert p_hi > p_lo > 75.0
    # Flat slope → peak is now.
    assert slope_implied_peak(78.0, 0.0, hours_to_peak=2.0, omega=13.0) == 78.0


def test_peak_at_tm():
    m = DiurnalGotTracker(lat=41.786, lon=-87.752, local_tz="America/Chicago")
    local = datetime(2026, 8, 8, 10, 0, tzinfo=CHI)
    m.init_from_nwp(now_local=local, tmax_f=90, tmin_f=70, tm_hour=15)
    assert m.params is not None
    T_peak = m.temperature(m.params.tm_hour)
    assert T_peak is not None
    assert abs(T_peak - 90) < 0.05
    r_peak = m.rate(m.params.tm_hour)
    assert r_peak is not None and abs(r_peak) < 1e-6


def test_rate_positive_before_peak():
    m = DiurnalGotTracker(lat=41.786, lon=-87.752, local_tz="America/Chicago")
    local = datetime(2026, 8, 8, 8, 0, tzinfo=CHI)
    m.init_from_nwp(now_local=local, tmax_f=90, tmin_f=70, tm_hour=15)
    r = m.rate(11.0)
    assert r is not None and r > 0


def test_soft_slope_pulls_peak_below_nwp():
    """LA-style: NWP says 80, weak rise from ~75 → GOT peak must fall below 80."""
    m = DiurnalGotTracker(lat=33.94, lon=-118.39, local_tz="America/Los_Angeles")
    local = datetime(2026, 8, 8, 8, 0, tzinfo=LA)
    m.init_from_nwp(now_local=local, tmax_f=80, tmin_f=70, tm_hour=10)
    assert m.params is not None
    assert m.params.tmax_f == 80
    # Slow climb ~0.5°F/hr for an hour of samples around 75°F.
    base = datetime(2026, 8, 8, 16, 0, tzinfo=timezone.utc)  # 09:00 PDT
    for i in range(12):
        m.on_obs(base + timedelta(minutes=5 * i), 75.0 + 0.04 * i)
    peak, _ = m.predicted_peak()
    assert peak is not None
    assert peak < 80, peak
    assert peak >= 75.0
    assert m.last_peak_method in ("slope_project", "slope_project_hour", "slope_flat", "slope_flat_hour")


def test_nwp_refresh_does_not_restore_locked_peak():
    m = DiurnalGotTracker(lat=33.94, lon=-118.39, local_tz="America/Los_Angeles")
    local = datetime(2026, 8, 8, 8, 0, tzinfo=LA)
    m.init_from_nwp(now_local=local, tmax_f=80, tmin_f=70, tm_hour=10)
    base = datetime(2026, 8, 8, 16, 0, tzinfo=timezone.utc)
    for i in range(10):
        m.on_obs(base + timedelta(minutes=5 * i), 75.0 + 0.05 * i)
    peak_before, _ = m.predicted_peak()
    assert peak_before is not None and peak_before < 80
    # NWP still says 80 — must not yank peak back up after slope lockout.
    m.init_from_nwp(
        now_local=datetime(2026, 8, 8, 9, 30, tzinfo=LA),
        tmax_f=80,
        tmin_f=70,
        tm_hour=10,
    )
    peak_after, _ = m.predicted_peak()
    assert peak_after is not None
    assert peak_after < 80
    assert abs(peak_after - peak_before) < 2.0


def test_predictor_attaches_diurnal_shadow():
    p = DailyHighPredictor(local_tz="America/Chicago", lat=41.786, lon=-87.752)
    p.forecast_peak_f = 88
    p.forecast_peak_hour = 15
    p.forecast = [
        (datetime(2026, 8, 8, h, 0, tzinfo=CHI), 70 + h)
        for h in range(6, 20)
    ]
    p.forecast[-1] = (datetime(2026, 8, 8, 15, 0, tzinfo=CHI), 88)
    p._seed_diurnal_from_forecast(datetime(2026, 8, 8, 14, 0, tzinfo=timezone.utc))
    t0 = datetime(2026, 8, 8, 14, 0, tzinfo=timezone.utc)
    for i in range(5):
        p.on_temp({
            "source": "synoptic_1m",
            "temp_f": 82,
            "tenths_f": 82.0 + 0.2 * i,
            "obs_ts": (t0 + timedelta(minutes=5 * i)).isoformat(),
        })
    pred = p.predict(datetime(2026, 8, 8, 15, 0, tzinfo=timezone.utc))
    assert pred.get("diurnal") is not None
    assert pred["diurnal"].get("stream") == "diurnal_got"
    assert pred["diurnal"].get("predicted_high_f") is not None
    assert "nwp_tmax_f" in pred["diurnal"]


def test_significant_change_on_diurnal_peak():
    a = {"predicted_high_f": 88, "bin": "87-88", "diurnal": {"predicted_high_f": 88}}
    b = {"predicted_high_f": 88, "bin": "87-88", "diurnal": {"predicted_high_f": 87}}
    assert significant_change(a, b) is True


if __name__ == "__main__":
    test_day_length_chicago_summer()
    test_slope_implied_peak_rises_with_rate()
    test_peak_at_tm()
    test_rate_positive_before_peak()
    test_soft_slope_pulls_peak_below_nwp()
    test_nwp_refresh_does_not_restore_locked_peak()
    test_predictor_attaches_diurnal_shadow()
    test_significant_change_on_diurnal_peak()
    print("ok")
