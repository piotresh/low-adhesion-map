"""Build a self-contained single-HTML export of the dashboard.

Replaces the original `save_to_html.py`. The frontend is split into many
modular JS files under ``frontend/js/`` plus a small bootstrap in
``frontend/app.js``; we inline them in dependency order here so the
resulting ``combined.html`` works offline with no external asset fetches
except for the CDN libraries (Leaflet / Plotly / D3 / Turf) which are
left as remote ``<script>`` tags.

The original implementation "stripped the last 46 lines of app.js" to remove
the `fetchEventsSummary` live-API call. We now do this cleanly by simply
**not including** the online-api module, and instead appending an offline
bootstrap block that loads the baked-in ``allEventsData`` variable.

Chain + waymark + TGA GeoJSON/JSON files are read from disk at save time
and baked into the HTML as inline JS variables. ``window.fetch`` is patched
so that ``chain_overlay.js`` and ``tga_overlay.js`` never hit the network.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# File: backend/app/exporters/html_builder.py
#   .parent                  → backend/app/exporters/
#   .parent.parent           → backend/app/
#   .parent.parent.parent    → backend/              ← _BACKEND_DIR
#   .parent.parent.parent.parent → low_adhesion_map/ (repo root)
# ---------------------------------------------------------------------------
_BACKEND_DIR  = Path(__file__).resolve().parent.parent.parent   # → backend/
_FRONTEND_DIR = _BACKEND_DIR.parent / "frontend"                # → low_adhesion_map/frontend/

# ---------------------------------------------------------------------------
# JS modules to inline, in load order.
# NOTE: ``api.js`` is deliberately excluded — the offline bundle uses the
# pre-loaded ``allEventsData`` + per-event script tags instead.
# ---------------------------------------------------------------------------
_JS_MODULE_ORDER = [
    "js/config.js",
    "js/state.js",
    "js/map/map_setup.js",
    "js/map/brake_layer.js",
    "js/map/adhesion_layer.js",
    "js/map/heatmap.js",          # heatmap must come before map_render
    "js/map/map_render.js",
    "js/map/chain_overlay.js",    # chain overlay after map_render (needs `map`)
    "js/map/tga_overlay.js",      # tga overlay after chain_overlay (awaits chainsReady)
    "js/map/speed_overlay.js",    # speed overlay after chain_overlay (reuses loadGeoJSON/showTip)
    "js/timeline.js",
    "js/panel/event_info.js",
    "js/panel/router_charts.js",
    "js/controls.js",
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _embed_image_base64(
    img_path: Path,
    alt: str = "Embedded Image",
    element_id: str | None = None,
    extra_attrs: str = "",
) -> str:
    """Return an ``<img>`` tag with the file base64-inlined."""
    with img_path.open("rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    id_attr = f' id="{element_id}"' if element_id else ""
    return f'<img src="data:image/png;base64,{b64}" alt="{alt}"{id_attr} {extra_attrs}>'


def _load_geojson_optional(path: Path) -> dict | None:
    """Load a GeoJSON/JSON file, returning None (with a warning) if missing."""
    try:
        return json.loads(_read(path))
    except FileNotFoundError:
        print(f"[save_to_html] WARNING: data file not found, skipping: {path}")
        return None


# ---------------------------------------------------------------------------
# Offline bootstrap builder
# ---------------------------------------------------------------------------

def _build_fetch_loader() -> str:
    """
    Provides ``fetchFullEvent`` — dynamically loads per-event JS files from
    the ZIP folder structure, caching results in memory.
    Replaces the online ``fetchFullEvent`` that hits the FastAPI backend.
    """
    return r"""
// ── Offline event loader ───────────────────────────────────────────────────
const FULL_EVENTS_CACHE = {};

