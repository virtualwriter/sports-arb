"""Per-city weather feed polling (Synoptic / NWS / AWC / tgftp / TWC)."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Callable
from zoneinfo import ZoneInfo

from lib.metar_tgroup import (
    is_auto_metar,
    metar_from_awc,
    metar_from_tgftp,
    metar_rows_from_awc,
    parse_metar_body_temp_c,
    parse_tgroup,
)
from lib.weather_cities import WeatherCity, get_city

SYN = "https://api.s.synopticdata.com/v2/stations/latest"
SYN_TS = "https://api.s.synopticdata.com/v2/stations/timeseries"
DEMO_TOKEN_URL = "https://demos.synopticdata.com/data/demotoken"
TWC_KEY = os.environ.get("TWC_API_KEY", "e1f10a1e78da46f5b10a1e78da96f525")
UA = {"User-Agent": "city-weather-feeds/1.0 (research@example.edu)"}


def get_json(url: str, headers: dict | None = None, timeout: float = 15, retries: int = 2) -> dict | list:
    last_exc: Exception | None = None
    for attempt in range(max(1, retries)):
        try:
            req = urllib.request.Request(url, headers=headers or UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode())
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            last_exc = exc
            if attempt + 1 < max(1, retries):
                time.sleep(0.4 * (attempt + 1))
    assert last_exc is not None
    raise last_exc


def fetch_synoptic_token() -> str:
    env = os.environ.get("SYNOPTIC_TOKEN")
    if env:
        return env
    req = urllib.request.Request(DEMO_TOKEN_URL, headers=UA)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode().strip()


def c_to_f(c: float) -> int:
    return round(c * 9 / 5 + 32)


def settle_from_ob(ob: dict) -> tuple[int | None, float | None]:
    tg = ob.get("tgroup") or {}
    if tg.get("temp_f_round") is not None:
        return int(tg["temp_f_round"]), tg.get("temp_f")
    tc = ob.get("temp_c_precise")
    if tc is None and ob.get("temp_c") is not None:
        tc = float(ob["temp_c"])
    if tc is not None:
        tf = tc * 9 / 5 + 32
        return round(tf), round(tf, 1)
    return None, None


def synoptic_day_max(city: WeatherCity, token: str, day_local: datetime | None = None) -> dict | None:
    """Max air_temp for the local calendar day (1-min if available, else station)."""
    stid = city.synoptic_1m_stid or city.synoptic_stid
    tz = ZoneInfo(city.local_tz)
    local = day_local.astimezone(tz) if day_local else datetime.now(tz)
    start_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
    end_local = local
    start = start_local.astimezone(timezone.utc).strftime("%Y%m%d%H%M")
    end = end_local.astimezone(timezone.utc).strftime("%Y%m%d%H%M")
    qs = urllib.parse.urlencode(
        {
            "stid": stid,
            "vars": "air_temp",
            "units": "temp|C",
            "token": token,
            "start": start,
            "end": end,
        }
    )
    d = get_json(f"{SYN_TS}?{qs}", timeout=25, retries=3)
    sts = d.get("STATION") or []
    if not sts:
        return None
    obs = sts[0].get("OBSERVATIONS") or {}
    times = obs.get("date_time") or []
    temps = obs.get("air_temp_set_1") or []
    best: tuple[datetime, float] | None = None
    for t, c in zip(times, temps):
        if c is None:
            continue
        try:
            dt = datetime.fromisoformat(str(t).replace("Z", "+00:00"))
            tc = float(c)
        except (TypeError, ValueError):
            continue
        if best is None or tc > best[1]:
            best = (dt, tc)
    if best is None:
        return None
    dt, tc = best
    precise = round(tc * 9 / 5 + 32, 1)
    return {
        "source": "synoptic_1m_backfill" if city.synoptic_1m_stid else "synoptic_backfill",
        "obs_ts": dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "temp_c": tc,
        "temp_f": round(precise),
        "temp_f_precise": precise,
        "n_obs": len([c for c in temps if c is not None]),
        "stid": stid,
    }


def metar_day_max(city: WeatherCity, day_local: datetime | None = None) -> dict | None:
    """Max settle temp from AWC METARs for the city's local calendar day.

    Live METAR polls only see the latest observation; after a mid-day restart the
    morning/peak METAR would otherwise be lost. AWC retains hourly+SPECI history.
    """
    tz = ZoneInfo(city.local_tz)
    local = day_local.astimezone(tz) if day_local else datetime.now(tz)
    start_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
    # Cover local midnight → now, with a small buffer; AWC caps around 48h.
    hours = int((local - start_local).total_seconds() // 3600) + 2
    hours = max(3, min(hours, 48))
    try:
        rows = metar_rows_from_awc(city.icao, hours=hours)
    except Exception:
        return None
    best: dict | None = None
    best_sf: int | None = None
    best_tf: float | None = None
    n_today = 0
    for row in rows:
        ots = row.get("obs_ts")
        if not ots:
            continue
        try:
            dt = datetime.fromisoformat(str(ots).replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        loc = dt.astimezone(tz)
        if loc < start_local or loc > local:
            continue
        n_today += 1
        sf, tf = settle_from_ob(row)
        if sf is None and row.get("temp_f") is not None:
            sf = int(row["temp_f"])
            tf = row.get("temp_f_precise")
        if sf is None:
            continue
        tf_f = float(tf) if tf is not None else float(sf)
        if (
            best is None
            or sf > (best_sf or -999)
            or (sf == best_sf and tf_f > (best_tf if best_tf is not None else -999.0))
        ):
            best = row
            best_sf = sf
            best_tf = tf_f
    if best is None or best_sf is None:
        return None
    out = dict(best)
    out["source"] = "awc_metar_backfill"
    out["temp_f"] = int(best_sf)
    out["temp_f_precise"] = best_tf
    out["n_obs"] = n_today
    out["icao"] = city.icao
    out["hours_lookback"] = hours
    return out


def poll_nws(city: WeatherCity) -> dict | None:
    url = f"https://api.weather.gov/stations/{city.icao}/observations/latest"
    p = get_json(url, UA)["properties"]
    t = p.get("temperature", {}).get("value")
    if t is None:
        return None
    tc = float(t)
    return {
        "source": "nws_5min",
        "obs_ts": p["timestamp"],
        "temp_c": tc,
        "temp_f": c_to_f(tc),
        "temp_f_precise": round(tc * 9 / 5 + 32, 1),
    }


def poll_synoptic_1m(city: WeatherCity, token: str) -> dict | None:
    stid = city.synoptic_1m_stid
    if not stid:
        # Fall back to station air_temp (e.g. KNYC) so NYC still has a live series.
        stid = city.synoptic_stid
        source = "synoptic_station"
    else:
        source = "synoptic_1m"
    qs = urllib.parse.urlencode(
        {"stid": stid, "vars": "air_temp", "units": "temp|C", "token": token, "session": "1"}
    )
    d = get_json(f"{SYN}?{qs}")
    sts = d.get("STATION") or []
    if not sts:
        return None
    obs = (sts[0].get("OBSERVATIONS") or {}).get("air_temp_value_1") or {}
    if obs.get("value") is None:
        return None
    tc = float(obs["value"])
    return {
        "source": source,
        "obs_ts": obs["date_time"],
        "temp_c": tc,
        "temp_f": c_to_f(tc),
        "temp_f_precise": round(tc * 9 / 5 + 32, 1),
        "stid": stid,
    }


def poll_synoptic_metar(city: WeatherCity, token: str) -> dict | None:
    qs = urllib.parse.urlencode(
        {"stid": city.synoptic_stid, "vars": "metar", "units": "temp|C", "token": token, "session": "1"}
    )
    d = get_json(f"{SYN}?{qs}")
    sts = d.get("STATION") or []
    if not sts:
        return None
    obs = (sts[0].get("OBSERVATIONS") or {}).get("metar_value_1") or {}
    raw = obs.get("value")
    if not raw:
        return None
    body_c = parse_metar_body_temp_c(raw)
    out: dict = {
        "source": "synoptic_metar",
        "obs_ts": obs.get("date_time"),
        "raw": raw[:140],
        "is_auto": is_auto_metar(raw),
    }
    if body_c is not None:
        out["temp_c"] = body_c
        out["temp_f"] = c_to_f(body_c)
        out["temp_f_precise"] = round(body_c * 9 / 5 + 32, 1)
    tg = parse_tgroup(raw)
    if tg:
        out["tgroup"] = tg
        out["temp_f"] = tg["temp_f_round"]
        out["temp_f_precise"] = tg["temp_f"]
    return out


def poll_awc_metar(city: WeatherCity) -> dict | None:
    ob = metar_from_awc(city.icao)
    if not ob:
        return None
    ob["source"] = "awc_metar"
    sf, tf = settle_from_ob(ob)
    if sf is not None:
        ob["temp_f"] = sf
        ob["temp_f_precise"] = tf
    return ob


def poll_tgftp(city: WeatherCity) -> dict | None:
    ob = metar_from_tgftp(city.icao)
    if not ob:
        return None
    ob["source"] = "noaa_tgftp"
    sf, tf = settle_from_ob(ob)
    if sf is not None:
        ob["temp_f"] = sf
        ob["temp_f_precise"] = tf
    return ob


def poll_twc(city: WeatherCity) -> dict | None:
    url = (
        f"https://api.weather.com/v3/wx/observations/current"
        f"?icaoCode={city.icao}&units=e&language=en-US&format=json&apiKey={TWC_KEY}"
    )
    try:
        d = get_json(url)
    except Exception:
        return None
    temp = d.get("temperature")
    if temp is None:
        return None
    return {
        "source": "twc",
        "obs_ts": d.get("validTimeUtc"),
        "valid_local": d.get("validTimeLocal"),
        "temp_f": int(temp),
        "max_since_7am": d.get("temperatureMaxSince7Am"),
    }


def make_feed_pollers(city: WeatherCity) -> tuple[tuple[str, Callable[[str], dict | None]], ...]:
    return (
        ("nws_5min", lambda _t: poll_nws(city)),
        ("synoptic_1m", lambda t: poll_synoptic_1m(city, t)),
        ("synoptic_metar", lambda t: poll_synoptic_metar(city, t)),
        ("awc_metar", lambda _t: poll_awc_metar(city)),
        ("noaa_tgftp", lambda _t: poll_tgftp(city)),
        ("twc", lambda _t: poll_twc(city)),
    )


# Back-compat Chicago defaults used by older imports.
_CHI = get_city("chicago")
ALL_FEED_POLLERS = make_feed_pollers(_CHI)
