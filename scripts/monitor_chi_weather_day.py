#!/usr/bin/env python3
"""Backward-compatible Chicago entrypoint → monitor_city_weather_day --city chicago."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Re-export / delegate so LaunchAgent + old commands keep working.
from monitor_city_weather_day import main  # noqa: E402


if __name__ == "__main__":
    # Default city=chicago is set in monitor_city_weather_day; ensure flag present
    # only when caller didn't already pass --city.
    if "--city" not in sys.argv:
        sys.argv[1:1] = ["--city", "chicago"]
    main()
