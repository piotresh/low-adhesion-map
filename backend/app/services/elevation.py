"""Elevation & slope lookup for an event's GPS track.

Queries the OpenTopoData SRTM-90m API for the start/end elevations of an
event and returns the total planar (Haversine) distance and net slope.

The first and last 10 s of the track are trimmed to avoid stationary GPS
noise at event boundaries.
"""
from __future__ import annotations

import math
from datetime import timedelta

import requests

# SRTM-90m covers the UK with ~90 m horizontal resolution; sufficient for slope.
_ELEVATION_URL = "https://api.opentopodata.org/v1/srtm90m"
_REQUEST_TIMEOUT_S = 10
_BOUNDARY_TRIM_S = 10

_EMPTY = {
    "start_elevation": None,
    "end_elevation": None,
    "elevations": [None, None],
    "total_distance": None,
    "slope": None,
    "net_elevation_change": None,
}


def _haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres between two GPS coordinates."""
    R = 6371000  # Earth radius in metres
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def get_elevation(coords):
    """Compute start/end elevation, Haversine distance and slope.

    Args:
        coords: iterable of `(lat, lon, timestamp)` tuples.

    Returns:
        dict with ``start_elevation``, ``end_elevation``, ``elevations``,
        ``total_distance`` (m), ``slope`` (m/m) and ``net_elevation_change`` (m).
        Returns sentinel `None` values on any failure or insufficient input.
    """
    if not coords or len(coords) < 2:
        return dict(_EMPTY)

    timestamps = [t for (_, _, t) in coords if t is not None]
    if not timestamps:
        return dict(_EMPTY)

    min_t, max_t = min(timestamps), max(timestamps)
    filtered_coords = [
        (lat, lon, t)
        for (lat, lon, t) in coords
        if t is not None
        and (t - min_t) > timedelta(seconds=_BOUNDARY_TRIM_S)
        and (max_t - t) > timedelta(seconds=_BOUNDARY_TRIM_S)
    ]
    if len(filtered_coords) < 2:
        return dict(_EMPTY)

    start, end = filtered_coords[0], filtered_coords[-1]
    locations = f"{start[0]},{start[1]}|{end[0]},{end[1]}"

    try:
        response = requests.get(
            _ELEVATION_URL, params={"locations": locations}, timeout=_REQUEST_TIMEOUT_S,
        )
        response.raise_for_status()
        results = response.json().get("results", [])
        if len(results) < 2:
            return dict(_EMPTY)

        start_elev = results[0].get("elevation")
        end_elev = results[1].get("elevation")
        # API can return null for valid coords over water
        if start_elev is None or end_elev is None:
            return dict(_EMPTY)
    except Exception:  # noqa: BLE001
        return dict(_EMPTY)

    total_distance = _haversine(start[0], start[1], end[0], end[1])
    net_elevation_change = end_elev - start_elev
    slope = net_elevation_change / total_distance if total_distance else None

    return {
        "start_elevation": start_elev,
        "end_elevation": end_elev,
        "elevations": [start_elev, end_elev],
        "total_distance": total_distance,
        "slope": slope,
        "net_elevation_change": net_elevation_change,
    }
