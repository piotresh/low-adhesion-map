"""Parse `train_165004.xml` → `all_trains_summary.csv`.

The source XML file is a concatenation of Network-Rail TAF TSI v5.3
``<PassengerTrainConsistMessage>`` records, each preceded by an epoch-ms
timestamp followed by `$` (e.g. ``1758916452102$<?xml ...>...``).

For every journey that includes resource group **165004** we emit one CSV row
with summary information: headcode, diagram, origin/destination, planned
formation, fleet IDs and mileage.

Usage::

    python3 pipeline_165004/xml_to_csv.py \
        --xml  pipeline_165004/raw/train_165004.xml \
        --out  backend/data/all_trains_summary.csv

The CSV this produces is the exact format expected by
``backend/app/services/slide_lookup.py``.
"""
from __future__ import annotations

import argparse
import csv
import re
import xml.etree.ElementTree as ET
from pathlib import Path

# TAF TSI namespace used throughout the message schema
NS = "{http://www.era.europa.eu/schemes/TAFTSI/5.3}"
TARGET_UNIT = "165004"

# Splits on each `<timestamp>$<xml>` record — the $ is always followed by `<?xml`
_RECORD_SPLIT_RE = re.compile(r"(\d+)\$(?=<\?xml)")


def _iter_records(raw: str):
    """Yield ``(epoch_ms, xml_text)`` for each record in the concatenated file."""
    parts = _RECORD_SPLIT_RE.split(raw)
    # The split pattern includes the captured timestamp, so parts looks like
    # ["", ts1, xml1, ts2, xml2, ...]
    it = iter(parts[1:])  # skip the empty lead
    for ts in it:
        try:
            xml_text = next(it)
        except StopIteration:
            return
        yield int(ts), xml_text.strip()


def _text(elem, tag):
    """Shortcut: return the text of the first `NS+tag` child, or empty string."""
    if elem is None:
        return ""
    found = elem.find(f"{NS}{tag}")
    return (found.text or "").strip() if found is not None else ""


def _location_code(loc_elem):
    """Extract the `LocationSubsidiaryCode` (e.g. 'MARYLBN') from a location node."""
    if loc_elem is None:
        return ""
    sub = loc_elem.find(f"{NS}LocationSubsidiaryIdentification")
    if sub is None:
        return ""
    code = sub.find(f"{NS}LocationSubsidiaryCode")
    return (code.text or "").strip() if code is not None else ""


