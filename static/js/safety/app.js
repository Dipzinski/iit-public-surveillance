// Boots the Safety Log views: load the archive, wire every view to the shared state,
// keyboard shortcuts, and the archive status chip.

import { $, h, getJSON, timeAgo } from '../util.js';
import { BuildingArchive, loadDataset } from './data.js';
import { init, filters, select, selection } from './state.js';
import { initFilterBar, toast } from './filterbar.js';
import { initKpis } from './kpis.js';
import { initTimeline } from './timeline.js';
import { initCampusMap } from './campus-map.js';
import { initFeed, step } from './feed.js';
import { initFacets } from './facets.js';
import { initDrawer } from './drawer.js';
import { initClock } from './clock.js';
import { initPunchcard } from './punchcard.js';
import { initFlow } from './flow.js';
import { initCalendar } from './calendar.js';
import { initPlaces } from './places.js';
import { initQuality } from './quality.js';

let loadedAt = 0;

// First run: the server is still downloading the archive. Show its progress and retry.
async function waitForArchive() {
  const panel = $('#building');
  panel.hidden = false;
  $('#safety').hidden = true;
  for (;;) {
    try {
      const s = await getJSON('/api/safety/status');
      const { phase, page, pages, fetched } = s.sync;
      $('#building-text').textContent = phase === 'backfill'
        ? `Downloading the Public Safety log: ${fetched.toLocaleString()} posts (page ${page} of ${pages || '…'})`
        : phase === 'parsing' ? 'Reading and mapping every report…' : 'Preparing the archive…';
      $('#building-bar').style.width = pages ? `${Math.round((page / pages) * 100)}%` : '5%';
      if (s.posts && phase !== 'backfill' && phase !== 'parsing') break;
    } catch { /* server still starting */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  panel.hidden = true;
  $('#safety').hidden = false;
}

async function refreshStatus() {
  try {
    const s = await getJSON('/api/safety/status');
    const mies = Object.entries(s.byCampus).filter(([c]) => ['MIES', 'OFF', 'UNKNOWN'].includes(c)).reduce((n, [, v]) => n + v, 0);
    const synced = s.sync.lastSync ? `synced ${timeAgo(s.sync.lastSync * 1000)}` : s.sync.phase;
    $('#archive-status').textContent = `${mies.toLocaleString()} reports · ${s.firstLog.slice(0, 4)}–${s.lastLog.slice(0, 4)} · ${synced}`;
    $('#archive-status').title = `${s.posts.toLocaleString()} log posts parsed (parser v${s.parserVersion}); `
      + `${Math.round((s.withTime / s.incidents) * 100)}% have a time`;
    // New posts were parsed since this page loaded: offer a reload that keeps the current view.
    $('#archive-update').hidden = !(loadedAt && s.rebuiltAt > loadedAt);
  } catch {
    $('#archive-status').textContent = 'Archive status unavailable';
  }
}

function shortcuts() {
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    if (e.key === 'Escape') {
      if (typing) e.target.blur();
      else if (selection.index != null) select(null);
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
    if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    else if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
  });
}

export async function startSafety() {
  let data;
  for (;;) {
    try {
      data = await loadDataset();
      break;
    } catch (err) {
      if (!(err instanceof BuildingArchive)) {
        $('#safety').prepend(h('p', { class: 'note is-error' }, `The Public Safety archive couldn't load: ${err.message}`));
        return;
      }
      await waitForArchive();
    }
  }

  init(data);
  initFilterBar();
  initKpis();
  initTimeline();
  initCampusMap();
  initFeed();
  initFacets();
  initDrawer();
  initClock();
  initPunchcard();
  initFlow();
  initCalendar();
  initPlaces();
  initQuality();
  shortcuts();

  const status = await getJSON('/api/safety/status').catch(() => null);
  loadedAt = status?.rebuiltAt || 0;
  $('#archive-update').addEventListener('click', () => location.reload());
  refreshStatus();
  setInterval(refreshStatus, 60_000);
  if (filters.q) toast(`Showing results for “${filters.q}”`);
}
