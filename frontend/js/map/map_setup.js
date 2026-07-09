/**
 * Leaflet map bootstrap.
 *
 * Creates the main `map`, attaches tile layers, marker cluster group and the
 * custom panes used by the route/arrow/brake renderers. All of these are
 * globals consumed by the render modules.
 */

// ───────────── Map + tile layers ─────────────
const map = L.map("map", {
  zoomControl: false,          // we add the control explicitly top-right below
}).setView([54.0, -2.0], 6);

const transport = L.tileLayer(
  "https://tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey=1b1fd70633e84f6ea40a22387fe5350c",
  { maxZoom: 22, attribution: "&copy; Thunderforest Transport" }
);

const topo = L.tileLayer(
  "https://tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=1b1fd70633e84f6ea40a22387fe5350c",
  { maxZoom: 22, attribution: "&copy; Thunderforest Outdoors" }
);

const satellite = L.tileLayer(
  "https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
  { subdomains: ["mt0", "mt1", "mt2", "mt3"], maxZoom: 22, attribution: "&copy; Google Satellite" }
);

transport.addTo(map);

L.control.zoom({ position: "topright" }).addTo(map);
L.control
  .layers(
    { Transport: transport, Topographic: topo, Satellite: satellite },
    null,
    { position: "topright" }
  )
  .addTo(map);

// ───────────── Marker cluster group ─────────────
const markers = L.markerClusterGroup({
  iconCreateFunction: (cluster) =>
    L.divIcon({
      html: cluster.getChildCount(),
      className: "custom-cluster",
      iconSize: [25, 25],
    }),
  maxClusterRadius: 50,
  disableClusteringAtZoom: 16,
});
map.addLayer(markers);

const redIcon  = L.divIcon({ className: "custom-marker red",  iconSize: [14, 14] });
const blueIcon = L.divIcon({ className: "custom-marker blue", iconSize: [14, 14] });

// ───────────── Custom Z-ordered panes ─────────────
/**
 * Create the three panes used by the renderer. Idempotent — safe to call on
 * every render without duplicating panes.
 */
function ensurePanes(mapInstance) {
  if (mapInstance.__panesInit) return;

  mapInstance.createPane("routesPane");
  mapInstance.getPane("routesPane").style.zIndex = MAPCFG.z.routes;

  mapInstance.createPane("arrowsPane");
  mapInstance.getPane("arrowsPane").style.zIndex = MAPCFG.z.arrows;

  mapInstance.createPane("selectedPane");
  mapInstance.getPane("selectedPane").style.zIndex = MAPCFG.z.selected;

  mapInstance.__panesInit = true;
}
