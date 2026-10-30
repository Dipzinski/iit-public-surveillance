// Campus map: one circle per place, sized by how many incidents match the current
// filters (area ∝ count, single hue), with the last week's incidents pulsing.
// Clicking a place filters every other view to it.

import { $, h } from '../util.js';
import { dataset, filtered, filters, selection, subscribe, toggle } from './state.js';
import { formatDay, today } from './data.js';
import { familyColor } from './colors.js';

const METERS_PER_MILE = 1609.34;
let map;
let placeLayer;
let pulseLayer;
let pickLayer;
let framed = false;
let lastPick = null;

export function createBaseMap(el, { zoom = true } = {}) {
  const data = dataset();
  const center = [data.site.center.lat, data.site.center.lon];
  const m = L.map(el, { scrollWheelZoom: false, zoomControl: zoom, attributionControl: zoom, zoomSnap: 0.25, maxZoom: 18 })
    .setView(center, 16);
  const esri = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas';
  L.tileLayer(`${esri}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 18, maxNativeZoom: 16, attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  }).addTo(m);
  L.tileLayer(`${esri}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 18, maxNativeZoom: 16 }).addTo(m);
  L.polygon(data.site.outline, {
    interactive: false, color: '#f5f7fa', weight: 1.5, dashArray: '5 5', fillColor: '#f5f7fa', fillOpacity: 0.05,
  }).addTo(m);
  return m;
}

function frame() {
  const data = dataset();
  // The campus plus a quarter mile around it, where almost every placed incident falls.
  const bounds = L.latLng(data.site.center.lat, data.site.center.lon).toBounds(1.1 * METERS_PER_MILE);
  map.fitBounds(bounds, { padding: [8, 8] });
}

function render() {
  const data = dataset();
  const rows = filtered('places');
  const inc = data.incidents;
  const t = today();

  // Count matching incidents per place, plus the most common family there.
  const stats = new Map();
  let unplaced = 0;
  for (const i of rows) {
    const g = data.group[i];
    if (!data.groups[g].mappable) { unplaced++; continue; }
    if (!stats.has(g)) stats.set(g, { count: 0, fams: new Map(), recent: 0, latest: 0 });
    const s = stats.get(g);
    s.count++;
    s.fams.set(inc.family[i], (s.fams.get(inc.family[i]) || 0) + 1);
    if (data.day[i] >= t - 6) s.recent++;
    s.latest = Math.max(s.latest, data.day[i]);
  }
  const max = Math.max(1, ...[...stats.values()].map((s) => s.count));

  placeLayer.clearLayers();
  pulseLayer.clearLayers();
  // Draw big circles first so small ones stay clickable on top.
  for (const [g, s] of [...stats].sort((a, b) => b[1].count - a[1].count)) {
    const place = data.groups[g];
    const on = filters.places.has(g);
    const radius = 4 + 22 * Math.sqrt(s.count / max);
    const [topFam] = [...s.fams].sort((a, b) => b[1] - a[1])[0];
    L.circleMarker([place.lat, place.lon], {
      radius,
      weight: on ? 3 : 1.5,
      color: on ? '#f5f7fa' : '#0b0e13',
      fillColor: '#3987e5',
      fillOpacity: filters.places.size && !on ? 0.25 : 0.6,
    })
      .bindTooltip(placeTip(place, s, data, topFam), { direction: 'top', offset: [0, -radius], className: 'map-tip' })
      .on('click', () => toggle('places', g))
      .addTo(placeLayer);
    if (s.recent) {
      L.marker([place.lat, place.lon], {
        icon: L.divIcon({ className: 'pulse-icon', html: '<span class="pulse"></span>', iconSize: [16, 16] }),
        interactive: false,
        keyboard: false,
      }).addTo(pulseLayer);
    }
  }

  renderPick();
  $('#map-note').textContent = `${(rows.length - unplaced).toLocaleString()} incidents at ${stats.size} places · `
    + `${unplaced.toLocaleString()} without a precise location · pulsing = last 7 days`;
  if (!framed) { frame(); framed = true; }
}

function placeTip(place, s, data, topFam) {
  return h('div', { class: 'tip' },
    h('strong', {}, place.name),
    place.address && h('div', { class: 'tip-row muted' }, place.address),
    h('div', { class: 'tip-row' }, `${s.count.toLocaleString()} ${s.count === 1 ? 'incident' : 'incidents'} · latest ${formatDay(s.latest)}`),
    h('div', { class: 'tip-row' }, h('i', { class: 'swatch', style: `background:${familyColor(data.families[topFam])}` }),
      `Mostly ${data.families[topFam].label.toLowerCase()}`),
    h('div', { class: 'tip-hint' }, filters.places.has(data.groups.indexOf(place)) ? 'Click to clear' : 'Click to filter'));
}

// The incident open in the case file gets a ring on the map.
function renderPick() {
  pickLayer.clearLayers();
  const data = dataset();
  const i = selection.index;
  if (i == null) return;
  const place = data.groups[data.group[i]];
  if (!place.mappable) return;
  L.circleMarker([place.lat, place.lon], { radius: 13, weight: 3, color: '#f5f7fa', fill: false, interactive: false }).addTo(pickLayer);
  if (i !== lastPick) map.panTo([place.lat, place.lon], { animate: true });
  lastPick = i;
}

export function initCampusMap() {
  if (!window.L) {
    $('#campus-map').replaceChildren(h('div', { class: 'map-error' }, 'Map library could not load.'));
    return;
  }
  map = createBaseMap($('#campus-map'));
  placeLayer = L.layerGroup().addTo(map);
  pulseLayer = L.layerGroup().addTo(map);
  pickLayer = L.layerGroup().addTo(map);
  new ResizeObserver(() => map.invalidateSize()).observe($('#campus-map'));
  subscribe(render);
  render();
}
