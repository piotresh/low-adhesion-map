/**
 * "Brake Demand" map overlay.
 *
 * Draws a coloured corridor along the selected router's GPS track where each
 * segment's colour corresponds to the brake-demand state (0–4) at that
 * sample. Used when the "Map Display" radio is set to `brakedemand`.
 */

// Segments of the world-fixed corridor for the currently-open event
// (kept separate from `polylines` so we can clear them independently).

// ─── Adhesion colour helpers (mirrors Python get_adhesion_index thresholds) ───

const labelToColor = {
  "Excellent adhesion":   "#4caf50",
  "Good adhesion":        "#8bc34a",
  "Moderate adhesion":    "#ffeb3b",
  "Poor adhesion":        "#ff9800",
  "Very poor adhesion":   "#f44336",
  "Extreme adhesion loss":"#212121",
  "--":                   "#f3f4f6",
};

function getAdhesionColor(label) {
  return labelToColor[label] ?? "#f3f4f6";
}

function drawBrakeDemandSegments(router) {
  if (!router?.data?.LATITUDE || !router.data.LONGITUDE) return;

  const n = Math.min(
    router.data.LATITUDE.length,
    router.data.LONGITUDE.length,
    router.data.BRAKEDEMAND_STEP1?.length ?? 0,
    router.data.BRAKEDEMAND_STEP2?.length ?? 0,
    router.data.EMERGENCY_BRAKE?.length ?? 0
  );
  if (n < 2) return;

  const latlngs = Array.from({ length: n }, (_, i) => [
    router.data.LATITUDE[i],
    router.data.LONGITUDE[i],
  ]);

  const brakeStates = Array.from({ length: n }, (_, i) =>
    getState(
      router.data.BRAKEDEMAND_STEP1[i],
      router.data.BRAKEDEMAND_STEP2[i],
      router.data.EMERGENCY_BRAKE[i]
    )
  );

  // Split the polyline each time the brake-demand state changes
  const segments = [];
  let currentSegment = [latlngs[0]];
  let currentState   = brakeStates[0];
  for (let i = 1; i < n; i++) {
    if (brakeStates[i] !== currentState) {
      segments.push({ coords: [...currentSegment], state: currentState });
      currentSegment = [latlngs[i - 1], latlngs[i]];
      currentState   = brakeStates[i];
    } else {
      currentSegment.push(latlngs[i]);
    }
  }
  segments.push({ coords: currentSegment, state: currentState });

  if (!map.getPane("brakePane")) {
    map.createPane("brakePane");
    map.getPane("brakePane").style.zIndex      = MAPCFG.z.brake;
    map.getPane("brakePane").style.pointerEvents = "none";
  }

  segments.forEach((seg) => {
    const color = brakeColors[seg.state] ?? "#000000";
    const lineCoords = seg.coords.map(([lat, lng]) => [lng, lat]); // Turf wants [lng, lat]
    const line = { type: "Feature", geometry: { type: "LineString", coordinates: lineCoords } };

    // 5× corridor width gives a visible band at typical zoom levels
    const halfWidthKm = (MAPCFG.line.widthMeters * 5) / 1000.0;

    let corridor;
    try {
      corridor = turf.buffer(line, halfWidthKm, {
        units: "kilometers",
        steps: MAPCFG.line.bufferSteps,
      });
    } catch (e) {
      console.warn("Buffer failed for brake segment:", e);
      return;
    }

    if (corridor && corridor.geometry && corridor.geometry.type === "Polygon") {
      const layer = L.geoJSON(corridor, {
        style: {
          stroke: false,
          fill: true,
          fillColor: color,
          fillOpacity: 1,
        },
        pane: "brakePane",
        interactive: false,
      }).addTo(map);
      brakePolylines.push(layer);
    }
  });

  console.log("Brake segments drawn (world-fixed):", segments.length);
}

/** Render the brake-demand colour legend in the top-left of the map. */
function addBrakeLegend() {
  if (brakeLegend) map.removeControl(brakeLegend);
  brakeLegend = L.control({ position: "topleft" });
  brakeLegend.onAdd = function () {
    const div = L.DomUtil.create("div", "brake-legend");
    div.innerHTML = `
      <h4>Brake Demand</h4>
      <div><span style="background:${brakeColors[0]}"></span> Off (0)</div>
      <div><span style="background:${brakeColors[1]}"></span> Step 1 (1)</div>
      <div><span style="background:${brakeColors[2]}"></span> Step 2 (2)</div>
      <div><span style="background:${brakeColors[3]}"></span> Step 3 (3)</div>
      <div><span style="background:${brakeColors[4]}"></span> Emergency (4)</div>
    `;
    return div;
  };
  brakeLegend.addTo(map);
}


/** Show the brake layer for the given router. */
function showBrakeDemandMapLayer(router) {
  if (!router) {
    console.log("⚠️ No router data provided, cannot draw brake demand");
    return;
  }
  drawBrakeDemandSegments({ data: router });
  addBrakeLegend();
  console.log("🟢 Brake demand segments drawn & legend added");
}

function hideBrakeDemandMapLayer() {
  if (brakePolylines && brakePolylines.length) {
    brakePolylines.forEach((layer) => map.removeLayer(layer));
    brakePolylines = [];
  }
  if (brakeLegend) {
    map.removeControl(brakeLegend);
    brakeLegend = null;
  }
  renderMapData();
}