/**
 * DOM event wiring + top-level update functions.
 *
 * Installs every `change`/`click` listener used by the left column and the
 * right-panel controls, plus `updateWheelMode` — the central function that
 * re-runs filters, re-populates the adhesion table, refreshes the KPI cards
 * and re-draws the map + timeline.
 *
 * Expects `map`, `markers`, `container`, `closePanel`, `renderMapData`,
 * `renderRouterCharts`, `updateEventInfo`, `refreshTimeline`,
 * `focusMarker` and `fetchFullEvent` to exist (they do — loaded earlier
 * in index.html).
 */

// ─────────── Cached DOM refs used frequently ───────────
const container  = document.getElementById("container");
const rightPanel = document.getElementById("right-panel");
const closePanel = document.getElementById("close-panel");

// ─────────── Click handler for map markers ───────────
async function handleMarkerClick(eventSummary) {
  if (!eventSummary || !eventSummary.event_id) return;
  try {
    const fullEvent = await fetchFullEvent(eventSummary.event_id);
    if (!fullEvent) return;
    currentEvent = fullEvent;

    const wasAlreadyOpen = container.classList.contains("show-panel");
    container.classList.add("show-panel");

    await updateEventInfo(fullEvent);
    if (fullEvent.latitude != null && fullEvent.longitude != null) {
      focusMarker(L.latLng(fullEvent.latitude, fullEvent.longitude), wasAlreadyOpen);
    }

    // Reset router checkboxes — hide either side if its router is missing
    document.querySelectorAll("#router-checkboxes label").forEach((label) => {
      label.style.display = "block";
      label.querySelector("input").checked = true;
    });
    if (fullEvent.front_router === "Missing Data") {
      document.querySelector('#router-checkboxes input[value="front"]').closest("label").style.display = "none";
    }
    if (fullEvent.back_router === "Missing Data") {
      document.querySelector('#router-checkboxes input[value="back"]').closest("label").style.display = "none";
    }

    renderRouterCharts(fullEvent);
    renderMapData();

    // Update the router we feed into the brake-map layer
    let frontName = fullEvent.front_router;
    if (frontName === "Missing Data") frontName = fullEvent.back_router;
    const routerKey = `router_${frontName}`;
    routerToRenderMap = fullEvent.data?.[routerKey];

    const selectedMode = document.querySelector('input[name="map-mode"]:checked')?.value;
    if (selectedMode === "brakedemand") showBrakeDemandMapLayer(routerToRenderMap);
    else hideBrakeDemandMapLayer();
  } catch (err) {
    console.error("Error handling marker click:", err);
  }
}

// ─────────── Panel close / download / chart controls ───────────
closePanel.addEventListener("click", () => {
  container.classList.remove("show-panel");
  if (!BrakeDemandMapEnabled) hideBrakeDemandMapLayer();
  setTimeout(() => map.invalidateSize(), 310);
});

document.getElementById("download-html").addEventListener("click", () => {
  window.location.href = "http://127.0.0.1:8000/api/download-all";
});

document.getElementById("download-pqt").addEventListener("click", () => {
  window.location.href = "http://127.0.0.1:8000/api/download-pqt";
});

// ─────────── Chart mode + checkboxes ───────────
const modeSelect = document.getElementById("mode-select");
modeSelect.addEventListener("change", async () => {
  mode = modeSelect.value;
  if (currentEvent) await renderRouterCharts(currentEvent);
});

document.querySelectorAll('#chart-checkboxes input[type="checkbox"]').forEach((cb) => {
  cb.addEventListener("change", () => { if (currentEvent) renderRouterCharts(currentEvent); });
});

document.getElementById("brakedemand-chart").addEventListener("change", (e) => {
  BrakeDemandChartEnabled = e.target.checked;
  if (currentEvent) renderRouterCharts(currentEvent);
});

// Map-display radio (off / brakedemand / adhesion)
document.querySelectorAll('input[name="map-mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const m = radio.value;
    console.log("🎛️ Map mode changed →", m);
    hideBrakeDemandMapLayer();
    hideAdhesionMapLayer();
    if (m === "adhesion")    showAdhesionMapLayer();
    if (m === "brakedemand") showBrakeDemandMapLayer(routerToRenderMap);
    if (m === "off")         console.log("🔕 Map mode OFF");
    renderMapData();
  });
});

document.querySelectorAll('#router-checkboxes input[type="checkbox"]').forEach((cb) => {
  cb.addEventListener("change", () => { if (currentEvent) renderRouterCharts(currentEvent); });
});

