// The opening view: a full-screen vector map of Chicago (every street, building and transit
// line from OpenStreetMap, with 3D buildings), carrying the IIT reports, citywide activity
// and cameras. Clicking a place filters the dashboard; opening a report flies the map to it.
// Replay animates the chosen dates: each report appears on its building, then fades.

import { $, h, timeAgo, formatDateTime } from '../util.js';
import { dataset, filtered, filters, selection, subscribe, toggle } from './state.js';
import { formatDay, today } from './data.js';
import { FAMILY_COLORS, familyColor } from './colors.js';

const LIBERTY = 'https://tiles.openfreemap.org/styles/liberty';
const IMAGERY = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const CHICAGO = [[-87.94, 41.64], [-87.52, 42.03]];
const STATUS = { critical: '#d03b3b', warning: '#fab219' };
const EMPTY = { type: 'FeatureCollection', features: [] };

const LAYER_CHIPS = [
  ['places', 'IIT reports', '#5cc8ff'],
  ['police', 'Police reports', FAMILY_COLORS.person],
  ['crashes', 'Injury crashes', FAMILY_COLORS.traffic],
  ['traffic', 'Live traffic', STATUS.warning],
  ['cameras', 'Cameras', '#e8edf4'],
];
// Which map layers each chip switches.
const CHIP_LAYERS = {
  places: ['places-circles'],
  police: ['police-heat', 'police-dots'],
  crashes: ['crashes-dots'],
  traffic: ['traffic-dots'],
  cameras: ['camera-dots'],
};

let map;
let styles;
let styleName = 'detail';
let center;
let framed = false;
let lastPick = null;
let replay = null;
let pulses = [];
let onCamera = () => {};
let mini;
let miniEl;
let miniDot;
let miniMarker;

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const padding = () => (window.innerWidth < 900
  ? { top: 70, bottom: 20, left: 20, right: 20 }
  : { top: 70, bottom: 220, left: 24, right: 396 });

const sources = {
  boundary: EMPTY, campus: EMPTY, places: EMPTY, picked: EMPTY, replay: EMPTY,
  police: EMPTY, crashes: EMPTY, traffic: EMPTY, cameras: EMPTY,
};
const shown = { places: true, police: true, crashes: true, traffic: true, cameras: true };

const point = (lon, lat, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });
const collection = (features) => ({ type: 'FeatureCollection', features });

function setData(name, data) {
  sources[name] = data;
  map?.getSource(name)?.setData(data);
}

// ---------- base map styles ----------

function hsl(h, s, l, opacity) {
  return d3.hsl(Number.isNaN(h) ? 215 : h, Number.isNaN(s) ? 0 : s, l, opacity).formatRgb();
}

// Apply `fn` to every color inside a paint value (plain colors, zoom stops and expressions).
function retone(value, fn) {
  if (typeof value === 'string') {
    const color = d3.color(value);
    return color ? fn(d3.hsl(color)) : value;
  }
  if (Array.isArray(value)) return value.map((v) => retone(v, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, retone(v, fn)]));
  return value;
}

// The full-detail OpenStreetMap style, re-toned for a dark interface: land goes dark,
// roads stay lighter than the land, and labels flip to light text.
function darkStyle(base) {
  const style = structuredClone(base);
  for (const layer of style.layers) {
    const paint = layer.paint || (layer.paint = {});
    const water = /water/.test(layer.id);
    if (layer.type === 'background') paint['background-color'] = '#10151d';
    if (layer.type === 'fill') {
      const tone = (c) => (water ? hsl(212, 0.38, 0.125, c.opacity) : hsl(c.h, Math.min(c.s, 0.5) * 0.55, 0.085 + (1 - c.l) * 0.2, c.opacity));
      for (const key of ['fill-color', 'fill-outline-color']) if (paint[key]) paint[key] = retone(paint[key], tone);
    }
    if (layer.type === 'line' && paint['line-color']) {
      paint['line-color'] = retone(paint['line-color'], (c) => (water ? hsl(212, 0.35, 0.2, c.opacity) : hsl(c.h, c.s * 0.6, 0.16 + c.l * 0.26, c.opacity)));
    }
    if (layer.type === 'fill-extrusion') {
      paint['fill-extrusion-color'] = ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, '#202835', 60, '#2b3648', 220, '#3f4e68'];
    }
    if (layer.type === 'symbol' && paint['text-color']) {
      paint['text-color'] = retone(paint['text-color'], (c) => hsl(c.h, Math.min(c.s, 0.35), Math.max(0.66, 0.93 - c.l * 0.3), c.opacity));
      paint['text-halo-color'] = 'rgba(9, 12, 17, 0.92)';
    }
    if (layer.type === 'raster') paint['raster-brightness-max'] = 0.35;
  }
  return style;
}

