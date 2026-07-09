"""Brake-performance scoring over an event timeline.

For each contiguous period of constant brake-demand we compute the achieved
deceleration and compare it against the required deceleration band for that
demand level. The worst (most-negative) percentage difference across
segments ≥ 10 s gives the event-level `worst_brake_performance` KPI.
"""
from __future__ import annotations

from calc_murs import get_brake_demand_state

# Required deceleration (m/s²) per brake-demand level.
# Level 0 = no braking (no requirement).
REQUIRED_DECELERATION = {0: None, 1: 0.40, 2: 0.70, 3: 0.88, 4: 1.18}

# Ignore segments shorter than this — too noisy to be meaningful
MIN_SEGMENT_SECONDS = 10


def calculate_brake_performance(timestamps, brake1, brake2, emergency, tacho, wheel_slide):
    """Score achieved-vs-required deceleration per brake-demand segment.

    Returns:
        dict with:
          - ``results``: list of per-segment dicts (speeds, deltas, % diff).
          - ``worst_brake_performance``: most-negative % diff among segments
            ≥ ``MIN_SEGMENT_SECONDS`` long, or ``None`` if nothing qualifies.
    """
    n = min(
        len(timestamps), len(brake1), len(brake2),
        len(emergency), len(tacho), len(wheel_slide),
    )
    if n == 0:
        return {"results": [], "worst_brake_performance": None}

    # Convert tacho speed km/h → m/s
    average_speed = [tacho[i] * 1000 / 3600 for i in range(n)]
    brake_demand = [get_brake_demand_state(brake1[i], brake2[i], emergency[i]) for i in range(n)]
    wheel_slide = [1 if w else 0 for w in wheel_slide]

    # Split timeline into contiguous constant-demand segments
    segments = []
    last_state = brake_demand[0]
    seg_start = 0
    for i in range(n):
        if brake_demand[i] != last_state:
            segments.append((seg_start, i - 1))
            seg_start = i
            last_state = brake_demand[i]
    segments.append((seg_start, len(timestamps) - 1))

    results = []
    worst_brake_performance = None

    for start_idx, end_idx in segments:
        start_time = timestamps[start_idx]
        end_time = timestamps[end_idx]
        start_speed = average_speed[start_idx]
        end_speed = average_speed[end_idx]
        delta_t = (end_time - start_time).total_seconds()

        if end_speed < 1:
            # Train stopped — deceleration calc is unreliable near v≈0
            achieved = None
        elif delta_t > 0:
            achieved = (start_speed - end_speed) / delta_t
        else:
            achieved = None

        demand = brake_demand[start_idx]
        required = REQUIRED_DECELERATION.get(demand)
        percent = (
            ((achieved - required) / required * 100)
            if required is not None and achieved is not None
            else None
        )

        results.append({
            "start_timestamp": start_time,
            "end_timestamp": end_time,
            "time_diff": delta_t,
            "start_speed": start_speed,
            "end_speed": end_speed,
            "achieved_deceleration": achieved,
            "required_deceleration": required,
            "percentage_difference": percent,
            "wheel_slide": wheel_slide[start_idx],
            "brake_demand": demand,
        })

        if delta_t >= MIN_SEGMENT_SECONDS and percent is not None:
            if worst_brake_performance is None or percent < worst_brake_performance:
                worst_brake_performance = percent

    return {"results": results, "worst_brake_performance": worst_brake_performance}
