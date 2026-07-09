"""Network-Rail slide-event CSV lookup (formation + diagram metadata).

The pipeline_165004/ folder exports one row per scheduled train journey
involving 165004. At query time we need to find the journey that covers a
given event timestamp; this module loads the CSV once and answers those
interval queries quickly.
"""
from __future__ import annotations

import pandas as pd

# Module-level state (mirrors the original main.py design so the background
# refresh thread and the HTTP handlers share one loaded dataset).
slide_lookup: dict = {}
interval_index: pd.IntervalIndex | None = None

# Columns stored pipe-delimited in the CSV; they become Python lists on load.
_MULTI_COLS = ["vehicle_ids", "vehicle_types", "fleet_ids", "planned_resource_groups"]


def load_wheel_slide_csv(csv_path: str) -> None:
    """Load the slide-event CSV into `slide_lookup` + `interval_index`.

    Safe to call multiple times — each call replaces the previous state.
    """
    global slide_lookup, interval_index

    df = pd.read_csv(csv_path)
    df["start_time"] = pd.to_datetime(df["start_time"])
    df["end_time"] = pd.to_datetime(df["end_time"])

    for col in _MULTI_COLS:
        if col in df.columns:
            df[col] = df[col].fillna("").astype(str).apply(lambda x: x.split("|") if x not in ("", "nan") else [])

    slide_lookup = df.to_dict(orient="index")
    interval_index = pd.IntervalIndex.from_arrays(
        df["start_time"], df["end_time"], closed="both",
    )


def get_slide_data_between(time_val, cab_active_on_either):
    """Find the slide-event row whose interval covers `time_val`.

    The formation order returned is flipped when necessary so that the list
    always runs front-to-back relative to the *currently active cab* of the
    target unit (165004). This keeps the frontend's lead/follow diagram
    aligned with the real physical orientation.
    """
    some_time = pd.to_datetime(time_val) if isinstance(time_val, str) else time_val

    intervals = pd.IntervalIndex.from_arrays(
        pd.to_datetime([data["start_time"] for data in slide_lookup.values()]),
        pd.to_datetime([data["end_time"] for data in slide_lookup.values()]),
        closed="both",
    )

    idxs, _ = intervals.get_indexer_non_unique([some_time])
    valid_idxs = [
        idx for idx in idxs if intervals[idx].left <= some_time <= intervals[idx].right
    ]

    if not valid_idxs:
        return {
            "status": "no info found",
            "vehicle_ids": [],
            "vehicle_types": [],
            "planned_resource_groups": [],
            "fleet_ids": [],
        }

    slide_data = slide_lookup[valid_idxs[0]].copy()

    prgs = slide_data.get("planned_resource_groups", [])
    fleet_ids = slide_data.get("fleet_ids", [])
    vehicle_ids = slide_data.get("vehicle_ids", [])
    vehicle_types = slide_data.get("vehicle_types", [])

    flip = False
    if prgs:
        # Flip so 165004's end aligns with whichever cab is currently active.
        if cab_active_on_either and prgs[0] != "165004":
            flip = True
        elif not cab_active_on_either and prgs[0] == "165004":
            flip = True

    if flip:
        slide_data["planned_resource_groups"] = prgs[::-1]
        slide_data["fleet_ids"] = fleet_ids[::-1]
        slide_data["vehicle_ids"] = vehicle_ids[::-1]
        slide_data["vehicle_types"] = vehicle_types[::-1]

    slide_data["status"] = "found"
    return slide_data
