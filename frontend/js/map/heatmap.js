let heatmapEnabled = false;
let heatLayers = [];

const HEAT_CONFIGS = [
  {
    key: 'poor',
    filter: (a) => a === 'Poor adhesion',
    weight: 0.4,
    gradient: {
      // yellow -> amber -> orange
      // NEVER goes red or black
      0.0: 'rgba(255,241,118,0)',
      0.3: 'rgba(255,241,118,0.65)',
      0.6: 'rgba(255,213,79,0.8)',
      0.8: 'rgba(255,183,77,0.9)',
      1.0: 'rgba(255,152,0,1)',
    },
  },

  {
    key: 'verypoor',
    filter: (a) => a === 'Very poor adhesion',
    weight: 0.7,
    gradient: {
      // orange -> deep orange -> red
      // NEVER goes black
      0.0: 'rgba(255,152,0,0)',
      0.3: 'rgba(255,152,0,0.7)',
      0.6: 'rgba(255,112,67,0.85)',
      0.8: 'rgba(244,67,54,0.92)',
      1.0: 'rgb(223, 40, 40)',
    },
  },

  {
    key: 'extreme',
    filter: (a) => a === 'Extreme adhesion loss',
    weight: 1.0,
    gradient: {
      // dark red -> maroon -> black
      0.0: 'rgba(183,28,28,0)',
      0.35: 'rgba(183,28,28,0.8)',
      0.65: 'rgba(120,0,0,0.92)',
      0.85: 'rgba(50,0,0,0.97)',
      1.0: 'rgba(0,0,0,1)',
    },
  },
];

// Fixed render options — no zoom-based recalculation
const HEAT_OPTIONS = {
  radius: 35,
  blur: 35,
  minOpacity: 0.75,
  maxZoom: 18,
};

function removeHeatLayers() {
  for (const layer of heatLayers) {
    if (map.hasLayer(layer)) map.removeLayer(layer);
  }
  heatLayers = [];
}

function buildHeatmap(filteredEvents) {
  removeHeatLayers();

  if (!filteredEvents?.length) return;

  const validEvents = filteredEvents.filter(ev => {
    const lat = Number(ev.latitude);
    const lon = Number(ev.longitude);
    const a = ev.Adhesion_Index_Murs_Min;
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      typeof a === 'string' &&
      a !== '--'
    );
  });

  if (!validEvents.length) return;

  // Render poor first, extreme last so worse always sits on top
  for (const cfg of HEAT_CONFIGS) {
    const points = validEvents
      .filter(ev => cfg.filter(ev.Adhesion_Index_Murs_Min))
      .map(ev => [Number(ev.latitude), Number(ev.longitude), cfg.weight]);

    if (points.length === 0) continue;

    const layer = L.heatLayer(points, {
      ...HEAT_OPTIONS,
      max: cfg.weight,
      gradient: cfg.gradient,
    });

    if (heatmapEnabled) layer.addTo(map);

    heatLayers.push(layer);
  }
}

function setHeatmapEnabled(enabled) {
  heatmapEnabled = enabled;

  if (enabled) {
    if (map.hasLayer(markers)) map.removeLayer(markers);
    buildHeatmap(selectedEvents);
  } else {
    removeHeatLayers();
    if (!map.hasLayer(markers)) map.addLayer(markers);
  }
}

function initHeatmapToggle() {
  if (document.getElementById('heatmapToggle')) return;

  const toggle = document.createElement('label');
  toggle.className = 'heatmap-toggle';
  toggle.innerHTML = `
    <input type="checkbox" id="heatmapToggle" />
    <span>Slide Heatmap</span>
  `;

  const container =
    document.querySelector('.map-controls') ??
    document.getElementById('map');

  if (!container) return;

  container.appendChild(toggle);

  document
    .getElementById('heatmapToggle')
    .addEventListener('change', e => {
      setHeatmapEnabled(e.target.checked);
    });
}

initHeatmapToggle();