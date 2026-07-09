/**
 * speed_overlay.js
 * Speed limit change marker overlay.
 *
 * Renders speed-limit change markers: a coloured circleMarker at the change
 * point plus a polyline showing the segment the new speed applies to.
 *
 * Perf strategy (mirrors chain_overlay.js):
 *  1. Debounce moveend/zoomend — no render spam while panning
 *  2. Pre-compute bboxes at load time
 *  3. rbush spatial index — O(log n) viewport query
 *  4. Canvas renderer for ALL geometry (no DOM elements per feature)
 *  5. Layer rebuilt only when visible set changes (fingerprint diff)
 *  6. Hidden below min zoom, with a "zoom in more" hint
 */

// ── Config ────────────────────────────────────────────────────────────────────
const SPEED_PATH               = "data/speed_change_markers.geojson";
const SPEED_MIN_ZOOM           = 13;
const SPEED_RENDER_DEBOUNCE_MS = 80;

// ── State ─────────────────────────────────────────────────────────────────────
let speedLayer           = null;
let speedEnabled         = false;
let allSpeedFeatures     = [];

let _speedSpatialIndex   = null;
let _speedRenderTimer    = null;
let _lastVisibleSpeedIds = null;

// ── Pane ──────────────────────────────────────────────────────────────────────
function ensureSpeedPane() {
  if (!map.getPane("speedPane")) {
    const p = map.createPane("speedPane");
    p.style.zIndex        = 470;
    p.style.pointerEvents = "auto";
  }
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
function _speedTipHtml(p) {
  const colour     = p.colour || (p.change > 0 ? "#2e7d32" : "#c8102e");
  const arrow      = p.change > 0 ? "▲" : "▼";
  const dirLabel   = p.change > 0 ? "INCREASE" : "DECREASE";
  const lengthLabel = p.to_segment_length_m != null
    ? `${p.to_segment_length_m.toFixed(0)} m`
    : "—";
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
      <div>
        <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.12em;color:#9ca3af;margin-bottom:3px;">Speed Limit ${dirLabel}</div>
        <div style="font-family:'DM Sans',sans-serif;font-size:18px;font-weight:700;color:#000;letter-spacing:-0.02em;line-height:1;">${p.elr || "—"} ${arrow}</div>
      </div>
      <div style="width:10px;height:10px;border-radius:50%;background:${colour};flex-shrink:0;margin-top:4px;"></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:12px;">
        <span style="color:#9ca3af;font-weight:500;">Change</span>
        <span style="color:#111;font-weight:600;">${p.speed_from} mph → ${p.speed_to} mph</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:12px;">
        <span style="color:#9ca3af;font-weight:500;">Applies for</span>
        <span style="color:#111;font-weight:600;">${lengthLabel}</span>
      </div>
    </div>
  `;
}

// ── Build spatial index ───────────────────────────────────────────────────────
// Bbox covers both the marker point and its segment so pan-into-view works.
function buildSpeedSpatialIndex(features) {
  const tree  = new RBush();
  const items = features.map(f => {
    const [lng, lat] = f.geometry.coordinates;
    let minX = lng, minY = lat, maxX = lng, maxY = lat;

    const seg = f.properties.to_segment;
    if (Array.isArray(seg)) {
      for (const [slng, slat] of seg) {
        if (slng < minX) minX = slng;
        if (slng > maxX) maxX = slng;
        if (slat < minY) minY = slat;
        if (slat > maxY) maxY = slat;
      }
    }

    f._bbox = { minX, minY, maxX, maxY };
    return { minX, minY, maxX, maxY, feature: f };
  });
  tree.load(items);
  return tree;
}

// ── Viewport query — O(log n) ─────────────────────────────────────────────────
function speedFeaturesInBounds(bounds) {
  if (!_speedSpatialIndex) return [];
  return _speedSpatialIndex.search({
    minX: bounds.getWest(),
    minY: bounds.getSouth(),
    maxX: bounds.getEast(),
    maxY: bounds.getNorth(),
  }).map(item => item.feature);
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderVisibleSpeedMarkers() {
  if (!speedEnabled || map.getZoom() < SPEED_MIN_ZOOM) {
    if (speedLayer) { map.removeLayer(speedLayer); speedLayer = null; }
    return;
  }

  const visible     = speedFeaturesInBounds(map.getBounds());
  const fingerprint = visible.map(f => f.properties.elr + ":" + f.geometry.coordinates.join(",")).join("|");
  if (fingerprint === _lastVisibleSpeedIds) return;
  _lastVisibleSpeedIds = fingerprint;

  if (speedLayer) { map.removeLayer(speedLayer); speedLayer = null; }
  if (visible.length === 0) return;

  // Single shared canvas renderer — all geometry drawn on one canvas
  const renderer = L.canvas({ pane: "speedPane", padding: 0.5, tolerance: 6 });

  // Build two GeoJSON feature collections: segments and points
  const segFeatures = [];
  const ptFeatures  = [];

  for (const f of visible) {
    const p      = f.properties;
    const colour = p.colour || (p.change > 0 ? "#2e7d32" : "#c8102e");
    p._colour    = colour;

    // Segment polyline
    const seg = p.to_segment;
    if (Array.isArray(seg) && seg.length >= 2) {
      segFeatures.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: seg },
        properties: { ...p, _colour: colour },
      });
    }

    // Point marker
    ptFeatures.push({
      type: "Feature",
      geometry: f.geometry,
      properties: { ...p, _colour: colour },
    });
  }

  const layers = [];

  // ── Segment lines ──
  if (segFeatures.length) {
    const segLayer = L.geoJSON(
      { type: "FeatureCollection", features: segFeatures },
      {
        pane: "speedPane",
        renderer,
        interactive: true,
        style(feature) {
          return {
            color:     feature.properties._colour,
            weight:    4,
            opacity:   0.85,
            lineCap:   "round",
            lineJoin:  "round",
          };
        },
        onEachFeature(feature, layer) {
          const p = feature.properties;
          layer.on({
            mouseover() { showTip(_speedTipHtml(p)); layer.setStyle({ weight: 7, opacity: 1 }); },
            mouseout()  { hideTip(); layer.setStyle({ weight: 4, opacity: 0.85 }); },
          });
        },
      }
    );
    layers.push(segLayer);
  }

  // ── Speed-change point markers ──
  if (ptFeatures.length) {
    const ptLayer = L.geoJSON(
      { type: "FeatureCollection", features: ptFeatures },
      {
        pane: "speedPane",
        renderer,
        interactive: true,
        pointToLayer(feature, latlng) {
          const colour = feature.properties._colour;
          return L.circleMarker(latlng, {
            pane:        "speedPane",
            renderer,
            radius:      6,
            fillColor:   colour,
            color:       "#ffffff",
            weight:      2,
            opacity:     1,
            fillOpacity: 1,
          });
        },
        onEachFeature(feature, layer) {
          const p = feature.properties;
          layer.on({
            mouseover() { showTip(_speedTipHtml(p)); layer.setStyle({ radius: 9, weight: 2.5 }); },
            mouseout()  { hideTip(); layer.setStyle({ radius: 6, weight: 2 }); },
          });
        },
      }
    );
    layers.push(ptLayer);
  }

  speedLayer = L.layerGroup(layers).addTo(map);
}

// Debounced wrapper
function scheduleSpeedRender() {
  clearTimeout(_speedRenderTimer);
  _speedRenderTimer = setTimeout(renderVisibleSpeedMarkers, SPEED_RENDER_DEBOUNCE_MS);
}

// ── Map hooks ─────────────────────────────────────────────────────────────────
map.on("moveend zoomend", scheduleSpeedRender);

// ── Button wiring ─────────────────────────────────────────────────────────────
function wireSpeedButton() {
  const speedBtn = document.getElementById("speed-master-btn");
  if (!speedBtn) return;

  speedBtn.style.opacity = "0.45";

  const hint = document.createElement("div");
  Object.assign(hint.style, {
    fontSize:      "9px",
    color:         "#666",
    fontFamily:    "monospace",
    letterSpacing: "0.5px",
    marginTop:     "2px",
    display:       "none",
    textAlign:     "center",
  });
  hint.textContent = "zoom in more to see";
  speedBtn.insertAdjacentElement("afterend", hint);

  speedBtn.addEventListener("click", function () {
    speedEnabled = !speedEnabled;
    if (speedEnabled) {
      this.style.opacity   = "1";
      _lastVisibleSpeedIds = null;
      renderVisibleSpeedMarkers();
      hint.style.display = map.getZoom() < SPEED_MIN_ZOOM ? "block" : "none";
    } else {
      if (speedLayer) { map.removeLayer(speedLayer); speedLayer = null; }
      this.style.opacity = "0.45";
      hint.style.display = "none";
    }
  });

  map.on("zoomend", () => {
    if (speedEnabled) hint.style.display = map.getZoom() < SPEED_MIN_ZOOM ? "block" : "none";
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  ensureSpeedPane();

  if (SPEED_PATH) {
    try {
      const spData       = await loadGeoJSON(SPEED_PATH);
      allSpeedFeatures   = spData.features;
      _speedSpatialIndex = buildSpeedSpatialIndex(allSpeedFeatures);
      console.log(`[speed_overlay] ${allSpeedFeatures.length} speed limit markers indexed`);
    } catch (e) {
      console.warn("[speed_overlay] Could not load speed markers:", e);
    }
  }

  wireSpeedButton();
})();
