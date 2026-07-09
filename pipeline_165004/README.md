# 165004 Data Pipeline

Reproducible pipeline that turns the raw Network-Rail passenger-consist XML
feed into the CSV that the backend uses for train-formation lookups.

```
raw/train_165004.xml
        │
        │  pipeline_165004/xml_to_csv.py
        ▼
backend/data/all_trains_summary.csv
        │
        │  pipeline_165004/formation_length.py   (optional: adds formation_length column)
        ▼
Used at runtime by backend/app/services/slide_lookup.py
```

## Layout

- [`raw/train_165004.xml`](raw/train_165004.xml) – concatenated TAF TSI v5.3
  `<PassengerTrainConsistMessage>` records, one per scheduled journey.
- [`xml_to_csv.py`](xml_to_csv.py) – parses the XML and writes one row per
  journey that includes unit **165004**.
- [`formation_length.py`](formation_length.py) – adds a single-integer
  `formation_length` column counting distinct resource groups per journey.

## Running the pipeline

The scripts have sensible defaults so you can usually run them with no
arguments:

```bash
# 1. Parse the XML into the CSV the backend consumes
python3 pipeline_165004/xml_to_csv.py

# 2. (optional) Annotate each row with the number of units in the consist
python3 pipeline_165004/formation_length.py
```

Override paths explicitly when needed:

```bash
python3 pipeline_165004/xml_to_csv.py \
  --xml pipeline_165004/raw/train_165004.xml \
  --out backend/data/all_trains_summary.csv

python3 pipeline_165004/formation_length.py \
  --csv backend/data/all_trains_summary.csv
```

## Output format

`backend/data/all_trains_summary.csv` contains one row per (journey × consist
allocation) and at a minimum these columns are produced:

| Column | Example |
|---|---|
| `headcode` | `5C76` |
| `diagram` / `diagram_date` | `AS.620` · `2025-09-26` |
| `origin` / `destination` | `AYLSPWY` · `AYLSBRY` |
| `start_time` / `end_time` | ISO 8601 timestamps |
| `vehicle_count` | Total vehicles across the consist |
| `vehicle_ids` / `vehicle_types` | Pipe-delimited per vehicle |
| `planned_resource_groups` / `fleet_ids` | Pipe-delimited per **unit** |
| `allocation_origin_miles` / `allocation_destination_miles` | Pipe-delimited per unit |
| `distance` | Pipe-delimited per unit |
| `formation_length` | *(added by `formation_length.py`)* |

The pipe-delimited columns are split back into Python lists at load time by
[`backend/app/services/slide_lookup.py`](../backend/app/services/slide_lookup.py:60).

## When to re-run

Re-run the pipeline whenever the raw XML is updated (e.g. when a new batch of
TAF TSI messages is received). The backend re-reads the CSV on every cache
refresh, so no server restart is needed — just wait for the next refresh
cycle (`cache_refresh_seconds` in [`backend/config.ini`](../backend/config.ini)).
