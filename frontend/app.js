/**
 * Online-only bootstrap.
 *
 * All functional code lives under `js/…`. This file only kicks off the
 * initial summary fetch so the dashboard populates on page load.
 *
 * In the offline ZIP export `app.js` is not used — see
 * `backend/app/exporters/html_builder.py` for the replacement bootstrap.
 */

fetchEventsSummary();