function satelliteStyle(base) {
  const style = structuredClone(base);
  style.sources.imagery = {
    type: 'raster', tiles: [IMAGERY], tileSize: 256, maxzoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  };
  style.layers = [
    { id: 'imagery', type: 'raster', source: 'imagery' },
    ...style.layers.filter((l) => l.type === 'symbol').map((l) => ({
      ...l, paint: { ...l.paint, 'text-color': '#ffffff', 'text-halo-color': 'rgba(0, 0, 0, 0.85)', 'text-halo-width': 1.4 },
    })),
  ];
  return style;
}

// ---------- overlays (re-added whenever the base style changes) ----------

function addOverlays() {
  for (const [name, data] of Object.entries(sources)) map.addSource(name, { type: 'geojson', data });
  const add = (layer) => map.addLayer(layer);
  const zoomed = (a, b) => ['interpolate', ['linear'], ['zoom'], 10, a, 16, b];

  add({ id: 'city-line', type: 'line', source: 'boundary', paint: { 'line-color': '#5cc8ff', 'line-opacity': 0.55, 'line-width': 1.5 } });
  add({ id: 'campus-fill', type: 'fill', source: 'campus', paint: { 'fill-color': '#f5f7fa', 'fill-opacity': 0.06 } });
  add({ id: 'campus-line', type: 'line', source: 'campus', paint: { 'line-color': '#f5f7fa', 'line-width': 1.5, 'line-dasharray': [3, 3] } });
  add({
    id: 'police-heat', type: 'heatmap', source: 'police', maxzoom: 14.5,
    paint: {
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 9, 5, 14, 22],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 9, 0.12, 14, 0.9],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(24,79,149,0)', 0.25, 'rgba(37,106,191,0.55)', 0.6, 'rgba(57,135,229,0.75)', 1, '#6da7ec'],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 14.5, 0],
    },
  });
  add({
    id: 'police-dots', type: 'circle', source: 'police', minzoom: 12,
    paint: { 'circle-radius': zoomed(3, 7), 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b0e13', 'circle-stroke-width': 1.5, 'circle-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 13, 0.95] },
  });
  add({ id: 'crashes-dots', type: 'circle', source: 'crashes', minzoom: 10.5, paint: { 'circle-radius': zoomed(3.5, 8), 'circle-color': FAMILY_COLORS.traffic, 'circle-stroke-color': '#0b0e13', 'circle-stroke-width': 1.5 } });
  add({ id: 'traffic-dots', type: 'circle', source: 'traffic', paint: { 'circle-radius': zoomed(4.5, 10), 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0b0e13', 'circle-stroke-width': 2 } });
  add({ id: 'camera-dots', type: 'circle', source: 'cameras', minzoom: 10.5, paint: { 'circle-radius': zoomed(2.5, 6), 'circle-color': '#e8edf4', 'circle-stroke-color': '#0b0e13', 'circle-stroke-width': 1.5 } });
  add({
    id: 'places-circles', type: 'circle', source: 'places',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, ['+', 2, ['*', 5, ['sqrt', ['get', 'share']]]], 16, ['+', 5, ['*', 30, ['sqrt', ['get', 'share']]]]],
      'circle-color': '#5cc8ff',
      'circle-opacity': ['case', ['==', ['get', 'dim'], 1], 0.2, 0.62],
      'circle-stroke-color': ['case', ['==', ['get', 'on'], 1], '#f5f7fa', '#0b0e13'],
      'circle-stroke-width': ['case', ['==', ['get', 'on'], 1], 3, 1.5],
    },
  });
  add({ id: 'picked-ring', type: 'circle', source: 'picked', paint: { 'circle-radius': 16, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#f5f7fa', 'circle-stroke-width': 3 } });
  add({ id: 'replay-dots', type: 'circle', source: 'replay', paint: { 'circle-radius': ['get', 'r'], 'circle-color': ['get', 'c'], 'circle-opacity': ['get', 'o'], 'circle-stroke-color': '#f5f7fa', 'circle-stroke-width': ['get', 's'] } });
  applyVisibility();
}

function applyVisibility() {
  for (const [chip, layers] of Object.entries(CHIP_LAYERS)) {
    for (const id of layers) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', shown[chip] ? 'visible' : 'none');
  }
}

// ---------- popups ----------

const tip = (title, ...lines) => h('div', { class: 'tip' }, h('strong', {}, title), lines.filter(Boolean).map((l) => h('div', { class: 'tip-row' }, l)));

const TIPS = {
  'police-dots': (p) => tip(p.type, p.detail, [p.block, p.area].filter(Boolean).join(' · '), `${formatDateTime(p.when)} · ${timeAgo(p.when)}`, p.arrest ? 'Arrest made' : ''),
  'crashes-dots': (p) => tip(`Injury crash · ${p.type}`, p.address, `${p.injuries} injured${p.fatal ? `, ${p.fatal} killed` : ''}${p.hitAndRun ? ' · hit-and-run' : ''}`, `${formatDateTime(p.when)} · ${timeAgo(p.when)}`),
  'traffic-dots': (p) => tip(`${p.kind}${p.road ? ` · ${p.road}` : ''}`, p.description === 'Closed.' ? '' : p.description, p.start ? `Since ${formatDateTime(p.start)}` : ''),
  'camera-dots': (p) => tip(p.name, p.roadName, 'Click to view'),
  'places-circles': (p) => tip(p.name, p.address, `${p.count.toLocaleString()} ${p.count === 1 ? 'report' : 'reports'} · latest ${p.latest}`, `Mostly ${p.top.toLowerCase()}`, filters.places.has(p.g) ? 'Click to clear' : 'Click to filter'),
};

function wirePopups() {
  const hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: 'map-pop', maxWidth: '280px' });
  for (const [layer, content] of Object.entries(TIPS)) {
    map.on('mousemove', layer, (e) => {
      map.getCanvas().style.cursor = 'pointer';
      hover.setLngLat(e.features[0].geometry.coordinates).setDOMContent(content(e.features[0].properties)).addTo(map);
    });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; hover.remove(); });
  }
  map.on('click', 'places-circles', (e) => toggle('places', e.features[0].properties.g));
  map.on('click', 'camera-dots', (e) => onCamera(e.features[0].properties.id));
  for (const layer of ['police-dots', 'crashes-dots', 'traffic-dots']) {
    map.on('click', layer, (e) => callout(e.features[0].geometry.coordinates, TIPS[layer](e.features[0].properties)));
  }
}

