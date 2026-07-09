"""Serialisation helpers for JSON / Parquet export.

- ``safe_convert`` recursively converts datetimes → ISO strings so a nested
  dict / list is JSON-serialisable without pulling in `fastapi.jsonable_encoder`.
- ``find_non_serializable`` is a dev helper that walks an object and prints
  the path to any value `json.dumps` refuses.
"""
from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from datetime import datetime


def safe_convert(obj):
    """Recursively convert datetimes (and nested containers) to JSON-safe form."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, list):
        return [safe_convert(x) for x in obj]
    if isinstance(obj, dict):
        return {k: safe_convert(v) for k, v in obj.items()}
    return obj


def find_non_serializable(obj, path: str = "root") -> None:
    """Walk `obj` and print the dotted-path to any non-JSON value. Dev-only."""
    try:
        json.dumps(obj)
        return
    except TypeError:
        pass

    if isinstance(obj, Mapping):
        for k, v in obj.items():
            find_non_serializable(v, path + f".{k}")
    elif isinstance(obj, Iterable) and not isinstance(obj, (str, bytes)):
        for i, v in enumerate(obj):
            find_non_serializable(v, path + f"[{i}]")
    else:
        print(f"❌ Non-serializable at {path}: {type(obj)} -> {obj}")
