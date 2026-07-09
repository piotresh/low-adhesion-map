/**
 * Right-panel Plotly charts (one card per measure × router combination).
 *
 * Supports chart modes from the `#mode-select` dropdown:
 *   - slide / spin      : overlay green/red status rectangles
 *   - VVPOP / HVPOP     : line-width/dash encodes valve activity
 *
 * Brake performance brackets are ALWAYS rendered below the x-axis for every
 * chart — they are no longer tied to a separate "brake_performance" mode.
 */

// ───────────── Plotly shape + trace helpers ─────────────

function createStatusShapes(
  timestamps, values, name = "",
  colorActive   = "rgba(16, 185, 129, 0.15)",
  colorInactive = "rgba(239, 68, 68, 0.10)"
) {
  const shapes = [];
  if (!values || values.length === 0) return shapes;

  let startIdx = 0;
  let currentState = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== currentState) {
      shapes.push({
        type: "rect", xref: "x", yref: "paper",
        x0: timestamps[startIdx], x1: timestamps[i],
        y0: 0, y1: 1,
        fillcolor: currentState === 1 ? colorActive : colorInactive,
        opacity: 1, layer: "below", line: { width: 0 },
      });
      startIdx = i;
      currentState = values[i];
    }
  }
  shapes.push({
    type: "rect", xref: "x", yref: "paper",
    x0: timestamps[startIdx], x1: timestamps[timestamps.length - 1],
    y0: 0, y1: 1,
    fillcolor: currentState === 1 ? colorActive : colorInactive,
    opacity: 1, layer: "below", line: { width: 0 },
  });
  return shapes;
}

function createBrakePerformanceHoverTrace(brakePerformance) {
  if (!brakePerformance || brakePerformance.length === 0) return null;
  const x = [], y = [], text = [];
  brakePerformance.forEach((entry) => {
    const midTime = new Date(
      (new Date(entry.start_timestamp).getTime() + new Date(entry.end_timestamp).getTime()) / 2
    );
    x.push(midTime);
    y.push(-0.2);
    text.push(buildBrakeHoverText(entry));
  });
  return {
    x, y, text, type: "scatter", mode: "markers",
    marker: { size: 40, opacity: 0 }, hoverinfo: "text",
    showlegend: false, name: "Brake Performance",
  };
}

function buildBrakeHoverText(entry) {
  let percentText;

  if (entry.percentage_difference == null) {
    percentText = "N/A";
  } else if (entry.percentage_difference < 0) {
    percentText = `${Math.abs(entry.percentage_difference).toFixed(2)}% less than required`;
  } else if (entry.percentage_difference > 0) {
    percentText = `${entry.percentage_difference.toFixed(2)}% more than required`;
  } else {
    percentText = "0% (within target)";
  }

  const requiredDecel = entry.required_deceleration;

  const requiredText =
    requiredDecel != null
      ? `${requiredDecel.toFixed(2)} m/s²`
      : "N/A";

  return (
    `Start Time: ${entry.start_timestamp}<br>` +
    `End Time: ${entry.end_timestamp}<br>` +
    `Time Delta: ${entry.time_diff?.toFixed(2) ?? "N/A"} s<br>` +
    `Start Speed: ${entry.start_speed?.toFixed(2) ?? "N/A"} kph<br>` +
    `End Speed: ${entry.end_speed?.toFixed(2) ?? "N/A"} kph<br>` +
    `Achieved Decel: ${entry.achieved_deceleration?.toFixed(3) ?? "N/A"} m/s²<br>` +
    `Required Decel: ${requiredText}<br>` +
    `% Difference: ${percentText}<br>` +
    `Brake Demand: ${entry.brake_demand}<br>` +
    `Wheel Slide: ${entry.wheel_slide}`
  );
}

