"""Event-related API routes.

- ``GET /api/events-summary`` returns a lightweight per-event summary used
  to plot markers and corridors on the map.
- ``GET /api/events/{event_id}`` returns the full telemetry payload.
"""
from __future__ import annotations

import time

from fastapi import APIRouter

from app import cache

router = APIRouter()


@router.get("/api/events-summary")
async def events_summary():
    """Return lightweight per-event metadata grouped by category.

    Blocks until the background refresh thread has populated the lookup at
    least once. Only GPS tracks are included (not full telemetry) to keep
    the response small enough to render all markers at once.
    """
    while not cache.EVENT_LOOKUP:
        time.sleep(0.5)

    all_cache_data = cache.all_caches_by_category()
    summary = {k: [] for k in all_cache_data}

    for category, events in all_cache_data.items():
        for ev in events:
            if not ev or "data" not in ev or not ev["data"]:
                continue

            event_id = f"{category}_{ev['start']}"
            router_latlon = {
                rtr: {
                    "LATITUDE": data.get("LATITUDE", []),
                    "LONGITUDE": data.get("LONGITUDE", []),
                    "TIMESTAMP": data.get("TIMESTAMP", []),
                }
                for rtr, data in ev["data"].items()
            }

            summary[category].append({
                "event_id": event_id,
                "start": ev["start"],
                "front_router": ev["front_router"],
                "back_router": ev["back_router"],
                "Adhesion_Index_Murs_Min": ev.get("Adhesion_Index_Murs_Min"),
                "Adhesion_Index_Murs_Avg": ev.get("Adhesion_Index_Murs_Avg"),
                "all_axles_slide": ev.get("all_axles_slide"),
                "latitude": ev.get("latitude"),
                "longitude": ev.get("longitude"),
                "data": router_latlon,
                "worst_brake_performance": ev.get("worst_brake_performance"),
            })

    # Cache the summary so the offline-export ZIP route can reuse it
    cache.set_cached_events_summary(summary)
    return summary


@router.get("/api/events/{event_id}")
async def get_event(event_id: str):
    """Return the full telemetry payload for one event by composite ID."""
    event = cache.EVENT_LOOKUP.get(event_id)
    if not event:
        return {"error": "Event not found"}, 404
    return event
