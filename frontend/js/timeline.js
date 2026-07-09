/**
 * D3 timeline overlay at the bottom of the map.
 *
 * Supports two modes:
 *   - `date` : one bar per calendar day with event counts
 *   - `bins` : one bar per 10%-wide worst-brake-performance bucket
 *
 * A brush selection updates the global filter state and re-renders the map.
 * The timeline also installs a ResizeObserver so it re-draws when the panel
 * slides in/out.
 */

function drawD3Timeline(inputObj, filterType = "date") {
  const overlayDiv = document.getElementById("timeline-overlay");

  /** Normalise both input shapes to a flat `[{key, label, count, date}, ...]` list. */
  function prepareTimelineData(obj, type) {
    if (type === "date") {
      const allDates = Object.keys(obj).map((d) => new Date(d)).sort((a, b) => a - b);
      if (allDates.length === 0) return [];
      const start = allDates[0];
      const end   = allDates[allDates.length - 1];
      const list  = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const iso = d.toISOString().split("T")[0];
        list.push({ key: iso, label: iso, date: new Date(d), count: obj[iso] || 0 });
      }
      return list;
    }
    if (type === "bins") {
      return obj.map((item) => ({ key: item.key, label: item.key, count: item.count, date: null }));
    }
    return [];
  }

  const items = prepareTimelineData(inputObj, filterType);
  if (items.length === 0) return;
  timelineItems = items;

  let startInput, endInput;

  function render() {
    overlayDiv.innerHTML = "";

    const margin = { top: 16, right: 16, bottom: 32, left: 16 };
    const width  = overlayDiv.clientWidth  - margin.left - margin.right;
    const height = overlayDiv.clientHeight - margin.top  - margin.bottom;
    if (width <= 0 || height <= 0) return;

    const svg = d3
      .select(overlayDiv)
      .append("svg")
      .attr("width",  width  + margin.left + margin.right)
      .attr("height", height + margin.top  + margin.bottom)
      .style("background", "transparent")
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand()
      .domain(items.map((d) => d.key))
      .range([0, width])
      .padding(0.2);

    const maxCount = d3.max(items, (d) => d.count) || 1;
    const y = d3.scaleLinear().domain([0, maxCount]).range([height, 0]);

    // Baseline
    svg.append("line")
      .attr("x1", 0).attr("x2", width)
      .attr("y1", height).attr("y2", height)
      .attr("stroke", "#e5e7eb")
      .attr("stroke-width", 1);

    // Bars
    svg.selectAll("rect.bar")
      .data(items.filter((d) => d.count > 0))
      .enter().append("rect")
      .attr("class", "bar")
      .attr("x",      (d) => x(d.key))
      .attr("y",      (d) => y(d.count))
      .attr("width",  x.bandwidth())
      .attr("height", (d) => height - y(d.count))
      .attr("fill",   "#1d4ed8")
      .attr("rx", 3);

    // Labels (only when the bar is tall enough to be readable)
    svg.selectAll("text.bar-label")
      .data(items.filter((d) => d.count > 0 && (height - y(d.count)) > 14))
      .enter().append("text")
      .attr("class", "bar-label")
      .attr("x", (d) => x(d.key) + x.bandwidth() / 2)
      .attr("y", (d) => y(d.count) - 4)
      .attr("text-anchor", "middle")
      .attr("font-size",    "9px")
      .attr("font-family",  "'DM Mono', monospace")
      .attr("fill",         "#1d4ed8")
      .text((d) => d.count);

    // X-axis — thin out tick labels to avoid overlap
    const minTickGap = 38;
    const step       = Math.max(1, Math.ceil(items.length / Math.floor(width / minTickGap)));
    const tickValues = items.filter((_, i) => i % step === 0).map((d) => d.key);

    svg.append("g")
      .attr("transform", `translate(0, ${height})`)
      .call(
        d3.axisBottom(x)
          .tickValues(tickValues)
          .tickFormat((k) => {
            if (filterType === "date") {
              const dt = new Date(k);
              return `${dt.getDate()}/${dt.getMonth() + 1}`;
            }
            return k;
          })
          .tickSize(0)
      )
      .call((g) => g.select(".domain").remove())
      .selectAll("text")
      .attr("dy", "1.2em")
      .style("text-anchor", "middle")
      .style("font-size",   "9px")
      .style("font-family", "'DM Mono', monospace")
      .style("fill",        "#9ca3af");

    // Brush — updates the global filter + re-renders the map
    const brush = d3.brushX()
      .extent([[0, 0], [width, height]])
      .handleSize(10)
      .on("brush end", (event) => {
        if (!event.selection) return;
        const [x0, x1] = event.selection;
        const midKeys  = items.map((d) => x(d.key) + x.bandwidth() / 2);
        const closest  = (val) => midKeys.reduce((p, c) => Math.abs(c - val) < Math.abs(p - val) ? c : p);
        const i0       = midKeys.indexOf(closest(x0));
        const i1       = midKeys.indexOf(closest(x1));
        const startKey = items[i0].key;
        const endKey   = items[i1].key;

        if (filterType === "date") {
          globalStartDate = startKey;
          globalEndDate   = endKey;
          if (startInput) startInput.value = startKey;
          if (endInput)   endInput.value   = endKey;
        }
        if (filterType === "bins") {
          globalBrakePerfStartBin = startKey;
          globalBrakePerfEndBin   = endKey;
        }
        renderMapData();
      });

    const brushGroup = svg.append("g")
      .attr("class", "brush")
      .call(brush)
      .call((g) => g.select(".overlay").attr("fill", "rgba(255,255,255,0)"))
      .call((g) => g.selectAll(".handle")
        .attr("fill", "#1d4ed8")
        .attr("stroke", "#fff")
        .attr("stroke-width", "1.5")
        .attr("rx", 3)
        .attr("cursor", "ew-resize")
      );

    // Date-mode: attach two <input type="date"> that drive the brush
    if (filterType === "date") {
      const inputDiv = document.createElement("div");
      inputDiv.style.cssText = `
        position:absolute; bottom:8px; right:12px;
        display:flex; gap:6px; align-items:center; pointer-events:all;
      `;
      overlayDiv.appendChild(inputDiv);

      startInput = document.createElement("input");
      startInput.type  = "date";
      startInput.value = items[0].key;

      endInput = document.createElement("input");
      endInput.type  = "date";
      endInput.value = items[items.length - 1].key;

      const inputStyle = `
        font-family:'DM Mono',monospace; font-size:10px;
        border:1.5px solid #e5e7eb; border-radius:8px;
        padding:3px 7px; color:#374151; background:#f9fafb; outline:none;
      `;
      startInput.style.cssText = inputStyle;
      endInput.style.cssText   = inputStyle;

      const sep = document.createElement("span");
      sep.textContent  = "→";
      sep.style.cssText = "font-family:'DM Mono',monospace;font-size:10px;color:#9ca3af;";

      inputDiv.appendChild(startInput);
      inputDiv.appendChild(sep);
      inputDiv.appendChild(endInput);

      function syncBrush() {
        const si = items.findIndex((d) => d.key >= startInput.value);
        const ei = items.findIndex((d) => d.key > endInput.value);
        if (si === -1 || ei === -1) return;
        brushGroup?.call(brush.move, [x(items[si].key), x(items[ei - 1].key) + x.bandwidth()]);
        globalStartDate = startInput.value;
        globalEndDate   = endInput.value;
        renderMapData();
      }
      startInput.addEventListener("change", syncBrush);
      endInput.addEventListener("change",   syncBrush);
    }
  }

  render();

  // Redraw on resize (e.g. when the right panel slides in/out)
  if (window._timelineObserver) window._timelineObserver.disconnect();
  window._timelineObserver = new ResizeObserver(() => render());
  window._timelineObserver.observe(overlayDiv);
}

/** Rebuild the timeline from the current `selectedEvents` + filter dropdown. */
function refreshTimeline() {
  const filterType = document.getElementById("timelineFilter").value;
  let timelineData, drawType = "date";
  if (filterType === "date") {
    timelineData = countEventsPerDay(selectedEvents);
    drawType = "date";
  } else if (filterType === "brake_perf") {
    timelineData = getBrakePerfBins(selectedEvents);
    drawType = "bins";
  }
  drawD3Timeline(timelineData, drawType);
}
