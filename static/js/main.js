// Entry point: loads the site config, builds the map, cameras and panels, and runs
// one shared clock so Pause stops everything at once.

import { $, h, getJSON } from './util.js';
import { createMap } from './map.js';
import * as cameras from './cameras.js';
import * as panels from './panels.js';

let paused = false;

function renderStatus() {
  const cams = cameras.cameraState;
  const chip = $('#feed-status');
  chip.className = `chip ${paused ? 'paused' : cams.feedStatus.kind}`;
  chip.querySelector('.label').textContent = paused ? 'Paused' : cams.feedStatus.label;

  const countdown = $('#countdown');
  if (paused) countdown.textContent = 'Paused';
  else if (cams.refreshing) countdown.textContent = 'Updating…';
  else {
    const s = Math.max(0, Math.ceil((cams.nextRefreshAt - Date.now()) / 1000));
    countdown.textContent = `Next 0:${String(s).padStart(2, '0')}`;
  }
}

function tick() {
  renderStatus();
  if (paused || document.hidden) return;
  cameras.tick();
  panels.tick();
}

function setPaused(value) {
  paused = value;
  const btn = $('#pause-btn');
  btn.textContent = paused ? 'Resume' : 'Pause';
  btn.setAttribute('aria-pressed', String(paused));
  if (!paused) cameras.cameraState.nextRefreshAt = Date.now();
  renderStatus();
}

async function start() {
  const site = await getJSON('/api/site');
  const mapView = createMap($('#map'), site);
  panels.initPanels(site, mapView);
  await cameras.initCameras(site, mapView);

  $('#refresh-btn').addEventListener('click', () => {
    cameras.refreshAll(renderStatus);
    panels.refreshAll();
  });
  $('#pause-btn').addEventListener('click', () => setPaused(!paused));
  $('#reset-btn').addEventListener('click', cameras.resetSelection);
  // Catch up right away when the tab comes back into view.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  tick();
  setInterval(tick, 1000);
  setInterval(() => { cameras.renderAges(); panels.renderAges(); }, 10_000);
}

start().catch((err) => {
  console.error(err);
  $('main').prepend(h('p', { class: 'note is-error' }, `The dashboard couldn't start: ${err.message}`));
});