let pinned;
function callout(lngLat, content) {
  pinned?.remove();
  pinned = new maplibregl.Popup({ offset: 14, className: 'map-pop', maxWidth: '300px' }).setLngLat(lngLat).setDOMContent(content).addTo(map);
}

// ---------- moving the camera ----------

function go(options) {
  if (reduceMotion()) map.jumpTo(options);
  else map.flyTo({ duration: 2400, ...options, padding: padding() });
}

export function viewChicago() {
  map?.fitBounds(CHICAGO, { padding: padding(), pitch: 0, bearing: 0, duration: reduceMotion() ? 0 : 2200 });
}

export function viewCampus() {
  if (map) go({ center: [center.lon, center.lat], zoom: 15.6, pitch: 58, bearing: -18 });
}

// Fly to a point from the activity feed and pin its details there.
export function showOnMap(lat, lon, content) {
  if (!map) return;
  go({ center: [lon, lat], zoom: 16.4, pitch: 55 });
  if (content) callout([lon, lat], content);
}

// ---------- data from other modules ----------

export function setPoliceLayer(items) {
  setData('police', collection(items.map((r) => point(r.lon, r.lat, { ...r, color: FAMILY_COLORS[r.family] || FAMILY_COLORS.other }))));
}
export function setCrashLayer(items) {
  setData('crashes', collection(items.map((c) => point(c.lon, c.lat, c))));
}
export function setTrafficLayer(items) {
  setData('traffic', collection(items.map((i) => point(i.lon, i.lat, { ...i, color: i.critical ? STATUS.critical : STATUS.warning }))));
}
export function setCameraLayer(cameras, open) {
  onCamera = open;
  setData('cameras', collection(cameras.map((c) => point(c.lon, c.lat, { id: c.id, name: c.name, roadName: c.roadName }))));
}

