#!/usr/bin/env python3
"""Unit tests: GOT diurnal shadow model (no network)."""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib.diurnal_got import DiurnalGotTracker, day_length_hours
from lib.chi_high_predictor import DailyHighPredictor, significant_change


CHI = ZoneInfo("America/Chicago")


def test_day_length_chicago_summer():
    # Mid-August Chicago day length ~13–14 h
    dl = day_length_hours(41.786, date(2026, 8, 8))
    assert 12.5 < dl < 15.0, dl


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


def test_synoptic_update_moves_params():
    m = DiurnalGotTracker(lat=41.786, lon=-87.752, local_tz="America/Chicago")
    local = datetime(2026, 8, 8, 9, 0, tzinfo=CHI)
    m.init_from_nwp(now_local=local, tmax_f=90, tmin_f=70, tm_hour=15)
    ta0 = m.params.Ta
    # Rising slower / cooler than model → Ta should ease down over several obs.
    base = datetime(2026, 8, 8, 10, 0, tzinfo=timezone.utc)
    for i in range(8):
        m.on_obs(base + timedelta(minutes=5 * i), 75.0 + 0.1 * i)
    assert m._n_updates >= 5
    assert m.params.Ta != ta0


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
    # Synoptic points
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
    # Live fields unchanged contract
    assert "predicted_high_f" in pred
    assert "bin" in pred


def test_significant_change_on_diurnal_peak():
    a = {"predicted_high_f": 88, "bin": "87-88", "diurnal": {"predicted_high_f": 88}}
    b = {"predicted_high_f": 88, "bin": "87-88", "diurnal": {"predicted_high_f": 87}}
    assert significant_change(a, b) is True


if __name__ == "__main__":
    test_day_length_chicago_summer()
    test_peak_at_tm()
    test_rate_positive_before_peak()
    test_synoptic_update_moves_params()
    test_predictor_attaches_diurnal_shadow()
    test_significant_change_on_diurnal_peak()
    print("ok")
