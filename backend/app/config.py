"""Configuration loader.

Reads the INI file once at import time and exposes it as the module-level
`config` object so every other module can simply `from app.config import config`.

The config file lives at `backend/config.ini` — we resolve its path relative
to this file so the process can be started from any working directory.
"""
from __future__ import annotations

import configparser
from pathlib import Path

# backend/app/config.py → backend/ is two parents up
BACKEND_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BACKEND_DIR / "config.ini"

config = configparser.ConfigParser()
config.read(CONFIG_PATH)

# Public shortcuts (used by multiple modules)
SNOWFLAKE_TABLE = config["SNOWFLAKE"]["TABLE_NAME"]
CACHE_REFRESH_SECONDS = int(config["SETTINGS"].get("CACHE_REFRESH_SECONDS", 10000))

# Slide-CSV path is expected to be absolute or relative to backend/.
# Fall back to the new default location if not specified.
_slide_csv_raw = config["SETTINGS"].get(
    "SLIDE_CSV_PATH", str(BACKEND_DIR / "data" / "all_trains_summary.csv")
)
SLIDE_CSV_PATH = str(
    Path(_slide_csv_raw)
    if Path(_slide_csv_raw).is_absolute()
    else (BACKEND_DIR / _slide_csv_raw)
)
