// Camera tiles, the full-screen viewer, and the camera layer on the map.

import { $, h, getJSON, milesBetween, formatMiles } from './util.js';
import { dot, swatch } from './map.js';

const REFRESH_MS = 30_000;          // how often each tile asks for a new frame
const FEED_REFRESH_MS = 5 * 60_000; // how often the camera list itself is reloaded
const STAGGER_MS = 150;             // spread tile requests out a little
const LIVE_MAX_MIN = 10;
const DELAYED_MAX_MIN = 30;
const STORAGE_KEY = 'iitwatch.cameras.v3'; // v3: Mies campus only

const state = {
  site: null,
  mapView: null,
  cameras: new Map(),
  order: [],          // camera ids in the camera area, north to south
  selection: [],      // camera ids on the grid, one per slot
  tiles: [],
  refreshing: 0,
  nextRefreshAt: 0,
  nextFeedAt: 0,
  feedStatus: { kind: 'ok', label: 'Connecting…' },
  layer: null,
  pins: [],
  viewer: { id: null, list: [], url: null, capturedAt: null, error: false, loading: null },
};

export const cameraState = state;

// ---------- helpers ----------

function storageGet() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
}
function storageSet(value) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* private mode */ }
}
function storageClear() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
}

const fromCampus = (cam) => milesBetween(cam, state.site.center);
const distanceLine = (cam) => `${formatMiles(fromCampus(cam))} from campus`;

function roadLine(cam) {
  const parts = [cam.roadName, cam.road !== cam.roadName ? cam.road : '', cam.direction];
  return parts.filter(Boolean).join(' · ');
}

function formatAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

function capturedTime(capturedAt, cam) {
  if (capturedAt) return new Date(capturedAt).getTime();
  // No Last-Modified from the source: fall back to the feed's own age estimate.
  return Date.now() - (cam.ageMinutes || 0) * 60_000;
}

function status(captured, error) {
  if (error) return { cls: 'offline', label: 'Offline' };
  const minutes = (Date.now() - captured) / 60_000;
  if (minutes <= LIVE_MAX_MIN) return { cls: 'live', label: 'Live' };
  if (minutes <= DELAYED_MAX_MIN) return { cls: 'delayed', label: 'Delayed' };
  return { cls: 'offline', label: 'Stale' };
}