// Returns a solid rgb() string for bracket lines and labels
function getBrakePerformanceSolidColor(percent) {
  if (percent === null || percent === undefined || isNaN(percent)) return "rgb(180,180,180)";
  const p = Math.max(-100, Math.min(100, percent));
  const stops = [
    { pct: -100, color: [220,   0,   0] },  // Red
    { pct:  -50, color: [255, 165,   0] },  // Orange
    { pct:  -15, color: [255, 220,   0] },  // Yellow
    { pct:    0, color: [  0, 200,   0] },  // Green
    { pct:  100, color: [  0, 100,   0] },  // Dark Green
  ];
  let start, end;
  for (let i = 0; i < stops.length - 1; i++) {
    if (p >= stops[i].pct && p <= stops[i + 1].pct) {
      start = stops[i]; end = stops[i + 1]; break;
    }
  }
  if (!start || !end) return "rgb(0,0,0)";
  const t = (p - start.pct) / (end.pct - start.pct);
  const r = Math.round(start.color[0] + t * (end.color[0] - start.color[0]));
  const g = Math.round(start.color[1] + t * (end.color[1] - start.color[1]));
  const b = Math.round(start.color[2] + t * (end.color[2] - start.color[2]));
  return `rgb(${r},${g},${b})`;
}
function addBrakePerformanceBrackets(brakeData, layout, FM) {
  if (!brakeData?.length) return;

  const barY0 = -0.11;
  const barY1 = -0.16;
  const labelY = -0.21;

  layout.shapes ??= [];
  layout.annotations ??= [];

  brakeData.forEach((entry) => {
    const start = new Date(entry.start_timestamp);
    const end   = new Date(entry.end_timestamp);
    if ((end - start) / 1000 < 3) return;

    const pct   = entry.percentage_difference;
    const color = getBrakePerformanceSolidColor(pct);
    const label = pct == null ? "N/A" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    const mid   = new Date((start.getTime() + end.getTime()) / 2);

    layout.shapes.push({
      type: "rect",
      xref: "x", yref: "paper",
      x0: start, x1: end,
      y0: barY0, y1: barY1,
      fillcolor: color,
      opacity: 0.85,
      line: { width: 0 },
      layer: "above",
      // Plotly supports rounding via this — not all renderers honour it but worth having
      // Use a thin same-colour border to fake soft edges
    });



    layout.annotations.push({
      xref: "x", yref: "paper",
      x: mid, y: labelY,
      text: `<b>${label}</b>`,
      showarrow: false,
      xanchor: "center", yanchor: "top",
      font: { family: FM, size: 8, color },
    });
  });

  layout.annotations.push({
    xref: "paper", yref: "paper",
    x: 1.01, y: (barY0 + barY1) / 2,
    text: "% dev.<br>from req.",
    showarrow: false,
    xanchor: "left", yanchor: "middle",
    font: { family: FM, size: 8, color: "#9ca3af" },
  });
}
function createBrakeDemandTrace(timestamps, brake1, brake2, emergency) {
  if (!brake1?.length || !brake2?.length) return null;

  const states = brake1.map((b1, i) =>
    getState(b1, brake2[i], emergency[i])
  );

  const x = [];
  const y = [];

  for (let i = 0; i < timestamps.length; i++) {
    if (i > 0) {
      x.push(timestamps[i]);
      y.push(states[i - 1]);
    }

    x.push(timestamps[i]);
    y.push(states[i]);
  }

  return {
    x,
    y,
    type: "scatter",
    mode: "lines",
    line: {
      shape: "hv",
      color: "rgba(107,114,128,0.4)",
      width: 3,
    },
    fill: "tozeroy",
    fillcolor: "rgba(107,114,128,0.08)",
    name: "Brake Demand",
    yaxis: "y2",
  };
}

function createBrakeDemandTrace(timestamps, brake1, brake2, emergency) {
  if (!brake1 || !brake2 || brake1.length === 0) return null;
  const states = brake1.map((b1, i) => getState(b1, brake2[i], emergency[i]));
  const x = [], y = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (i > 0) { x.push(timestamps[i]); y.push(states[i - 1]); }
    x.push(timestamps[i]); y.push(states[i]);
  }
  return {
    x, y, type: "scatter", mode: "lines",
    line: { shape: "hv", color: "rgba(107,114,128,0.4)", width: 3 },
    fill: "tozeroy", fillcolor: "rgba(107,114,128,0.08)",
    name: "Brake Demand", yaxis: "y2",
  };
}

// ───────────── Optional elevation chart (not wired by default) ─────────────