async function fetchFullEvent(event_id) {
    if (FULL_EVENTS_CACHE[event_id]) return FULL_EVENTS_CACHE[event_id];
    if (window.EVENTS && window.EVENTS[event_id]) {
        FULL_EVENTS_CACHE[event_id] = window.EVENTS[event_id];
        return window.EVENTS[event_id];
    }

    const parts      = event_id.split("_");
    const category   = parts[0] + "_" + parts[1];
    const safeId     = event_id.replace(/[:\s-]/g, "_");
    const scriptPath = `events/${category}/${safeId}.js`;

    return new Promise((resolve) => {
        const script  = document.createElement("script");
        script.src    = scriptPath;
        script.async  = true;
        script.onload = () => {
            if (window.EVENTS && window.EVENTS[event_id]) {
                FULL_EVENTS_CACHE[event_id] = window.EVENTS[event_id];
                resolve(window.EVENTS[event_id]);
            } else {
                console.error("[offline] Event not found after loading script:", scriptPath);
                resolve(null);
            }
            script.remove();
        };
        script.onerror = () => {
            console.error("[offline] Failed to load event script:", scriptPath);
            resolve(null);
        };
        document.body.appendChild(script);
    });
}
"""


def _build_offline_bootstrap(
    cached_events_summary: dict,
    chain_geojson: dict | None,
    waymarks_geojson: dict | None,
    tga_data: dict | None,
) -> tuple[str, str]:
    """
    Returns ``(fetch_patch_js, boot_js)`` — two separate JS strings.

    ``fetch_patch_js`` must be injected in a <script> block BEFORE the
    module concatenation so that ``chain_overlay.js`` and ``tga_overlay.js``
    (which fire their async IIFEs immediately on parse) see the patched
    ``window.fetch``.

    ``boot_js`` is appended after all modules and contains:
      - ``fetchFullEvent`` (dynamic per-event loader)
      - ``allEventsData`` injection
      - ``updateWheelMode`` deferred call
    """

    # Serialise GeoJSON/JSON (or safe fallbacks where applicable)
    chain_js = json.dumps(
        chain_geojson
        if chain_geojson is not None
        else {"type": "FeatureCollection", "features": []}
    )
    waymarks_js = json.dumps(
        waymarks_geojson
        if waymarks_geojson is not None
        else {"type": "FeatureCollection", "features": []}
    )
    tga_js = json.dumps(
        tga_data
        if tga_data is not None
        else {"meta": {}, "tgas": []}
    )
    events_js = json.dumps(cached_events_summary)

    # ── Part 1: fetch patch (runs BEFORE chain_overlay.js runs its IIFE) ──
    fetch_patch_js = f"""
// ── Offline data (baked in at export time) ─────────────────────────────────
const _OFFLINE_CHAINS   = {chain_js};
const _OFFLINE_WAYMARKS = {waymarks_js};
const _OFFLINE_TGAS     = {tga_js};

// ── Patch window.fetch to serve data files from memory ────────────────────
// Must run before chain_overlay.js and tga_overlay.js fire their async IIFEs.
(function () {{
    const _origFetch = window.fetch.bind(window);
    window.fetch = function (url, ...args) {{
        if (typeof url === "string") {{
            if (url.includes("chain_info.geojson")) {{
                console.log("[offline] Serving chain_info.geojson from memory");
                return Promise.resolve(
                    new Response(JSON.stringify(_OFFLINE_CHAINS), {{
                        status: 200,
                        headers: {{ "Content-Type": "application/json" }},
                    }})
                );
            }}
            if (url.includes("waymarks.geojson")) {{
                console.log("[offline] Serving waymarks.geojson from memory");
                return Promise.resolve(
                    new Response(JSON.stringify(_OFFLINE_WAYMARKS), {{
                        status: 200,
                        headers: {{ "Content-Type": "application/json" }},
                    }})
                );
            }}
            if (url.includes("tgas.json")) {{
                console.log("[offline] Serving tgas.json from memory");
                return Promise.resolve(
                    new Response(JSON.stringify(_OFFLINE_TGAS), {{
                        status: 200,
                        headers: {{ "Content-Type": "application/json" }},
                    }})
                );
            }}
        }}
        return _origFetch(url, ...args);
    }};
}})();
"""

    # ── Part 2: boot block (appended after all modules) ───────────────────
    boot_js = _build_fetch_loader() + f"""
// ── Boot dashboard ─────────────────────────────────────────────────────────
allEventsData = {events_js};
console.log("[offline] Loaded offline events:", allEventsData);