async function fetchSnapshot(id) {
  const res = await fetch(`/api/snapshot/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  const capturedAt = res.headers.get('X-Captured-At') || '';
  const blob = await res.blob();
  return { capturedAt, blob };
}

// Decode off-screen first so the visible image swaps without a flash. Background tabs
// can hold decode() until they're shown, so don't wait on it for more than a few seconds.
async function decode(blob) {
  const url = URL.createObjectURL(blob);
  const probe = new Image();
  probe.src = url;
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
  try { await Promise.race([probe.decode(), timeout]); } catch { /* still try to show it */ }
  return url;
}

// Fetch a fresh frame for `holder` (a tile or the viewer) and show it in `img`.
// A result is dropped if the holder switched cameras while it was in flight.
async function loadFrame(holder, id, img) {
  if (holder.loading === id) return false;
  holder.loading = id;
  let snap = null;
  try {
    snap = await fetchSnapshot(id);
    if (snap.capturedAt !== holder.capturedAt || !holder.url) snap.url = await decode(snap.blob);
  } catch {
    snap = null;
  }
  if (holder.loading === id) holder.loading = null;
  if (holder.id !== id) {
    if (snap?.url) URL.revokeObjectURL(snap.url);
    return false;
  }
  holder.error = !snap;
  if (snap?.url) {
    if (holder.url) URL.revokeObjectURL(holder.url);
    img.src = holder.url = snap.url;
    holder.capturedAt = snap.capturedAt;
  }
  return true;
}

// ---------- camera list ----------

async function loadCameras() {
  state.nextFeedAt = Date.now() + FEED_REFRESH_MS;
  try {
    const data = await getJSON('/api/cameras');
    const inArea = data.cameras.filter((c) => milesBetween(c, state.site.center) <= state.site.cameraAreaMi);
    state.cameras = new Map(inArea.map((c) => [c.id, c]));
    state.order = inArea.map((c) => c.id);
    state.feedStatus = data.stale ? { kind: 'warn', label: 'Feed delayed' } : { kind: 'ok', label: 'Live' };
    return true;
  } catch (err) {
    console.error(err);
    state.feedStatus = { kind: 'error', label: 'Feed offline' };
    state.nextFeedAt = Date.now() + 15_000;
    return false;
  }
}

// Saved picks first, then the defaults, then whichever cameras are closest to campus.
function chooseSelection() {
  const slots = state.site.slots;
  const saved = storageGet();
  const preferred = Array.isArray(saved) && saved.length ? saved : state.site.defaultCameras;
  const ids = [];
  for (const id of [...preferred, ...state.site.defaultCameras]) {
    if (ids.length < slots && state.cameras.has(id) && !ids.includes(id)) ids.push(id);
  }
  const pool = [...state.cameras.values()]
    .filter((c) => !c.tooOld && !ids.includes(c.id))
    .sort((a, b) => fromCampus(a) - fromCampus(b));
  while (ids.length < slots && pool.length) ids.push(pool.shift().id);
  return ids;
}

// ---------- tiles ----------

function buildTiles() {
  state.tiles.forEach((t) => { t.el.remove(); t.id = null; if (t.url) URL.revokeObjectURL(t.url); });
  const grid = $('#camera-grid');
  const template = $('#tile-template');

  state.tiles = state.selection.map((id, slot) => {
    const el = template.content.firstElementChild.cloneNode(true);
    const tile = {
      el,
      slot,
      id: null,
      cam: null,
      img: el.querySelector('img'),
      pill: el.querySelector('.pill'),
      age: el.querySelector('.cam-age'),
      url: null,
      capturedAt: null,
      error: false,
      loading: null,
    };
    el.querySelector('.slot').textContent = String(slot + 1).padStart(2, '0');
    el.querySelector('.cam-media').addEventListener('click', () => openViewer(tile.id, state.selection));
    el.addEventListener('mouseenter', () => highlight(slot, true));
    el.addEventListener('mouseleave', () => highlight(slot, false));
    setTileCamera(tile, state.cameras.get(id));
    grid.appendChild(el);
    return tile;
  });
  $('#camera-count').textContent = `${state.selection.length} of ${state.order.length} nearby`;
}

function setTileCamera(tile, cam) {
  if (tile.url) URL.revokeObjectURL(tile.url);
  tile.img.removeAttribute('src');
  tile.url = null;
  tile.id = cam.id;
  tile.cam = cam;
  tile.capturedAt = null;
  tile.error = false;
  tile.el.classList.add('is-loading');
  tile.el.classList.remove('is-offline');
  tile.el.querySelector('.cam-name').textContent = cam.name;
  tile.el.querySelector('.cam-name').title = cam.name;
  tile.el.querySelector('.cam-road').textContent = roadLine(cam);
  tile.el.querySelector('.cam-site').textContent = distanceLine(cam);
  tile.el.querySelector('.cam-media').setAttribute('aria-label', `Open ${cam.name} camera`);
  tile.img.alt = `Traffic camera view: ${cam.name}, ${roadLine(cam)}`;
  tile.pill.textContent = '';
  tile.age.textContent = '';
}

async function refreshTile(tile) {
  if (!(await loadFrame(tile, tile.id, tile.img))) return;
  tile.el.classList.remove('is-loading');
  renderTileStatus(tile);
}

function renderTileStatus(tile) {
  tile.el.classList.toggle('is-offline', tile.error);
  if (!tile.url && !tile.error) return;
  const captured = capturedTime(tile.capturedAt, tile.cam);
  const s = status(captured, tile.error);
  tile.pill.className = `pill ${s.cls}`;
  tile.pill.textContent = s.label;
  tile.age.textContent = tile.error ? 'no signal' : formatAge(Date.now() - captured);
  tile.age.title = tile.error ? '' : `Captured ${new Date(captured).toLocaleString()}`;
}

export async function refreshAll(onProgress = () => {}) {
  state.refreshing++;
  state.nextRefreshAt = Date.now() + REFRESH_MS;
  onProgress();
  const jobs = state.tiles.map((tile, i) =>
    new Promise((r) => setTimeout(r, i * STAGGER_MS)).then(() => refreshTile(tile)));
  if (state.viewer.id) jobs.push(refreshViewer());
  await Promise.all(jobs);
  state.refreshing--;
  onProgress();
}

export function renderAges() {
  state.tiles.forEach(renderTileStatus);
  renderViewerStatus();
}

// ---------- map layer ----------

function renderMarkers() {
  if (!state.layer) return;
  state.layer.clearLayers();
  const pinned = new Set(state.selection);

  for (const id of state.order) {
    if (pinned.has(id)) continue;
    const cam = state.cameras.get(id);
    dot(cam.lat, cam.lon, '#7d8899', 4)
      .bindTooltip(cam.name, { direction: 'top', offset: [0, -4] })
      .on('click', () => openViewer(cam.id, state.order))
      .addTo(state.layer);
  }

  state.pins = state.selection.map((id, slot) => {
    const cam = state.tiles[slot]?.cam || state.cameras.get(id);
    if (!cam) return null;
    return L.marker([cam.lat, cam.lon], {
      icon: L.divIcon({ className: '', html: `<div class="pin">${slot + 1}</div>`, iconSize: [24, 24] }),
      zIndexOffset: 1000,
      keyboard: false,
    })
      .bindTooltip(`${slot + 1}. ${cam.name}`, { direction: 'top', offset: [0, -12] })
      .on('click', () => openViewer(id, state.selection))
      .on('mouseover', () => highlight(slot, true))
      .on('mouseout', () => highlight(slot, false))
      .addTo(state.layer);
  });
}

function highlight(slot, on) {
  state.tiles[slot]?.el.classList.toggle('hot', on);
  state.pins[slot]?.getElement()?.querySelector('.pin')?.classList.toggle('hot', on);
}

// ---------- viewer ----------

const viewer = () => $('#viewer');

function openViewer(id, list) {
  const v = state.viewer;
  v.id = id;
  v.list = list.includes(id) ? list : state.order;
  v.capturedAt = null;
  v.error = false;

  const cam = state.cameras.get(id) || state.tiles.find((t) => t.id === id)?.cam;
  $('#viewer-title').textContent = cam.name;
  $('#viewer-road').textContent = `${roadLine(cam)} · ${distanceLine(cam)}`;
  $('#viewer-time').textContent = 'Loading…';
  $('#viewer-pill').className = 'pill';
  $('#viewer-pill').textContent = '';
  $('#viewer-source').href = cam.sourceUrl || 'https://www.travelmidwest.com/';
  $('#viewer-maps').href = `https://www.google.com/maps/search/?api=1&query=${cam.lat},${cam.lon}`;
  const img = $('#viewer-img');
  img.alt = `Traffic camera view: ${cam.name}`;

  // Show the tile's current frame immediately while the fresh one loads.
  const tile = state.tiles.find((t) => t.id === id);
  img.removeAttribute('src');
  if (tile?.img.src) img.src = tile.img.src;

  renderSwapControls();
  const multiple = v.list.length > 1;
  $('#viewer-prev').hidden = !multiple;
  $('#viewer-next').hidden = !multiple;

  if (!viewer().open) viewer().showModal();
  refreshViewer();
}

function renderSwapControls() {
  const slot = state.selection.indexOf(state.viewer.id);
  $('#viewer-swap').hidden = slot !== -1;
  $('#viewer-slot').textContent = slot !== -1 ? `On the grid · slot ${slot + 1}` : '';
  if (slot === -1) {
    $('#swap-slot').replaceChildren(...state.tiles.map((t, i) => new Option(`${i + 1} — ${t.cam.name}`, i)));
  }
}

async function refreshViewer() {
  const v = state.viewer;
  if (v.id && (await loadFrame(v, v.id, $('#viewer-img')))) renderViewerStatus();
}

function renderViewerStatus() {
  const v = state.viewer;
  const cam = state.cameras.get(v.id) || state.tiles.find((t) => t.id === v.id)?.cam;
  if (!v.id || !cam || (!v.url && !v.error)) return;
  const captured = capturedTime(v.capturedAt, cam);
  const s = status(captured, v.error);
  $('#viewer-pill').className = `pill ${s.cls}`;
  $('#viewer-pill').textContent = s.label;
  $('#viewer-time').textContent = v.error
    ? 'Camera not responding'
    : `Captured ${new Date(captured).toLocaleTimeString()} (${formatAge(Date.now() - captured)}) · ${cam.lat.toFixed(4)}, ${cam.lon.toFixed(4)}`;
}

function stepViewer(delta) {
  const v = state.viewer;
  if (!v.id || v.list.length < 2) return;
  const i = v.list.indexOf(v.id);
  openViewer(v.list[(i + delta + v.list.length) % v.list.length], v.list);
}

function closeViewer() {
  // 'close' fires asynchronously, so ignore it if the viewer was reopened meanwhile.
  if (viewer().open) return;
  const v = state.viewer;
  v.id = null;
  if (v.url) URL.revokeObjectURL(v.url);
  v.url = null;
}

function swapIntoSlot() {
  const id = state.viewer.id;
  const slot = Number($('#swap-slot').value);
  if (!id || Number.isNaN(slot)) return;
  state.selection[slot] = id;
  storageSet(state.selection);
  const tile = state.tiles[slot];
  setTileCamera(tile, state.cameras.get(id));
  refreshTile(tile);
  renderMarkers();
  renderSwapControls();
}

// ---------- lifecycle ----------

function resetFromFeed() {
  state.selection = chooseSelection();
  buildTiles();
  renderMarkers();
  refreshAll();
}

export function resetSelection() {
  storageClear();
  resetFromFeed();
}

// Called every second by main.js while the dashboard isn't paused.
export async function tick() {
  if (Date.now() >= state.nextFeedAt && (await loadCameras())) {
    if (!state.selection.length) resetFromFeed();
    else renderMarkers();
  }
  if (state.selection.length && Date.now() >= state.nextRefreshAt) refreshAll();
}

export async function initCameras(site, mapView) {
  state.site = site;
  state.mapView = mapView;
  if (mapView) {
    state.layer = mapView.overlay(`${swatch('#5cc8ff')}Cameras`, L.layerGroup());
  }

  $('#viewer-close').addEventListener('click', () => viewer().close());
  $('#viewer-prev').addEventListener('click', () => stepViewer(-1));
  $('#viewer-next').addEventListener('click', () => stepViewer(1));
  $('#swap-btn').addEventListener('click', swapIntoSlot);
  viewer().addEventListener('close', closeViewer);
  viewer().addEventListener('click', (e) => { if (e.target === viewer()) viewer().close(); });
  document.addEventListener('keydown', (e) => {
    if (!viewer().open || e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowLeft') stepViewer(-1);
    if (e.key === 'ArrowRight') stepViewer(1);
  });

  if ((await loadCameras()) && state.cameras.size) resetFromFeed();
  else $('#camera-count').textContent = 'No cameras available';
}
