"""In-memory event cache + background refresh thread.

A single process-wide dictionary holds one list per event type, plus a flat
`{event_id: event}` lookup for O(1) `/api/events/{event_id}` hits. A daemon
thread refreshes the caches from Snowflake every `CACHE_REFRESH_SECONDS`.

Design note: the original `main.py` declared these as module globals; we
replicate that here so behaviour is unchanged, but expose them through this
module so API handlers import one canonical state.
"""
from __future__ import annotations

import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed

from app.config import CACHE_REFRESH_SECONDS, SLIDE_CSV_PATH
from app.db.snowflake import get_snowflake_connection
from app.services.fetcher import fetch_and_merge_pair_full
from app.services.slide_lookup import load_wheel_slide_csv

# Router pairs to fetch; extend to add more train units
PAIR_LIST = [(5, 6)]

# Per-event-type caches (replaced atomically each refresh cycle)
WHEEL_SLIDE_CACHE: list = []
WHEEL_SPIN_CACHE: list = []
EMERGENCY_BRAKE_CACHE: list = []
TRAIN_STOP_CACHE: list = []

# Flat event_id → event map rebuilt from the above after every refresh
EVENT_LOOKUP: dict = {}

# Last summary built by /api/events-summary (re-used by the offline-export
# path when zipping the frontend into a single HTML bundle)
CACHED_EVENTS_SUMMARY: dict = {}


def all_caches_by_category() -> dict[str, list]:
    """Return the 4 caches keyed by the category label used in event_ids."""
    return {
        "wheel_slide": WHEEL_SLIDE_CACHE,
        "wheel_spin": WHEEL_SPIN_CACHE,
        "emergency_brakes": EMERGENCY_BRAKE_CACHE,
        "train_stop": TRAIN_STOP_CACHE,
    }


def build_event_lookup() -> None:
    """Rebuild `EVENT_LOOKUP` from the four per-type caches."""
    global EVENT_LOOKUP
    EVENT_LOOKUP = {}
    for category, events in all_caches_by_category().items():
        for ev in events:
            if not ev or "data" not in ev or not ev["data"]:
                continue
            event_id = f"{category}_{ev['start']}"
            EVENT_LOOKUP[event_id] = ev


def _run_pairs(event_type: str) -> list:
    """Open a Snowflake connection and fetch all pairs for one event type."""
    conn_local = get_snowflake_connection()
    if not conn_local:
        print(f"⚠️  Skipping {event_type}: connection failed")
        return []
    try:
        with ThreadPoolExecutor(max_workers=len(PAIR_LIST)) as executor:
            results = list(executor.map(
                lambda pair: fetch_and_merge_pair_full(conn_local, *pair, event_type),
                PAIR_LIST,
            ))
        return [item for sub in results for item in sub]
    except Exception as e:  # noqa: BLE001
        print(f"❌ ERROR in event_type={event_type}: {type(e).__name__}: {e}")
        traceback.print_exc()
        return []
    finally:
        try:
            conn_local.close()
        except Exception:  # noqa: BLE001
            pass


def _refresh_cache_loop() -> None:
    """Infinite refresh loop (runs in a daemon thread)."""
    global WHEEL_SLIDE_CACHE, WHEEL_SPIN_CACHE, EMERGENCY_BRAKE_CACHE, TRAIN_STOP_CACHE

    load_wheel_slide_csv(SLIDE_CSV_PATH)

    while True:
        print("🔄 Refreshing cache...")
        try:
            event_types = ["WHEEL_SLIDE", "WHEEL_SPIN", "EMERGENCY_BRAKE", "TRAIN_STOP"]
            #event_types = ["WHEEL_SPIN"]
            with ThreadPoolExecutor(max_workers=4) as ex:
                futures = {ex.submit(_run_pairs, et): et for et in event_types}

                for future in as_completed(futures):
                    t = futures[future]
                    try:
                        cache = future.result()
                        if t == "WHEEL_SLIDE":
                            WHEEL_SLIDE_CACHE = cache
                        elif t == "WHEEL_SPIN":
                            WHEEL_SPIN_CACHE = cache
                        elif t == "EMERGENCY_BRAKE":
                            EMERGENCY_BRAKE_CACHE = cache
                        elif t == "TRAIN_STOP":
                            TRAIN_STOP_CACHE = cache
                        print(f"✅ {t}: {len(cache)} events cached")
                    except Exception as e:  # noqa: BLE001
                        print(f"❌ Error refreshing {t}: {e}")
        except Exception as e:  # noqa: BLE001
            print(f"❌ Error during refresh loop: {e}")

        build_event_lookup()
        print(f"💤 Sleeping {CACHE_REFRESH_SECONDS}s...")
        time.sleep(CACHE_REFRESH_SECONDS)


def start_background_refresh() -> None:
    """Kick off the refresh thread. Call once during app startup."""
    threading.Thread(target=_refresh_cache_loop, daemon=True).start()


def set_cached_events_summary(summary: dict) -> None:
    """Overwrite the last-built events summary (used by the ZIP exporter)."""
    global CACHED_EVENTS_SUMMARY
    CACHED_EVENTS_SUMMARY = summary


def get_cached_events_summary() -> dict:
    """Return whatever the last events-summary call produced (may be empty)."""
    return CACHED_EVENTS_SUMMARY
