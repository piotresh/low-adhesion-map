"""MURS (Maximum Utilised Rail-wheel Adhesion Coefficient) cleaning + smoothing.

Raw MURS samples include sentinels (`0.2`) for invalid readings and must be
filtered, gap-filled and smoothed before plotting or summarising. The derived
variant also uses the brake-demand signal to mask samples where no braking is
active — MURS is only physically meaningful under brake application.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# The sensor emits 0.2 when no valid reading is available
INVALID_SENTINEL = 0.2


def process_murs(
    timestamps,
    murs_values,
    vvvalues=None,
    breakdemand=None,
    derived: bool = False,
    buffer: int = 10,
):
    """Clean and smooth a MURS time series for a single axle.

    Args:
        timestamps:   Aligned timestamp array.
        murs_values:  Raw MURS numeric array.
        vvvalues:     WSP VV/POP flag per sample (1 = WSP active). Required in
                      `derived` mode; used to compute min/avg only over
                      WSP-active samples.
        breakdemand:  Brake demand state per sample. Used in `derived` mode to
                      mask out samples where no braking is active.
        derived:      If True, apply the derived-MURS pipeline (returns
                      min/avg summary in addition to the cleaned series).
        buffer:       Number of samples to expand each zero-brake-demand
                      sample by on each side, to avoid transient edge
                      artefacts at brake application/release.

    Returns:
        `(cleaned, rolling)` in raw mode, or
        `(cleaned, rolling, murs_min, murs_avg)` in derived mode.
    """
    if derived:
        # Trim to the shortest input so indices stay aligned
        min_len = min(len(timestamps), len(murs_values), len(vvvalues))
        timestamps = timestamps[:min_len]
        murs_values = murs_values[:min_len]
        vvvalues = vvvalues[:min_len]
        if breakdemand is not None:
            breakdemand = breakdemand[:min_len]

    df = pd.DataFrame(
        {
            "timestamp": pd.to_datetime(timestamps),
            "MURS": [float(x) for x in murs_values],
            "VVPOP": vvvalues,
        }
    )
    df.set_index("timestamp", inplace=True)

    mask_invalid = (df["MURS"] == INVALID_SENTINEL) | (df["MURS"] < 0)

    if derived and breakdemand is not None:
        bd_mask = pd.Series(breakdemand, index=df.index) == 0
        bd_mask_expanded = bd_mask.copy()
        # Widen each zero-demand sample by `buffer` in both directions
        bd_indices = np.where(bd_mask)[0]
        for idx in bd_indices:
            start = max(0, idx - buffer)
            end = min(len(df), idx + buffer + 1)
            bd_mask_expanded[start:end] = True
        mask_invalid |= bd_mask_expanded

    df["MURS_cleaned"] = df["MURS"].mask(mask_invalid)
    df["MURS_cleaned"] = df["MURS_cleaned"].ffill().bfill()
    df["MURS_rolling"] = df["MURS_cleaned"].rolling("1s", min_periods=1).mean()

    if derived:
        vv_mask = df["VVPOP"] == 1
        valid_vals = df.loc[vv_mask, "MURS_rolling"]
        if not valid_vals.empty:
            murs_min = valid_vals.min()
            murs_avg = valid_vals.mean()
        else:
            murs_min = "no wsp activity"
            murs_avg = "no wsp activity"
    else:
        murs_min = None
        murs_avg = None

    cleaned = df["MURS_cleaned"].tolist()
    rolling = df["MURS_rolling"].tolist()

    if derived:
        return cleaned, rolling, murs_min, murs_avg
    return cleaned, rolling
