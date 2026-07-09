/**
 * Main map renderer: markers + corridors + direction arrows.
 *
 * For each event in `selectedEvents` (optionally filtered by date or brake
 * performance) we:
 *   1. Add a clustered marker at the event centroid
 *   2. Draw a square-ended corridor polygon along the leading router's GPS
 *      track with a trailing triangular arrow showing direction of travel
 *
 * All corridor maths run in world metres (via Leaflet's projected CRS) so
 * widths stay consistent regardless of zoom.
 */

/**
 * Drop events that fall outside the selected brake-performance bin range.
 * @param {Array} events     - Events to filter.
 * @param {Array} bins       - Bins array as produced by `getBrakePerfBins`.
 * @param {string} startKey  - Starting bin key, e.g. "-40--30".
 * @param {string} endKey    - Ending bin key (inclusive).
 */
function filterEventsByBrakePerf(events, bins, startKey, endKey) {
  const startIdx = bins.findIndex((b) => b.key === startKey);
  const endIdx   = bins.findIndex((b) => b.key === endKey);
  if (startIdx === -1 || endIdx === -1) return events;

  const allowedBins = bins
    .slice(startIdx, endIdx + 1)
    .map((b) => {
      const match = b.key.match(/^(-?\d+)-(-?\d+)$/);
      if (!match) return null;
      return { start: Number(match[1]), end: Number(match[2]) };
    })
    .filter((b) => b !== null);

  return events.filter((ev) => {
    const val = Number(ev.worst_brake_performance);
    if (isNaN(val)) return false;
    return allowedBins.some((bin) => val >= bin.start && val < bin.end);
  });
}

// ───────────── Geometry helpers (closures into the renderer) ─────────────