function renderElevationChart(routers) {
  const chartsContainer = document.getElementById("charts-container");
  const elevationChartDivId = "elevation-chart";
  let elevationChartDiv = document.getElementById(elevationChartDivId);
  if (!elevationChartDiv) {
    elevationChartDiv = document.createElement("div");
    elevationChartDiv.id = elevationChartDivId;
    elevationChartDiv.style.width     = "100%";
    elevationChartDiv.style.height    = "300px";
    elevationChartDiv.style.marginTop = "25px";
    chartsContainer.appendChild(elevationChartDiv);
  }
  const timestamps  = routers[0]?.data.TIMESTAMP || [];
  const elevationsA = routers[0]?.data.ELEVATIONS || [];
  const elevationsB = routers[1]?.data.ELEVATIONS || [];
  const averaged    = elevationsA.map((val, i) => { const b = elevationsB[i] ?? val; return (val + b) / 2; });
  const windowSize  = 30;
  const smoothed = averaged.map((_, i, arr) => {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end   = Math.min(arr.length, i + Math.floor(windowSize / 2));
    const w = arr.slice(start, end);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  const trace = {
    x: timestamps, y: smoothed,
    type: "scatter", mode: "lines",
    name: "Average Elevation (Smoothed)",
    line: { color: "#10b981", width: 2 },
  };
  const layout = {
    title: { text: "<b>Average Elevation vs Time</b>", font: { size: 16 }, y: 0.90 },
    xaxis: { title: "Timestamp" }, yaxis: { title: "Elevation (m)" },
    margin: { t: 50, b: 50, l: 50, r: 50 }, showlegend: false,
  };
  Plotly.react(elevationChartDivId, [trace], layout);
}

// Map axle config to actual time-series MURS keys
const routerAxleConfig = {
  front: [
    { label: "Axle 1",   vvKey: "WSP_Y_VV1_POP2", mursKey: "MURS_1_derived_rolling",   mursIdx: 0, ci: 0 },
    { label: "Axle 2",   vvKey: "WSP_Y_VV2_POP4", mursKey: "MURS_2_derived_rolling",   mursIdx: 1, ci: 1 },
    { label: "Axle 3-4", vvKey: "WSP_Y_VV3_POP6", mursKey: "MURS_3_4_derived_rolling", mursIdx: 2, ci: 2 },
  ],
  back: [
    { label: "Axle 5-6", vvKey: "WSP_Y_VV3_POP6", mursKey: "MURS_3_4_derived_rolling", mursIdx: 3, ci: 0 },
    { label: "Axle 7",   vvKey: "WSP_Y_VV2_POP4", mursKey: "MURS_2_derived_rolling",   mursIdx: 4, ci: 1 },
    { label: "Axle 8",   vvKey: "WSP_Y_VV1_POP2", mursKey: "MURS_1_derived_rolling",   mursIdx: 5, ci: 2 },
  ],
};
function renderVVPOPMursCharts(event, routers, FM, F, CGRID, CLINE, CTEXT, TC) {
  document.getElementById("chart-card-vvpop-murs-front")?.remove();
  document.getElementById("chart-card-vvpop-murs-back")?.remove();

  const chartsContainer = document.getElementById("panel-content");
  const mursAvgArr = event.murs_avg || [];
  const mursMinArr = event.murs_min || [];

  function lightenColor(hex, amount = 90) {
    const c = hex.replace("#", "");
    const num = parseInt(c, 16);
    const r = Math.min(255, (num >> 16) + amount);
    const g = Math.min(255, ((num >> 8) & 0xff) + amount);
    const b = Math.min(255, (num & 0xff) + amount);
    return `rgb(${r},${g},${b})`;
  }

  // Lead car first, following car second
  const orderedRouters = [
    ...routers.filter((r) =>  r.isFront),
    ...routers.filter((r) => !r.isFront),
  ];

  // Compute shared y max across both routers for consistent scale
  let sharedMursMax = 0;
  for (const router of orderedRouters) {
    if (!router?.data) continue;
    for (const axle of routerAxleConfig[router.isFront ? "front" : "back"]) {
      const mursData = router.data[axle.mursKey] || [];
      for (const v of mursData) {
        if (v != null && Number.isFinite(v) && v > sharedMursMax) sharedMursMax = v;
      }
    }
  }
  sharedMursMax = sharedMursMax * 1.1;

  for (const router of orderedRouters) {
    if (!router?.data) continue;
    const timestamps = router.data.TIMESTAMP;
    if (!timestamps?.length) continue;

    const side       = router.isFront ? "front" : "back";
    const axleConfig = routerAxleConfig[side];
    const cardId     = `chart-card-vvpop-murs-${side}`;
    const chartId    = `chart-vvpop-murs-${side}`;

    const cardWrapper = document.createElement("div");
    cardWrapper.id        = cardId;
    cardWrapper.className = "rp-card";
    cardWrapper.innerHTML = `
      <div class="chart-card-title">
        <span class="chart-title-measure">VVPOP Events + MURS Level</span>
        <span class="chart-title-sep"> — </span>
        <span class="chart-title-car">${router.label}</span>
      </div>`;

    chartsContainer.appendChild(cardWrapper);

    const plotTraces = [];

    for (const axle of axleConfig) {
      const baseColor  = TC[axle.ci % TC.length];
      const lightColor = lightenColor(baseColor, 90);

      const rawAvg  = mursAvgArr[axle.mursIdx];
      const rawMin  = mursMinArr[axle.mursIdx];
      const mursAvg = (rawAvg !== "no wsp activity" && rawAvg != null) ? Number(rawAvg) : null;
      const mursMin = (rawMin !== "no wsp activity" && rawMin != null) ? Number(rawMin) : null;

      if (mursAvg !== null) {
        plotTraces.push({
          x: [timestamps[0], timestamps[timestamps.length - 1]],
          y: [mursAvg, mursAvg],
          type: "scatter", mode: "lines",
          name: `${axle.label} Avg (${mursAvg.toFixed(3)} µ)`,
          line: { color: lightColor, width: 2, dash: "dot" },
          legendgroup: axle.label,
        });
      }

      if (mursMin !== null) {
        plotTraces.push({
          x: [timestamps[0], timestamps[timestamps.length - 1]],
          y: [mursMin, mursMin],
          type: "scatter", mode: "lines",
          name: `${axle.label} Min (${mursMin.toFixed(3)} µ)`,
          line: { color: baseColor, width: 2 },
          legendgroup: axle.label,
        });
      }

      const vvData   = router.data[axle.vvKey]  || [];
      const mursData = router.data[axle.mursKey] || [];
      const dotX = [], dotY = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (vvData[i] === 1 && mursData[i] != null) {
          dotX.push(timestamps[i]);
          dotY.push(mursData[i]);
        }
      }
      if (dotX.length) {
        plotTraces.push({
          x: dotX, y: dotY,
          type: "scatter", mode: "markers",
          name: `${axle.label} VV POP`,
          marker: { color: baseColor, size: 8, symbol: "circle", line: { color: "#ffffff", width: 1.5 } },
          legendgroup: axle.label,
          showlegend: false,
          hovertemplate: `${axle.label} VV POP<br>MURS: %{y:.3f} µ<br>%{x}<extra></extra>`,
        });
      }
    }

    const hasAnyDots  = plotTraces.some((t) => t.mode === "markers" && t.x.length > 0);
    const hasAnyLines = plotTraces.some((t) => t.mode === "lines");

    if (!hasAnyDots && !hasAnyLines) {
      cardWrapper.innerHTML += `
        <div style="padding:16px 20px;color:${CTEXT};font-family:${F};font-size:13px;font-style:italic;">
          No VV POP activity — ${router.label}
        </div>`;
      continue;
    }

    const chartDiv = document.createElement("div");
    chartDiv.id            = chartId;
    chartDiv.style.cssText = "width:100%;height:380px;";
    cardWrapper.appendChild(chartDiv);

    const layout = {
      paper_bgcolor: "#ffffff",
      plot_bgcolor:  "#f9fafb",
      margin: { t: 55, b: 90, l: 56, r: 180 },
      font:   { family: F, size: 11, color: CTEXT },
      xaxis: {
        tickfont:  { family: FM, size: 9, color: CTEXT },
        gridcolor: CGRID, linecolor: CLINE, linewidth: 1,
        showgrid: true, zeroline: false, automargin: true,
      },
      yaxis: {
        title:     { text: "MURS (µ)", font: { family: F, size: 10, color: CTEXT }, standoff: 4 },
        tickfont:  { family: FM, size: 9, color: CTEXT },
        gridcolor: CGRID, linecolor: CLINE, linewidth: 1,
        showgrid: true, zeroline: false, automargin: true,
        range: [0, sharedMursMax],
      },
      showlegend: true,
      legend: {
        font:        { family: F, size: 10, color: "#374151" },
        bgcolor:     "rgba(255,255,255,0.9)",
        bordercolor: CLINE, borderwidth: 1,
        x: 1.02, y: 1, xanchor: "left", yanchor: "top",
      },
      hoverlabel: {
        bgcolor: "#111827", bordercolor: "#111827",
        font: { family: F, size: 11, color: "#f9fafb" },
      },
      shapes:      [],
      annotations: [],
    };

    // ─── Brake performance brackets + hover trace ───
    const brakeData  = router.data.BRAKE_PERFORMANCE || [];
    const hoverTrace = createBrakePerformanceHoverTrace(brakeData);
    if (hoverTrace) plotTraces.push(hoverTrace);
    addBrakePerformanceBrackets(brakeData, layout, FM);

    // ─── Sander-on hat ───
    if (router.data.SANDER_ON?.length) {
      const sander = router.data.SANDER_ON;
      let regions = [], startIndex = -1;
      for (let i = 0; i < sander.length; i++) {
        if (sander[i] === 1 && startIndex === -1) startIndex = i;
        if (startIndex !== -1 && sander[i] !== 1) { regions.push([startIndex, i - 1]); startIndex = -1; }
      }
      if (startIndex !== -1) regions.push([startIndex, sander.length - 1]);

      if (regions.length) {
        const barY0 = 1.055;
        const barY1 = 1.09;

        regions.forEach(([s, e]) => {
          const x0 = timestamps[s], x1 = timestamps[e];
          layout.shapes.push({
            type: "rect",
            xref: "x", yref: "paper",
            x0, x1,
            y0: barY0, y1: barY1,
            fillcolor: "#111827",
            opacity: 1,
            line: { width: 0 },
            layer: "above",
          });
        });

        const allStart = timestamps[regions[0][0]];
        const allEnd   = timestamps[regions[regions.length - 1][1]];
        const midX     = new Date((new Date(allStart).getTime() + new Date(allEnd).getTime()) / 2);

        layout.annotations.push({
          xref: "x", yref: "paper",
          x: midX, y: barY1 + 0.03,
          text: "SANDER ON",
          showarrow: false,
          xanchor: "center", yanchor: "bottom",
          font: { family: FM, size: 9, color: "#374151" },
        });
      }
    }

    Plotly.react(chartId, plotTraces, layout);
    console.log(`✅ Rendered: VVPOP MURS — ${router.label}`);
  }
}

// ───────────── Axle → POP key maps (used in VVPOP/HVPOP/VV+HVPOP modes) ─────
const vvpopMap = {
  "FS_WSP_M_AXLE1_IN_KPH":"WSP_Y_VV1_POP2","FS_WSP_M_AXLE2_IN_KPH":"WSP_Y_VV2_POP4","FS_WSP_M_AXLE3_4_IN_KPH":"WSP_Y_VV3_POP6",
  "BCP_M_AXLE1_IN_BAR":"WSP_Y_VV1_POP2","BCP_M_AXLE2_IN_BAR":"WSP_Y_VV2_POP4","BCP_M_AXLE3_4_IN_BAR":"WSP_Y_VV3_POP6",
  "MURS_1":"WSP_Y_VV1_POP2","MURS_2":"WSP_Y_VV2_POP4","MURS_3_4":"WSP_Y_VV3_POP6",
  "MURS_1_cleaned":"WSP_Y_VV1_POP2","MURS_2_cleaned":"WSP_Y_VV2_POP4","MURS_3_4_cleaned":"WSP_Y_VV3_POP6",
  "MURS_1_rolling":"WSP_Y_VV1_POP2","MURS_2_rolling":"WSP_Y_VV2_POP4","MURS_3_4_rolling":"WSP_Y_VV3_POP6",
  "MURS_1_derived":"WSP_Y_VV1_POP2","MURS_2_derived":"WSP_Y_VV2_POP4","MURS_3_4_derived":"WSP_Y_VV3_POP6",
  "MURS_1_derived_cleaned":"WSP_Y_VV1_POP2","MURS_2_derived_cleaned":"WSP_Y_VV2_POP4","MURS_3_4_derived_cleaned":"WSP_Y_VV3_POP6",
  "MURS_1_derived_rolling":"WSP_Y_VV1_POP2","MURS_2_derived_rolling":"WSP_Y_VV2_POP4","MURS_3_4_derived_rolling":"WSP_Y_VV3_POP6",
};
const hvpopMap = {
  "FS_WSP_M_AXLE1_IN_KPH":"WSP_Y_HV1_POP1","FS_WSP_M_AXLE2_IN_KPH":"WSP_Y_HV2_POP3","FS_WSP_M_AXLE3_4_IN_KPH":"WSP_Y_HV3_POP5",
  "BCP_M_AXLE1_IN_BAR":"WSP_Y_HV1_POP1","BCP_M_AXLE2_IN_BAR":"WSP_Y_HV2_POP3","BCP_M_AXLE3_4_IN_BAR":"WSP_Y_HV3_POP5",
  "MURS_1":"WSP_Y_HV1_POP1","MURS_2":"WSP_Y_HV2_POP3","MURS_3_4":"WSP_Y_HV3_POP5",
  "MURS_1_cleaned":"WSP_Y_HV1_POP1","MURS_2_cleaned":"WSP_Y_HV2_POP3","MURS_3_4_cleaned":"WSP_Y_HV3_POP5",
  "MURS_1_rolling":"WSP_Y_HV1_POP1","MURS_2_rolling":"WSP_Y_HV2_POP3","MURS_3_4_rolling":"WSP_Y_HV3_POP5",
  "MURS_1_derived":"WSP_Y_HV1_POP1","MURS_2_derived":"WSP_Y_HV2_POP3","MURS_3_4_derived":"WSP_Y_HV3_POP5",
  "MURS_1_derived_cleaned":"WSP_Y_HV1_POP1","MURS_2_derived_cleaned":"WSP_Y_HV2_POP3","MURS_3_4_derived_cleaned":"WSP_Y_HV3_POP5",
  "MURS_1_derived_rolling":"WSP_Y_HV1_POP1","MURS_2_derived_rolling":"WSP_Y_HV2_POP3","MURS_3_4_derived_rolling":"WSP_Y_HV3_POP5",
};

// ───────────── Main chart renderer ─────────────

async function renderRouterCharts(event, force = false) {
  console.log("🚀 renderRouterCharts called");

  const selectedCharts = Array.from(
    document.querySelectorAll('#chart-checkboxes input[type="checkbox"]:checked')
  ).map((cb) => cb.value);

  const BrakeDemandChartEnabled = document.querySelector("#brakedemand-chart").checked;

  const selectedRouters = Array.from(
    document.querySelectorAll('#router-checkboxes input[type="checkbox"]:checked')
  ).map((cb) => cb.value);

  // Clear old chart cards
  document.querySelectorAll('[id^="chart-card-"]').forEach((el) => el.remove());

  // Resolve routers based on the event + router-checkbox filter
  let routers = [
    { id: event.front_router, data: event.data[`router_${event.front_router}`], label: "Lead Car",      isFront: true },
    { id: event.back_router,  data: event.data[`router_${event.back_router}`],  label: "Following Car", isFront: false },
  ];
  routers = routers.filter((r) => r && r.data);
  routers = routers.filter((r) => {
    if (r.isFront  && selectedRouters.includes("front")) return true;
    if (!r.isFront && selectedRouters.includes("back"))  return true;
    return false;
  });

  // Measure catalogue
  const measures = [
    { keys: ["FS_WSP_M_AXLE1_IN_KPH","FS_WSP_M_AXLE2_IN_KPH","FS_WSP_M_AXLE3_4_IN_KPH"], label: "Axle Speeds",                        yaxistitle: "Axle Speeds (kph)" },
    { keys: ["BCP_M_AXLE1_IN_BAR","BCP_M_AXLE2_IN_BAR","BCP_M_AXLE3_4_IN_BAR"],           label: "BCP",                                 yaxistitle: "BCP (bar)" },
    { keys: ["MURS_1","MURS_2","MURS_3_4"],                                                label: "MURS EZRA",                           yaxistitle: "MURS (Mu)" },
    { keys: ["MURS_1_cleaned","MURS_2_cleaned","MURS_3_4_cleaned"],                        label: "MURS EZRA (Cleaned)",                 yaxistitle: "MURS (units)" },
    { keys: ["MURS_1_rolling","MURS_2_rolling","MURS_3_4_rolling"],                        label: "MURS EZRA (Rolling 1 second average)", yaxistitle: "MURS (units)" },
    { keys: ["MURS_1_derived","MURS_2_derived","MURS_3_4_derived"],                        label: "MURS Derived",                        yaxistitle: "MURS (units)" },
    { keys: ["MURS_1_derived_cleaned","MURS_2_derived_cleaned","MURS_3_4_derived_cleaned"], label: "MURS Derived (Cleaned)",              yaxistitle: "MURS (units)" },
    { keys: ["MURS_1_derived_rolling","MURS_2_derived_rolling","MURS_3_4_derived_rolling"], label: "MURS",                                yaxistitle: "MURS (units)" },
  ];

  // Build the ordered list of (router, measure) pairs to render
  const chartOrder = [];
  const add = (mIdx) => {
    if (routers[0]) chartOrder.push({ router: routers[0], measure: measures[mIdx] });
    if (routers[1]) chartOrder.push({ router: routers[1], measure: measures[mIdx] });
  };
  if (selectedCharts.includes("WSP"))                  add(0);
  if (selectedCharts.includes("BCP"))                  add(1);
  if (selectedCharts.includes("MURS"))                 add(2);
  if (selectedCharts.includes("MURS_cleaned"))         add(3);
  if (selectedCharts.includes("MURS_rolling"))         add(4);
  if (selectedCharts.includes("MURS_derived"))         add(5);
  if (selectedCharts.includes("MURS_derived_cleaned")) add(6);
  if (selectedCharts.includes("MURS_derived_rolling")) add(7);

  // Compute shared y-axis ranges per measure so front/back cards align
  const sharedYScales = {};
  for (const measure of measures) {
    let allY = [];
    for (const router of routers) {
      if (!router.data) continue;
      for (const key of measure.keys) {
        const yData = router.data[key] ?? [];
        allY.push(...yData.filter((v) => Number.isFinite(v)));
      }
    }
    if (allY.length > 0) sharedYScales[measure.label] = [Math.min(...allY), Math.max(...allY)];
  }

  // Design tokens
  const F     = "'DM Sans','Helvetica Neue',Helvetica,Arial,sans-serif";
  const FM    = "'DM Mono',monospace";
  const CGRID = "rgba(0,0,0,0.04)";
  const CLINE = "rgba(0,0,0,0.07)";
  const CTEXT = "#9ca3af";
  const TC    = ["#1d4ed8", "#10b981", "#f59e0b"];
  // ── VVPOP + MURS summary chart (always first) ──
  renderVVPOPMursCharts(event, routers, FM, F, CGRID, CLINE, CTEXT, TC);
  for (const item of chartOrder) {
    if (!item || !item.router || !item.router.data) continue;
    const { router, measure } = item;
    const timestamps = router.data.TIMESTAMP;
    if (!timestamps || timestamps.length === 0) continue;

    // Map each measure key → axle-naming-aware trace data
    let traces = measure.keys.map((key) => {
      const yData = router.data[key] || [];
      if (yData.every((v) => v === 0)) return null;
      let axleName;
      if (router.isFront) {
        axleName = key.match(/\d+(_\d+)?/)[0];
      } else {
        const backMap = { "1": "8", "2": "7", "3_4": "5_6" };
        axleName = backMap[key.match(/\d+(_\d+)?/)[0]] || key;
      }
      return { key, axleName, legendName: `Axle ${axleName}`, yData };
    }).filter((t) => t !== null);

    if (!router.isFront) {
      const order = ["5_6", "7", "8"];
      traces.sort((a, b) => order.indexOf(a.axleName) - order.indexOf(b.axleName));
    }

    let plotTraces = [];

    // Helper: push per-state segments with variable line width
    const pushSegments = (t, idx, popData, getWidth) => {
      const color = TC[idx % 3];
      let sx = [timestamps[0]], sy = [t.yData[0]], sw = getWidth(popData[0]);
      for (let i = 1; i < timestamps.length; i++) {
        const w = getWidth(popData[i]);
        if (w !== sw) {
          plotTraces.push({ x: [...sx], y: [...sy], type: "scatter", mode: "lines", line: { width: sw, color }, showlegend: false, hoverinfo: "skip" });
          sx = [timestamps[i - 1], timestamps[i]];
          sy = [t.yData[i - 1], t.yData[i]];
          sw = w;
        } else {
          sx.push(timestamps[i]);
          sy.push(t.yData[i]);
        }
      }
      plotTraces.push({ x: [...sx], y: [...sy], type: "scatter", mode: "lines", line: { width: sw, color }, showlegend: false, hoverinfo: "skip" });
    };

    if (mode === "VVPOP") {
      traces.forEach((t, idx) => {
        const key = vvpopMap[t.key]; if (!key) return;
        const pop = router.data[key] || []; if (!pop.length || !t.yData.length) return;
        pushSegments(t, idx, pop, (v) => (v ? 5 : 1.5));
        plotTraces.push({
          x: timestamps, y: t.yData, type: "scatter", mode: "lines",
          line: { width: 0, color: TC[idx % 3] },
          name: t.legendName,
          text: t.yData.map((_, i) => `WSP Dump Valve: ${pop[i] ? "On" : "Off"}`),
          showlegend: false,
        });
      });
    } else if (mode === "HVPOP") {
      traces.forEach((t, idx) => {
        const key = hvpopMap[t.key]; if (!key) return;
        const pop = router.data[key] || []; if (!pop.length || !t.yData.length) return;
        pushSegments(t, idx, pop, (v) => (v ? 5 : 1.5));
        plotTraces.push({
          x: timestamps, y: t.yData, type: "scatter", mode: "lines",
          line: { width: 0, color: TC[idx % 3] },
          name: t.legendName,
          hovertemplate: "%{text}<extra></extra>",
          text: t.yData.map((v, i) => `Axle ${t.axleName} ${v} kph<br>HVPOP: ${pop[i] ? "On" : "Off"}`),
          showlegend: false,
        });
      });
    } else if (mode === "VV+HVPOP") {
      traces.forEach((t, idx) => {
        const vk = vvpopMap[t.key], hk = hvpopMap[t.key];
        const vd = router.data[vk] || [], hd = router.data[hk] || [];
        if (!t.yData.length || !vd.length || !hd.length) return;
        const color = TC[idx % 3];
        let sx = [timestamps[0]], sy = [t.yData[0]], sw = vd[0] ? 5 : 1.5, sd = hd[0] ? "dot" : "solid";
        for (let i = 1; i < timestamps.length; i++) {
          const w = vd[i] ? 5 : 1.5;
          const d = hd[i] ? "dot" : "solid";
          if (w !== sw || d !== sd) {
            plotTraces.push({ x: [...sx], y: [...sy], type: "scatter", mode: "lines", line: { width: sw, color, dash: sd }, showlegend: false, hoverinfo: "skip" });
            sx = [timestamps[i - 1], timestamps[i]];
            sy = [t.yData[i - 1], t.yData[i]];
            sw = w; sd = d;
          } else {
            sx.push(timestamps[i]);
            sy.push(t.yData[i]);
          }
        }
        plotTraces.push({ x: [...sx], y: [...sy], type: "scatter", mode: "lines", line: { width: sw, color, dash: sd }, showlegend: false, hoverinfo: "skip" });
        plotTraces.push({
          x: timestamps, y: t.yData, type: "scatter", mode: "lines",
          line: { width: 0, color },
          name: t.legendName,
          hovertemplate: "%{text}<extra></extra>",
          text: t.yData.map((v, i) => `${v}  VVPOP:${vd[i] ? "On" : "Off"} HVPOP:${hd[i] ? "On" : "Off"} Axle ${t.axleName}`),
          showlegend: false,
        });
      });
    } else {
      // Default: one plain line per axle
      plotTraces = traces.map((t, idx) => ({
        x: timestamps, y: t.yData,
        type: "scatter", mode: "lines",
        name: t.legendName,
        line: { color: TC[idx % 3], width: 2 },
      }));
    }

    // Decorative legend entries for VVPOP modes
    if (["VVPOP", "HVPOP", "VV+HVPOP"].includes(mode)) {
      const labels = router.isFront
        ? ["Axle 1", "Axle 2", "Axle 3+4"]
        : ["Axle 5+6", "Axle 7", "Axle 8"];
      labels.forEach((name, i) => plotTraces.push({
        x: [null], y: [null],
        mode: "lines", name,
        line: { color: TC[i], width: 2.5 }, showlegend: true,
      }));
    }

    const modeNames = { sander: "Sander_On", slide: "Wheel_Slide", spin: "Wheel_Spin" };
    if (modeNames[mode]) {
      plotTraces.push(
        { x: [null], y: [null], mode: "markers", name: `${modeNames[mode]} On`,
          marker: { color: "rgba(16,185,129,0.4)", symbol: "square", size: 12 } },
        { x: [null], y: [null], mode: "markers", name: `${modeNames[mode]} Off`,
          marker: { color: "rgba(239,68,68,0.25)", symbol: "square", size: 12 } }
      );
    }

    // ─── Card + canvas ───
    const cardId = ("chart-card-" + router.id + "-" + measure.label).replace(/[\s()]+/g, "-");
    let cardWrapper = document.getElementById(cardId);
    if (!cardWrapper) {
      cardWrapper = document.createElement("div");
      cardWrapper.id = cardId;
      cardWrapper.className = "rp-card";
    }

    const titleHtml = `
      <div class="chart-card-title">
        <span class="chart-title-measure">${measure.label}</span>
        <span class="chart-title-sep"> — </span>
        <span class="chart-title-car">${router.label}</span>
      </div>`;

    let chartDiv = document.getElementById(router.id + "-" + measure.label);
    if (!chartDiv) {
      chartDiv = document.createElement("div");
      chartDiv.id = router.id + "-" + measure.label;
      chartDiv.style.cssText = "width:100%;height:380px;";
    }

    cardWrapper.innerHTML = titleHtml;
    cardWrapper.appendChild(chartDiv);
    document.getElementById("panel-content").appendChild(cardWrapper);

    // ─── Layout (always reserve bottom margin for brackets) ───
    const layout = {
      paper_bgcolor: "#ffffff",
      plot_bgcolor:  "#f9fafb",
      margin: { t: 55, b: 90, l: 56, r: 64 },
      font: { family: F, size: 11, color: CTEXT },
      title: { text: "" },
      xaxis: {
        tickfont: { family: FM, size: 9, color: CTEXT },
        gridcolor: CGRID, linecolor: CLINE, linewidth: 1,
        showgrid: true, zeroline: false, automargin: true,
        title: { text: "" },
      },
      yaxis: {
        title: { text: measure.yaxistitle, font: { family: F, size: 10, color: CTEXT }, standoff: 4 },
        tickfont: { family: FM, size: 9, color: CTEXT },
        gridcolor: CGRID, linecolor: CLINE, linewidth: 1,
        showgrid: true, zeroline: false, automargin: true,
        range: measure.label === "BCP" ? [0, 5] : (sharedYScales[measure.label] || undefined),
      },
      showlegend: true,
      legend: {
        font: { family: F, size: 10, color: "#374151" },
        bgcolor: "rgba(255,255,255,0.9)",
        bordercolor: CLINE, borderwidth: 1,
        x: 1.2, y: 1, xanchor: "left", yanchor: "top",
      },
      hoverlabel: {
        bgcolor: "#111827", bordercolor: "#111827",
        font: { family: F, size: 11, color: "#f9fafb" },
      },
      shapes: [],
      annotations: [],
    };

    // ─── Status shapes (slide / spin modes) ───
    if (wheel_mode === "wheel_slide") {
      layout.shapes = createStatusShapes(timestamps, router.data.WHEEL_SLIDE || [], "WHEEL_SLIDE");
    } else if (wheel_mode === "wheel_spin") {
      layout.shapes = createStatusShapes(timestamps, router.data.WHEEL_SPIN || [], "WHEEL_SPIN");
    }

    // ─── Brake performance: hover trace + brackets (always) ───
    const brakeData = router.data.BRAKE_PERFORMANCE || [];
    const hoverTrace = createBrakePerformanceHoverTrace(brakeData);
    if (hoverTrace) plotTraces.push(hoverTrace);
    addBrakePerformanceBrackets(brakeData, layout, FM);

    // ─── Brake demand overlay ───
    if (BrakeDemandChartEnabled) {
      const bdt = createBrakeDemandTrace(
        timestamps,
        router.data.BRAKEDEMAND_STEP1 || [],
        router.data.BRAKEDEMAND_STEP2 || [],
        router.data.EMERGENCY_BRAKE
      );
      if (bdt) {
        plotTraces.push(bdt);
        layout.margin.r = 30;
        layout.yaxis2 = {
          overlaying: "y", side: "right", showgrid: false,
          range: [0, 4], dtick: 1,
          tickvals: [0, 1, 2, 3, 4],
          ticktext: ["No Brake", "Step 1", "Step 2", "Step 3", "Emergency"],
          tickfont: { family: FM, size: 8, color: CTEXT },
          linecolor: CLINE, linewidth: 1,
        };
      }
    }

    // ─── Sander-on hat ───
    if (router.data.SANDER_ON?.length) {
      const sander = router.data.SANDER_ON;
      let regions = [], startIndex = -1;
      for (let i = 0; i < sander.length; i++) {
        if (sander[i] === 1 && startIndex === -1) startIndex = i;
        if (startIndex !== -1 && sander[i] !== 1) { regions.push([startIndex, i - 1]); startIndex = -1; }
      }
      if (startIndex !== -1) regions.push([startIndex, sander.length - 1]);

      if (regions.length) {
        const barY0 = 1.055;
        const barY1 = 1.09;

        regions.forEach(([s, e]) => {
          const x0 = timestamps[s], x1 = timestamps[e];
          layout.shapes.push({
            type: "rect",
            xref: "x", yref: "paper",
            x0, x1,
            y0: barY0, y1: barY1,
            fillcolor: "#111827",
            opacity: 1,
            line: { width: 0 },
            layer: "above",
          });
        });

        const allStart = timestamps[regions[0][0]];
        const allEnd   = timestamps[regions[regions.length - 1][1]];
        const midX     = new Date((new Date(allStart).getTime() + new Date(allEnd).getTime()) / 2);

        layout.annotations.push({
          xref: "x", yref: "paper",
          x: midX, y: barY1 + 0.03,
          text: "SANDER ON",
          showarrow: false,
          xanchor: "center", yanchor: "bottom",
          font: { family: FM, size: 9, color: "#374151" },
        });
      }
    }

    // ─── Tacho overlay on KPH charts ───
    if (measure.keys.some((k) => k.includes("KPH")) && router.data.WSP_S_VTACHO?.length) {
      plotTraces.push({
        x: timestamps, y: router.data.WSP_S_VTACHO,
        type: "scatter", mode: "lines", name: "Tacho",
        line: { color: "#9ca3af", width: 1, dash: "dot" },
      });
    }

    // ─── Single unified Plotly call ───
    Plotly.react(chartDiv.id, plotTraces, layout);
    console.log(`✅ Rendered: ${measure.label} — ${router.label}`);
  }
}