/**
 * tga_overlay.js
 * Renders TGA (Gel Application) sites as hoverable markers on the map.
 *
 * Positions are resolved dynamically at runtime by matching each TGA's
 * ELR + mileage + line (Up/Down) against allChainFeatures (chain_info.geojson),
 * then using that chain segment's geometry centroid as the marker position.
 *
 * Depends on: chain_overlay.js  (allChainFeatures, chainsReady, loadGeoJSON, showTip, hideTip)
 * Load order:  chain_overlay.js  →  tga_overlay.js
 */

// ── Config ────────────────────────────────────────────────────────────────────
const TGA_PATH = "data/tgas.json";

const TGA_COLOURS = {
  commissioned_on:  "#00e676",  // green  – on and running
  commissioned_off: "#ffb300",  // amber  – commissioned, not yet switched on
  not_commissioned: "#ff4444",  // red    – not being commissioned
};

const TGA_LABELS = {
  commissioned_on:  "Commissioned & On",
  commissioned_off: "Commissioned, Not Switched On",
  not_commissioned: "Not Commissioned",
};

// ── State ─────────────────────────────────────────────────────────────────────
let tgaLayer   = null;
let tgaEnabled = false;

// ── Pane ──────────────────────────────────────────────────────────────────────
function ensureTgaPane() {
  if (!map.getPane("tgaPane")) {
    map.createPane("tgaPane");
    map.getPane("tgaPane").style.zIndex        = 465;
    map.getPane("tgaPane").style.pointerEvents = "auto";
  }
}

// ── Geometry centroid ─────────────────────────────────────────────────────────
function _tgaFeatureCentroid(geometry) {
  if (!geometry) return null;
  const { type, coordinates: c } = geometry;
  if (type === "Point") return [c[1], c[0]];
  if (type === "LineString") {
    return [c.reduce((s,p)=>s+p[1],0)/c.length, c.reduce((s,p)=>s+p[0],0)/c.length];
  }
  if (type === "MultiLineString") {
    const all = c.flat();
    return [all.reduce((s,p)=>s+p[1],0)/all.length, all.reduce((s,p)=>s+p[0],0)/all.length];
  }
  if (type === "Polygon") {
    const ring = c[0];
    return [ring.reduce((s,p)=>s+p[1],0)/ring.length, ring.reduce((s,p)=>s+p[0],0)/ring.length];
  }
  return null;
}

// ── Match a TGA to its best chain feature ─────────────────────────────────────
// tga.line is "Up" or "Down" — chain features use direction: "Up" / "Down"
function _findChainForTga(tga) {
  const tgaDec = tga.miles + tga.chains / 80;

  // Strict match: ELR + direction ("Up"/"Down")
  let candidates = allChainFeatures.filter(f =>
    f.properties?.ELR === tga.elr &&
    f.properties?.direction === tga.line
  );

  // Fallback: ELR only (data anomaly guard)
  if (candidates.length === 0 && tga.line) {
    candidates = allChainFeatures.filter(f => f.properties?.ELR === tga.elr);
    if (candidates.length > 0) {
      console.warn(`[tga_overlay] No direction match for ${tga.elr} ${tga.line}, falling back — ${tga.id}`);
    }
  }

  if (candidates.length === 0) {
    if (!_tgaMissingElrLogged) {
      _tgaMissingElrLogged = true;
      const present = [...new Set(allChainFeatures.map(f => f.properties?.ELR))].sort();
      console.warn("[tga_overlay] ELRs in chain data:", present);
    }
    return null;
  }

  let best = null, bestDiff = Infinity;
  for (const f of candidates) {
    const p    = f.properties;
    const fDec = (p.mile ?? p.MILE ?? 0) + (p.chain ?? p.CHAIN ?? 0) / 80;
    const diff = Math.abs(fDec - tgaDec);
    if (diff < bestDiff) { bestDiff = diff; best = f; }
  }
  return best;
}
let _tgaMissingElrLogged = false;

