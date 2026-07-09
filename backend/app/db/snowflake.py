"""Snowflake connection helper.

A single entry point that reads credentials from the global config and hands
back a live connection, or `None` if the connection fails so callers can
degrade gracefully without crashing the API.
"""
from __future__ import annotations

from pathlib import Path

import snowflake.connector as sc

from app.config import BACKEND_DIR, config


def _resolve_key_path(raw: str) -> str:
    """Return an absolute path for the private key file.

    The INI value may be absolute, or relative to the backend/ directory.
    """
    p = Path(raw)
    return str(p if p.is_absolute() else (BACKEND_DIR / p))


def get_snowflake_connection():
    """Open a fresh Snowflake connection.

    Returns `None` (not raises) on failure because the background refresh
    thread should keep running even if one cycle cannot connect.
    """
    try:
        return sc.connect(
            account=config["SNOWFLAKE"]["ACCOUNT"],
            user=config["SNOWFLAKE"]["USER"],
            private_key_file=_resolve_key_path(config["SNOWFLAKE"]["PRIVATE_KEY_FILE"]),
            private_key_file_pwd=config["SNOWFLAKE"]["PRIVATE_KEY_FILE_PWD"],
            warehouse=config["SNOWFLAKE"]["WAREHOUSE"],
            database=config["SNOWFLAKE"]["DATABASE"],
            schema=config["SNOWFLAKE"]["SCHEMA"],
            role=config["SNOWFLAKE"]["ROLE"],
        )
    except Exception as e:  # noqa: BLE001 — we want to catch and log anything here
        print(f"❌ FATAL: Could not connect to Snowflake. ERROR: {e}")
        return None