// A small map for the case file. One instance is reused and moved into each new report.
export function miniMapElement(lat, lon, color) {
  if (!styles) return h('div', { class: 'case-map', hidden: true });
  if (!mini) {
    miniEl = h('div', { class: 'case-map' });
    miniDot = h('span', { class: 'mini-dot' });
    mini = new maplibregl.Map({ container: miniEl, style: styles.detail, center: [lon, lat], zoom: 17, pitch: 45, interactive: false });
    miniMarker = new maplibregl.Marker({ element: miniDot }).setLngLat([lon, lat]).addTo(mini);
  }
  miniDot.style.background = color;
  mini.jumpTo({ center: [lon, lat] });
  miniMarker.setLngLat([lon, lat]);
  setTimeout(() => mini.resize(), 0);
  return miniEl;
}

// ---------- IIT reports ----------

function render() {
  if (replay) stopReplay(false); // any filter change ends a replay
  const data = dataset();
  const rows = filtered('places');
  const inc = data.incidents;
  const t = today();
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

  pulses.forEach((m) => m.remove());
  pulses = [];
  const features = [...stats].sort((a, b) => b[1].count - a[1].count).map(([g, s]) => {
    const place = data.groups[g];
    const [topFam] = [...s.fams].sort((a, b) => b[1] - a[1])[0];
    if (s.recent && map) pulses.push(new maplibregl.Marker({ element: h('span', { class: 'pulse' }) }).setLngLat([place.lon, place.lat]).addTo(map));
    const on = filters.places.has(g);
    return point(place.lon, place.lat, {
      g, name: place.name, address: place.address, count: s.count, share: s.count / max,
      latest: formatDay(s.latest), top: data.families[topFam].label, on: on ? 1 : 0, dim: filters.places.size && !on ? 1 : 0,
    });
  });
  setData('places', collection(features));
  $('#map-note').textContent = `${(rows.length - unplaced).toLocaleString()} reports at ${stats.size} places · ${unplaced.toLocaleString()} without a precise location`;
  renderPick();
}

function renderPick() {
  const data = dataset();
  const i = selection.index;
  const place = i == null ? null : data.groups[data.group[i]];
  setData('picked', place?.mappable ? collection([point(place.lon, place.lat, {})]) : EMPTY);
  if (place?.mappable && i !== lastPick && framed) go({ center: [place.lon, place.lat], zoom: 17, pitch: 60 });
  lastPick = i;
}

// ---------- replay ----------

