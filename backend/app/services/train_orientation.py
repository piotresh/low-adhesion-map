"""Identify which router sits at the leading end of the train.

A two-car unit carries one RUTX11 router per cab. The router whose `FORWARD`
flag is active (and whose peer reports `REVERSE`) is the leading one. When
the flags are missing or ambiguous we default to the first router of the pair
so the pipeline always produces a usable orientation.
"""
from __future__ import annotations


def determine_front_router(event, router_pair):
    """Return `(lead_router, follow_router, description)` for one event.

    `event["routers"]` is expected to map `router_<N>` → dict-of-arrays.
    We only inspect the first sample of each direction flag; the flags are
    stable for the duration of a normal event.

    Returns:
        `("Missing Data", "Missing Data", "Missing Data")` when both routers
        have no data at all, a sensible pair otherwise.
    """
    r1, r2 = router_pair
    router_1_data = event.get("routers", {}).get(f"router_{r1}", {})
    router_2_data = event.get("routers", {}).get(f"router_{r2}", {})

    # First sample of each flag is representative of the whole event
    fwd1 = router_1_data.get("FORWARD", [None])[0] if router_1_data.get("FORWARD") else None
    rev1 = router_1_data.get("REVERSE", [None])[0] if router_1_data.get("REVERSE") else None
    fwd2 = router_2_data.get("FORWARD", [None])[0] if router_2_data.get("FORWARD") else None
    rev2 = router_2_data.get("REVERSE", [None])[0] if router_2_data.get("REVERSE") else None

    missing_note = ""

    if router_1_data and router_2_data:
        if fwd1 and rev2:
            lead_router, follow_router = r1, r2
        elif fwd2 and rev1:
            lead_router, follow_router = r2, r1
        else:
            # Ambiguous or identical flags → default to r1 as lead
            lead_router, follow_router = r1, r2
    elif router_1_data:
        lead_router, follow_router = r1, "Missing Data"
        missing_note = f" Router {r2} missing."
    elif router_2_data:
        lead_router, follow_router = r2, "Missing Data"
        missing_note = f" Router {r1} missing."
    else:
        return "Missing Data", "Missing Data", "Missing Data"

    description = f"Router {lead_router} is leading the train.{missing_note} "
    return lead_router, follow_router, description