function renderMapData() {
  ensurePanes(map);
  markers.clearLayers();
  polylines.forEach((p) => map.removeLayer(p));
  polylines = [];

  // ─── Date-window filter ───
  const startDate = globalStartDate ? new Date(globalStartDate) : null;
  const endDate   = globalEndDate   ? new Date(globalEndDate)   : null;
  if (startDate) startDate.setHours(0, 0, 0, 0);
  if (endDate)   endDate.setHours(23, 59, 59, 999);

  let filteredEvents = selectedEvents.filter((event) => {
    if (!startDate || !endDate) return true;
    const eventDate = new Date(event.start);
    return eventDate >= startDate && eventDate <= endDate;
  });

  // ─── Brake-performance bin filter ───
  if (globalBrakePerfStartBin && globalBrakePerfEndBin) {
    filteredEvents = filterEventsByBrakePerf(
      filteredEvents, timelineItems, globalBrakePerfStartBin, globalBrakePerfEndBin
    );
  }

  const crs = map.options.crs || L.CRS.EPSG3857;
  const isFiniteLL   = (ll) => Number.isFinite(ll.lat) && Number.isFinite(ll.lng);
  const isFinitePair = (p)  => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

  // Close a linear ring; null if invalid (needs ≥4 finite points)
  function closeRing(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return null;
    const first = coords[0];
    const last  = coords[coords.length - 1];
    const ring  = (first[0] === last[0] && first[1] === last[1])
      ? coords.slice()
      : coords.concat([[first[0], first[1]]]);
    if (ring.length < 4) return null;
    for (const [x, y] of ring) if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return ring;
  }

  function isValidPolygonGeom(geom) {
    if (!geom) return false;
    const checkPoly = (poly) => {
      if (!Array.isArray(poly) || poly.length === 0) return false;
      const ring = poly[0];
      if (!Array.isArray(ring) || ring.length < 4) return false;
      const f = ring[0], l = ring[ring.length - 1];
      if (!isFinitePair(f) || !isFinitePair(l)) return false;
      if (f[0] !== l[0] || f[1] !== l[1]) return false;
      for (const [x, y] of ring) if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      return true;
    };
    if (geom.type === "Polygon")      return checkPoly(geom.coordinates);
    if (geom.type === "MultiPolygon") return geom.coordinates.every(checkPoly);
    return false;
  }

  /** Build a square-ended corridor polygon from a line using L/R offsets. */
  function buildButtCorridorPolygon(lineString, halfWidthKm) {
    const left  = turf.lineOffset(lineString, +halfWidthKm, { units: "kilometers" });
    const right = turf.lineOffset(lineString, -halfWidthKm, { units: "kilometers" });

    const leftCoords  = left?.geometry?.coordinates;
    const rightCoords = right?.geometry?.coordinates;

    if (!Array.isArray(leftCoords)  || leftCoords.length  < 2) return null;
    if (!Array.isArray(rightCoords) || rightCoords.length < 2) return null;

    const stitched = leftCoords.concat(rightCoords.slice().reverse());
    const ring = closeRing(stitched);
    if (!ring) return null;

    try {
      return turf.polygon([ring]);
    } catch (e) {
      // Re-close with forced first-coord copy just in case
      const ring2 = ring.slice(0, -1).concat([[ring[0][0], ring[0][1]]]);
      if (ring2.length >= 4) return turf.polygon([ring2]);
      throw e;
    }
  }

  /** Drop NaN/dupe consecutive points to avoid zero-length segments. */
  function sanitizeLatLngs(latlngs, tolMeters = 0.05) {
    const numeric = latlngs
      .map(([la, lo]) => [Number(la), Number(lo)])
      .filter(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo));
    if (numeric.length < 2) return [];

    const out = [numeric[0]];
    let last  = L.latLng(numeric[0][0], numeric[0][1]);
    let lastP = crs.project(last);
    for (let i = 1; i < numeric.length; i++) {
      const cur  = L.latLng(numeric[i][0], numeric[i][1]);
      const curP = crs.project(cur);
      const d    = Math.hypot(curP.x - lastP.x, curP.y - lastP.y);
      if (d >= tolMeters) {
        out.push(numeric[i]);
        last  = cur;
        lastP = curP;
      }
    }
    return out;
  }
  //buildHeatmap(filteredEvents);
  // ─── Main per-event render ───
  filteredEvents.forEach((event) => {

    if (event.latitude == null || event.longitude == null) return;
    // Hard-coded sanity skips for two known-bad events
    if (event.start == "2025-10-10 01:55:14.805093" ||
        event.start == "2025-10-10 01:55:11.794954") return;

    const isSelected = currentEvent && event.start === currentEvent.start;
    const selectedMode = document.querySelector('input[name="map-mode"]:checked')?.value;
    const adhesionMu = event.Adhesion_Index_Murs_Avg ?? "--";

    console.log("adhesionMu:", adhesionMu, "color:", getAdhesionColor(adhesionMu), "event:", event.start);

    const color = (isSelected && selectedMode === "brakedemand")
      ? "#FFFFFF"
      : getAdhesionColor(adhesionMu);
    // ─── Marker ───
    const marker = L.marker([event.latitude, event.longitude], {
      icon: isSelected ? redIcon : blueIcon,
    });

    
    marker.bindPopup(`<b>${event.start}</b>`);
    marker.on("mouseover", function () { this.openPopup(); });
    marker.on("mouseout",  function () { this.closePopup(); });
    marker.on("click", () => handleMarkerClick(event));
    markers.addLayer(marker);

    // ─── Pick leading router (fall back to back router if front missing) ───
    let frontName = event.front_router;
    if (frontName === "Missing Data") frontName = event.back_router;
    const routerKey = `router_${frontName}`;
    const router = event.data?.[routerKey];

    // Trim 10 s at start/end of the router's arrays if the whole span is > 20 s
    if (router && router.TIMESTAMP?.length > 0) {
      const timestamps = router.TIMESTAMP.map((ts) => new Date(ts));
      const first = timestamps[0].getTime();
      const last  = timestamps[timestamps.length - 1].getTime();
      const startTime = (last - first > 20000) ? new Date(first + 10000) : new Date(first);
      const endTime   = (last - first > 20000) ? new Date(last - 10000)  : new Date(last);
      for (const key in router) {
        if (Array.isArray(router[key])) {
          router[key] = router[key].filter((_, idx) => {
            const ts = timestamps[idx];
            return ts >= startTime && ts <= endTime;
          });
        }
      }
    } else {
      console.log("No data found for", routerKey);
    }

    if (!router?.LATITUDE || !router?.LONGITUDE) return;

    const raw = router.LATITUDE.map((lat, i) => [lat, router.LONGITUDE[i]]);
    const latlngs = sanitizeLatLngs(raw);
    if (latlngs.length < 2) return;

    const routePane = isSelected ? "selectedPane" : "routesPane";
    const arrowPane = isSelected ? "selectedPane" : "arrowsPane";

    try {
      if (!self.turf && !window.turf) throw new Error("Turf not loaded");

      const lineCoords = latlngs.map(([lat, lng]) => [lng, lat]);
      const fullLine = {
        type: "Feature",
        geometry: { type: "LineString", coordinates: lineCoords },
        properties: {},
      };

      const widthM            = MAPCFG.line.widthMeters;
      const halfWidthKm       = (widthM / 2) / 1000.0;
      const arrowLenM         = MAPCFG.arrow.lenMeters;
      const arrowLenKm        = arrowLenM / 1000.0;
      const detachGapM        = MAPCFG.arrow.gapMeters ?? 8;
      const detachBelowCorrM  = MAPCFG.arrow.detachIfCorridorBelowMeters ?? 120;

      const totalKm   = turf.length(fullLine, { units: "kilometers" });
      const stopKmRaw = totalKm - arrowLenKm;
      const detach    = (stopKmRaw <= 0) || (stopKmRaw * 1000 < detachBelowCorrM);

      const segmentForCorridor = detach
        ? fullLine
        : turf.lineSliceAlong(fullLine, 0, stopKmRaw, { units: "kilometers" });

      // Build the corridor polygon, falling back to Turf's rounded buffer if
      // the square-ended construction fails on a degenerate segment
      let corridor = null;
      const tl = segmentForCorridor?.geometry?.coordinates ?? [];
      if (tl.length >= 2 && tl.every(isFinitePair)) {
        try {
          corridor = buildButtCorridorPolygon(segmentForCorridor, halfWidthKm);
        } catch (err) {
          console.warn("lineOffset failed; falling back to buffer (rounded caps):", err);
        }
        if (!corridor) {
          try {
            corridor = turf.buffer(segmentForCorridor, halfWidthKm, {
              units: "kilometers",
              steps: MAPCFG.line.bufferSteps,
            });
          } catch (e) {
            console.warn("Buffer failed; corridor fallback to pixel polyline:", e);
          }
        }
      }

      // Render corridor if valid; else fall back to pixel polyline
      let corridorRendered = false;
      if (corridor && isValidPolygonGeom(corridor.geometry)) {
        // ── Geo-proportional blue border on the corridor body ────────────────
        // Only draw when the corridor is ≥ 2 screen pixels wide — below that
        // threshold both polygons are sub-pixel and the blue one would show as
        // a hairline artefact on the map at low zoom.
        const lat0    = latlngs[Math.floor(latlngs.length / 2)][0];
        const mPerPx  = 156543.034 * Math.cos(lat0 * Math.PI / 180) / Math.pow(2, map.getZoom());
        const drawBorder = (MAPCFG.line.widthMeters / mPerPx) >= 2;

        if (drawBorder) {
          const borderKm = (MAPCFG.arrow.borderMeters || 5) / 1000;
          let borderPoly = null;
          try {
            borderPoly = buildButtCorridorPolygon(segmentForCorridor, halfWidthKm + borderKm);
          } catch (_) {
            try {
              borderPoly = turf.buffer(segmentForCorridor, halfWidthKm + borderKm, {
                units: "kilometers", steps: MAPCFG.line.bufferSteps,
              });
            } catch (_2) {}
          }
          if (borderPoly && isValidPolygonGeom(borderPoly.geometry)) {
            const borderLayer = L.geoJSON(borderPoly, {
              style: { stroke: false, fill: true, fillColor: MAPCFG.arrow.strokeColor, fillOpacity: 1 },
              pane: routePane, interactive: false, smoothFactor: 0,
            }).addTo(map);
            polylines.push(borderLayer);
          }
        }

        const corridorLayer = L.geoJSON(corridor, {
          style: {
            stroke: false,
            fill: true,
            fillColor: color,
            fillOpacity: isSelected ? MAPCFG.line.opacitySelected : MAPCFG.line.opacityDefault,
          },
          pane: routePane,
          interactive: false,
          smoothFactor: 0,
        }).addTo(map);
        polylines.push(corridorLayer);
        if (isSelected && corridorLayer.bringToFront) corridorLayer.bringToFront();
        corridorRendered = true;
      }

      if (!corridorRendered) {
        // Fallback: layered polylines — wider blue under narrower adhesion fill.
        const fallbackBorder = L.polyline(latlngs, {
          color: MAPCFG.arrow.strokeColor || "#2563eb",
          weight: 10 + (MAPCFG.arrow.borderMeters || 5),
          opacity: isSelected ? 1.0 : 0.7,
          pane: routePane, lineCap: "butt", lineJoin: "miter",
        }).addTo(map);
        const fallbackFill = L.polyline(latlngs, {
          color,
          weight: 10,
          opacity: isSelected ? 1.0 : 0.7,
          pane: routePane, lineCap: "butt", lineJoin: "miter",
        }).addTo(map);
        polylines.push(fallbackBorder, fallbackFill);
        if (isSelected && fallbackFill.bringToFront) fallbackFill.bringToFront();
      }

      // ─── Arrowhead ───
      const ARROW_LEN_M        = arrowLenM;
      const ARROW_HALF_WIDTH_M = MAPCFG.arrow.halfWidthMeters;
      const FORWARD_M_DEFAULT  = MAPCFG.arrow.forwardMeters || 0;
      const TOL_M              = MAPCFG.arrow.tolMeters;

      const iEnd  = latlngs.length - 1;
      const tipLL = L.latLng(latlngs[iEnd][0], latlngs[iEnd][1]);
      if (!isFiniteLL(tipLL)) return;

      // Walk back along the track until we find a prev point far enough to form a direction vector
      let prevIdx = iEnd - 1;
      let tipP    = crs.project(tipLL);
      let prevLL  = L.latLng(latlngs[prevIdx][0], latlngs[prevIdx][1]);
      let prevP   = crs.project(prevLL);
      while (prevIdx >= 0 && Math.hypot(tipP.x - prevP.x, tipP.y - prevP.y) <= TOL_M) {
        prevIdx--;
        if (prevIdx >= 0) {
          prevLL = L.latLng(latlngs[prevIdx][0], latlngs[prevIdx][1]);
          prevP  = crs.project(prevLL);
        }
      }
      if (prevIdx < 0) return;

      const vx = tipP.x - prevP.x, vy = tipP.y - prevP.y;
      const segLen = Math.hypot(vx, vy);
      if (segLen <= TOL_M) return;

      const tx = vx / segLen, ty = vy / segLen;
      const nx = -ty, ny = tx;

      const TIP_OFFSET_M = detach ? (detachGapM + ARROW_LEN_M) : FORWARD_M_DEFAULT;

      let baseCenterLL;
      if (!detach) {
        try {
          const backKm = Math.max(0, totalKm - arrowLenKm);
          const baseCenterPt = turf.along(fullLine, backKm, { units: "kilometers" });
          const c = baseCenterPt?.geometry?.coordinates;
          baseCenterLL = (c && Number.isFinite(c[0]) && Number.isFinite(c[1]))
            ? L.latLng(c[1], c[0]) : null;
        } catch (err) {
          const Cx = tipP.x - ARROW_LEN_M * tx;
          const Cy = tipP.y - ARROW_LEN_M * ty;
          baseCenterLL = crs.unproject(L.point(Cx, Cy));
        }
      } else {
        const Cx = tipP.x + (detachGapM) * tx;
        const Cy = tipP.y + (detachGapM) * ty;
        baseCenterLL = crs.unproject(L.point(Cx, Cy));
      }
      if (!baseCenterLL || !isFiniteLL(baseCenterLL)) return;

      const tipForwardX = tipP.x + TIP_OFFSET_M * tx;
      const tipForwardY = tipP.y + TIP_OFFSET_M * ty;

      const C = crs.project(baseCenterLL);
      const B1x = C.x + ARROW_HALF_WIDTH_M * nx, B1y = C.y + ARROW_HALF_WIDTH_M * ny;
      const B2x = C.x - ARROW_HALF_WIDTH_M * nx, B2y = C.y - ARROW_HALF_WIDTH_M * ny;

      const tipOut = crs.unproject(L.point(tipForwardX, tipForwardY));
      const b1Out  = crs.unproject(L.point(B1x, B1y));
      const b2Out  = crs.unproject(L.point(B2x, B2y));
      if (!isFiniteLL(tipOut) || !isFiniteLL(b1Out) || !isFiniteLL(b2Out)) return;

      // ── Geo-proportional border on arrowhead ──────────────────────────────
      // Expand the 3 vertices outward from the triangle's centroid in EPSG:3857
      // projected-metre space.  The expanded triangle is drawn in the border
      // colour first; the adhesion-coloured triangle goes on top.  Both are
      // geographic polygons so they scale identically with zoom.
      const BORDER_M = MAPCFG.arrow.borderMeters || 3;
      const tipPx  = crs.project(tipOut);
      const b1Px   = crs.project(b1Out);
      const b2Px   = crs.project(b2Out);
      const cgx    = (tipPx.x + b1Px.x + b2Px.x) / 3;
      const cgy    = (tipPx.y + b1Px.y + b2Px.y) / 3;
      function _expandPt(p) {
        const dx = p.x - cgx, dy = p.y - cgy;
        const d  = Math.hypot(dx, dy) || 1;
        return crs.unproject(L.point(p.x + (dx / d) * BORDER_M, p.y + (dy / d) * BORDER_M));
      }
      const tipB = _expandPt(tipPx);
      const b1B  = _expandPt(b1Px);
      const b2B  = _expandPt(b2Px);
      const arrowBorder = L.polygon(
        [[tipB.lat, tipB.lng], [b1B.lat, b1B.lng], [b2B.lat, b2B.lng]],
        { stroke: false, fillColor: MAPCFG.arrow.strokeColor, fillOpacity: 1,
          interactive: false, pane: arrowPane }
      ).addTo(map);
      polylines.push(arrowBorder);

      const arrow = L.polygon(
        [[tipOut.lat, tipOut.lng], [b1Out.lat, b1Out.lng], [b2Out.lat, b2Out.lng]],
        { stroke: false,
          fillColor: color,
          fillOpacity: isSelected ? MAPCFG.arrow.fillOpacitySelected : MAPCFG.arrow.fillOpacityDefault,
          interactive: false,
          pane: arrowPane,
        }
      ).addTo(map);
      polylines.push(arrow);
      if (isSelected && arrow.bringToFront) arrow.bringToFront();

    } catch (e) {
      console.warn("Corridor pipeline failed; using pixel polyline fallback:", e);

      const fallback = L.polyline(latlngs, {
        color, weight: 10,
        opacity: isSelected ? 1.0 : 0.7,
        pane: routePane,
        lineCap: "butt", lineJoin: "miter",
      }).addTo(map);
      polylines.push(fallback);
      if (isSelected && fallback.bringToFront) fallback.bringToFront();

      // Last-resort arrow using screen-pixel vectors
      const iEnd = latlngs.length - 1;
      if (iEnd > 0) {
        const tipLL  = L.latLng(latlngs[iEnd][0],     latlngs[iEnd][1]);
        const prevLL = L.latLng(latlngs[iEnd - 1][0], latlngs[iEnd - 1][1]);
        const tipP   = crs.project(tipLL);
        const prevP  = crs.project(prevLL);
        const vx = tipP.x - prevP.x, vy = tipP.y - prevP.y;
        const len = Math.hypot(vx, vy) || 1;
        const tx = vx / len, ty = vy / len, nx = -ty, ny = tx;

        const ARROW_LEN_M = MAPCFG.arrow.lenMeters;
        const detachGapM  = MAPCFG.arrow.gapMeters ?? 8;
        const tipX = tipP.x + (detachGapM + ARROW_LEN_M) * tx;
        const tipY = tipP.y + (detachGapM + ARROW_LEN_M) * ty;
        const Cx   = tipP.x + detachGapM * tx;
        const Cy   = tipP.y + detachGapM * ty;
        const B1x = Cx + MAPCFG.arrow.halfWidthMeters * nx;
        const B1y = Cy + MAPCFG.arrow.halfWidthMeters * ny;
        const B2x = Cx - MAPCFG.arrow.halfWidthMeters * nx;
        const B2y = Cy - MAPCFG.arrow.halfWidthMeters * ny;

        const tipOut2 = crs.unproject(L.point(tipX, tipY));
        const b1Out2  = crs.unproject(L.point(B1x, B1y));
        const b2Out2  = crs.unproject(L.point(B2x, B2y));

        // Geo-proportional border: expand from centroid in projected space
        const BM2   = MAPCFG.arrow.borderMeters || 3;
        const cgx2  = (tipX + B1x + B2x) / 3;
        const cgy2  = (tipY + B1y + B2y) / 3;
        function _ep2(px, py) {
          const dx = px - cgx2, dy = py - cgy2;
          const d  = Math.hypot(dx, dy) || 1;
          return crs.unproject(L.point(px + (dx / d) * BM2, py + (dy / d) * BM2));
        }
        const bTip = _ep2(tipX, tipY);
        const bB1  = _ep2(B1x,  B1y);
        const bB2  = _ep2(B2x,  B2y);

        L.polygon(
          [[bTip.lat, bTip.lng], [bB1.lat, bB1.lng], [bB2.lat, bB2.lng]],
          { stroke: false, fillColor: MAPCFG.arrow.strokeColor, fillOpacity: 1,
            interactive: false, pane: arrowPane }
        ).addTo(map);

        const arrow = L.polygon(
          [[tipOut2.lat, tipOut2.lng], [b1Out2.lat, b1Out2.lng], [b2Out2.lat, b2Out2.lng]],
          {
            stroke: false,
            fillColor: color,
            fillOpacity: isSelected ? MAPCFG.arrow.fillOpacitySelected : MAPCFG.arrow.fillOpacityDefault,
            interactive: false, pane: arrowPane,
          }
        ).addTo(map);
        polylines.push(arrow);
        if (isSelected && arrow.bringToFront) arrow.bringToFront();
      }
    }
  });
}

/** Centre the map on `latLng`, offsetting for the right-panel if already open. */
function focusMarker(latLng, panelAlreadyOpen = true) {
  setTimeout(() => {
    map.invalidateSize();
    if (!panelAlreadyOpen) {
      const zoom = 14;
      const targetPoint = map.project(latLng, zoom);
      targetPoint.x += 180; // offset for panel width
      map.flyTo(map.unproject(targetPoint, zoom), zoom, {
        animate: true, duration: 1.2, easeLinearity: 0.25,
      });
    } else {
      map.flyTo(latLng, 14, { animate: true, duration: 1.2, easeLinearity: 0.25 });
    }
  }, 360);
}
