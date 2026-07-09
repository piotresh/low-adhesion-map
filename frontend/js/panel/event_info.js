/**
 * Right-panel event summary: KPIs, weather, router position, MURS table,
 * train formation and the slope-indicator canvas.
 *
 * All DOM updates happen here; the chart card is filled in separately by
 * `router_charts.js`.
 */

function updateEventInfo(event) {
  console.log(event);

  const startTime       = new Date(event.start.replace(" ", "T").split(".")[0]);
  const endTime         = new Date(event.end.replace(" ", "T").split(".")[0]);
  const durationSeconds = (endTime - startTime) / 1000;

  // ── Event title ──
  const titles = {
    wheel_slide:      "Wheel Slide",
    wheel_spin:       "Wheel Spin",
    emergency_breaks: "Emergency Brake",
    train_stop:       "Train Stop",
  };
  const eventTitle = titles[wheel_mode] || "Event";
  const titleEl = document.getElementById("event-title-label");
  if (titleEl) titleEl.textContent = eventTitle;

  const timeEl = document.getElementById("event-time-label");
  if (timeEl) timeEl.textContent = event.start.split(" ")[1]?.slice(0, 8) ?? "—";

  // ── KPI value formatting ──
  const durStr   = durationSeconds >= 60
    ? (durationSeconds / 60).toFixed(1) + "m"
    : durationSeconds.toFixed(0) + "s";
  // total_distance is 0 when GPS data was insufficient; show N/A.
  const distNoData = event.total_distance == null || event.total_distance === 0;
  const distStr    = distNoData ? "N/A" : event.total_distance.toFixed(0);
  // net_elevation_change is 0 when the elevation API returned no data (backend
  // defaults to 0 on failure). Show N/A rather than a misleading 0.0 m.
  const elevNoData = event.net_elevation_change == null || event.net_elevation_change === 0;
  const elevStr  = elevNoData
    ? "N/A"
    : (event.net_elevation_change >= 0 ? "+" : "") + event.net_elevation_change.toFixed(1);
  // Slope depends on elevation; show N/A when elevation is unavailable.
  const slopeNoData = elevNoData || event.slope == null || event.slope === 0;
  const slopeVal    = slopeNoData ? "N/A" : event.slope.toFixed(1);

  const setHTML = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };

  const durNum  = durStr.slice(0, -1);
  const durUnit = durStr.slice(-1);
  setHTML("detail-duration",  `${durNum}<span class="rp-kpi-unit">${durUnit}</span>`);
  setHTML("detail-distance",  distNoData  ? `N/A` : `${distStr}<span class="rp-kpi-unit">m</span>`);
  setHTML("detail-elevation", elevNoData  ? `N/A` : `${elevStr}<span class="rp-kpi-unit">m</span>`);
  setHTML("detail-slope",     slopeNoData ? `N/A` : `${slopeVal}<span class="rp-kpi-unit">%</span>`);

  drawSlopeIndicator(slopeNoData ? 0 : event.slope);

  // ── Chain Info Cards ──
  const chainData = event.chain_info || {};
  
  // Get values
  const elrVal   = chainData.ELR   || chainData.elr   || "--";
  const mileVal  = chainData.mile  || chainData.MILE  || chainData.MILEAGE || "--";
  const chainVal = chainData.chain || chainData.CHAIN || "--";
  
  // Use the same setHTML function and structure as the top cards.
  // We add an empty <span class="rp-kpi-unit"></span> to force the CSS alignment to match perfectly.
  setHTML("chain-elr",   `${elrVal}<span class="rp-kpi-unit"></span>`);
  setHTML("chain-mile",  `${mileVal}<span class="rp-kpi-unit"></span>`);
  setHTML("chain-chain", `${chainVal}<span class="rp-kpi-unit"></span>`);


  // ── Weather cards ──
  const currentBody  = document.getElementById("weather-current-body");
  const previousBody = document.getElementById("weather-previous-body");
  const weatherDiv   = document.getElementById("weather-info");
  if (event.weather_data && Array.isArray(event.weather_data)) {
    const [current, previous] = event.weather_data;
    if (currentBody)  currentBody.innerHTML  = current.replace(/\n/g, "<br>");
    if (previousBody) previousBody.innerHTML = previous.replace(/\n/g, "<br>");
    if (weatherDiv)   weatherDiv.innerHTML   = "";
  } else {
    if (currentBody)  currentBody.innerHTML  = `<p class="rp-empty">No data available.</p>`;
    if (previousBody) previousBody.innerHTML = `<p class="rp-empty">No data available.</p>`;
  }

  // ── MURS table ──
  if (event.murs_min && event.murs_avg && event.masses) {
    const leadWeight   = event.masses.slice(0, 3).reduce((s, w) => s + (typeof w === "number" ? w : 0), 0);
    const followWeight = event.masses.slice(3, 6).reduce((s, w) => s + (typeof w === "number" ? w : 0), 0);

    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setTxt("weight-lead",   leadWeight.toFixed(0));
    setTxt("weight-follow", followWeight.toFixed(0));

    const axleIds = ["axle1", "axle2", "axle3-4", "axle5-6", "axle7", "axle8"];
    axleIds.forEach((axle, i) => {
      const minVal = event.murs_min[i] ?? "--";
      const avgVal = event.murs_avg[i] ?? "--";
      const lastTs = event.last_stable_timestamps?.[i];
      let formattedTime = "--";
      if (lastTs) {
        const d = new Date(lastTs);
        if (!isNaN(d)) formattedTime = d.toTimeString().slice(0, 5);
      }
      setTxt(`${axle}-min`,  typeof minVal === "number" ? minVal.toFixed(3) : minVal);
      setTxt(`${axle}-avg`,  typeof avgVal === "number" ? avgVal.toFixed(3) : avgVal);
      setTxt(`${axle}-time`, formattedTime);
    });
  } else {
    document.querySelectorAll(".murs-table td[id]").forEach((c) => (c.textContent = "--"));
  }

  // ── Router 5 / 6 status row ──
  const r5 = event.data.router_5;
  const r6 = event.data.router_6;
  const setField = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setField("router5-cab",     r5 ? r5.CABIN_ACTIVE[0] : "--");
  setField("router5-forward", r5 ? r5.FORWARD[0]      : "--");
  setField("router5-reverse", r5 ? r5.REVERSE[0]      : "--");
  setField("router6-cab",     r6 ? r6.CABIN_ACTIVE[0] : "--");
  setField("router6-forward", r6 ? r6.FORWARD[0]      : "--");
  setField("router6-reverse", r6 ? r6.REVERSE[0]      : "--");

  // ── Derived leading/following labels ──
  const r5Lead = r5 ? r5.CABIN_ACTIVE[0] : 0;
  const r6Lead = r6 ? r6.CABIN_ACTIVE[0] : 0;
  const leadingRouter   = r5Lead > r6Lead ? "Router 5" : r6Lead > r5Lead ? "Router 6" : "—";
  const followingRouter = r5Lead > r6Lead ? "Router 6" : r6Lead > r5Lead ? "Router 5" : "—";

  const frontRouter = event.front_router ? `Router ${event.front_router}` : leadingRouter;
  const backRouter  = event.back_router  ? `Router ${event.back_router}`  : followingRouter;
  const reasonText  = event.reason       || (leadingRouter !== "—" ? `${leadingRouter} is leading the train.` : "");

  const reasonEl = document.getElementById("reason-label");
  if (reasonEl) {
    reasonEl.innerHTML = reasonText
      ? `<span class="rp-reason-therefore">Therefore:</span> ${reasonText}`
      : "";
  }

  const frontEl = document.getElementById("front-label");
  if (frontEl) frontEl.textContent = `Leading: ${frontRouter}`;
  const backEl  = document.getElementById("back-label");
  if (backEl) backEl.textContent = `Following: ${backRouter}`;

  // ── Router diagram image (replaces placeholder with first fleet image) ──
  const slideData = event.extra_slide_data;
  const routerImg = document.getElementById("router-train-img");
  if (routerImg && slideData?.fleet_ids?.length > 0) {
    const prgs = slideData.planned_resource_groups || [];
    const idx  = prgs.indexOf("165004");
    const fid  = idx >= 0 ? slideData.fleet_ids[idx] : slideData.fleet_ids[0];
    const sel  = fid ? fid.replace("/", "-") : null;
    const pre  = sel ? document.querySelector(`#fleet-images img[data-fleet-id="${sel}"]`) : null;
    if (pre) {
      routerImg.src = pre.src;
      routerImg.style.display = "block";
    }
  }

  // ── Train formation card ──
  const metaEl   = document.getElementById("train-formation-meta");
  const fleetEl  = document.getElementById("train-formation-fleet");
  const legacyEl = document.getElementById("train-slide-container");
  if (metaEl)   metaEl.innerHTML  = "";
  if (fleetEl)  fleetEl.innerHTML = "";
  if (legacyEl) legacyEl.innerHTML = "";

  if (slideData?.status === "no info found") {
    if (legacyEl) {
      legacyEl.innerHTML = `
        <div class="rp-empty-card">
          <span class="rp-empty-icon">🚆</span>
          <span>No Network Rail wheel slide data found for this event.</span>
        </div>`;
    }
    return;
  }

  if (slideData?.fleet_ids?.length > 0) {
    if (metaEl) {
      metaEl.innerHTML = `
        <div class="tf-meta">
          <div class="tf-headcode">${slideData.headcode}</div>
          <div class="tf-meta-row">
            <span class="tf-times">${slideData.start_time.slice(11,16)} → ${slideData.end_time.slice(11,16)}</span>
            <span class="tf-route">${slideData.origin} → ${slideData.destination}</span>
          </div>
          <div class="tf-diagram">Diagram: ${slideData.diagram} · ${slideData.diagram_date}</div>
        </div>`;
    }

    if (fleetEl) {
      const images = [];
      let loadedCount = 0;
      const baseHeight = 68;

      slideData.fleet_ids.forEach((fleetId, i) => {
        const sel = fleetId.replace("/", "-");
        const pre = document.querySelector(`#fleet-images img[data-fleet-id="${sel}"]`);
        if (!pre) return;

        const block = document.createElement("div");
        block.className = "tf-fleet-block";
        const prg = slideData.planned_resource_groups?.[i] ?? "N/A";
        if (prg === "165004") block.classList.add("tf-highlighted");

        const img = pre.cloneNode(true);
        img.style.height = `${baseHeight}px`;
        img.style.width  = "auto";

        const prgLbl = document.createElement("div");
        prgLbl.className   = "tf-fleet-prg";
        prgLbl.textContent = prg;

        const classLbl = document.createElement("div");
        classLbl.className   = "tf-fleet-class";
        classLbl.textContent = fleetId;

        block.appendChild(img);
        block.appendChild(prgLbl);
        block.appendChild(classLbl);
        fleetEl.appendChild(block);
        images.push(img);

        // After all images decode, scale them proportionally to fit the row
        img.onload = () => {
          loadedCount++;
          if (loadedCount === images.length) {
            const total = images.reduce(
              (s, im) => s + im.naturalWidth * (baseHeight / im.naturalHeight), 0
            );
            const scale = (fleetEl.clientWidth / total) * 0.97;
            images.forEach((im) => {
              im.style.height = `${baseHeight * scale}px`;
              im.style.width  = "auto";
            });
          }
        };
      });
    }
  } else {
    if (legacyEl) {
      legacyEl.innerHTML = `
        <div class="rp-empty-card">
          <span class="rp-empty-icon">⚠️</span>
          <span>Train slide data could not be retrieved for this event.</span>
        </div>`;
    }
  }
}

