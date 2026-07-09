"""Brake-demand and derived-MURS helpers.

The public repository keeps the interface used by the FastAPI event pipeline,
but the Knorr-Bremse-specific derived-MURS physics model, constants, and
calibration details are REDACTED for company confidentiality.
"""

REDACTED = "REDACTED"


def get_brake_demand_state(brake1, brake2, emergency):
    """Return brake demand level 0-4 using the public signal convention.

    Signal convention: 0 = ON, 1 = OFF.
    """
    if emergency == 0:
        return 4

    if brake1 == 1 and brake2 == 1:
        return 0
    if brake1 == 0 and brake2 == 1:
        return 1
    if brake1 == 1 and brake2 == 0:
        return 2
    if brake1 == 0 and brake2 == 0:
        return 3

    return 0


def calculate_derived_murs(BCP_Axel, WSP_Axle_in_kph, WSP_Axle_in_kph_previous, current_axel, mass):
    """Placeholder for the confidential derived-MURS calculation.

    The production implementation uses Knorr-Bremse-specific physical
    modelling, calibration constants, and validation rules. Those details are
    intentionally REDACTED in this public portfolio repository.

    Returning ``None`` keeps the surrounding event-enrichment pipeline usable:
    callers can still display raw MURS values and public contextual data while
    omitting the confidential derived output.
    """
    _ = (BCP_Axel, WSP_Axle_in_kph, WSP_Axle_in_kph_previous, current_axel, mass)
    return None
