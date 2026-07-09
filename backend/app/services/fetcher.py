"""Core Snowflake → enriched-event pipeline.

Fetches raw RUTX11 telemetry for a router pair and event type, clusters
hits into events, then enriches each event with:

  * Per-axle MURS (raw + derived) cleaned & smoothed
  * Axle weights from `ESRA_DERIVED_WEIGHTS`
  * Elevation + slope via OpenTopoData
  * Historical weather via Open-Meteo
  * Per-segment brake performance
  * Train orientation (front/back router)
  * Network-Rail slide metadata

One call returns a list of fully-enriched event dicts ready for caching.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from statistics import mean

import pandas as pd

from app.config import SNOWFLAKE_TABLE
from app.services.adhesion import get_adhesion_index
from app.services.brake_performance import calculate_brake_performance
from app.services.elevation import get_elevation
from app.services.murs import process_murs
from app.services.slide_lookup import get_slide_data_between
from app.services.train_orientation import determine_front_router
from app.services.weather import get_weather
from app.services.get_chain_info import get_closest_chain_info, load_geojson_data
from calc_murs import calculate_derived_murs, get_brake_demand_state

# TODO: move to config once date-range comes from the UI
START_DATE = "2025-10-01 00:00:00"
END_DATE = "2026-07-06 11:59:00"
TRAIN_STOP_START = "2026-09-01 23:00:00"
TRAIN_STOP_END = "2026-09-01 23:59:59"

# Pad each detected event by ±10 s to capture lead-in/out context
EVENT_PADDING_SECONDS = 10
# Merge consecutive hits within this gap into one event
EVENT_MERGE_GAP_SECONDS = 1

# Axles 1,2 (front bogie) and 5,6 (back bogie) carry 4 wheels each;
# axles 3,4 (middle)    carry 2 wheels each.
AXLE_WHEEL_SCALES = [4, 4, 2, 2, 4, 4]

_AXLE_INFO = {
    1: ("FS_WSP_M_AXLE1_IN_KPH", "BCP_M_AXLE1_IN_BAR", "axle_1"),
    2: ("FS_WSP_M_AXLE2_IN_KPH", "BCP_M_AXLE2_IN_BAR", "axle_2"),
    3: ("FS_WSP_M_AXLE3_4_IN_KPH", "BCP_M_AXLE3_4_IN_BAR", "axle_3"),
}

_MURS_RAW_KEYS = ["MURS_1", "MURS_2", "MURS_3_4"]
_MURS_DERIVED_TO_VVPOP = {
    "MURS_1_derived": "WSP_Y_VV1_POP2",
    "MURS_2_derived": "WSP_Y_VV2_POP4",
    "MURS_3_4_derived": "WSP_Y_VV3_POP6",
}

_DB_WEIGHT_MAP = {
    1: {"weight": "DERIVED_WEIGHT_AXLE1", "timestamp": "LAST_STABLE_TIMESTAMP_AXLE1",
        "lat": "LAST_STABLE_LATITUDE_AXLE1", "lon": "LAST_STABLE_LONGITUDE_AXLE1"},
    2: {"weight": "DERIVED_WEIGHT_AXLE2", "timestamp": "LAST_STABLE_TIMESTAMP_AXLE2",
        "lat": "LAST_STABLE_LATITUDE_AXLE2", "lon": "LAST_STABLE_LONGITUDE_AXLE2"},
    3: {"weight": "DERIVED_WEIGHT_AXLE3", "timestamp": "LAST_STABLE_TIMESTAMP_AXLE3",
        "lat": "LAST_STABLE_LATITUDE_AXLE3", "lon": "LAST_STABLE_LONGITUDE_AXLE3"},
}





# ────────────────────────────────────────────────────────────────
# Step 1: query timestamps matching the event type
# ────────────────────────────────────────────────────────────────
def _fetch_event_timestamps(cursor, router1, router2, event_type):
    """Run the event-type-specific query and return a list of timestamps."""
    if event_type == "EMERGENCY_BRAKE":
        cursor.execute(f"""
            SELECT TIMESTAMP
            FROM {SNOWFLAKE_TABLE}
            WHERE TOPIC IN ('rutx11_{router1}/data', 'rutx11_{router2}/data')
              AND {event_type} = 0
              AND FS_WSP_M_AXLE1_IN_KPH > 5
              AND TIMESTAMP BETWEEN '{START_DATE}' AND '{END_DATE}'
            ORDER BY TIMESTAMP
        """)
        return [r[0] for r in cursor.fetchall()]

    if event_type == "TRAIN_STOP":
        cursor.execute(f"""
            SELECT TIMESTAMP, BRAKEDEMAND_STEP1, BRAKEDEMAND_STEP2, FS_WSP_M_AXLE1_IN_KPH
            FROM {SNOWFLAKE_TABLE}
            WHERE TOPIC IN ('rutx11_{router1}/data', 'rutx11_{router2}/data')
              AND TIMESTAMP BETWEEN '{TRAIN_STOP_START}' AND '{TRAIN_STOP_END}'
            ORDER BY TOPIC, TIMESTAMP
        """)
        rows = cursor.fetchall()

        all_timestamps = []
        event_active = False
        for ts, brake1, brake2, speed in rows:
            brakes_on = brake1 == 0 or brake2 == 0
            if not event_active:
                if brakes_on and speed > 0:
                    event_active = True
                    all_timestamps.append(ts)
            else:
                all_timestamps.append(ts)
                if speed == 0:
                    event_active = False
        return all_timestamps

    cursor.execute(f"""
        SELECT TIMESTAMP
        FROM {SNOWFLAKE_TABLE}
        WHERE TOPIC IN ('rutx11_{router1}/data', 'rutx11_{router2}/data')
          AND {event_type} = 1
          AND TIMESTAMP BETWEEN '{START_DATE}' AND '{END_DATE}'
        ORDER BY TIMESTAMP
    """)
    return [r[0] for r in cursor.fetchall()]


# ────────────────────────────────────────────────────────────────
# Step 2: merge close timestamps into padded intervals
# ────────────────────────────────────────────────────────────────
def _merge_timestamps_into_intervals(all_timestamps):
    """Cluster near-adjacent timestamps into `[start, end]` string intervals."""
    if not all_timestamps:
        return []

    merged = []
    start_ts = end_ts = all_timestamps[0]

    for ts in all_timestamps[1:]:
        if (ts - end_ts).total_seconds() <= EVENT_MERGE_GAP_SECONDS:
            end_ts = ts
        else:
            merged.append({
                "start": str(start_ts - timedelta(seconds=EVENT_PADDING_SECONDS)),
                "end": str(end_ts + timedelta(seconds=EVENT_PADDING_SECONDS)),
            })
            start_ts = end_ts = ts

    merged.append({
        "start": str(start_ts - timedelta(seconds=EVENT_PADDING_SECONDS)),
        "end": str(end_ts + timedelta(seconds=EVENT_PADDING_SECONDS)),
    })
    return merged


# ────────────────────────────────────────────────────────────────
# Step 3: pull all telemetry for one interval, grouped by router
# ────────────────────────────────────────────────────────────────
def _pull_router_data_for_interval(cursor, router1, router2, interval):
    """Return `(router_data, lat_list, lon_list)` for one merged interval."""
    cursor.execute(f"""
        SELECT *
        FROM {SNOWFLAKE_TABLE}
        WHERE TOPIC IN ('rutx11_{router1}/data','rutx11_{router2}/data')
          AND TIMESTAMP BETWEEN %s AND %s
        ORDER BY TIMESTAMP
    """, (interval["start"], interval["end"]))
    rows = cursor.fetchall()
    if not rows:
        return None, [], []

    col_names = [col[0] for col in cursor.description]
    router_data = {
        f"router_{router1}": defaultdict(list),
        f"router_{router2}": defaultdict(list),
    }
    latitudes, longitudes = [], []

    for r in rows:
        row_dict = dict(zip(col_names, r))
        topic = row_dict["TOPIC"]
        router_num = int(topic.split("_")[1].split("/")[0])
        router_key = f"router_{router_num}"

        for key, val in row_dict.items():
            router_data[router_key][key].append(val)

        if row_dict.get("LATITUDE") and row_dict.get("LONGITUDE"):
            latitudes.append(row_dict["LATITUDE"])
            longitudes.append(row_dict["LONGITUDE"])

    router_data = {k: dict(v) for k, v in router_data.items()}

    # Drop routers with no data
    for r_key in [f"router_{router1}", f"router_{router2}"]:
        if not router_data[r_key]:
            print(
                f"⚠️  No data for {r_key} in interval "
                f"{interval['start']} -> {interval['end']}"
            )
            router_data.pop(r_key, None)

    # Normalise axle-3 naming to "AXLE3_4" so all downstream code uses one key
    for _r_key, data in router_data.items():
        if "BCP_M_AXLE3_IN_BAR" in data:
            data["BCP_M_AXLE3_4_IN_BAR"] = data.pop("BCP_M_AXLE3_IN_BAR")
            data["BCP_M_AXLE3_4_NOT_SCALED_TO_BAR"] = data.pop("BCP_M_AXLE3_NOT_SCALED_TO_BAR")

    return router_data, latitudes, longitudes


# ────────────────────────────────────────────────────────────────
# Step 4: look up axle weights from ESRA_DERIVED_WEIGHTS
# ────────────────────────────────────────────────────────────────
def _fetch_axle_weights(cursor, router_data):
    """Populate `router_masses[r_key]["axle_{1,2,3}"] = {mass,...}`."""
    router_masses = {}
    for r_key, data in router_data.items():
        router_masses.setdefault(r_key, {})

        if "TIMESTAMP" not in data or not data["TIMESTAMP"]:
            print(f"❌ No timestamp data for {r_key} — skipping weight lookup")
            continue

        first_ts = data["TIMESTAMP"][0]
        router_num = r_key.split("_")[-1]

        cursor.execute("""
            SELECT *
            FROM ESRA_DERIVED_WEIGHTS
            WHERE TIMESTAMP > %s
              AND TOPIC = %s
            ORDER BY TIMESTAMP
            LIMIT 1
        """, (first_ts, f"rutx11_{router_num}/data"))
        weight_rows = cursor.fetchall()

        if not weight_rows:
            print(f"❌ No weight samples for {r_key} at timestamp {first_ts}")
            for axle in [1, 2, 3]:
                router_masses[r_key][f"axle_{axle}"] = None
            continue

        col_names_w = [c[0] for c in cursor.description]
        row_dict_w = dict(zip(col_names_w, weight_rows[0]))

        for axle in [1, 2, 3]:
            db_cols = _DB_WEIGHT_MAP[axle]
            raw_weight = row_dict_w.get(db_cols["weight"])
            router_masses[r_key][f"axle_{axle}"] = {
                "mass": float(raw_weight) if raw_weight is not None else None,
                "last_stable_timestamp": row_dict_w.get(db_cols["timestamp"]),
                "last_stable_lat": row_dict_w.get(db_cols["lat"]),
                "last_stable_lon": row_dict_w.get(db_cols["lon"]),
            }

    return router_masses


# ────────────────────────────────────────────────────────────────
# Step 5: derive MURS, clean raw MURS, compute derived summary
# ────────────────────────────────────────────────────────────────
def _compute_derived_murs(router_data, router_masses):
    """Append `MURS_{1,2,3_4}_derived` arrays to each router."""
    for r_key, data in router_data.items():
        for axle, (wsp_key, bcp_key, axle_key) in _AXLE_INFO.items():
            wsp_vals = data.get(wsp_key, [])
            bcp_vals = data.get(bcp_key, [])
            mass_value = router_masses.get(r_key, {}).get(axle_key, {})
            mass_value = mass_value.get("mass") if isinstance(mass_value, dict) else None

            key_name = f"MURS_{axle if axle < 3 else '3_4'}_derived"

            if not wsp_vals or not bcp_vals or mass_value is None:
                data[key_name] = []
                continue

            data[key_name] = [
                calculate_derived_murs(bcp_vals[i], wsp_vals[i], wsp_vals[i - 1], axle, mass_value)
                for i in range(1, len(wsp_vals) - 1)
            ]


def _clean_raw_murs(router_data):
    """Add `..._cleaned` + `..._rolling` arrays for the three raw MURS keys."""
    for _r_key, data in router_data.items():
        for murs_key in _MURS_RAW_KEYS:
            murs_vals = data.get(murs_key, [])
            ts_vals = data.get("TIMESTAMP", [])
            if not murs_vals or not ts_vals:
                continue
            murs_vals = [float(v) for v in murs_vals if v is not None]
            cleaned, rolling = process_murs(pd.to_datetime(ts_vals), murs_vals)
            data[f"{murs_key}_cleaned"] = cleaned
            data[f"{murs_key}_rolling"] = rolling


def _process_derived_murs_with_vvpop(router_data):
    """Clean derived MURS using VV/POP + brake demand; return per-axle summary."""
    summary = []
    for r_key, data in router_data.items():
        for murs_key, vvpop_key in _MURS_DERIVED_TO_VVPOP.items():
            murs_vals = data.get(murs_key, [])
            vv_vals = data.get(vvpop_key, [])
            ts_vals = data.get("TIMESTAMP", [])
            if not murs_vals or not ts_vals or not vv_vals:
                continue

            murs_vals = [float(v) for v in murs_vals if v is not None]
            breakdemand = [
                get_brake_demand_state(b1, b2, em)
                for b1, b2, em in zip(
                    data.get("BRAKEDEMAND_STEP1", []),
                    data.get("BRAKEDEMAND_STEP2", []),
                    data.get("EMERGENCY_BRAKE", []),
                )
            ]

            cleaned, rolling, murs_min, murs_avg = process_murs(
                pd.to_datetime(ts_vals), murs_vals, vv_vals,
                breakdemand=breakdemand, derived=True,
            )
            data[f"{murs_key}_cleaned"] = cleaned
            data[f"{murs_key}_rolling"] = rolling

            summary.append({
                "router": r_key,
                "key": murs_key,
                "min": murs_min,
                "avg": murs_avg,
            })
    return summary


# ────────────────────────────────────────────────────────────────
# Step 6: elevation + slope aggregation
# ────────────────────────────────────────────────────────────────
def _aggregate_elevation(router_data):
    """Average elevation/slope across routers; annotate each router's track."""
    total_dist_list, slope_list, net_elev_list = [], [], []

    for _r_key, data in router_data.items():
        coords = list(zip(
            data.get("LATITUDE", []),
            data.get("LONGITUDE", []),
            data.get("TIMESTAMP", []),
        ))
        if coords:
            ei = get_elevation(coords)
            data["ELEVATIONS"] = ei["elevations"]
            total_dist_list.append(ei["total_distance"])
            slope_list.append(ei["slope"])
            net_elev_list.append(ei["net_elevation_change"])
        else:
            data["ELEVATIONS"] = []
            total_dist_list.append(0)
            slope_list.append(0)
            net_elev_list.append(0)

    def _safe_avg(values):
        valid = [v for v in values if v is not None]
        return sum(valid) / len(valid) if valid else 0

    total_distance = _safe_avg(total_dist_list)
    net_elevation_change = _safe_avg(net_elev_list)
    slope = (net_elevation_change / total_distance * 100) if total_distance else 0
    return total_distance, net_elevation_change, slope