/** Slope canvas — simple trigonometric wedge tuned for narrow card. */
function drawSlopeIndicator(slopePct) {
  const dpr    = window.devicePixelRatio || 1;
  const card   = document.getElementById("slope-card");
  const canvas = document.getElementById("slope-canvas");
  if (!canvas || !card) return;

  const label   = card.querySelector(".rp-kpi-label");
  const val     = card.querySelector(".rp-kpi-value");
  const cardW   = card.clientWidth;
  const cardH   = card.clientHeight;
  const topUsed = 14 + label.offsetHeight + 6 + val.offsetHeight + 6;
  const W = cardW;
  const H = cardH - topUsed;
  if (W <= 0 || H <= 4) return;

  canvas.width        = Math.round(W * dpr);
  canvas.height       = Math.round(H * dpr);
  canvas.style.height = H + "px";

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const rise = W * (slopePct / 100) * 2;
  const midY = H * 0.5;
  const yR   = Math.max(4, Math.min(H - 4, midY - rise / 2));
  const yL   = Math.max(4, Math.min(H - 4, midY + rise / 2));

  const lineColor = "#1d4ed8";
  const fillColor = "rgba(29,78,216,0.10)";
  ctx.beginPath();
  ctx.moveTo(0, yL);
  ctx.lineTo(W, yR);
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(0, yL);
  ctx.lineTo(W, yR);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = "butt";
  ctx.stroke();
}
