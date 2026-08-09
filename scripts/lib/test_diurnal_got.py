#!/usr/bin/env python3
"""Unit tests: GOT diurnal shadow model (no network)."""

from __future__ import annotations

import math
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib.diurnal_got import DiurnalGotTracker, day_length_hours, fit_daytime_cosine
from lib.chi_high_predictor import DailyHighPredictor, significant_change
from monitor_city_diurnal_got import GotFollower, default_got_tape_path


CHI = ZoneInfo("America/Chicago")
LA = ZoneInfo("America/Los_Angeles")


def test_day_length_chicago_summer():
    dl = day_length_hours(41.786, date(2026, 8, 8))
    assert 12.5 < dl < 15.0, dl


def test_fit_recovers_synthetic_cosine():
    omega = 13.0
    T0, Ta, tm = 80.0, 10.0, 15.0
    samples = []
    for h in [9, 10, 11, 12, 13, 14, 15, 16]:
        T = T0 + Ta * math.cos(math.pi / omega * (h - tm))
        samples.append((float(h), T))
    fit = fit_daytime_cosine(
        samples, omega=omega, tm_prior=14.5, tm_lo=12.0, tm_hi=17.0
    )
    assert fit is not None
    fT0, fTa, ftm, _sse = fit
    assert abs(fT0 + fTa - (T0 + Ta)) < 0.5  # peak
    assert abs(ftm - tm) < 0.5


def test_peak_at_tm():
    m = DiurnalGotTracker(lat=41.786, lon=-87.752, local_tz="America/Chicago")
    local = datetime(2026, 8, 8, 10, 0, tzinfo=CHI)
    m.init_from_nwp(now_local=local, tmax_f=90, tmin_f=70, tm_hour=15)
    assert m.params is not None
    T_peak = m.temperature(m.params.tm_hour)
    assert T_peak is not None
    assert abs(T_peak - 90) < 0.05


def test_ls_fit_smooths_below_nwp_on_soft_rise():
    """Synthetic soft morning under NWP 80 → fitted peak falls below 80."""
    m = DiurnalGotTracker(lat=33.94, lon=-118.39, local_tz="America/Los_Angeles")
    m.init_from_nwp(
        now_local=datetime(2026, 8, 8, 7, 0, tzinfo=LA),
        tmax_f=80,
        tmin_f=68,
        tm_hour=12,
    )
    # Smooth climb 70 → 76 over morning (won't support 80).
    base = datetime(2026, 8, 8, 15, 0, tzinfo=timezone.utc)  # 08:00 PDT
    for i in range(40):
        # ~0.15°F per 5 min ≈ 1.8°F/hr from 70
        m.on_obs(base + timedelta(minutes=5 * i), 70.0 + 0.15 * i)
    peak, tm = m.predicted_peak()
    assert peak is not None
    assert peak < 80, peak
    assert peak >= 70
    assert m.last_peak_method in ("ls_fit", "residual_warmup", "hold", "vertex_lock")


def test_nwp_refresh_does_not_restore_fitted_peak():
    m = DiurnalGotTracker(lat=33.94, lon=-118.39, local_tz="America/Los_Angeles")
    m.init_from_nwp(
        now_local=datetime(2026, 8, 8, 7, 0, tzinfo=LA),
        tmax_f=80,
        tmin_f=68,
        tm_hour=12,
    )
    base = datetime(2026, 8, 8, 15, 0, tzinfo=timezone.utc)
    for i in range(40):
        m.on_obs(base + timedelta(minutes=5 * i), 70.0 + 0.15 * i)
    peak_before, _ = m.predicted_peak()
    assert peak_before is not None and peak_before < 80
    m.init_from_nwp(
        now_local=datetime(2026, 8, 8, 10, 0, tzinfo=LA),
        tmax_f=80,
        tmin_f=68,
        tm_hour=12,
    )
    peak_after, _ = m.predicted_peak()
    assert peak_after is not None
    assert peak_after < 80
    assert abs(peak_after - peak_before) < 1.5


def test_active_predictor_has_no_embedded_diurnal():
    p = DailyHighPredictor(local_tz="America/Chicago", lat=41.786, lon=-87.752)
    assert not hasattr(p, "diurnal")
    pred = p.predict(datetime(2026, 8, 8, 15, 0, tzinfo=timezone.utc))
    assert pred.get("diurnal") is None


def test_significant_change_ignores_diurnal_field():
    # GOT runs on a separate tape; active emit gate must not key off diurnal.
    a = {"predicted_high_f": 88, "bin": "87-88", "diurnal": {"predicted_high_f": 88}}
    b = {"predicted_high_f": 88, "bin": "87-88", "diurnal": {"predicted_high_f": 87}}
    assert significant_change(a, b) is False


def test_got_follower_writes_separate_tape():
    import json
    from pathlib import Path

    root = Path(".tmp/test-got-follower")
    root.mkdir(parents=True, exist_ok=True)
    src = root / "chi-weather-26aug08-monitor.jsonl"
    out = root / "chi-diurnal-got-26aug08-monitor.jsonl"
    t0 = datetime(2026, 8, 8, 14, 0, tzinfo=timezone.utc)
    rows = [
        {
            "type": "prediction",
            "recv": t0.isoformat(),
            "predicted_high_f": 86,
            "bin": "85-86",
            "floor_f": 80,
            "forecast_peak_f": 86,
            "forecast_peak_hour": 15,
            "daily_implied": {"83-84": 0.2, "85-86": 0.5, "87-88": 0.2},
        }
    ]
    for i in range(12):
        rows.append(
            {
                "type": "temp",
                "source": "synoptic_1m",
                "temp_f": 82,
                "tenths_f": 82.0 + 0.15 * i,
                "obs_ts": (t0 + timedelta(minutes=5 * i)).isoformat(),
                "recv": (t0 + timedelta(minutes=5 * i)).isoformat(),
            }
        )
    rows.append(
        {
            "type": "prediction",
            "recv": (t0 + timedelta(hours=1)).isoformat(),
            "predicted_high_f": 85,
            "bin": "85-86",
            "floor_f": 82,
            "forecast_peak_f": 86,
            "forecast_peak_hour": 15,
            "daily_implied": {"83-84": 0.25, "85-86": 0.55, "87-88": 0.15},
        }
    )
    src.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    if out.exists():
        out.unlink()
    GotFollower(
        "chicago",
        "26AUG08",
        source_path=src,
        out_path=out,
        once=True,
    ).run()
    got_rows = [json.loads(line) for line in out.read_text().splitlines() if line.strip()]
    preds = [r for r in got_rows if r.get("type") == "prediction"]
    assert preds
    assert all(r.get("stream") == "diurnal_got" for r in preds)
    assert preds[-1].get("predicted_high_f") is not None
    assert preds[-1].get("bin") is not None
    assert default_got_tape_path("chicago", "26AUG08").name.startswith("chi-diurnal-got-")


if __name__ == "__main__":
    test_day_length_chicago_summer()
    test_fit_recovers_synthetic_cosine()
    test_peak_at_tm()
    test_ls_fit_smooths_below_nwp_on_soft_rise()
    test_nwp_refresh_does_not_restore_fitted_peak()
    test_active_predictor_has_no_embedded_diurnal()
    test_significant_change_ignores_diurnal_field()
    test_got_follower_writes_separate_tape()
    print("ok")
