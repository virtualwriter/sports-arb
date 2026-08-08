#!/usr/bin/env python3
"""Unit tests: NYC human courtside ceiling (no network)."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib.chi_high_predictor import DailyHighPredictor, HUMAN_CEILING_MAX_AGE


NYC_TZ = ZoneInfo("America/New_York")


def _nyc_pred(**kwargs) -> DailyHighPredictor:
    p = DailyHighPredictor(
        local_tz="America/New_York",
        lat=40.77898,
        lon=-73.96925,
        city_key="nyc",
        **kwargs,
    )
    p.forecast_peak_f = 90
    p.forecast_peak_hour = 15
    p.on_daily_summary([
        {"status": "active", "subtitle": "88° or below", "bid": "0.1000", "ask": "0.1200"},
        {"status": "active", "subtitle": "89° to 90°", "bid": "0.7000", "ask": "0.7200"},
        {"status": "active", "subtitle": "91° or above", "bid": "0.0500", "ask": "0.0800"},
    ])
    p.on_hourly_summary("KXTEMPNYCH-26AUG0815", [
        {"status": "active", "subtitle": "89° or above", "strike": 89, "bid": "0.7000", "ask": "0.7500"},
        {"status": "active", "subtitle": "87° or above", "strike": 87, "bid": "0.9000", "ask": "0.9200"},
    ])
    return p


def test_fresh_human_caps_peak_to_87():
    p = _nyc_pred()
    p.on_obs_high(85, 85.0)
    now_local = datetime(2026, 8, 8, 15, 10, tzinfo=NYC_TZ)
    now_utc = now_local.astimezone(timezone.utc)
    p.on_temp({
        "source": "human_knyc",
        "temp_f": 87,
        "tenths_f": 87.2,
        "obs_ts": (now_utc - timedelta(minutes=5)).isoformat(),
    })
    pred = p.predict(now_utc=now_utc)
    assert pred["phase"] == "peak_hour", pred["phase"]
    assert pred["human_ceiling_active"] is True
    assert pred["human_high_f"] == 87
    assert pred["predicted_high_f"] == 87, pred
    assert pred["bin"] == "<=88" or "88" in (pred["bin"] or ""), pred["bin"]
    assert "human ceiling 87" in (pred["rationale"] or "")
    print("fresh_human_caps_peak_to_87: PASS", pred["bin"], pred["rationale"])


def test_stale_human_no_cap():
    p = _nyc_pred()
    p.on_obs_high(85, 85.0)
    now_local = datetime(2026, 8, 8, 15, 10, tzinfo=NYC_TZ)
    now_utc = now_local.astimezone(timezone.utc)
    stale = now_utc - HUMAN_CEILING_MAX_AGE - timedelta(minutes=1)
    p.on_temp({
        "source": "human_knyc",
        "temp_f": 87,
        "tenths_f": 87.0,
        "obs_ts": stale.isoformat(),
    })
    pred = p.predict(now_utc=now_utc)
    assert pred["phase"] == "peak_hour"
    assert pred["human_ceiling_active"] is False
    assert pred["predicted_high_f"] == 89, pred  # hourly mode
    assert "human ceiling" not in (pred["rationale"] or "")
    print("stale_human_no_cap: PASS", pred["predicted_high_f"])


def test_pre_peak_no_cap():
    p = _nyc_pred()
    p.on_obs_high(85, 85.0)
    # Peak hour 15 → NYC peak window [14,16]; 12 is pre_peak.
    now_local = datetime(2026, 8, 8, 12, 0, tzinfo=NYC_TZ)
    now_utc = now_local.astimezone(timezone.utc)
    p.on_temp({
        "source": "human_knyc",
        "temp_f": 87,
        "tenths_f": 87.0,
        "obs_ts": now_utc.isoformat(),
    })
    pred = p.predict(now_utc=now_utc)
    assert pred["phase"] == "pre_peak", pred["phase"]
    assert pred["human_ceiling_active"] is False
    assert pred["predicted_high_f"] == 90, pred  # forecast peak, not capped
    assert "human ceiling" not in (pred["rationale"] or "")
    print("pre_peak_no_cap: PASS", pred["predicted_high_f"])


def test_human_89_allows_89_90():
    p = _nyc_pred()
    now_local = datetime(2026, 8, 8, 15, 10, tzinfo=NYC_TZ)
    now_utc = now_local.astimezone(timezone.utc)
    p.on_temp({
        "source": "human_knyc",
        "temp_f": 89,
        "tenths_f": 89.1,
        "obs_ts": now_utc.isoformat(),
    })
    assert p.day_high_f == 89
    assert p.human_high_f == 89
    pred = p.predict(now_utc=now_utc)
    assert pred["phase"] == "peak_hour"
    assert pred["human_ceiling_active"] is True
    assert pred["floor_f"] == 89
    assert pred["predicted_high_f"] == 89, pred
    assert pred["bin"] == "89-90", pred["bin"]
    print("human_89_allows_89_90: PASS", pred["bin"])


def test_no_human_unchanged():
    p = _nyc_pred()
    p.on_obs_high(85, 85.0)
    now_local = datetime(2026, 8, 8, 15, 10, tzinfo=NYC_TZ)
    now_utc = now_local.astimezone(timezone.utc)
    pred = p.predict(now_utc=now_utc)
    assert pred["human_high_f"] is None
    assert pred["human_ceiling_active"] is False
    assert pred["predicted_high_f"] == 89
    print("no_human_unchanged: PASS", pred["predicted_high_f"])


def test_chicago_ignores_human_source_for_ceiling():
    """human_knyc still raises floor if fed, but ceiling gate is NYC-only."""
    p = DailyHighPredictor(city_key="chicago")
    p.forecast_peak_f = 90
    p.forecast_peak_hour = 15
    p.on_obs_high(85, 85.0)
    p.on_hourly_summary("x", [
        {"status": "active", "subtitle": "89° or above", "strike": 89, "bid": "0.70", "ask": "0.75"},
    ])
    now_local = datetime(2026, 8, 8, 15, 10, tzinfo=ZoneInfo("America/Chicago"))
    now_utc = now_local.astimezone(timezone.utc)
    p.on_temp({
        "source": "human_knyc",
        "temp_f": 87,
        "tenths_f": 87.0,
        "obs_ts": now_utc.isoformat(),
    })
    pred = p.predict(now_utc=now_utc)
    assert pred["human_high_f"] == 87  # tracked if fed
    assert pred["human_ceiling_active"] is False
    assert pred["predicted_high_f"] == 89
    print("chicago_no_ceiling: PASS")


if __name__ == "__main__":
    test_fresh_human_caps_peak_to_87()
    test_stale_human_no_cap()
    test_pre_peak_no_cap()
    test_human_89_allows_89_90()
    test_no_human_unchanged()
    test_chicago_ignores_human_source_for_ceiling()
    print("ALL PASS")