def _parse_passenger_message(root):
    """Extract one row per journey that contains 165004.

    Returns a list of dicts (possibly empty) ready for `csv.DictWriter`.
    """
    rows = []

    # Headcode — top-level train identifier
    otn = root.find(f"{NS}OperationalTrainNumberIdentifier")
    headcode = _text(otn, "OperationalTrainNumber")

    for alloc in root.findall(f"{NS}Allocation"):
        # Collect every resource group (i.e. unit) in the journey
        vehicle_ids, vehicle_types, planned_resource_groups, fleet_ids = [], [], [], []
        includes_target = False

        # The ResourceGroup/Vehicle structure is variable depth; iterate explicitly
        for rg in alloc.findall(f"{NS}ResourceGroup"):
            rg_id = _text(rg, "ResourceGroupId")
            fleet_id = _text(rg, "FleetId")
            if rg_id == TARGET_UNIT:
                includes_target = True
            # Collect one entry per vehicle within the group
            for veh in rg.findall(f"{NS}Vehicle"):
                vehicle_ids.append(_text(veh, "VehicleId"))
                vehicle_types.append(_text(veh, "SpecificType"))
                planned_resource_groups.append(_text(veh, "PlannedResourceGroup"))
                fleet_ids.append(fleet_id)

        if not includes_target:
            continue  # Ignore journeys not involving 165004

        diagram      = _text(alloc, "DiagramNo")
        diagram_date = _text(alloc, "DiagramDate")
        origin       = _location_code(alloc.find(f"{NS}AllocationOriginLocation"))
        destination  = _location_code(alloc.find(f"{NS}AllocationDestinationLocation"))
        start_time   = _text(alloc, "AllocationOriginDateTime")
        end_time     = _text(alloc, "AllocationDestinationDateTime")
        origin_miles = _text(alloc, "AllocationOriginMiles")
        dest_miles   = _text(alloc, "AllocationDestinationMiles")

        # Dedupe adjacent PRGs while keeping order — each unit appears per
        # vehicle in the XML but we only want per-unit entries in the CSV
        unit_prgs, seen = [], set()
        for prg in planned_resource_groups:
            if prg and prg not in seen:
                unit_prgs.append(prg)
                seen.add(prg)

        # Parallel lists keyed by unit PRG order (one fleet_id per unit)
        unit_fleet_ids = []
        for prg in unit_prgs:
            idx = planned_resource_groups.index(prg)
            unit_fleet_ids.append(fleet_ids[idx])

        # Distance computed per unit — each unit travels the full journey so
        # the destination-origin delta is replicated `len(unit_prgs)` times.
        try:
            journey_miles = float(dest_miles) - float(origin_miles)
        except ValueError:
            journey_miles = 0.0
        per_unit_distance = "|".join(f"{journey_miles:.1f}" for _ in unit_prgs)

        rows.append({
            "headcode":                      headcode,
            "diagram":                       diagram,
            "diagram_date":                  diagram_date,
            "origin":                        origin,
            "destination":                   destination,
            "start_time":                    start_time,
            "end_time":                      end_time,
            "vehicle_count":                 len(vehicle_ids),
            "vehicle_ids":                   "|".join(vehicle_ids),
            "vehicle_types":                 "|".join(vehicle_types),
            "planned_resource_groups":       "|".join(unit_prgs),
            "fleet_ids":                     "|".join(unit_fleet_ids),
            "allocation_origin_miles":       "|".join(f"{float(origin_miles):.1f}" for _ in unit_prgs) if origin_miles else "",
            "allocation_destination_miles":  "|".join(f"{float(dest_miles):.1f}"  for _ in unit_prgs) if dest_miles  else "",
            "distance":                      per_unit_distance,
        })

    return rows


def xml_to_csv(xml_path: Path, csv_path: Path) -> int:
    """Parse the XML file and write the CSV. Returns the number of rows written."""
    raw = xml_path.read_text(encoding="utf-8")

    all_rows = []
    parse_errors = 0
    for _ts, xml_text in _iter_records(raw):
        try:
            root = ET.fromstring(xml_text)
        except ET.ParseError:
            parse_errors += 1
            continue
        all_rows.extend(_parse_passenger_message(root))

    csv_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "headcode", "diagram", "diagram_date", "origin", "destination",
        "start_time", "end_time", "vehicle_count", "vehicle_ids",
        "vehicle_types", "planned_resource_groups", "fleet_ids",
        "allocation_origin_miles", "allocation_destination_miles", "distance",
    ]
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(all_rows)

    if parse_errors:
        print(f"⚠️  {parse_errors} record(s) failed XML parsing and were skipped")
    print(f"✅ Wrote {len(all_rows)} row(s) to {csv_path}")
    return len(all_rows)


def main():
    here = Path(__file__).resolve().parent
    default_xml = here / "raw" / "train_165004.xml"
    default_csv = here.parent / "backend" / "data" / "all_trains_summary.csv"

    ap = argparse.ArgumentParser(description="Parse 165004 consist XML → summary CSV.")
    ap.add_argument("--xml", type=Path, default=default_xml, help="Path to the raw XML file.")
    ap.add_argument("--out", type=Path, default=default_csv, help="Output CSV path.")
    args = ap.parse_args()

    xml_to_csv(args.xml, args.out)


if __name__ == "__main__":
    main()
