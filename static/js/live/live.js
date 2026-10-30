// Live around campus: featured camera widgets framing the notification stream, context cards
// and the ticker, on one clock so Pause stops them all at once.

import { $, h, getJSON, milesBetween } from '../util.js';
import { buildWidgets, initViewer, refreshWidgets, renderAges } from './widgets.js';
import { initStream, refreshStream } from './stream.js';
import { renderDispatch, renderNeighborhood } from './context.js';

const CAMERA_MS = 30_000;     // camera frames
const STREAM_MS = 2 * 60_000; // traffic, weather and 311

let paused = false;
let refreshing = false;
let nextCameraAt = 0;
let nextStreamAt = Date.now() + STREAM_MS;
let feedStatus = { kind: 'ok', label: 'Connecting…' };

function renderStatus() {
  const chip = $('#feed-status');
  chip.className = `chip ${paused ? 'paused' : feedStatus.kind}`;
  chip.querySelector('.label').textContent = paused ? 'Paused' : feedStatus.label;
  const s = Math.max(0, Math.ceil((nextCameraAt - Date.now()) / 1000));
  $('#countdown').textContent = paused ? 'Paused' : refreshing ? 'Updating…' : `Next 0:${String(s).padStart(2, '0')}`;
}

async function refreshCameras() {
  refreshing = true;
  nextCameraAt = Date.now() + CAMERA_MS;
  renderStatus();
  await refreshWidgets();
  refreshing = false;
  renderStatus();
}

function tick() {
  renderStatus();
  if (paused || document.hidden) return;
  if (Date.now() >= nextCameraAt) refreshCameras();
  if (Date.now() >= nextStreamAt) {
    nextStreamAt = Date.now() + STREAM_MS;
    refreshStream();
  }
}

function setPaused(value) {
  paused = value;
  $('#pause-btn').textContent = paused ? 'Resume' : 'Pause';
  $('#pause-btn').setAttribute('aria-pressed', String(paused));
  $('#ticker').classList.toggle('paused', paused);
  if (!paused) nextCameraAt = Date.now();
  renderStatus();
}

export async function startLive(ready) {
  const site = await getJSON('/api/site');
  let cameras = [];
  try {
    const data = await getJSON('/api/cameras');
    cameras = data.cameras.filter((c) => milesBetween(c, site.center) <= site.cameraAreaMi);
    feedStatus = data.stale ? { kind: 'warn', label: 'Cameras delayed' } : { kind: 'ok', label: 'Cameras live' };
  } catch {
    feedStatus = { kind: 'error', label: 'Cameras offline' };
  }

  buildWidgets(site, cameras);
  initViewer();
  initStream(ready);
  renderNeighborhood(ready);
  renderDispatch(site);

  $('#refresh-btn').addEventListener('click', () => { refreshCameras(); refreshStream(); });
  $('#pause-btn').addEventListener('click', () => setPaused(!paused));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  tick();
  setInterval(tick, 1000);
  setInterval(renderAges, 10_000);
}

export function reportLiveError(err) {
  console.error(err);
  $('#live').prepend(h('p', { class: 'note is-error' }, `The live feeds couldn't start: ${err.message}`));
}
