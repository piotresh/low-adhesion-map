"""FastAPI entry point for the Low Adhesion Map backend.

Run locally with:

    uvicorn main:app --reload

All real logic lives in the `app/` package. This file only wires the app
together: CORS, compression, routers and the background cache thread.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import ORJSONResponse

from app.api.downloads import router as downloads_router
from app.api.events import router as events_router
from app.cache import start_background_refresh

# ORJSONResponse is faster than the default JSON encoder and handles numpy/dt
app = FastAPI(default_response_class=ORJSONResponse)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Compress any response larger than 500 bytes
app.add_middleware(GZipMiddleware, minimum_size=500)

# Mount routers
app.include_router(events_router)
app.include_router(downloads_router)

# Kick off the background refresh thread (imports `calc_murs` via fetcher)
start_background_refresh()
