/**
 * Mutable global state shared across frontend modules.
 *
 * Kept in one place so anyone reading the code can see what "the world" looks
 * like at runtime. These are plain `let` bindings — assignment from other
 * modules just works because all scripts share one global scope.
 */

// ───────────── Event data ─────────────
let allEventsData      = {};            // { wheel_slide: [...], wheel_spin: [...], ... }
let selectedEvents     = [];            // Events currently matching the filters
let currentEvent       = null;          // Event open in the right panel (full data)
let wheel_mode         = "wheel_slide"; // Active category in the UI dropdown
let mursField          = "murs_avg";    // Which adhesion index is shown
let timelineItems      = [];            // Raw data for the D3 timeline

// ───────────── Filter state ─────────────
let globalStartDate         = null;
let globalEndDate           = null;
let globalBrakePerfStartBin = null;
let globalBrakePerfEndBin   = null;

// ───────────── Map layers ─────────────
let polylines      = [];    // Non-brake polylines/arrows currently drawn
let brakePolylines = [];    // Brake-demand segments (tracked separately)
let brakeLegend    = null;  // Leaflet control for the brake legend (or null)

// ───────────── Per-event ancillary state ─────────────
let routerToRenderMap = null;     // Which router's data to use for the brake-map layer
let mode              = "slide";  // Chart-mode dropdown (slide/spin/brake_performance/VVPOP)

// ───────────── Feature flags ─────────────
let BrakeDemandChartEnabled = true;
let BrakeDemandMapEnabled   = false;

// ───────────── Adhesion-index field → event-object field ─────────────
const mursFieldMap = {
  murs_min: "Adhesion_Index_Murs_Min",
  murs_avg: "Adhesion_Index_Murs_Avg",
};

// ───────────── Brake-demand state classifier ─────────────
// Shared by the map layer, the chart shapes and the hover text.
const getState = (b1, b2, e) => {
  if (e === 0)        return 4;  // emergency
  if (b1 && b2)       return 0;  // no brake
  if (!b1 && b2)      return 1;  // step 1
  if (b1 && !b2)      return 2;  // step 2
  return 3;                      // step 3
};

// ───────────── Small utilities ─────────────

/** Wrap an async function with a timing log so the console shows hot spots. */
function timed(fn, label) {
  const name = label || fn.name || "anonymous";
  return async function (...args) {
    const t0 = performance.now();
    const result = await fn(...args);
    const t1 = performance.now();
    console.log(`${name}: ${t1 - t0} ms`);
    return result;
  };
}

/** Strict array equality (by-value). */
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Count events per ISO date. */
function countEventsPerDay(intervals) {
  const counts = {};
  intervals.forEach((interval) => {
    const day = new Date(interval.start).toISOString().split("T")[0];
    counts[day] = (counts[day] || 0) + 1;
  });
  return counts;
}

/** Bucket events into 10%-wide worst-brake-performance bins for the timeline. */
function getBrakePerfBins(events) {
  const bins = {};
  events.forEach((ev) => {
    const val = Number(ev.worst_brake_performance);
    if (isNaN(val)) return;
    const binStart = Math.floor(val / 10) * 10;
    const binEnd   = binStart + 10;
    const binLabel = `${binStart}-${binEnd}`;
    bins[binLabel] = (bins[binLabel] || 0) + 1;
  });
  const binsArray = Object.entries(bins).map(([range, count]) => ({ key: range, count }));
  binsArray.sort((a, b) => {
    const startA = parseFloat(a.key.match(/^-?\d+/)[0]);
    const startB = parseFloat(b.key.match(/^-?\d+/)[0]);
    return startA - startB;
  });
  return binsArray;
}
