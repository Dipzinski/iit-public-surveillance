// The watch map: campus outline, watch-radius ring, landmarks, and a layer switcher
// that the camera and panel modules add their own overlays to.

import { h } from './util.js';

const METERS_PER_MILE = 1609.34;

// Validated categorical slots (dark steps). Only three are used on the map because
// scattered points must stay distinguishable for color-blind viewers.
export const SERIES = {
  crime: '#d95926', // orange
  crash: '#199e70', // aqua
};

export function createMap(el, site) {
  if (!window.L) {
    el.replaceChildren(h('div', { class: 'map-error' }, 'Map library could not load. Everything else still works.'));
    return null;
  }
  const center = [site.center.lat, site.center.lon];
  const map = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.25, maxZoom: 17 }).setView(center, 15);

  // Esri's dark canvas basemap: free to use with attribution, no API key.
  const esri = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas';
  L.tileLayer(`${esri}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 17,
    maxNativeZoom: 16,
    attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  }).addTo(map);
  L.tileLayer(`${esri}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 17, maxNativeZoom: 16 }).addTo(map);

  L.polygon(site.campusOutline, {
    interactive: false,
    color: '#f5f7fa',
    weight: 1.5,
    dashArray: '5 5',
    fillColor: '#f5f7fa',
    fillOpacity: 0.07,
  }).addTo(map);
  L.circle(center, {
    interactive: false,
    radius: site.watchRadiusMi * METERS_PER_MILE,
    color: '#f5f7fa',
    weight: 1,
    opacity: 0.4,
    dashArray: '2 6',
    fill: false,
  }).addTo(map);

  label(map, site.center, site.name, 'right');
  for (const mark of site.landmarks || []) label(map, mark, mark.name, mark.label || 'right');

  const control = L.control.layers(null, null, { collapsed: window.innerWidth < 900, position: 'topright' }).addTo(map);

  // Frame a bit more than the watch radius so the nearest expressway cameras show too.
  const frame = L.latLng(center).toBounds(2.5 * METERS_PER_MILE);
  const fit = () => map.fitBounds(frame, { padding: [6, 6] });
  fit();
  new ResizeObserver(() => { map.invalidateSize(); fit(); }).observe(el);

  return {
    map,
    // Add a toggleable layer. The name may contain a legend swatch.
    overlay(name, layer, { visible = true } = {}) {
      if (visible) layer.addTo(map);
      control.addOverlay(layer, name);
      return layer;
    },
    focus(lat, lon) {
      map.flyTo([lat, lon], 17, { duration: 0.5 });
    },
  };
}

function label(map, at, text, side) {
  L.marker([at.lat, at.lon], {
    icon: L.divIcon({ className: 'site-icon', html: `<span class="site-marker ${side}"><i></i><b></b></span>`, iconSize: null }),
    interactive: false,
    keyboard: false,
    zIndexOffset: 500, // camera pins (1000) stay on top
  }).addTo(map).getElement().querySelector('b').textContent = text;
}

// A point with a 2px ring in the map's surface color, so overlapping points stay separate.
export function dot(lat, lon, color, radius = 5) {
  return L.circleMarker([lat, lon], { radius, weight: 2, color: '#11161d', fillColor: color, fillOpacity: 0.95 });
}

// Live traffic incidents use the status colors with an icon, never color alone.
export function incidentMarker(lat, lon, critical) {
  return L.marker([lat, lon], {
    icon: L.divIcon({
      className: 'incident-icon',
      html: `<span class="incident ${critical ? 'critical' : 'warning'}">!</span>`,
      iconSize: [20, 20],
    }),
    zIndexOffset: 800,
  });
}

// Legend swatch used inside layer names.
export const swatch = (color, shape = 'dot') => `<i class="swatch ${shape}" style="background:${color}"></i>`;

// Popup content built as DOM so feed text is never parsed as HTML.
export function popup(title, ...lines) {
  return h('div', { class: 'popup' }, h('strong', {}, title), lines.filter(Boolean).map((line) => h('div', {}, line)));
}
