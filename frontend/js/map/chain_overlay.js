/**
 * chain_overlay.js
 * High-performance chain segment overlay.
 *
 * Perf strategy:
 *  1. Debounce moveend/zoomend — no render spam while panning
 *  2. Pre-compute bboxes at load time — O(1) bounds check per feature
 *  3. rbush spatial index — O(log n) viewport query instead of O(n)
 *  4. Canvas renderer with padding — fewer redraws at edges
 *  5. Layer is only rebuilt when the visible set actually changes
 *
 * Colour strategy:
 *  Alternates red/blue by chain number (even = #1d4ed8 blue, odd = #ef4444 red)
 *  so adjacent chains are always visually distinct.
 */

// ── Config ────────────────────────────────────────────────────────────────────
const CHAIN_PATH          = "data/chain_info.geojson";
const WAYMARKS_PATH       = "data/waymarks.geojson";
const CHAIN_MIN_ZOOM      = 15;
const RENDER_DEBOUNCE_MS  = 80;

const CHAIN_COLOURS = {
  even: "#1d4ed8",
  odd:  "#ef4444",
};

// ── State ─────────────────────────────────────────────────────────────────────
let _chainsReadyResolve;
const chainsReady = new Promise(res => { _chainsReadyResolve = res; });

let allChainFeatures = [];   // populated at bootstrap — used by tga_overlay.js too
let chainLayer       = null;
let waymarkLayer     = null;
let chainsEnabled    = false;
let waymarksEnabled  = false;

let _spatialIndex    = null;
let _renderTimer     = null;
let _lastVisibleIds  = null;

// ── Colour helpers ────────────────────────────────────────────────────────────
function chainColour(chain) {
  return (chain % 2 === 0) ? CHAIN_COLOURS.even : CHAIN_COLOURS.odd;
}

// 25 visually distinct colours for waymark ELR assignment.
// Each ELR hashes deterministically to one slot — same ELR always same colour,
// neighbouring ELRs (alphabetically close) land in different slots.
const WAYMARK_PALETTE = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990",
  "#dcbeff", "#9a6324", "#fffac8", "#800000", "#aaffc3",
  "#808000", "#ffd8b1", "#000075", "#a9a9a9", "#ffffff",
  "#e6beff", "#ff6347", "#00ced1", "#ff1493", "#32cd32",
];

// djb2-style hash → palette index
function _elrHash(elr) {
  let h = 5381;
  for (let i = 0; i < elr.length; i++) h = (h * 33) ^ elr.charCodeAt(i);
  return Math.abs(h) % WAYMARK_PALETTE.length;
}

function elrColour(elr) {
  if (!elr) return WAYMARK_PALETTE[0];
  return WAYMARK_PALETTE[_elrHash(elr)];
}

// ── Panes ─────────────────────────────────────────────────────────────────────
function ensureChainPanes() {
  if (!map.getPane("chainPane")) {
    const p = map.createPane("chainPane");
    p.style.zIndex        = 450;
    p.style.pointerEvents = "visiblePainted";
  }
  if (!map.getPane("waymarkPane")) {
    const p = map.createPane("waymarkPane");
    p.style.zIndex        = 460;
    p.style.pointerEvents = "auto";
  }
}

// ── Shared tooltip element ────────────────────────────────────────────────────
let _tip = document.getElementById("chain-tooltip");
if (!_tip) {
  _tip = document.createElement("div");
  _tip.id = "chain-tooltip";
  Object.assign(_tip.style, {
    position:      "fixed",
    top:           "50%",
    left:          "280px",
    transform:     "translateY(-50%)",
    marginLeft:    "14px",
    background:    "#ffffff",
    border:        "none",
    borderRadius:  "22px",
    boxShadow:     "0 2px 10px rgba(0,0,0,0.10)",
    padding:       "18px 20px",
    width:         "230px",
    pointerEvents: "none",
    display:       "none",
    zIndex:        "9999",
    fontFamily:    "'DM Sans', Helvetica, Arial, sans-serif",
    color:         "#111111",
    lineHeight:    "1.6",
  });
  document.body.appendChild(_tip);
}

