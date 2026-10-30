// Featured camera widgets (the best angles on campus, from data/site.json) styled as
// monitor feeds, plus the full-screen viewer that any camera can open in.

import { $, h, milesBetween, formatMiles } from '../util.js';
import { capturedTime, formatAge, loadFrame, roadLine, status } from './frames.js';

const STAGGER_MS = 200;
const widgets = [];
let site;
let cameras = new Map(); // id -> camera, every camera in the area
let order = [];          // area cameras, north to south (viewer prev/next)
const viewerState = { id: null, list: [], url: null, capturedAt: null, error: false, loading: null };

const clock = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/Chicago' });
const distance = (cam) => `${formatMiles(milesBetween(cam, site.center))} from campus`;

// ---------- widgets ----------

function widget(feature, cam, index) {
  const img = h('img', { alt: `Live traffic camera: ${feature.view}`, decoding: 'async' });
  const pill = h('span', { class: 'pill' });
  const stamp = h('span', { class: 'hud-stamp mono' });
  const el = h('article', { class: `camw is-loading${index === 0 ? ' primary' : ''}` },
    h('button', { type: 'button', class: 'camw-frame', 'aria-label': `Open ${feature.angle} camera`, onclick: () => openViewer(cam.id, featuredIds()) },
      img,
      h('span', { class: 'hud', 'aria-hidden': 'true' },
        h('i', { class: 'corner tl' }), h('i', { class: 'corner tr' }), h('i', { class: 'corner bl' }), h('i', { class: 'corner br' }),
        h('span', { class: 'hud-cam mono' }, `CAM ${String(index + 1).padStart(2, '0')}`),
        stamp),
      pill),
    h('div', { class: 'camw-meta' },
      h('strong', {}, feature.angle),
      h('span', {}, feature.view),
      h('span', { class: 'mono muted' }, distance(cam))));
  return { el, img, pill, stamp, id: cam.id, cam, url: null, capturedAt: null, error: false, loading: null };
}

const featuredIds = () => widgets.map((w) => w.id);

export function buildWidgets(siteConfig, cameraList) {
  site = siteConfig;
  cameras = new Map(cameraList.map((c) => [c.id, c]));
  order = cameraList.map((c) => c.id);
  const features = site.featuredCameras.filter((f) => cameras.has(f.id));
  const half = Math.ceil(features.length / 2);
  features.forEach((feature, i) => {
    const w = widget(feature, cameras.get(feature.id), i);
    widgets.push(w);
    (i < half ? $('#cam-left') : $('#cam-right')).append(w.el);
  });
}

function renderWidget(w) {
  w.el.classList.toggle('is-offline', w.error);
  if (!w.url && !w.error) return;
  const captured = capturedTime(w.capturedAt, w.cam);
  const s = status(captured, w.error);
  w.pill.className = `pill ${s.cls}`;
  w.pill.textContent = s.label === 'Live' ? 'REC' : s.label;
  w.stamp.textContent = w.error ? 'NO SIGNAL' : `${clock.format(new Date(captured))} · ${formatAge(Date.now() - captured)}`;
}

export async function refreshWidgets() {
  await Promise.all(widgets.map((w, i) => new Promise((r) => setTimeout(r, i * STAGGER_MS)).then(async () => {
    if (await loadFrame(w, w.id, w.img)) {
      w.el.classList.remove('is-loading');
      renderWidget(w);
    }
  })));
  if (viewerState.id) await refreshViewer();
}

export function renderAges() {
  widgets.forEach(renderWidget);
  renderViewerStatus();
}

export const featuredCameras = () => widgets.map((w) => w.cam);
export const areaCameras = () => [...cameras.values()];

// ---------- viewer ----------

const viewer = () => $('#viewer');

export function openViewer(id, list = order) {
  const cam = cameras.get(id);
  if (!cam) return;
  const v = viewerState;
  v.id = id;
  v.list = list.includes(id) ? list : order;
  v.capturedAt = null;
  v.error = false;
  $('#viewer-title').textContent = site.featuredCameras.find((f) => f.id === id)?.angle || cam.name;
  $('#viewer-road').textContent = `${cam.name} · ${roadLine(cam)} · ${distance(cam)}`;
  $('#viewer-time').textContent = 'Loading…';
  $('#viewer-pill').className = 'pill';
  $('#viewer-pill').textContent = '';
  $('#viewer-source').href = cam.sourceUrl || 'https://www.travelmidwest.com/';
  $('#viewer-maps').href = `https://www.google.com/maps/search/?api=1&query=${cam.lat},${cam.lon}`;
  const img = $('#viewer-img');
  img.alt = `Traffic camera view: ${cam.name}`;
  const shown = widgets.find((w) => w.id === id);
  img.removeAttribute('src');
  if (shown?.img.src) img.src = shown.img.src; // show the widget's frame while a fresh one loads
  $('#viewer-prev').hidden = v.list.length < 2;
  $('#viewer-next').hidden = v.list.length < 2;
  if (!viewer().open) viewer().showModal();
  refreshViewer();
}

async function refreshViewer() {
  if (viewerState.id && (await loadFrame(viewerState, viewerState.id, $('#viewer-img')))) renderViewerStatus();
}

function renderViewerStatus() {
  const v = viewerState;
  const cam = cameras.get(v.id);
  if (!cam || (!v.url && !v.error)) return;
  const captured = capturedTime(v.capturedAt, cam);
  const s = status(captured, v.error);
  $('#viewer-pill').className = `pill ${s.cls}`;
  $('#viewer-pill').textContent = s.label;
  $('#viewer-time').textContent = v.error ? 'Camera not responding'
    : `Captured ${new Date(captured).toLocaleTimeString()} (${formatAge(Date.now() - captured)}) · ${cam.lat.toFixed(4)}, ${cam.lon.toFixed(4)}`;
}

function stepViewer(delta) {
  const v = viewerState;
  if (!v.id || v.list.length < 2) return;
  const i = v.list.indexOf(v.id);
  openViewer(v.list[(i + delta + v.list.length) % v.list.length], v.list);
}

export function initViewer() {
  $('#viewer-close').addEventListener('click', () => viewer().close());
  $('#viewer-prev').addEventListener('click', () => stepViewer(-1));
  $('#viewer-next').addEventListener('click', () => stepViewer(1));
  viewer().addEventListener('click', (e) => { if (e.target === viewer()) viewer().close(); });
  viewer().addEventListener('close', () => {
    if (viewer().open) return; // 'close' fires late; ignore it if the viewer was reopened meanwhile
    viewerState.id = null;
    if (viewerState.url) URL.revokeObjectURL(viewerState.url);
    viewerState.url = null;
  });
  document.addEventListener('keydown', (e) => {
    if (!viewer().open || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') stepViewer(-1);
    if (e.key === 'ArrowRight') stepViewer(1);
  });
}