# ────────────────────────────────────────────────────────────────
# Step 7: assemble per-axle MURS / mass arrays in bogie order
# ────────────────────────────────────────────────────────────────
def _build_axle_arrays(derived_murs_summary, router_masses, front_router, back_router):
    """Return axle-ordered (front 1-3, back 3-1) min/avg/mass/ts/lat/lon arrays."""
    front = sorted(
        [i for i in derived_murs_summary if str(front_router) in i["router"]],
        key=lambda x: x["key"],
    )
    back = sorted(
        [i for i in derived_murs_summary if str(back_router) in i["router"]],
        key=lambda x: x["key"],
    )

    murs_min = [f["min"] for f in front] if front else ["--", "--", "--"]
    murs_avg = [f["avg"] for f in front] if front else ["--", "--", "--"]
    # Back-router axles reversed so the combined list runs front→back in bogie order
    murs_min.extend([b["min"] for b in reversed(back)] if back else ["--", "--", "--"])
    murs_avg.extend([b["avg"] for b in reversed(back)] if back else ["--", "--", "--"])

    front_key = f"router_{front_router}" if front_router is not None else None
    back_key = f"router_{back_router}" if back_router is not None else None

    def _get(router_key, axle_num, field):
        ad = router_masses.get(router_key, {}).get(f"axle_{axle_num}", {})
        if not ad or ad == "--":
            return "--"
        return ad.get(field, "--")

    front_mass = [_get(front_key, a, "mass") for a in [1, 2, 3]]
    front_ts = [_get(front_key, a, "last_stable_timestamp") for a in [1, 2, 3]]
    front_lat = [_get(front_key, a, "last_stable_lat") for a in [1, 2, 3]]
    front_lon = [_get(front_key, a, "last_stable_lon") for a in [1, 2, 3]]

    back_mass = [_get(back_key, a, "mass") for a in [1, 2, 3]]
    back_ts = [_get(back_key, a, "last_stable_timestamp") for a in [1, 2, 3]]
    back_lat = [_get(back_key, a, "last_stable_lat") for a in [1, 2, 3]]
    back_lon = [_get(back_key, a, "last_stable_lon") for a in [1, 2, 3]]

    masses = front_mass + list(reversed(back_mass))
    last_stable_timestamps = front_ts + list(reversed(back_ts))
    last_stable_latitudes = front_lat + list(reversed(back_lat))
    last_stable_longitudes = front_lon + list(reversed(back_lon))

    scaled_masses = []
    for i, m in enumerate(masses):
        try:
            scaled_masses.append(m / AXLE_WHEEL_SCALES[i])
        except Exception:  # noqa: BLE001
            scaled_masses.append(None)

    return (
        murs_min, murs_avg, scaled_masses,
        last_stable_timestamps, last_stable_latitudes, last_stable_longitudes,
    )


