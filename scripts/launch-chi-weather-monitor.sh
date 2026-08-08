#!/usr/bin/env bash
# Backward-compatible Chicago launcher → multi-city launcher.
exec bash "$(cd "$(dirname "$0")" && pwd)/launch-city-weather-monitor.sh" --city chicago "$@"