// ─────────── MURS min/avg select ───────────
const mursSelect = document.getElementById("mursMode");
mursSelect.addEventListener("change", (e) => {
  mursField = e.target.value;
  updateWheelMode(wheel_mode, null, mursField);
});

// ─────────── KPI card updater ───────────
function updateKPICards() {
  const day = 24 * 60 * 60 * 1000;

  const allSlides = allEventsData["wheel_slide"] || [];
  const allSpins  = allEventsData["wheel_spin"]  || [];
  const allDates  = [...allSlides, ...allSpins]
    .map((e) => new Date(e.start))
    .filter((d) => !isNaN(d));
  if (allDates.length === 0) return;

  const latest        = new Date(Math.max(...allDates));
  const thisWeekStart = new Date(latest - 7 * day);
  const prevWeekStart = new Date(latest - 14 * day);

  function getWeekCounts(wMode) {
    const events = allEventsData[wMode] || [];
    const thisWeek = events.filter((e) => {
      const d = new Date(e.start);
      return d >= thisWeekStart && d <= latest;
    }).length;
    const prevWeek = events.filter((e) => {
      const d = new Date(e.start);
      return d >= prevWeekStart && d < thisWeekStart;
    }).length;
    return { thisWeek, prevWeek };
  }

  function renderKPI(cardId, counts) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const valEl   = card.querySelector(".kpi-value");
    const trendEl = card.querySelector(".kpi-trend");
    const { thisWeek, prevWeek } = counts;
    const diff = thisWeek - prevWeek;
    const pct  = prevWeek > 0 ? Math.round((diff / prevWeek) * 100) : null;

    valEl.textContent = thisWeek;
    valEl.style.color = "#000";

    if (pct === null) {
      trendEl.textContent = "no prev data";
      trendEl.style.color = "#9ca3af";
    } else if (diff === 0) {
      trendEl.textContent = "→ no change";
      trendEl.style.color = "#9ca3af";
    } else if (diff > 0) {
      trendEl.textContent = `↑ ${pct}% vs last week`;
      trendEl.style.color = "#ef4444";
    } else {
      trendEl.textContent = `↓ ${Math.abs(pct)}% vs last week`;
      trendEl.style.color = "#22c55e";
    }
  }

  renderKPI("kpi-slides", getWeekCounts("wheel_slide"));
  renderKPI("kpi-spins",  getWeekCounts("wheel_spin"));
}