function startReplay() {
  const data = dataset();
  const [from, to] = filters.range;
  const span = to - from + 1;
  const step = span <= 60 ? 1 : span <= 400 ? 3 : span <= 1500 ? 7 : 30; // days per frame
  const fade = step * 6;
  const rows = filtered().filter((i) => data.groups[data.group[i]].mappable).reverse(); // oldest first
  let cursor = from - 1;
  viewCampus();
  setData('places', EMPTY);
  pulses.forEach((m) => m.remove());
  pulses = [];
  $('#replay-btn').textContent = '■ Stop';
  $('#replay-btn').setAttribute('aria-pressed', 'true');
  $('#replay-label').hidden = false;

  replay = setInterval(() => {
    cursor += step;
    if (cursor > to + fade) { stopReplay(); return; }
    const features = [];
    let count = 0;
    for (const i of rows) {
      const d = data.day[i];
      if (d > cursor) break;
      count++;
      if (d <= cursor - fade) continue;
      const age = (cursor - d) / fade;
      const place = data.groups[data.group[i]];
      features.push(point(place.lon, place.lat, {
        r: 4 + 10 * (1 - age), c: familyColor(data.families[data.incidents.family[i]]), o: 0.15 + 0.8 * (1 - age), s: age < 0.2 ? 2 : 0,
      }));
    }
    setData('replay', collection(features));
    $('#replay-label').textContent = `${formatDay(Math.min(cursor, to))} · ${count.toLocaleString()} of ${rows.length.toLocaleString()} reports`;
  }, 110);
}

function stopReplay(redraw = true) {
  clearInterval(replay);
  replay = null;
  setData('replay', EMPTY);
  $('#replay-btn').textContent = '▶ Replay';
  $('#replay-btn').setAttribute('aria-pressed', 'false');
  $('#replay-label').hidden = true;
  if (redraw) render();
}

// ---------- toolbar ----------

function renderTools() {
  const seg = (label, on, onclick) => h('button', { type: 'button', class: `seg${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick }, label);
  $('#map-styles').replaceChildren(...[['detail', 'Detailed'], ['streets', 'Streets'], ['satellite', 'Satellite']].map(([key, label]) =>
    seg(label, styleName === key, () => {
      if (styleName === key) return;
      styleName = key;
      map.setStyle(styles[key], { diff: false });
      renderTools();
    })));
  $('#map-layers').replaceChildren(...LAYER_CHIPS.map(([key, label, color]) => h('button', {
    type: 'button', class: `layer-chip${shown[key] ? ' on' : ''}`, 'aria-pressed': String(shown[key]),
    onclick: () => { shown[key] = !shown[key]; applyVisibility(); renderTools(); },
  }, h('i', { class: 'swatch', style: `background:${color}` }), label)));
}

export async function initCityMap() {
  const el = $('#city-map');
  const data = dataset();
  center = data.site.center;
  if (!window.maplibregl) {
    el.replaceChildren(h('div', { class: 'map-error' }, 'The map library could not load.'));
    return;
  }
  try {
    const base = await (await fetch(LIBERTY)).json();
    styles = { detail: darkStyle(base), streets: base, satellite: satelliteStyle(base) };
  } catch (err) {
    el.replaceChildren(h('div', { class: 'map-error' }, `The map couldn't load: ${err.message}`));
    return;
  }

  setData('campus', { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...data.site.outline, data.site.outline[0]].map(([lat, lon]) => [lon, lat])] }, properties: {} });
  fetch('api/boundary').then((r) => r.json()).then((b) => setData('boundary', { type: 'Feature', geometry: { type: b.type, coordinates: b.coordinates }, properties: {} })).catch(() => {});

  map = new maplibregl.Map({
    container: el,
    style: styles.detail,
    bounds: CHICAGO,
    fitBoundsOptions: { padding: padding() },
    maxZoom: 20,
    maxPitch: 75,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
  map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
  map.on('style.load', addOverlays);
  map.once('load', () => { framed = true; });
  wirePopups();

  const beacon = h('button', { type: 'button', class: 'beacon', onclick: viewCampus, 'aria-label': 'Zoom to IIT Mies Campus' }, h('i', {}), h('b', {}, data.site.name));
  new maplibregl.Marker({ element: beacon }).setLngLat([center.lon, center.lat]).addTo(map);
  map.on('zoom', () => beacon.classList.toggle('hide', map.getZoom() > 14.2));

  renderTools();
  $('#view-chicago').addEventListener('click', viewChicago);
  $('#view-campus').addEventListener('click', viewCampus);
  $('#replay-btn').addEventListener('click', () => (replay ? stopReplay() : startReplay()));
  new ResizeObserver(() => map.resize()).observe(el);
  subscribe(render);
  render();
}
