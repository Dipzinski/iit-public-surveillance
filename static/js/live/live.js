// Live around campus: featured camera widgets framing the notification stream, context cards
// and the ticker, on one clock so Pause stops them all at once.

import { $, h, getJSON } from '../util.js';
import { setCameraLayer } from '../safety/city-map.js';
import { buildWidgets, initViewer, openViewer, refreshWidgets, renderAges } from './widgets.js';
import { usePublishedFrames } from './frames.js';
import { initActivity, refreshActivity } from './activity.js';
import { initStream, refreshStream } from './stream.js';
import { renderDispatch, renderNeighborhood } from './context.js';

const PUBLISHED_MS = 5 * 60_000; // the published files only change on each scheduled build

let cameraMs = 30_000;     // camera frames
let streamMs = 2 * 60_000; // traffic, weather and 311
let paused = false;
let refreshing = false;
let nextCameraAt = 0;
let nextStreamAt = Date.now() + streamMs;
let feedStatus = { kind: 'ok', label: 'Connecting…' };

function renderStatus() {
  const chip = $('#feed-status');
  chip.className = `chip ${paused ? 'paused' : feedStatus.kind}`;
  chip.querySelector('.label').textContent = paused ? 'Paused' : feedStatus.label;
  const s = Math.max(0, Math.ceil((nextCameraAt - Date.now()) / 1000));
  $('#countdown').textContent = paused ? 'Paused' : refreshing ? 'Updating…' : `Next ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function refreshCameras() {
  refreshing = true;
  nextCameraAt = Date.now() + cameraMs;
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
    nextStreamAt = Date.now() + streamMs;
    refreshStream();
    refreshActivity();
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
  const site = await getJSON('api/site.json');
  let cameras = [];
  try {
    const data = await getJSON('api/cameras.json');
    cameras = data.cameras;
    feedStatus = data.stale ? { kind: 'warn', label: 'Cameras delayed' } : { kind: 'ok', label: 'Cameras live' };
    if (data.published) {
      usePublishedFrames();
      cameraMs = streamMs = PUBLISHED_MS;
      nextStreamAt = Date.now() + streamMs;
      feedStatus = { kind: 'ok', label: 'Camera snapshots' };
    }
  } catch {
    feedStatus = { kind: 'error', label: 'Cameras offline' };
  }

  buildWidgets(site, cameras);
  initViewer();
  setCameraLayer(cameras, openViewer);
  initStream(ready);
  ready.then(initActivity);
  renderNeighborhood(ready);
  renderDispatch(site);

  $('#refresh-btn').addEventListener('click', () => { refreshCameras(); refreshStream(); refreshActivity(); });
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