// showTip / hideTip are used by tga_overlay.js too
function showTip(html) {
  _tip.innerHTML = html;
  _tip.style.display = "block";
}
const hideTip = () => { _tip.style.display = "none"; };

// ── Chain tooltip (yards, not metres) ─────────────────────────────────────────
function _chainTipHtml(p, colour) {
  const isMile    = p.chain === 0;
  const lenYd     = p.chain_length_yd  != null ? p.chain_length_yd.toFixed(1)  : "—";
  const distMi    = p.track_distance_mi     != null ? p.track_distance_mi.toFixed(4)     : "—";
  const distEndMi = p.track_distance_end_mi != null ? p.track_distance_end_mi.toFixed(4) : "—";
  const distYd    = p.track_distance_m      != null ? (p.track_distance_m * 1.09361).toFixed(1)     : "—";
  const distEndYd = p.track_distance_end_m  != null ? (p.track_distance_end_m * 1.09361).toFixed(1) : "—";

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
      <div>
        <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.12em;color:#9ca3af;margin-bottom:3px;">Chain Segment</div>
        <div style="font-family:'DM Sans',sans-serif;font-size:18px;font-weight:700;color:#000;letter-spacing:-0.02em;line-height:1;">${p.chain_id || "—"}</div>
      </div>
      <div style="width:10px;height:10px;border-radius:50%;background:${colour};flex-shrink:0;margin-top:4px;"></div>
    </div>

    <div style="background:#f9fafb;border-radius:14px;padding:12px;margin-bottom:10px;display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div>
        <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;">ELR</div>
        <div style="font-size:14px;font-weight:700;color:#000;margin-top:2px;">${p.ELR || "—"}</div>
      </div>
      <div>
        <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;">Track ID</div>
        <div style="font-size:14px;font-weight:700;color:#000;margin-top:2px;">${p.TRID || "—"}</div>
      </div>
      <div>
        <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;">Mile</div>
        <div style="font-size:14px;font-weight:700;color:#000;margin-top:2px;">${p.mile ?? "—"}</div>
      </div>
      <div>
        <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;">Chain</div>
        <div style="font-size:14px;font-weight:700;color:#000;margin-top:2px;">${p.chain ?? "—"}${isMile ? " <span style='font-size:10px;font-weight:500;color:#9ca3af;'>(mile mark)</span>" : ""}</div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:6px;">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:12px;">
        <span style="color:#9ca3af;font-weight:500;">Position</span>
        <span style="color:#111;font-weight:600;">${p.mile_chain_label || "—"}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:12px;">
        <span style="color:#9ca3af;font-weight:500;">Track</span>
        <span style="color:#111;font-weight:600;">${p.track_label || p.direction || "—"} ${p.direction_arrow || ""}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:12px;">
        <span style="color:#9ca3af;font-weight:500;">Track type</span>
        <span style="color:#111;font-weight:600;">${p.track_type || "—"}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:12px;">
        <span style="color:#9ca3af;font-weight:500;">Length</span>
        <span style="color:#111;font-weight:600;">${lenYd} yd</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:12px;">
        <span style="color:#9ca3af;font-weight:500;">From</span>
        <span style="color:#111;font-weight:600;">${distMi} mi <span style="color:#9ca3af;font-weight:400;">(${distYd} yd)</span></span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:12px;">
        <span style="color:#9ca3af;font-weight:500;">To</span>
        <span style="color:#111;font-weight:600;">${distEndMi} mi <span style="color:#9ca3af;font-weight:400;">(${distEndYd} yd)</span></span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:12px;">
        <span style="color:#9ca3af;font-weight:500;">Segment</span>
        <span style="color:#111;font-weight:600;">${p.segment_from ?? "?"} → ${p.segment_to ?? "?"}</span>
      </div>
    </div>
  `;
}

// ── Waymark tooltip (ELR + mile only) ────────────────────────────────────────
function _waymarkTipHtml(p, colour) {
  const mile = p.WAYMARK_VA ?? p.WAYMARK_VAL ?? p.MILE ?? "—";
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
      <div>
        <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.12em;color:#9ca3af;margin-bottom:3px;">Waymark</div>
        <div style="font-family:'DM Sans',sans-serif;font-size:18px;font-weight:700;color:#000;letter-spacing:-0.02em;line-height:1;">${p.ELR || "—"}</div>
      </div>
      <div style="width:10px;height:10px;border-radius:50%;background:${colour};flex-shrink:0;margin-top:4px;"></div>
    </div>
    <div style="display:flex;justify-content:space-between;padding:5px 0;font-size:12px;">
      <span style="color:#9ca3af;font-weight:500;">Mile</span>
      <span style="color:#111;font-weight:600;">${mile}</span>
    </div>
  `;
}

