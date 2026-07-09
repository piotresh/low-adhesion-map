/**
 * Live-backend API calls.
 *
 * In the online build this file provides the cache + fetchers that hit the
 * FastAPI server on `http://localhost:8000`. When the dashboard is exported
 * via `/api/download-all` this file is **replaced** at build time by the
 * offline bootstrap in `backend/app/exporters/html_builder.py`, which loads
 * per-event JS files instead of hitting the network.
 */

// ─────────── Per-event lazy cache ───────────
const FULL_EVENTS_CACHE = {};

/**
 * Return the full telemetry payload for one event id, hitting the backend
 * on first request and caching the result locally.
 */
async function fetchFullEvent(event_id) {
  if (FULL_EVENTS_CACHE[event_id]) return FULL_EVENTS_CACHE[event_id];

  try {
    const response = await fetch(`http://localhost:8000/api/events/${event_id}`);
    if (!response.ok) {
      console.error(`Error: ${response.status} ${response.statusText}`);
      const errorText = await response.text();
      console.error("Response body:", errorText);
    }
    const data = await response.json();
    FULL_EVENTS_CACHE[event_id] = data;
    return data;
  } catch (err) {
    console.error("Failed to fetch full event:", err);
    return null;
  }
}

/** Pull the summary payload on boot and kick the dashboard into slide-mode. */
async function fetchEventsSummary() {
  try {
    const response = await fetch("http://localhost:8000/api/events-summary");
    allEventsData = await response.json();
    console.log("Fetched event summaries:", allEventsData);
    updateWheelMode("wheel_slide");
  } catch (err) {
    console.error("Failed to fetch event summaries:", err);
  }
}
