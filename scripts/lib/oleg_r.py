"""Oleg-R: retrained Oleg — walk-forward refit Fourier + ARMA(1,2) + monthly sigma.

Differences from the static Oleg (lib/oleg.py):
  - Coefficients refit on all observed highs strictly before a cutoff
    (walk-forward; monthly cadence via OlegRCache). Original Oleg is frozen
    on the 2025 workbook fit forever.
  - Bin probabilities use a per-calendar-month innovation sigma (shrunk
    toward the global sigma), so winter forecasts stop pretending to be as
    sharp as August ones.

Pure stdlib: Fourier via OLS normal equations, ARMA(1,2) via conditional
sum of squares minimized with Nelder-Mead. Deterministic.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, timedelta

from lib.oleg import EPOCH, OlegForecast


# ---------------------------------------------------------------- Fourier OLS

def _fourier_row(d: date) -> list[float]:
    t = (d - EPOCH).days
    w = 2.0 * math.pi * t / 365.25
    return [1.0, math.sin(w), math.cos(w), math.sin(2 * w), math.cos(2 * w)]


def _solve(a: list[list[float]], b: list[float]) -> list[float]:
    """Gaussian elimination with partial pivoting (small dense systems)."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[piv][col]) < 1e-12:
            raise ValueError("singular normal equations")
        m[col], m[piv] = m[piv], m[col]
        for r in range(col + 1, n):
            f = m[r][col] / m[col][col]
            for c in range(col, n + 1):
                m[r][c] -= f * m[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (m[r][n] - sum(m[r][c] * x[c] for c in range(r + 1, n))) / m[r][r]
    return x


def fit_fourier(obs: dict[date, float]) -> list[float]:
    """OLS fit of [const, sin1, cos1, sin2, cos2] on observed highs."""
    days = sorted(obs)
    xtx = [[0.0] * 5 for _ in range(5)]
    xty = [0.0] * 5
    for d in days:
        row = _fourier_row(d)
        y = obs[d]
        for i in range(5):
            xty[i] += row[i] * y
            for j in range(5):
                xtx[i][j] += row[i] * row[j]
    return _solve(xtx, xty)


# ------------------------------------------------------------ ARMA(1,2) CSS

def _css(params: list[float], resid: list[float]) -> float:
    """Conditional sum of squares for ARMA(1,2) on a residual series."""
    ar1, ma1, ma2 = params
    if not (-0.99 < ar1 < 0.99):
        return 1e18
    u_prev = eps1 = eps2 = 0.0
    total = 0.0
    for u in resid:
        u_hat = ar1 * u_prev + ma1 * eps1 + ma2 * eps2
        eps = u - u_hat
        total += eps * eps
        u_prev, eps1, eps2 = u, eps, eps1
    return total


def _nelder_mead(
    fn, x0: list[float], *, step: float = 0.1, iters: int = 400, tol: float = 1e-10
) -> list[float]:
    n = len(x0)
    simplex = [x0[:]]
    for i in range(n):
        p = x0[:]
        p[i] += step
        simplex.append(p)
    vals = [fn(p) for p in simplex]
    for _ in range(iters):
        order = sorted(range(n + 1), key=lambda i: vals[i])
        simplex = [simplex[i] for i in order]
        vals = [vals[i] for i in order]
        if abs(vals[-1] - vals[0]) < tol:
            break
        centroid = [sum(p[i] for p in simplex[:-1]) / n for i in range(n)]
        refl = [centroid[i] + (centroid[i] - simplex[-1][i]) for i in range(n)]
        fr = fn(refl)
        if fr < vals[0]:
            exp = [centroid[i] + 2 * (centroid[i] - simplex[-1][i]) for i in range(n)]
            fe = fn(exp)
            simplex[-1], vals[-1] = (exp, fe) if fe < fr else (refl, fr)
        elif fr < vals[-2]:
            simplex[-1], vals[-1] = refl, fr
        else:
            con = [centroid[i] + 0.5 * (simplex[-1][i] - centroid[i]) for i in range(n)]
            fc = fn(con)
            if fc < vals[-1]:
                simplex[-1], vals[-1] = con, fc
            else:
                for i in range(1, n + 1):
                    simplex[i] = [(simplex[i][j] + simplex[0][j]) / 2 for j in range(n)]
                    vals[i] = fn(simplex[i])
    return min(zip(vals, simplex))[1]


def fit_arma12(resid: list[float]) -> tuple[float, float, float, float]:
    """Fit (ar1, ma1, ma2) by CSS; returns (ar1, ma1, ma2, sigma2)."""
    best = _nelder_mead(lambda p: _css(p, resid), [0.5, 0.0, 0.0])
    sigma2 = _css(best, resid) / max(1, len(resid))
    return best[0], best[1], best[2], sigma2


# ------------------------------------------------------------------- model

@dataclass
class OlegRModel:
    cutoff: date  # fit uses obs strictly before this date
    fourier_coefs: list[float]
    ar1: float
    ma1: float
    ma2: float
    sigma2: float
    monthly_sigma: dict[int, float] = field(default_factory=dict)
    n_train: int = 0

    def fourier(self, d: date) -> float:
        return sum(c * x for c, x in zip(self.fourier_coefs, _fourier_row(d)))

    def sigma_for(self, d: date) -> float:
        return self.monthly_sigma.get(d.month, math.sqrt(self.sigma2))

    def forecast(self, day: date, highs: dict[date, float]) -> OlegForecast:
        """One-step-ahead conditioned forecast using obs strictly before day."""
        obs_days = sorted(d for d in highs if d < day)
        mean = self.fourier(day)
        n_used = 0
        last_obs = None
        if obs_days:
            last_obs = obs_days[-1]
            u_prev = eps1 = eps2 = 0.0
            d = obs_days[0]
            while d < day:
                u_hat = self.ar1 * u_prev + self.ma1 * eps1 + self.ma2 * eps2
                if d in highs:
                    u = highs[d] - self.fourier(d)
                    eps = u - u_hat
                    n_used += 1
                else:
                    u, eps = u_hat, 0.0
                u_prev, eps1, eps2 = u, eps, eps1
                d += timedelta(days=1)
            if (day - last_obs).days <= 10:
                mean += self.ar1 * u_prev + self.ma1 * eps1 + self.ma2 * eps2
        return OlegForecast(
            day=day,
            mean_f=mean,
            sigma_f=self.sigma_for(day),
            mode="oleg_r",
            n_obs_used=n_used,
            last_obs_day=last_obs,
        )


def fit_oleg_r(
    highs: dict[date, float],
    cutoff: date,
    *,
    shrink_n: float = 15.0,
) -> OlegRModel:
    """Fit on all obs strictly before cutoff; monthly sigma shrunk to global."""
    train = {d: v for d, v in highs.items() if d < cutoff}
    if len(train) < 90:
        raise ValueError(f"need >=90 obs before {cutoff}, have {len(train)}")
    coefs = fit_fourier(train)

    def fourier(d: date) -> float:
        return sum(c * x for c, x in zip(coefs, _fourier_row(d)))

    days = sorted(train)
    resid = [train[d] - fourier(d) for d in days]
    ar1, ma1, ma2, sigma2 = fit_arma12(resid)

    # One-step innovations per calendar month -> seasonal sigma (shrunk).
    by_month: dict[int, list[float]] = {}
    u_prev = eps1 = eps2 = 0.0
    d = days[0]
    i = 0
    while d < cutoff:
        u_hat = ar1 * u_prev + ma1 * eps1 + ma2 * eps2
        if i < len(days) and days[i] == d:
            u = resid[i]
            eps = u - u_hat
            by_month.setdefault(d.month, []).append(eps)
            i += 1
        else:
            u, eps = u_hat, 0.0
        u_prev, eps1, eps2 = u, eps, eps1
        d += timedelta(days=1)

    g = math.sqrt(sigma2)
    monthly: dict[int, float] = {}
    for m, eps_list in by_month.items():
        n = len(eps_list)
        s = math.sqrt(sum(e * e for e in eps_list) / n)
        w = n / (n + shrink_n)
        monthly[m] = w * s + (1 - w) * g

    return OlegRModel(
        cutoff=cutoff,
        fourier_coefs=coefs,
        ar1=ar1,
        ma1=ma1,
        ma2=ma2,
        sigma2=sigma2,
        monthly_sigma=monthly,
        n_train=len(train),
    )


class OlegRCache:
    """Walk-forward monthly refits: forecasts for day D use the model fit at
    the first of D's month (trained on obs strictly before it)."""

    def __init__(self, highs: dict[date, float]):
        self.highs = highs
        self._models: dict[tuple[int, int], OlegRModel] = {}

    def model_for(self, day: date) -> OlegRModel:
        key = (day.year, day.month)
        model = self._models.get(key)
        if model is None:
            cutoff = date(day.year, day.month, 1)
            model = fit_oleg_r(self.highs, cutoff)
            self._models[key] = model
        return model

    def forecast(self, day: date) -> OlegForecast:
        model = self.model_for(day)
        prior = {k: v for k, v in self.highs.items() if k < day}
        return model.forecast(day, prior)
