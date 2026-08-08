"""Backward-compatible Chicago feed exports (see lib.weather_feeds)."""

from __future__ import annotations

from lib.weather_cities import get_city
from lib.weather_feeds import (  # noqa: F401
    ALL_FEED_POLLERS,
    c_to_f,
    fetch_synoptic_token,
    get_json,
    make_feed_pollers,
    metar_day_max as _metar_day_max,
    poll_awc_metar as _poll_awc_metar,
    poll_nws as _poll_nws,
    poll_synoptic_1m as _poll_synoptic_1m,
    poll_synoptic_metar as _poll_synoptic_metar,
    poll_tgftp as _poll_tgftp,
    poll_twc as _poll_twc,
    settle_from_ob,
    synoptic_day_max as _synoptic_day_max,
)

_CHI = get_city("chicago")
ICAO = _CHI.icao
LOCAL_TZ = _CHI.local_tz


def poll_nws():
    return _poll_nws(_CHI)


def poll_synoptic_1m(token: str):
    return _poll_synoptic_1m(_CHI, token)


def poll_synoptic_metar(token: str):
    return _poll_synoptic_metar(_CHI, token)


def poll_awc_metar():
    return _poll_awc_metar(_CHI)


def poll_tgftp():
    return _poll_tgftp(_CHI)


def poll_twc():
    return _poll_twc(_CHI)


def synoptic_day_max(token: str, day_local=None):
    return _synoptic_day_max(_CHI, token, day_local)


def metar_day_max(day_local=None):
    return _metar_day_max(_CHI, day_local)
