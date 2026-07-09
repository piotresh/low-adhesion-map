/**
 * Static configuration shared across all frontend modules.
 *
 * - MAPCFG  : corridor/arrow sizing, z-order layering and detach thresholds.
 * - brakeColors : colour per brake-demand state (0–4) used by both map layer and legend.
 *
 * Plain globals so this works without a bundler (matches the original app.js).
 */

// ───────────── Map rendering configuration ─────────────
const MAPCFG = {
  line: {
    widthMeters: 8,          // corridor width in meters (world-fixed)
    bufferSteps: 8,          // smoothing for the buffer polygon
    opacityDefault: 1.0,  //changing opacity
    opacitySelected: 1.0,
  },
  arrow: {
    lenMeters: 60,           // distance from base-center → tip (also trim distance)
    halfWidthMeters: 35,     // half base width (≥ widthMeters/2 so it covers the end)
    forwardMeters: 5,        // push tip a bit past the end to fully cover the cut
    tolMeters: 0.5,          // tolerance for degenerate tiny segments
    strokeColor: "#2563eb",  // blue border colour
    borderMeters: 4.0,         // geo-proportional border width in metres (scales with zoom like the arrow does)
    fillOpacityDefault: 1.0,// better visivility for differing colours
    fillOpacitySelected: 1.0,
    gapMeters: 8,                    // keep arrow ≥ 8 m in front when detached
    detachIfCorridorBelowMeters: 120, // detach arrow if trimmed corridor < 120 m
  },
  z: {
    routes:   410,
    arrows:   420,
    brake:    425,   // below routes/arrows/selected
    selected: 430,
  },
};

// ───────────── Brake-demand colour palette ─────────────
const brakeColors = {
  0: "#43A047",  // Normal     - bright green
  1: "#00BCD4",  // Step 1     - cyan (stands out from green)
  2: "#FFC107",  // Step 2     - amber
  3: "#FF5722",  // No Demand  - deep orange
  4: "#D32F2F",  // Emergency  - strong red
};

// ───────────── Colours used by polyline severity (kept for future use) ─────
function getPolylineColor(speedDrop) {
  if (speedDrop > 15) return "#d32f2f"; // severe
  if (speedDrop > 5)  return "#f57c00"; // moderate
  return "#fbc02d";                     // minor
}
