"""Adhesion classification from MURS coefficient.

Tiny pure function kept in its own module so front-end, exports and API
summaries all share one canonical threshold set.
"""
from __future__ import annotations


def get_adhesion_index(mu):
    """Map a MURS (µ) value to a human-readable adhesion quality label.

    Thresholds match the standard rail adhesion classification bands used
    throughout the project and reflected in the frontend adhesion table.
    Passing the sentinel string `"--"` returns `"--"` unchanged.
    """
    if mu == "--":
        return "--"
    if mu >= 0.15:
        return "Excellent adhesion"
    if mu >= 0.10:
        return "Good adhesion"
    if mu >= 0.08:
        return "Moderate adhesion"
    if mu >= 0.05:
        return "Poor adhesion"
    if mu >= 0.03:
        return "Very poor adhesion"
    return "Extreme adhesion loss"