// ─────────── Central re-render function ───────────
function updateWheelMode(newWheelMode, dateRange = null, overrideMursField = null) {
  wheel_mode = newWheelMode;

  const fieldToCount =
    mursFieldMap[overrideMursField || mursField] || "Adhesion_Index_Murs_Avg";

  const allEvents = allEventsData[wheel_mode] || [];
  const allAxlesOnly = document.getElementById("allAxlesSlide").checked;

  const activeConditions = [];
  document.querySelectorAll("#adhesion-table tr[data-condition]").forEach((row) => {
    const checkbox = row.querySelector("input[type=checkbox]");
    if (checkbox && checkbox.checked) activeConditions.push(row.dataset.condition);
  });

  // Events that pass the "All Axles Slide" filter and date range
  const eventsForCounts = allEvents.filter((event) => {
    if (allAxlesOnly && !event.all_axles_slide) return false;

    if (dateRange) {
      const eventDate = new Date(event.date);
      if (eventDate < dateRange[0] || eventDate > dateRange[1]) return false;
    }
    return true;
  });

  // Reset then repopulate the count column
  document.querySelectorAll("#adhesion-table tr[data-condition]").forEach((row) => {
    const countCell = row.querySelectorAll("td")[4];
    if (countCell) countCell.textContent = "0";
  });

  const conditionMap = {
    "Excellent adhesion":     "row-excellent",
    "Good adhesion":          "row-good",
    "Moderate adhesion":      "row-moderate",
    "Poor adhesion":          "row-poor",
    "Very poor adhesion":     "row-verypoor",
    "Extreme adhesion loss":  "row-extreme",
    "--":                     "row-none",
    "no wsp activity":        "row-none",
  };

  eventsForCounts.forEach((event) => {
    let adhesionCondition = event[fieldToCount];
    if (!adhesionCondition || adhesionCondition === "no wsp activity") adhesionCondition = "--";

    const rowClass = conditionMap[adhesionCondition];
    if (rowClass) {
      const row = document.querySelector(`#adhesion-table tr.${rowClass}`);
      if (row) {
        const countCell = row.querySelectorAll("td")[4];
        if (countCell) countCell.textContent = parseInt(countCell.textContent) + 1;
      }
    }
  });

  selectedEvents = eventsForCounts.filter((event) => {
    if (allAxlesOnly && !event.all_axles_slide) return false;
    let adhesionCondition = event[fieldToCount];
    if (!adhesionCondition || adhesionCondition === "no wsp activity") adhesionCondition = "--";
    return activeConditions.includes(adhesionCondition);
  });

  // ─── Adhesion table availability ───
  // The adhesion table is only meaningful for wheel_slide; disable it visually
  // when wheel_spin is selected so the user knows it cannot be interacted with.
  // The label wraps the input directly (no for= attribute), so find it via closest()
  const adhesionTableCheckboxEl    = document.getElementById("showAdhesionTable");
  const adhesionTableCheckboxLabel = adhesionTableCheckboxEl?.closest("label");
  const adhesionTableEl            = document.getElementById("adhesion-table");
  if (wheel_mode === "wheel_spin") {
    if (adhesionTableCheckboxLabel) {
      adhesionTableCheckboxLabel.style.opacity       = "0.35";
      adhesionTableCheckboxLabel.style.pointerEvents = "none";
      adhesionTableCheckboxLabel.style.cursor        = "not-allowed";
      adhesionTableCheckboxLabel.style.color         = "#9ca3af";
    }
    if (adhesionTableCheckboxEl) adhesionTableCheckboxEl.disabled = true;
    if (adhesionTableEl) {
      adhesionTableEl.style.opacity       = "0.25";
      adhesionTableEl.style.pointerEvents = "none";
    }
  } else {
    if (adhesionTableCheckboxLabel) {
      adhesionTableCheckboxLabel.style.opacity       = "";
      adhesionTableCheckboxLabel.style.pointerEvents = "";
      adhesionTableCheckboxLabel.style.cursor        = "";
      adhesionTableCheckboxLabel.style.color         = "";
    }
    if (adhesionTableCheckboxEl) adhesionTableCheckboxEl.disabled = false;
    if (adhesionTableEl) {
      adhesionTableEl.style.opacity       = "";
      adhesionTableEl.style.pointerEvents = "";
    }
  }

  // Chart-selector visibility / default option per wheel mode
  const chartSelector = document.getElementById("chart-selector");
  const chartSelect   = document.getElementById("mode-select");
  const spinOption    = chartSelect.querySelector('option[value="spin"]');
  const slideOption   = chartSelect.querySelector('option[value="slide"]');
  chartSelector.style.display = "block";
  spinOption.hidden  = false;
  slideOption.hidden = false;
  if (wheel_mode === "wheel_spin") {
    slideOption.hidden = true;
    chartSelect.value  = "spin";
  } else if (wheel_mode === "wheel_slide") {
    spinOption.hidden = true;
    chartSelect.value = "slide";
  } else if (wheel_mode === "emergency_brakes" || wheel_mode === "train_stop") {
    chartSelector.style.display = "none";
    chartSelect.value = "";
  }
  if (chartSelector.style.display !== "none") {
    chartSelect.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
  }

  // Close any open event panel on category change
  container.classList.remove("show-panel");
  setTimeout(() => map.invalidateSize(), 310);

  refreshTimeline();
  renderMapData(selectedEvents);

  if (markers && markers.getBounds && selectedEvents.length > 0) {
    map.fitBounds(markers.getBounds().pad(0.1));
  }

  updateKPICards();
}

// ─────────── Left-column control listeners ───────────
document.getElementById("timelineFilter").addEventListener("change", () => {
  refreshTimeline();
});

document.querySelectorAll("#adhesion-table input[type=checkbox]").forEach((cb) => {
  cb.addEventListener("change", () => {
    updateWheelMode(wheel_mode, null, mursField);
  });
});

document.getElementById("wheelMode").addEventListener("change", (e) => {
  updateWheelMode(e.target.value, null, mursField);
});

document.getElementById("allAxlesSlide").addEventListener("change", () => {
  updateWheelMode(wheel_mode);
});

const adhesionCheckbox = document.getElementById("showAdhesionTable");
const adhesionTable    = document.getElementById("adhesion-table");
adhesionCheckbox.addEventListener("change", () => {
  adhesionTable.style.display = adhesionCheckbox.checked ? "table" : "none";
});
adhesionTable.style.display = adhesionCheckbox.checked ? "table" : "none";


// ─────────── Wrap the heavy renderers with timing logs ───────────
renderMapData       = timed(renderMapData);
drawD3Timeline      = timed(drawD3Timeline);
updateEventInfo     = timed(updateEventInfo);
renderRouterCharts  = timed(renderRouterCharts);
handleMarkerClick   = timed(handleMarkerClick);
