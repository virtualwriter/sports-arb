"""Research roll basics: min-buy mid + same-row sizing at actual mid."""

from __future__ import annotations

from lib.weather_hourly_hedge_filter import bin_for_temp, simulate_roll_policy


def _row(recv: str, bin_label: str, mid: float, other: dict[str, float] | None = None) -> dict:
    di = {bin_label: mid}
    if other:
        di.update(other)
    return {"recv": recv, "bin": bin_label, "daily_implied": di}


def test_bin_for_temp_ceiling_and_range():
    labels = ["<=88", "89-90", "91-92"]
    assert bin_for_temp(87, labels) == "<=88"
    assert bin_for_temp(88, labels) == "<=88"
    assert bin_for_temp(89, labels) == "89-90"
    assert bin_for_temp(90, labels) == "89-90"


def test_cheap_fill_sizes_at_actual_mid():
    preds = [
        _row("2026-08-08T12:00:00+00:00", "83-84", 0.22),
    ]
    roll = simulate_roll_policy(preds, settle_f=83.0, mode="model", min_buy_mid=0.05)
    # $1000 / 0.22 ≈ 4545 contracts → win ≈ +$3545
    assert roll.won is True
    assert roll.held == "83-84"
    assert roll.pnl > 3000


def test_roll_into_cheap_bin_uses_actual_mid():
    preds = [
        _row("2026-08-08T12:00:00+00:00", "85-86", 0.56, {"83-84": 0.20}),
        _row("2026-08-08T16:00:00+00:00", "83-84", 0.22, {"85-86": 0.40}),
    ]
    roll = simulate_roll_policy(preds, settle_f=83.0, mode="model", min_buy_mid=0.05)
    assert roll.won is True
    assert roll.path == ["85-86", "83-84"]
    # Sell 85-86 @40¢, buy 83-84 @22¢ → leveraged win well above stake.
    assert roll.pnl > 2000


def test_dust_below_min_buy_is_skipped():
    preds = [
        _row("2026-08-08T12:00:00+00:00", "83-84", 0.04),
    ]
    roll = simulate_roll_policy(preds, settle_f=83.0, mode="model", min_buy_mid=0.05)
    assert roll.held is None
    assert roll.pnl == 0.0


if __name__ == "__main__":
    test_bin_for_temp_ceiling_and_range()
    test_cheap_fill_sizes_at_actual_mid()
    test_roll_into_cheap_bin_uses_actual_mid()
    test_dust_below_min_buy_is_skipped()
    print("ok")
