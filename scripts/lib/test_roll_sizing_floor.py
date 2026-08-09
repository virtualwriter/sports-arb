"""De-luck knobs: min buy mid + sizing floor cap leverage on cheap fills."""

from __future__ import annotations

from lib.weather_hourly_hedge_filter import (
    RESEARCH_MIN_BUY_MID,
    SIZING_FLOOR_MID,
    bin_for_temp,
    simulate_roll_policy,
)


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


def test_sizing_floor_caps_open_leverage():
    preds = [
        _row("2026-08-08T12:00:00+00:00", "83-84", 0.22),
    ]
    lucky = simulate_roll_policy(preds, settle_f=83.0, mode="model", min_buy_mid=0.05)
    deluck = simulate_roll_policy(
        preds,
        settle_f=83.0,
        mode="model",
        min_buy_mid=RESEARCH_MIN_BUY_MID,
        sizing_floor_mid=SIZING_FLOOR_MID,
    )
    # Lucky: $1000 / 0.22 ≈ 4545 contracts → win ≈ +$3545
    assert lucky.won is True
    assert lucky.pnl > 3000
    # De-luck: skip open (22¢ < 25¢ min) → flat
    assert deluck.held is None
    assert deluck.pnl == 0.0


def test_sizing_floor_on_roll_into_cheap_bin():
    preds = [
        _row("2026-08-08T12:00:00+00:00", "85-86", 0.56, {"83-84": 0.20}),
        _row("2026-08-08T16:00:00+00:00", "83-84", 0.22, {"85-86": 0.40}),
    ]
    lucky = simulate_roll_policy(preds, settle_f=83.0, mode="model", min_buy_mid=0.05)
    deluck = simulate_roll_policy(
        preds,
        settle_f=83.0,
        mode="model",
        min_buy_mid=0.05,  # allow the fill
        sizing_floor_mid=SIZING_FLOOR_MID,
    )
    assert lucky.won is True and deluck.won is True
    # Same path, but de-luck sizes the 22¢ buy as 40¢ → much smaller P&L.
    assert lucky.path == ["85-86", "83-84"]
    assert deluck.path == ["85-86", "83-84"]
    assert deluck.pnl < lucky.pnl
    assert deluck.pnl < 2000  # no ~$3.7k lottery


if __name__ == "__main__":
    test_bin_for_temp_ceiling_and_range()
    test_sizing_floor_caps_open_leverage()
    test_sizing_floor_on_roll_into_cheap_bin()
    print("ok")
