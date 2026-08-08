"""Kalshi daily-high / hourly weather city configs.

Each city is a separate monitor entity (own feeds, series, ledger, LaunchAgent).
Hourly Kalshi tickers use Eastern hour labels for all cities (…HH = HH:00 EDT/EST).
Daily event day-stamps use the city's local calendar date.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class WeatherCity:
    key: str
    name: str
    icao: str
    lat: float
    lon: float
    local_tz: str
    daily_series: str
    hourly_series: str
    # Synoptic 1-min ASOS mesh (not available at Central Park).
    synoptic_1m_stid: str | None
    synoptic_stid: str
    # Kalshi hourly suffix timezone (empirically Eastern for CHI/NYC/AUS/LAX).
    market_tz: str = "America/New_York"
    cli_issuedby: str = ""


CITIES: dict[str, WeatherCity] = {
    "chicago": WeatherCity(
        key="chicago",
        name="Chicago",
        icao="KMDW",
        lat=41.786,
        lon=-87.752,
        local_tz="America/Chicago",
        daily_series="KXHIGHCHI",
        hourly_series="KXTEMPCHIH",
        synoptic_1m_stid="KMDW1M",
        synoptic_stid="KMDW",
        cli_issuedby="MDW",
    ),
    "nyc": WeatherCity(
        key="nyc",
        name="NYC",
        icao="KNYC",
        lat=40.77898,
        lon=-73.96925,
        local_tz="America/New_York",
        daily_series="KXHIGHNY",
        hourly_series="KXTEMPNYCH",
        synoptic_1m_stid=None,  # no public KNYC1M
        synoptic_stid="KNYC",
        cli_issuedby="NYC",
    ),
    "miami": WeatherCity(
        key="miami",
        name="Miami",
        icao="KMIA",
        lat=25.78800,
        lon=-80.31690,
        local_tz="America/New_York",
        daily_series="KXHIGHMIA",
        hourly_series="KXTEMPMIAH",
        synoptic_1m_stid="KMIA1M",
        synoptic_stid="KMIA",
        cli_issuedby="MIA",
    ),
    "austin": WeatherCity(
        key="austin",
        name="Austin",
        icao="KAUS",
        lat=30.19453,
        lon=-97.66988,
        local_tz="America/Chicago",
        daily_series="KXHIGHAUS",
        hourly_series="KXTEMPAUSH",
        synoptic_1m_stid="KAUS1M",
        synoptic_stid="KAUS",
        cli_issuedby="AUS",
    ),
    "la": WeatherCity(
        key="la",
        name="LA",
        icao="KLAX",
        lat=33.93819,
        lon=-118.38660,
        local_tz="America/Los_Angeles",
        daily_series="KXHIGHLAX",
        hourly_series="KXTEMPLAXH",
        synoptic_1m_stid="KLAX1M",
        synoptic_stid="KLAX",
        cli_issuedby="LAX",
    ),
}


ALIASES = {
    "chi": "chicago",
    "mdw": "chicago",
    "newyork": "nyc",
    "new-york": "nyc",
    "ny": "nyc",
    "mia": "miami",
    "aus": "austin",
    "lax": "la",
    "losangeles": "la",
    "los-angeles": "la",
}


def get_city(name: str) -> WeatherCity:
    key = (name or "").strip().lower()
    key = ALIASES.get(key, key)
    if key not in CITIES:
        known = ", ".join(sorted(CITIES))
        raise KeyError(f"unknown city {name!r}; expected one of: {known}")
    return CITIES[key]


def list_cities() -> list[str]:
    return list(CITIES.keys())
