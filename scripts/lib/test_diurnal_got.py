#!/usr/bin/env python3
"""Unit tests: GOT diurnal shadow model (no network)."""

from __future__ import annotations

import math
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib.diurnal_got import (
    DiurnalGotTracker,
    day_length_hours,
    fit_daytime_cosine,
    sticky_bin_for_peak,
)
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


def test_sticky_bin_hold_band_blocks_adjacent_chatter():
    labels = ["94-95", "96-97", "98-99", "100-101"]
    # Open on 96-97 at peak 97.2
    held, raw = sticky_bin_for_peak(97.2, labels, None)
    assert held == "96-97" and raw == "96-97"
    # Wobble toward 98-99 but still inside hi(97)+1.0 → stay
    held2, raw2 = sticky_bin_for_peak(98.0, labels, held)
    assert held2 == "96-97" and raw2 == "98-99"
    # Clear the band → flip
    held3, raw3 = sticky_bin_for_peak(98.1, labels, held2)
    assert held3 == "98-99" and raw3 == "98-99"
    # Symmetric down: held 98-99, peak 97.0 still inside lo(98)-1 → stay
    held4, raw4 = sticky_bin_for_peak(97.0, labels, held3)
    assert held4 == "98-99" and raw4 == "96-97"
    held5, raw5 = sticky_bin_for_peak(96.9, labels, held4)
    assert held5 == "96-97" and raw5 == "96-97"


def test_sticky_bin_open_ended_and_missing_held():
    labels = ["<=88", "89-90", "91-92"]
    held, _ = sticky_bin_for_peak(87.0, labels, None)
    assert held == "<=88"
    # Need peak > 88+1 to leave
    stay, raw = sticky_bin_for_peak(89.0, labels, held)
    assert stay == "<=88" and raw == "89-90"
    leave, raw2 = sticky_bin_for_peak(89.1, labels, held)
    assert leave == "89-90" and raw2 == "89-90"
    # Held disappeared from strip → accept raw
    flipped, _ = sticky_bin_for_peak(91.0, ["91-92", "93-94"], "<=88")
    assert flipped == "91-92"


def test_got_follower_bin_sticky_across_wobble():
    """Follower keeps bin through sub-band peak chatter; exposes bin_raw."""
    import json
    from pathlib import Path
    from unittest.mock import patch

    root = Path(".tmp/test-got-bin-sticky")
    root.mkdir(parents=True, exist_ok=True)
    src = root / "austin-weather-26aug10-monitor.jsonl"
    out = root / "austin-diurnal-got-26aug10-monitor.jsonl"
    if out.exists():
        out.unlink()
    t0 = datetime(2026, 8, 10, 18, 0, tzinfo=timezone.utc)
    labels = {"96-97": 0.3, "98-99": 0.5, "100-101": 0.15}
    # Seed + force successive peaks that would thrash without hold-band.
    rows = [
        {
            "type": "prediction",
            "recv": t0.isoformat(),
            "predicted_high_f": 98,
            "bin": "98-99",
            "floor_f": 96,
            "forecast_peak_f": 98,
            "forecast_peak_hour": 15,
            "daily_implied": labels,
        }
    ]
    src.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    follower = GotFollower(
        "austin",
        "26AUG10",
        source_path=src,
        out_path=out,
        once=False,
    )
    follower.catch_up()
    # Isolate hold-band behavior from the NWP seed bin.
    follower._held_bin = None
    follower._last_emit = None
    # Inject snapshots with wobbling continuous peaks near the 97/98 fence.
    peaks = [97.2, 98.0, 97.4, 98.0, 98.2, 99.0]
    bins_out = []
    raws_out = []
    for i, pk in enumerate(peaks):
        local = datetime(2026, 8, 10, 13, i, tzinfo=ZoneInfo("America/Chicago"))
        with patch.object(
            follower.got,
            "snapshot",
            return_value={
                "stream": "diurnal_got",
                "predicted_high_f": int(round(pk)),
                "predicted_peak_f": pk,
                "peak_method": "ls_fit",
                "phase": "peak_window",
            },
        ):
            follower._seeded = True
            follower._last_daily_implied = labels
            follower._emit(local, force=True)
        last = follower._last_emit
        assert last is not None
        bins_out.append(last.get("bin"))
        raws_out.append(last.get("bin_raw"))
    # First peak 97.2 → 96-97; 98.0 raw wants 98-99 but hold keeps 96-97;
    # 98.2 clears band → 98-99 and stays.
    assert bins_out[0] == "96-97"
    assert bins_out[1] == "96-97" and raws_out[1] == "98-99"
    assert bins_out[2] == "96-97"
    assert bins_out[4] == "98-99"
    assert bins_out[5] == "98-99"


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


def test_got_follower_resets_on_source_truncate():
    """Rsync/replace can shrink the active tape; follower must not stall past EOF."""
    import json
    from pathlib import Path

    root = Path(".tmp/test-got-follower-rotate")
    root.mkdir(parents=True, exist_ok=True)
    src = root / "miami-weather-26aug10-monitor.jsonl"
    out = root / "miami-diurnal-got-26aug10-monitor.jsonl"
    if out.exists():
        out.unlink()
    t0 = datetime(2026, 8, 10, 14, 0, tzinfo=timezone.utc)
    src.write_text(
        json.dumps(
            {
                "type": "prediction",
                "recv": t0.isoformat(),
                "predicted_high_f": 92,
                "bin": "91-92",
                "floor_f": 88,
                "forecast_peak_f": 92,
                "forecast_peak_hour": 14,
                "daily_implied": {"91-92": 0.7, "93-94": 0.2},
            }
        )
        + "\n"
    )
    follower = GotFollower(
        "miami",
        "26AUG10",
        source_path=src,
        out_path=out,
        once=False,
    )
    follower.catch_up()
    assert follower._offset > 0
    n_before = sum(1 for line in out.read_text().splitlines() if '"prediction"' in line)
    # Simulate rsync replace: truncate then rewrite longer content.
    src.write_text(
        json.dumps(
            {
                "type": "prediction",
                "recv": (t0 + timedelta(hours=1)).isoformat(),
                "predicted_high_f": 93,
                "bin": "92-93",
                "floor_f": 91,
                "forecast_peak_f": 93,
                "forecast_peak_hour": 14,
                "daily_implied": {"91-92": 0.2, "92-93": 0.7},
            }
        )
        + "\n"
        + json.dumps(
            {
                "type": "temp",
                "source": "synoptic_1m",
                "temp_f": 91,
                "tenths_f": 91.2,
                "obs_ts": (t0 + timedelta(hours=1, minutes=5)).isoformat(),
                "recv": (t0 + timedelta(hours=1, minutes=5)).isoformat(),
            }
        )
        + "\n"
    )
    follower.catch_up()
    rows = [json.loads(line) for line in out.read_text().splitlines() if line.strip()]
    assert any(r.get("type") == "source_rotated" for r in rows)
    preds = [r for r in rows if r.get("type") == "prediction"]
    assert len(preds) > n_before
    assert preds[-1].get("predicted_high_f") is not None


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
    test_sticky_bin_hold_band_blocks_adjacent_chatter()
    test_sticky_bin_open_ended_and_missing_held()
    test_got_follower_bin_sticky_across_wobble()
    test_active_predictor_has_no_embedded_diurnal()
    test_significant_change_ignores_diurnal_field()
    test_got_follower_resets_on_source_truncate()
    test_got_follower_writes_separate_tape()
    print("ok")
