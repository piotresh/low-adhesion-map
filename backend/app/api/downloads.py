"""Offline-export API routes.

- ``GET /api/download-all`` packages every cached event + a self-contained
  HTML dashboard into one ZIP for offline viewing.
- ``GET /api/download-pqt``  writes every cached event to a single Parquet
  file for bulk analysis in notebooks / dashboards.
"""
from __future__ import annotations

import json
import os
import shutil
from tempfile import mkdtemp
from zipfile import ZipFile

import numpy as np
import pandas as pd
from fastapi import APIRouter, BackgroundTasks
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse

from app import cache
from app.exporters.html_builder import save_to_html
from app.utils.serialisation import safe_convert

router = APIRouter()


@router.get("/api/download-all")
async def download_all_zip(background_tasks: BackgroundTasks):
    """Build and return a ZIP with `combined.html` + one JS file per event."""
    all_cache_data = cache.all_caches_by_category()

    html_content = save_to_html(cache.get_cached_events_summary())
    tmpdir = mkdtemp()
    total_saved = 0

    html_path = os.path.join(tmpdir, "combined.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html_content)

    events_dir = os.path.join(tmpdir, "events")
    for category, events in all_cache_data.items():
        category_dir = os.path.join(events_dir, category)
        os.makedirs(category_dir, exist_ok=True)

        for ev in events:
            if not ev or "data" not in ev or not ev["data"]:
                continue

            event_id = f"{category}_{ev['start']}"
            ev["event_id"] = event_id

            safe_timestamp = ev["start"].replace(" ", "_").replace("-", "_").replace(":", "_")
            js_path = os.path.join(category_dir, f"{category}_{safe_timestamp}.js")

            js_content = (
                "window.EVENTS = window.EVENTS || {};\n"
                f"window.EVENTS['{event_id}'] = "
                f"{json.dumps(jsonable_encoder(ev), ensure_ascii=False, indent=2)};"
            )
            with open(js_path, "w", encoding="utf-8") as f:
                f.write(js_content)
            total_saved += 1

    zip_filename = os.path.join(tmpdir, "combined.zip")
    with ZipFile(zip_filename, "w") as zipf:
        zipf.write(html_path, "combined.html")
        for root, _, files in os.walk(events_dir):
            for file in files:
                file_path = os.path.join(root, file)
                zipf.write(file_path, os.path.relpath(file_path, tmpdir))

    print(f"✅ ZIP ready: {total_saved} events")
    background_tasks.add_task(shutil.rmtree, tmpdir)
    return FileResponse(zip_filename, media_type="application/zip", filename="combined.zip")


@router.get("/api/download-pqt")
async def download_parquet(background_tasks: BackgroundTasks):
    """Export every cached event as a single Parquet file."""
    all_data = []
    for cache_name, cache_data in cache.all_caches_by_category().items():
        for entry in cache_data:
            entry_copy = entry.copy()
            entry_copy["type"] = cache_name
            for k, v in entry_copy.items():
                if isinstance(v, str) and v.lower() in ("missing data", "no wsp activity"):
                    entry_copy[k] = np.nan
            all_data.append(entry_copy)

    df = pd.DataFrame(all_data)

    for col in ["murs_min", "murs_avg"]:
        if col in df.columns:
            df[col] = df[col].astype("string")

    for col in df.columns:
        if df[col].dtype == "object":
            df[col] = df[col].apply(
                lambda x: json.dumps(safe_convert(x)) if isinstance(x, (list, dict)) else x
            )

    parquet_path = "all_data.parquet"
    df.to_parquet(parquet_path, index=False)

    background_tasks.add_task(lambda: os.remove(parquet_path))
    return FileResponse(parquet_path, filename="all_data.parquet")
