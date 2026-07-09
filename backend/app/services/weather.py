"""Historical weather lookup via Open-Meteo's archive API.

For each event we fetch the weather at the event hour and the hour before,
which lets the frontend show "conditions leading into the event". Absolute
humidity is derived from temperature + RH using the Magnus formula.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
_REQUEST_TIMEOUT_S = 15


def absolute_humidity(temp_c, rh):
    """Absolute humidity (g/m³) from temperature (°C) and relative humidity (%).

    Uses the Magnus formula for saturation vapour pressure.
    """
    es = 6.112 * math.exp((17.67 * temp_c) / (temp_c + 243.5))
    e = (rh / 100.0) * es
    return 216.7 * e / (temp_c + 273.15)


def _fallback_block(timestamp):
    """Placeholder string used when the API call fails."""
    return (
        f"🕒 Time: {timestamp}\n"
        "🌡 Temp: None °C\n"
        "💨 Wind: 0.0 km/h\n"
        "☔ Rain: 0 mm\n"
        "☁ Cloud cover: 0 %\n"
        "💧 Relative Humidity: None %\n"
        "🌫 Absolute Humidity: None g/m³"
    )


def get_weather(lat, lon, timestamp):
    """Return `[current_hour_str, previous_hour_str]` pretty-printed blocks.

    Any network or parsing failure returns two fallback blocks so the
    frontend always has something to render.
    """
    try:
        if isinstance(timestamp, str):
            timestamp = datetime.fromisoformat(timestamp.split(".")[0])

        target = timestamp.replace(minute=0, second=0, microsecond=0)
        previous = target - timedelta(hours=1)

        url = (
            f"{_ARCHIVE_URL}?latitude={lat}&longitude={lon}"
            f"&start_date={previous.strftime('%Y-%m-%d')}"
            f"&end_date={target.strftime('%Y-%m-%d')}"
            "&hourly=temperature_2m,precipitation,windspeed_10m,cloudcover,relative_humidity_2m"
        )

        resp = requests.get(url, timeout=_REQUEST_TIMEOUT_S, verify=False)
        if resp.status_code != 200:
            raise requests.HTTPError(f"Status {resp.status_code}")

        data = resp.json()
        if "hourly" not in data or "time" not in data["hourly"]:
            raise ValueError("No hourly data returned")

        times = data["hourly"]["time"]
        temps = data["hourly"].get("temperature_2m", [])
        winds = data["hourly"].get("windspeed_10m", [])
        rains = data["hourly"].get("precipitation", [])
        clouds = data["hourly"].get("cloudcover", [])
        humidity = data["hourly"].get("relative_humidity_2m", [])

        if not times:
            raise ValueError("Empty hourly.time array")

        def _to_dt(s):
            return datetime.fromisoformat(s)

        def _extract_for(ts):
            idx = min(range(len(times)), key=lambda i: abs(_to_dt(times[i]) - ts))
            temp = temps[idx] if idx < len(temps) else None
            wind = winds[idx] if idx < len(winds) else 0.0
            rain = rains[idx] if idx < len(rains) else 0.0
            cloud = clouds[idx] if idx < len(clouds) else 0
            hum = humidity[idx] if idx < len(humidity) else None

            if temp is not None and hum is not None:
                abs_hum_str = f"{absolute_humidity(temp, hum):.2f} g/m³"
            else:
                abs_hum_str = "None"

            return (
                f"🕒 Time: {ts.isoformat()}\n"
                f"🌡 Temp: {temp if temp is not None else 'None'} °C\n"
                f"💨 Wind: {float(wind):.1f} km/h\n"
                f"☔ Rain: {float(rain)} mm\n"
                f"☁ Cloud cover: {int(cloud)} %\n"
                f"💧 Relative Humidity: {int(hum)} %\n"
                f"🌫 Absolute Humidity: {abs_hum_str}"
            )

        return [_extract_for(target), _extract_for(previous)]

    except Exception as e:  # noqa: BLE001
        print(f"❌ Weather fetch failed for {lat}, {lon} at {timestamp}: {repr(e)}")
        return [_fallback_block(timestamp), _fallback_block(timestamp)]