# ────────────────────────────────────────────────────────────────
# Step 8: brake performance per router, worst across event
# ────────────────────────────────────────────────────────────────
def _attach_brake_performance(router_data, interval_start):
    """Annotate each router with brake-performance results; return worst %."""
    worst = None
    for r_key, data in router_data.items():
        if not data.get("TIMESTAMP"):
            data["BRAKE_PERFORMANCE"] = None
            continue
        try:
            bp = calculate_brake_performance(
                data.get("TIMESTAMP", []),
                data.get("BRAKEDEMAND_STEP1", []),
                data.get("BRAKEDEMAND_STEP2", []),
                data.get("EMERGENCY_BRAKE", []),
                data.get("WSP_S_VTACHO", []),
                data.get("WHEEL_SLIDE", []),
            )
            data["BRAKE_PERFORMANCE"] = bp["results"]
            rw = bp["worst_brake_performance"]
            if rw is not None and (worst is None or rw < worst):
                worst = rw
        except Exception as e:  # noqa: BLE001
            print(f"❌ brake calc failed for {r_key} at {interval_start}: {e}")
            data["BRAKE_PERFORMANCE"] = None
    return worst


# ────────────────────────────────────────────────────────────────
# Public entry point
# ────────────────────────────────────────────────────────────────
def fetch_and_merge_pair_full(conn, router1, router2, event_type):

    load_geojson_data("data/chain_info.geojson")

    """Fetch and fully enrich all events of `event_type` for a router pair."""
    cursor = conn.cursor()

    all_timestamps = _fetch_event_timestamps(cursor, router1, router2, event_type)
    print(f"   → {len(all_timestamps)} {event_type} timestamps found")
    if not all_timestamps:
        cursor.close()
        return []

    merged_intervals = _merge_timestamps_into_intervals(all_timestamps)
    print(f"   → {len(merged_intervals)} intervals merged")

    merged_events = []
    for interval in merged_intervals:
        router_data, latitudes, longitudes = _pull_router_data_for_interval(
            cursor, router1, router2, interval,
        )
        if not router_data:
            continue

        router_masses = _fetch_axle_weights(cursor, router_data)

        _compute_derived_murs(router_data, router_masses)
        _clean_raw_murs(router_data)
        derived_murs_summary = _process_derived_murs_with_vvpop(router_data)

        total_distance, net_elevation_change, slope = _aggregate_elevation(router_data)

        # Orientation
        front_router, back_router, reason = determine_front_router(
            {"routers": router_data}, (router1, router2),
        )

        def _avg_mass(r_key):
            masses = router_masses.get(r_key, {})

            values = [
                v["mass"]
                for v in masses.values()
                if v is not None and v.get("mass") is not None
            ]

            return sum(values) / len(values) if values else 0

        mass = {
            front_router: _avg_mass(f"router_{front_router}"),
            back_router: _avg_mass(f"router_{back_router}"),
        }

        (murs_min, murs_avg, scaled_masses,
         last_stable_timestamps, last_stable_latitudes, last_stable_longitudes) = (
            _build_axle_arrays(derived_murs_summary, router_masses, front_router, back_router)
        )

        bad_values = {"--", "no wsp activity", "", None}
        all_axles_slide = all(murs_min[i] not in bad_values for i in range(6))
        valid_min = [float(x) for x in murs_min if x not in bad_values]
        valid_avg = [float(x) for x in murs_avg if x not in bad_values]
        lowest_min = min(valid_min) if valid_min else "--"
        lowest_avg = min(valid_avg) if valid_avg else "--"

        avg_lat = mean(latitudes) if latitudes else None
        avg_lon = mean(longitudes) if longitudes else None

        avg_lat = mean(latitudes) if latitudes else None

        if avg_lat is None or avg_lon is None:
            print(f"⚠️  No lat/lon data for interval {interval['start']} -> {interval['end']}, skipping location-based enrichment")
            continue

        chain_info = get_closest_chain_info(avg_lat, avg_lon)

        weather_data = get_weather(
            avg_lat, avg_lon,
            datetime.fromisoformat(interval["start"].split(".")[0]),
        )

        worst_brake_performance = _attach_brake_performance(router_data, interval["start"])

        cab_active_on_either = any(
            data.get("CABIN_ACTIVE", [0])[0] == 1
            for data in router_data.values()
        )
        extra_slide_data = get_slide_data_between(interval["start"], cab_active_on_either)

        merged_events.append({
            "start": interval["start"],
            "end": interval["end"],
            "latitude": avg_lat,
            "longitude": avg_lon,
            "front_router": front_router,
            "back_router": back_router,
            "murs_min": murs_min,
            "murs_avg": murs_avg,
            "Adhesion_Index_Murs_Min": get_adhesion_index(lowest_min),
            "Adhesion_Index_Murs_Avg": get_adhesion_index(lowest_avg),
            "all_axles_slide": all_axles_slide,
            "masses": scaled_masses,
            "last_stable_timestamps": last_stable_timestamps,
            "last_stable_latitudes": last_stable_latitudes,
            "last_stable_longitudes": last_stable_longitudes,
            "reason": reason,
            "weather_data": weather_data,
            "chain_info": chain_info,
            "total_distance": total_distance,
            "slope": slope,
            "net_elevation_change": net_elevation_change,
            "mass": mass,
            "worst_brake_performance": worst_brake_performance,
            "extra_slide_data": extra_slide_data,
            "data": {
                k: {
                    kk: [str(vv) if isinstance(vv, datetime) else vv for vv in vv_list]
                    for kk, vv_list in v.items()
                }
                for k, v in router_data.items()
            },
        })

    cursor.close()
    print(f"✅ {event_type} ({router1},{router2}): {len(merged_events)} events done")
    return merged_events
