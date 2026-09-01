"""Oleg: NYC Central Park daily-high model — Fourier seasonality + ARMA(1,2) errors.

Coefficients fit on 2025 Central Park (GHCN USW00094728) daily highs, taken
verbatim from the Model tab of NYC_Central_Park_High_Temp_Model_Backtest.xlsx.

Two forecast modes:
  - frozen (the workbook backtest): pure seasonal curve; the ARMA state decays
    from end-of-training and is ~0 within two weeks. Never sees new obs.
  - conditioned (one-step-ahead): innovation-filter the ARMA(1,2) over observed
    daily highs, so each forecast uses yesterday's residual. This is the mode
    the equation was built for.

Also exposes a per-bin probability distribution (normal CDF over Kalshi bin
edges) so Oleg can be compared against market prices, not just settles.

Time index: t = days since 2025-01-01 (t=0 on Jan 1 2025), verified to
reproduce the workbook forecast column to 4 decimals.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

EPOCH = date(2025, 1, 1)

CONST = 62.642548060214644
SIN1 = -6.57062628598799
COS1 = -22.824814445424987
SIN2 = 0.7759343378631948
COS2 = -3.035695780488154
AR1 = 0.6745151985413088
MA1 = -0.170931110095793
MA2 = -0.185030643795193
SIGMA2 = 44.47170829314413  # full-year innovation variance from training

DEFAULT_HIGHS_STORE = Path("/var/lib/sports-arb/data/central-park-daily-highs.json")


def fourier(d: date) -> float:
    """Seasonal mean for a calendar date."""
    t = (d - EPOCH).days
    w = 2.0 * math.pi * t / 365.25
    return CONST + SIN1 * math.sin(w) + COS1 * math.cos(w) + SIN2 * math.sin(2 * w) + COS2 * math.cos(2 * w)


@dataclass
class OlegForecast:
    day: date
    mean_f: float
    sigma_f: float
    mode: str  # "frozen" | "conditioned"
    n_obs_used: int = 0
    last_obs_day: date | None = None

    def bin_probs(self, bins: list[str]) -> dict[str, float]:
        """P(settle lands in bin) for Kalshi-style bin labels.

        Labels: "82-83" (half-open [81.5, 83.5) on whole-degree settles),
        "<=79", ">=85". Uses a normal around mean_f. Whole-degree bin `a-b`
        covers reported highs a..b, i.e. true temp in [a-0.5, b+0.5).
        """
        out: dict[str, float] = {}
        for label in bins:
            lo, hi = _bin_edges(label)
            p_hi = _norm_cdf((hi - self.mean_f) / self.sigma_f) if hi is not None else 1.0
            p_lo = _norm_cdf((lo - self.mean_f) / self.sigma_f) if lo is not None else 0.0
            out[label] = max(0.0, p_hi - p_lo)
        return out

    def pick_bin(self, bins: list[str]) -> str | None:
        probs = self.bin_probs(bins)
        if not probs:
            return None
        return max(probs.items(), key=lambda kv: kv[1])[0]


def _bin_edges(label: str) -> tuple[float | None, float | None]:
    label = label.strip()
    if label.startswith("<="):
        return None, float(label[2:]) + 0.5
    if label.startswith(">="):
        return float(label[2:]) - 0.5, None
    if label.startswith("<"):
        return None, float(label[1:]) - 0.5
    if label.startswith(">"):
        return float(label[1:]) + 0.5, None
    if "-" in label:
        a, b = label.split("-", 1)
        return float(a) - 0.5, float(b) + 0.5
    v = float(label)
    return v - 0.5, v + 0.5


def _norm_cdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def load_highs(store: Path = DEFAULT_HIGHS_STORE) -> dict[date, float]:
    """date -> official daily high from the feed store."""
    raw = json.loads(Path(store).read_text())
    out: dict[date, float] = {}
    for day_s, rec in raw.items():
        try:
            out[date.fromisoformat(day_s)] = float(rec["high_f"])
        except (ValueError, KeyError, TypeError):
            continue
    return out


def forecast_frozen(day: date) -> OlegForecast:
    """Workbook mode: bare seasonal curve (ARMA long since decayed)."""
    return OlegForecast(day=day, mean_f=fourier(day), sigma_f=math.sqrt(SIGMA2), mode="frozen")


def forecast_conditioned(
    day: date,
    highs: dict[date, float],
    *,
    sigma_f: float | None = None,
    max_gap_days: int = 10,
) -> OlegForecast:
    """One-step-ahead forecast for `day` using obs strictly before `day`.

    Runs the ARMA(1,2) innovation recursion over the observed residual series:
      u_hat_t = AR1*u_{t-1} + MA1*eps_{t-1} + MA2*eps_{t-2}
      eps_t   = u_t - u_hat_t          (when day t was observed)
    Missing days propagate the prediction (u carried as u_hat, eps=0).
    If the last obs is older than `max_gap_days`, degrades toward frozen.
    """
    obs_days = sorted(d for d in highs if d < day)
    if not obs_days:
        return forecast_frozen(day)

    start = obs_days[0]
    u_prev = 0.0  # u_{t-1} (actual residual if observed, else predicted)
    eps1 = 0.0  # eps_{t-1}
    eps2 = 0.0  # eps_{t-2}
    n_used = 0

    d = start
    while d < day:
        u_hat = AR1 * u_prev + MA1 * eps1 + MA2 * eps2
        if d in highs:
            u = highs[d] - fourier(d)
            eps = u - u_hat
            n_used += 1
        else:
            u = u_hat
            eps = 0.0
        u_prev, eps1, eps2 = u, eps, eps1
        d += timedelta(days=1)

    last_obs = obs_days[-1]
    gap = (day - last_obs).days
    mean = fourier(day) + AR1 * u_prev + MA1 * eps1 + MA2 * eps2
    if gap > max_gap_days:
        return forecast_frozen(day)

    return OlegForecast(
        day=day,
        mean_f=mean,
        sigma_f=sigma_f if sigma_f is not None else math.sqrt(SIGMA2),
        mode="conditioned",
        n_obs_used=n_used,
        last_obs_day=last_obs,
    )