// Defer until Leaflet map bounds are valid to avoid LatLngBounds crash
map.whenReady(function () {{
    updateWheelMode("wheel_slide");
}});
"""

    return fetch_patch_js, boot_js


# ---------------------------------------------------------------------------
# Main export function
# ---------------------------------------------------------------------------

def save_to_html(cached_events_summary: dict) -> str:
    """Return a self-contained HTML document as a string."""

    # --- Read source files ---
    html_content = _read(_FRONTEND_DIR / "index.html")
    css_content  = _read(_FRONTEND_DIR / "styles.css")

    # --- Load data files at save time so they can be baked in ---
    # backend/data/ is the authoritative source
    chain_geojson    = _load_geojson_optional(_FRONTEND_DIR / "data" / "chain_info.geojson")
    waymarks_geojson = _load_geojson_optional(_FRONTEND_DIR / "data" / "waymarks.geojson")
    tga_data         = _load_geojson_optional(_FRONTEND_DIR / "data" / "tgas.json")

    # --- Build the offline bootstrap ---
    # fetch_patch_js is injected FIRST (before chain_overlay.js runs its IIFE)
    fetch_patch_js, boot_js = _build_offline_bootstrap(
        cached_events_summary, chain_geojson, waymarks_geojson, tga_data
    )

    # --- Concatenate all frontend JS modules in load order ---
    modules_js = "\n".join(
        _read(_FRONTEND_DIR / rel) for rel in _JS_MODULE_ORDER
    )
    js_content = modules_js + "\n" + boot_js

    # --- Inline CSS ---
    html_content = html_content.replace(
        "</head>",
        f"<style>\n{css_content}\n</style>\n</head>",
    )

    # --- Remove the live stylesheet link (now inlined above) ---
    html_content = html_content.replace(
        '<link rel="stylesheet" href="styles.css">',
        "",
    )

    # --- Replace the APP SCRIPTS block with the inlined concatenation ---
    # The fetch patch MUST run before chain_overlay.js (which fires its async
    # IIFE immediately), so we inject it in a separate <script> block first,
    # then the main module concatenation follows in a second block.
    marker_start = "<!-- APP SCRIPTS START -->"
    marker_end   = "<!-- APP SCRIPTS END -->"
    if marker_start in html_content and marker_end in html_content:
        before = html_content.split(marker_start)[0]
        after  = html_content.split(marker_end)[1]
        html_content = (
            before
            + marker_start
            + "\n<script>\n"
            + fetch_patch_js
            + "\n</script>\n"
            + "<script>\n"
            + js_content
            + "\n</script>\n"
            + marker_end
            + after
        )

    # --- Inline required images ---
    html_content = html_content.replace(
        '<img src="new_train_photo_no_back.png" alt="Train Photo">',
        _embed_image_base64(
            _FRONTEND_DIR / "new_train_photo_no_back.png",
            alt="Train Photo",
            extra_attrs='class="train-photo"',
        ),
    )
    html_content = html_content.replace(
        '<img src="traintracks.png" alt="Train Tracks" class="train-tracks">',
        _embed_image_base64(
            _FRONTEND_DIR / "traintracks.png",
            alt="Train Tracks",
            extra_attrs='class="train-tracks"',
        ),
    )
    html_content = html_content.replace(
        '<img src="newest_logo.png" alt="Logo">',
        _embed_image_base64(_FRONTEND_DIR / "newest_logo.png", alt="Logo"),
    )
    html_content = html_content.replace(
        '''<div id="fleet-images" style="display:none;">
        <img src="images/165-2.png" data-fleet-id="165-2" class="train-photo">
        <img src="images/165-3.png" data-fleet-id="165-3" class="train-photo">
        <img src="images/168-3.png" data-fleet-id="168-3" class="train-photo">
    </div>''',
        f'''<div id="fleet-images" style="display:none;">
        {_embed_image_base64(_FRONTEND_DIR / "images/165-2.png", extra_attrs='data-fleet-id="165-2" class="train-photo"')}
        {_embed_image_base64(_FRONTEND_DIR / "images/165-3.png", extra_attrs='data-fleet-id="165-3" class="train-photo"')}
        {_embed_image_base64(_FRONTEND_DIR / "images/168-3.PNG", extra_attrs='data-fleet-id="168-3" class="train-photo"')}
    </div>''',
    )

    return html_content