// ── GeoJSON fetch ─────────────────────────────────────────────────────────────
async function loadGeoJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${path}`);
  return res.json();
}

// ── Build spatial index ───────────────────────────────────────────────────────
function buildSpatialIndex(features) {
  const tree  = new RBush();
  const items = features.map(f => {
    const coords = f.geometry.coordinates;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [lng, lat] of coords) {
      if (lng < minX) minX = lng;
      if (lng > maxX) maxX = lng;
      if (lat < minY) minY = lat;
      if (lat > maxY) maxY = lat;
    }
    f._bbox = { minX, minY, maxX, maxY };
    return { minX, minY, maxX, maxY, feature: f };
  });
  tree.load(items);
  return tree;
}

// ── Viewport query — O(log n) ─────────────────────────────────────────────────
function featuresInBounds(bounds) {
  if (!_spatialIndex) return [];
  return _spatialIndex.search({
    minX: bounds.getWest(),
    minY: bounds.getSouth(),
    maxX: bounds.getEast(),
    maxY: bounds.getNorth(),
  }).map(item => item.feature);
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderVisibleChains() {
  if (!chainsEnabled || map.getZoom() < CHAIN_MIN_ZOOM) {
    if (chainLayer) { map.removeLayer(chainLayer); chainLayer = null; }
    return;
  }

  const visible     = featuresInBounds(map.getBounds());
  const fingerprint = visible.map(f => f.properties.chain_id || "").join(",");
  if (fingerprint === _lastVisibleIds) return;
  _lastVisibleIds = fingerprint;

  if (chainLayer) { map.removeLayer(chainLayer); chainLayer = null; }
  if (visible.length === 0) return;

  const renderer = L.canvas({ pane: "chainPane", padding: 0.5, tolerance: 6 });

  chainLayer = L.geoJSON(
    { type: "FeatureCollection", features: visible },
    {
      pane:        "chainPane",
      interactive: true,
      renderer,
      style(feature) {
        const p      = feature.properties;
        const colour = chainColour(p.chain ?? 0);
        p._colour    = colour;
        const isMile = p.chain === 0;
        return {
          color:    colour,
          weight:   isMile ? 6 : 4,
          opacity:  isMile ? 1.0 : 0.85,
          lineCap:  "round",
          lineJoin: "round",
        };
      },
      onEachFeature(feature, layer) {
        const p = feature.properties;
        layer.on({
          mouseover() {
            const c = p._colour || CHAIN_COLOURS.even;
            showTip(_chainTipHtml(p, c));
            layer.setStyle({ weight: p.chain === 0 ? 9 : 7, opacity: 1 });
          },
          mouseout() {
            hideTip();
            layer.setStyle({ weight: p.chain === 0 ? 6 : 4, opacity: p.chain === 0 ? 1.0 : 0.85 });
          },
          click() {
            map.fitBounds(layer.getBounds(), { padding: [50, 50], maxZoom: 16 });
          },
        });
      },
    }
  ).addTo(map);
}

// Debounced wrapper
function scheduleRender() {
  clearTimeout(_renderTimer);
  _renderTimer = setTimeout(renderVisibleChains, RENDER_DEBOUNCE_MS);
}

// ── Waymark layer ─────────────────────────────────────────────────────────────
function buildWaymarkLayer(data) {
  if (waymarkLayer) { try { map.removeLayer(waymarkLayer); } catch (_) {} }

  waymarkLayer = L.geoJSON(data, {
    pane: "waymarkPane",
    pointToLayer(feature, latlng) {
      const colour = elrColour(feature.properties.ELR);
      feature.properties._colour = colour;
      return L.circleMarker(latlng, {
        pane:        "waymarkPane",
        radius:      5,
        fillColor:   colour,
        color:       "#fff",
        weight:      1.5,
        opacity:     1,
        fillOpacity: 0.9,
      });
    },
    onEachFeature(feature, layer) {
      const p = feature.properties;
      layer.on({
        mouseover() {
          showTip(_waymarkTipHtml(p, p._colour || WAYMARK_PALETTE[0]));
          layer.setStyle({ radius: 8, weight: 2.5 });
        },
        mouseout() {
          hideTip();
          layer.setStyle({ radius: 5, weight: 1.5 });
        },
      });
    },
  });
}

// ── Map hooks ─────────────────────────────────────────────────────────────────
map.on("moveend zoomend", scheduleRender);

// ── Button wiring ─────────────────────────────────────────────────────────────
function wireButtons() {
  const chainBtn   = document.getElementById("chain-master-btn");
  const waymarkBtn = document.getElementById("waymark-master-btn");

  chainBtn.style.opacity   = "0.45";
  waymarkBtn.style.opacity = "0.45";

  const hint = document.createElement("div");
  Object.assign(hint.style, {
    fontSize:    "9px",
    color:       "#666",
    fontFamily:  "monospace",
    letterSpacing: "0.5px",
    marginTop:   "2px",
    display:     "none",
    textAlign:   "center",
  });
  hint.textContent = "zoom in more to see";
  chainBtn.insertAdjacentElement("afterend", hint);

  chainBtn.addEventListener("click", function () {
    chainsEnabled = !chainsEnabled;
    if (chainsEnabled) {
      this.style.opacity = "1";
      _lastVisibleIds    = null;
      renderVisibleChains();
      hint.style.display = map.getZoom() < CHAIN_MIN_ZOOM ? "block" : "none";
    } else {
      if (chainLayer) { map.removeLayer(chainLayer); chainLayer = null; }
      this.style.opacity = "0.45";
      hint.style.display = "none";
    }
  });

  map.on("zoomend", () => {
    if (chainsEnabled) hint.style.display = map.getZoom() < CHAIN_MIN_ZOOM ? "block" : "none";
  });

  waymarkBtn.addEventListener("click", function () {
    if (!waymarkLayer) return;
    waymarksEnabled = !waymarksEnabled;
    if (waymarksEnabled) {
      map.addLayer(waymarkLayer);
      this.style.opacity = "1";
    } else {
      map.removeLayer(waymarkLayer);
      this.style.opacity = "0.45";
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  ensureChainPanes();

  try {
    const data       = await loadGeoJSON(CHAIN_PATH);
    allChainFeatures = data.features;
    _spatialIndex    = buildSpatialIndex(allChainFeatures);
    _chainsReadyResolve();
    console.log(`[chain_overlay] ${allChainFeatures.length} features indexed`);
  } catch (e) {
    console.error("[chain_overlay] Failed to load chains:", e);
  }

  if (WAYMARKS_PATH) {
    try {
      const wmData = await loadGeoJSON(WAYMARKS_PATH);
      buildWaymarkLayer(wmData);
      console.log(`[chain_overlay] ${wmData.features.length} waymarks ready`);
    } catch (e) {
      console.warn("[chain_overlay] Could not load waymarks:", e);
    }
  }

  wireButtons();
})();