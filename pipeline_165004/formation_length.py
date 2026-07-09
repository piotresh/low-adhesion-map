"""Add a `formation_length` column (number of units per journey) to the CSV.

Replaces the old ``backend/formation.py`` which had a hardcoded Windows path
and wrote to a different file than the rest of the pipeline consumed.

Usage::

    python3 pipeline_165004/formation_length.py \
        --csv backend/data/all_trains_summary.csv
"""
from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd


def count_resources(prg: str | float) -> int:
    """Count non-empty pipe-separated entries in `planned_resource_groups`."""
    if pd.isna(prg) or prg == "":
        return 0
    return len([x for x in str(prg).split("|") if x.strip()])


def add_formation_length(csv_path: Path) -> None:
    """Add / overwrite the `formation_length` column in the CSV in-place."""
    df = pd.read_csv(csv_path)
    df["formation_length"] = df["planned_resource_groups"].apply(count_resources)
    df.to_csv(csv_path, index=False)
    print(f"✅ Added 'formation_length' column to {csv_path}")


def main():
    here = Path(__file__).resolve().parent
    default_csv = here.parent / "backend" / "data" / "all_trains_summary.csv"

    ap = argparse.ArgumentParser(description="Add formation_length column to the CSV.")
    ap.add_argument("--csv", type=Path, default=default_csv, help="CSV file to modify in place.")
    args = ap.parse_args()

    add_formation_length(args.csv)


if __name__ == "__main__":
    main()