// ── Build layer ───────────────────────────────────────────────────────────────
function buildTgaLayer(data) {
  if (tgaLayer) { try { map.removeLayer(tgaLayer); } catch (_) {} }

  const markers = [];
  let placed = 0, noChain = 0;

  for (const tga of data.tgas) {
    const chainFeature = _findChainForTga(tga);
    if (!chainFeature) {
      console.warn(`[tga_overlay] No chain match for ${tga.id} (${tga.elr} ${tga.miles}m${tga.chains}ch ${tga.line})`);
      noChain++;
      continue;
    }

    const centroid = _tgaFeatureCentroid(chainFeature.geometry);
    if (!centroid) continue;

    const [lat, lon] = centroid;
    const colour     = TGA_COLOURS[tga.status] || "#aaa";
    const mileDecimal = tga.mile_decimal ?? (tga.miles + tga.chains / 80).toFixed(4);

    const marker = L.circleMarker([lat, lon], {
      pane:        "tgaPane",
      radius:      6,
      fillColor:   colour,
      color:       "#1a1a2e",
      weight:      1.5,
      opacity:     1,
      fillOpacity: 0.92,
    });

    marker.on({
      mouseover() {
        // Build tooltip purely from TGA data — no chain props leaked in
        _tip.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
            <div>
              <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.12em;color:#9ca3af;margin-bottom:3px;">TGA Site</div>
              <div style="font-family:'DM Sans',sans-serif;font-size:18px;font-weight:700;color:#000;letter-spacing:-0.02em;line-height:1;">${tga.id || "—"}</div>
            </div>
            <div style="width:10px;height:10px;border-radius:50%;background:${colour};flex-shrink:0;margin-top:4px;"></div>
          </div>

          <div style="background:#f9fafb;border-radius:14px;padding:12px;margin-bottom:10px;display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;">Type</div>
              <div style="font-size:14px;font-weight:700;color:#000;margin-top:2px;">${tga.type || "—"}</div>
            </div>
            <div>
              <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;">Location</div>
              <div style="font-size:14px;font-weight:700;color:#000;margin-top:2px;">${tga.location || "—"}</div>
            </div>
            <div>
              <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;">ELR</div>
              <div style="font-size:14px;font-weight:700;color:#000;margin-top:2px;">${tga.elr || "—"}</div>
            </div>
            <div>
              <div style="font-family:'DM Mono',monospace;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;">Line</div>
              <div style="font-size:14px;font-weight:700;color:#000;margin-top:2px;">${tga.line || "—"}</div>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:12px;">
              <span style="color:#9ca3af;font-weight:500;">Position</span>
              <span style="color:#111;font-weight:600;">${tga.miles}m ${tga.chains}ch <span style="color:#9ca3af;font-weight:400;">(${mileDecimal} mi)</span></span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #f3f4f6;font-size:12px;">
              <span style="color:#9ca3af;font-weight:500;">Status</span>
              <span style="color:${colour};font-weight:600;">${TGA_LABELS[tga.status] || tga.status || "—"}</span>
            </div>
          </div>
        `;
        _tip.style.display = "block";
        this.setStyle({ radius: 9, weight: 2.5 });
      },
      mouseout() {
        hideTip();
        this.setStyle({ radius: 6, weight: 1.5 });
      },
    });

    markers.push(marker);
    placed++;
  }

  tgaLayer = L.layerGroup(markers);
  console.log(`[tga_overlay] ${placed} placed, ${noChain} unmatched`);
}

// ── Button ────────────────────────────────────────────────────────────────────
function wireTgaButton() {
  const btn = document.getElementById("tga-master-btn");
  if (!btn) { console.warn("[tga_overlay] #tga-master-btn not found"); return; }

  btn.style.opacity = "0.45";

  btn.addEventListener("click", function () {
    if (!tgaLayer) return;
    tgaEnabled = !tgaEnabled;
    if (tgaEnabled) {
      map.addLayer(tgaLayer);
      this.style.opacity = "1";
    } else {
      map.removeLayer(tgaLayer);
      this.style.opacity = "0.45";
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  ensureTgaPane();

  try {
    await chainsReady;
    const data = await loadGeoJSON(TGA_PATH);
    buildTgaLayer(data);
  } catch (e) {
    console.error("[tga_overlay] Failed:", e);
  }

  wireTgaButton();
})();