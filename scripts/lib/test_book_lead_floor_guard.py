#!/usr/bin/env python3
"""Unit tests: book_lead / anti_thrash respect trusted floor."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from lib.weather_hourly_hedge_filter import (
    BookAwareBinTracker,
    apply_book_aware_bins,
    bin_reachable_given_floor,
    simulate_roll_policy,
)


def test_bin_reachable_given_floor():
    assert bin_reachable_given_floor("97-98", 97) is True
    assert bin_reachable_given_floor("97-98", 98) is True
    assert bin_reachable_given_floor("97-98", 99) is False
    assert bin_reachable_given_floor("<=88", 87) is True
    assert bin_reachable_given_floor("<=88", 89) is False
    assert bin_reachable_given_floor(">=99", 99) is True
    assert bin_reachable_given_floor(None, 99) is True
    assert bin_reachable_given_floor("97-98", None) is True


def test_book_lead_blocked_when_fav_below_floor():
    t = BookAwareBinTracker()
    held, notes = t.update("99-100", {"99-100": 0.72, "97-98": 0.18}, floor_f=99)
    assert held == "99-100"
    held, notes = t.update(
        "99-100",
        {"97-98": 0.66, "99-100": 0.34},
        floor_f=99,
    )
    assert held == "99-100"
    assert any("book_lead blocked" in n for n in notes)
    assert not any("book_lead → 97-98" in n for n in notes)


def test_book_lead_still_works_when_floor_allows():
    t = BookAwareBinTracker()
    t.update("78-79", {"78-79": 0.50, "80-81": 0.46}, floor_f=72)
    held, notes = t.update(
        "78-79",
        {"80-81": 0.52, "78-79": 0.40},
        floor_f=72,
    )
    assert held == "80-81"
    assert any("book_lead → 80-81" in n for n in notes)


def test_anti_thrash_cannot_hold_floor_dead_bin():
    t = BookAwareBinTracker()
    t.update("97-98", {"97-98": 0.60, "99-100": 0.30}, floor_f=97)
    # Floor jumps to 99; raw escapes to 99-100 while book still likes 97-98.
    held, notes = t.update(
        "99-100",
        {"97-98": 0.60, "99-100": 0.30},
        floor_f=99,
    )
    assert held == "99-100"
    assert any("floor escape" in n or "follow raw" in n for n in notes)
    assert not any(n.startswith("anti_thrash:") for n in notes)


def test_austin_style_tape_path():
    preds = [
        {
            "recv": "2026-08-08T09:49:00+00:00",
            "bin": "97-98",
            "floor_f": 81,
            "daily_implied": {"99-100": 0.62, "97-98": 0.22},
        },
        {
            "recv": "2026-08-08T20:33:00+00:00",
            "bin": "99-100",
            "floor_f": 99,
            "daily_implied": {"99-100": 0.72, "97-98": 0.18},
        },
        {
            "recv": "2026-08-08T21:51:00+00:00",
            "bin": "99-100",
            "floor_f": 99,
            "daily_implied": {"97-98": 0.66, "99-100": 0.34},
        },
        {
            "recv": "2026-08-08T22:17:00+00:00",
            "bin": "99-100",
            "floor_f": 99,
            "daily_implied": {"99-100": 0.98, "97-98": 0.01},
        },
    ]
    enriched = apply_book_aware_bins(preds)
    path = []
    for r in enriched:
        b = r["bin_book_aware"]
        if not path or path[-1] != b:
            path.append(b)
    assert path == ["97-98", "99-100"], path

    roll = simulate_roll_policy(preds, settle_f=98.6, mode="book_aware")
    assert roll.path == ["97-98", "99-100"], roll.path
    assert roll.won is True
    assert any("blocked" in n for n in roll.notes)


if __name__ == "__main__":
    test_bin_reachable_given_floor()
    test_book_lead_blocked_when_fav_below_floor()
    test_book_lead_still_works_when_floor_allows()
    test_anti_thrash_cannot_hold_floor_dead_bin()
    test_austin_style_tape_path()
    print("ok")
