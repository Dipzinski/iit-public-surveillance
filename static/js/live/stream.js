// The live notification stream: recent campus safety reports, weather warnings, live traffic
// incidents and city 311 requests in one timeline. Each card that has a location shows the
// frame from the nearest traffic camera. The same items scroll through the bottom ticker.

import { $, h, getJSON, timeAgo, formatMiles } from '../util.js';
import { dataset, select } from '../safety/state.js';
import { familyColor } from '../safety/colors.js';
import { nearestCamera, snapshotUrl } from './frames.js';
import { areaCameras, openViewer } from './widgets.js';

const CAMPUS_DAYS = 21;    // how far back campus reports appear in the stream
const CAMERA_MAX_MI = 1.2; // only show a "nearest camera" that is actually near
const SEVERITY = { Extreme: 'critical', Severe: 'critical', Moderate: 'serious', Minor: 'warning' };

const ICONS = {
  campus: 'M10 2 3 5v5c0 4.2 3 7.4 7 8 4-.6 7-3.8 7-8V5z',
  traffic: 'M10 2 2 17h16zM10 7v5M10 14.5v.5',
  weather: 'M6 15h8a4 4 0 0 0 .5-8A5 5 0 0 0 5 8a3.5 3.5 0 0 0 1 7zM8 18l1-2M12 18l1-2',
  city: 'M4 17h12M6 17V8l4-4 4 4v9M9 17v-4h2v4',
};
const SOURCES = [
  ['all', 'All'],
  ['campus', 'Campus safety'],
  ['traffic', 'Traffic'],
  ['weather', 'Weather'],
  ['city', 'City 311'],
];

const state = { items: [], fresh: new Set(), filter: 'all', weather: [] };

const icon = (kind) => h('span', { class: `ev-icon ${kind}`, 'aria-hidden': 'true' },
  (() => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[kind]);
    svg.append(path);
    return svg;
  })());

// ---------- collecting ----------

function campusItems() {
  const data = dataset();
  if (!data) return [];
  const cutoff = Date.now() / 1000 - CAMPUS_DAYS * 86400;
  const inc = data.incidents;
  const items = [];
  for (const i of data.newest) {
    if (inc.t[i] < cutoff) break;
    const place = data.groups[data.group[i]];
    items.push({
      key: `campus-${inc.id[i]}`,
      kind: 'campus',
      time: inc.t[i] * 1000,
      title: data.types[inc.type[i]],
      meta: [place.name, data.dispositions[inc.disp[i]]].filter(Boolean).join(' · '),
      text: inc.notes[i],
      accent: familyColor(data.families[inc.family[i]]),
      tag: data.families[inc.family[i]].label,
      lat: place.mappable ? place.lat : null,
      lon: place.mappable ? place.lon : null,
      open: () => select(i),
    });
  }
  return items;
}

async function collect() {
  const [traffic, alerts] = await Promise.all([
    getJSON('/api/traffic').catch(() => null),
    getJSON('/api/alerts').catch(() => null),
  ]);
  const items = campusItems();

  state.weather = alerts?.weather?.alerts || [];
  for (const a of state.weather) {
    items.push({
      key: `weather-${a.event}-${a.effective}`, kind: 'weather', time: Date.parse(a.effective) || Date.now(),
      title: a.event, meta: a.expires ? `Until ${new Date(a.expires).toLocaleString()}` : '', text: a.headline,
      level: SEVERITY[a.severity] || 'warning', tag: a.severity,
    });
  }
  for (const i of traffic?.live?.incidents || []) {
    if (i.longTerm) continue;
    items.push({
      key: `traffic-${i.lat}-${i.lon}-${i.start}`, kind: 'traffic', time: Date.parse(i.start) || Date.now(),
      title: `${i.kind}${i.road ? ` · ${i.road}` : ''}`, meta: `${i.distanceMi} mi from campus${i.end ? ` · until ${new Date(i.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`,
      text: i.description === 'Closed.' ? '' : i.description, level: i.critical ? 'critical' : 'warning', tag: i.critical ? 'Major' : 'Minor', lat: i.lat, lon: i.lon,
    });
  }
  for (const r of (alerts?.requests?.recent || []).slice(0, 12)) {
    items.push({
      key: `city-${r.id}`, kind: 'city', time: Date.parse(r.created), title: r.type, meta: `${r.address} · ${r.department}`,
      text: '', tag: r.status, lat: r.lat, lon: r.lon,
    });
  }
  items.sort((a, b) => b.time - a.time);
  return items;
}

// ---------- rendering ----------

function cameraFor(item) {
  if (item.lat == null) return null;
  const near = nearestCamera(item.lat, item.lon, areaCameras());
  return near && near.miles <= CAMERA_MAX_MI ? near : null;
}

function card(item, isNew) {
  const near = cameraFor(item);
  const levelBadge = item.level
    ? h('span', { class: `status ${item.level}` }, h('span', { class: 'status-icon', 'aria-hidden': 'true' }, '!'), item.tag)
    : h('span', { class: 'tag' }, item.tag);
  return h('article', {
    class: `ev ${item.kind}${isNew ? ' is-new' : ''}${item.open ? ' clickable' : ''}`,
    style: item.accent ? `--ev:${item.accent}` : null,
  },
    h('div', { class: 'ev-body', role: item.open ? 'button' : null, tabindex: item.open ? '0' : null,
      onclick: item.open || null, onkeydown: item.open ? (e) => { if (e.key === 'Enter') item.open(); } : null },
      h('div', { class: 'ev-top' }, icon(item.kind), h('span', { class: 'ev-src' }, SOURCES.find(([k]) => k === item.kind)[1]),
        isNew && h('span', { class: 'ev-new' }, 'New'), h('span', { class: 'ev-time mono' }, timeAgo(item.time))),
      h('strong', { class: 'ev-title' }, item.title),
      h('div', { class: 'ev-meta' }, levelBadge, h('span', {}, item.meta)),
      item.text && h('p', { class: 'ev-text' }, item.text)),
    near && h('button', { type: 'button', class: 'ev-cam', onclick: () => openViewer(near.cam.id), title: `Open ${near.cam.name}` },
      h('img', { src: snapshotUrl(near.cam.id), alt: `Nearest camera: ${near.cam.name}`, loading: 'lazy', decoding: 'async' }),
      h('span', { class: 'ev-cam-label mono' }, `cam ${formatMiles(near.miles)}`)));
}

function render() {
  const counts = new Map(SOURCES.map(([k]) => [k, 0]));
  for (const item of state.items) counts.set(item.kind, counts.get(item.kind) + 1);
  counts.set('all', state.items.length);
  $('#stream-filters').replaceChildren(...SOURCES.map(([key, label]) => h('button', {
    type: 'button', class: `seg${state.filter === key ? ' on' : ''}`, 'aria-pressed': String(state.filter === key),
    onclick: () => { state.filter = key; render(); },
  }, label, h('span', { class: 'mono muted' }, counts.get(key)))));

  const shown = state.items.filter((it) => state.filter === 'all' || it.kind === state.filter);
  $('#stream-list').replaceChildren(...(shown.length
    ? shown.map((it) => card(it, state.fresh.has(it.key)))
    : [h('p', { class: 'quiet' }, 'Nothing here right now.')]));
  $('#stream-note').textContent = `campus reports from the last ${CAMPUS_DAYS} days · live traffic · weather · 311`;
  renderTicker();
  renderBanner();
}

function renderTicker() {
  const items = state.items.slice(0, 14);
  const ticker = $('#ticker');
  if (!items.length) { ticker.hidden = true; return; }
  const run = () => h('div', { class: 'ticker-run' }, items.map((it) => h('span', { class: `tick ${it.kind}` },
    h('i', { style: it.accent ? `background:${it.accent}` : null }),
    h('b', {}, SOURCES.find(([k]) => k === it.kind)[1]), ` ${it.title} · ${it.meta.split(' · ')[0]} · ${timeAgo(it.time)}`)));
  const track = h('div', { class: 'ticker-track' }, run(), (() => { const copy = run(); copy.setAttribute('aria-hidden', 'true'); return copy; })());
  track.style.setProperty('--ticker-duration', `${Math.max(40, items.length * 7)}s`);
  ticker.querySelector('.ticker-viewport').replaceChildren(track);
  ticker.hidden = false;
  document.body.classList.add('has-ticker');
}

// Severe weather is the one thing that should be loud: put it across the top.
function renderBanner() {
  const banner = $('#alert-banner');
  const top = state.weather[0];
  banner.hidden = !top;
  if (!top) return;
  const level = SEVERITY[top.severity] || 'warning';
  const sirens = /tornado warning/i.test(top.event) ? ' Outdoor warning sirens may sound.' : '';
  banner.className = `alert-banner ${level}`;
  banner.replaceChildren(
    h('span', { class: `status ${level}` }, h('span', { class: 'status-icon', 'aria-hidden': 'true' }, '!'), top.event),
    h('span', {}, `${top.headline}${sirens}`));
}

// `initial` loads mark nothing as new; later refreshes flag items that weren't there before.
export async function refreshStream(initial = false) {
  const items = await collect();
  const before = new Set(state.items.map((it) => it.key));
  state.fresh = initial ? new Set() : new Set(items.filter((it) => !before.has(it.key)).map((it) => it.key));
  state.items = items;
  render();
}

export async function initStream(ready) {
  $('#ticker-pause').addEventListener('click', (e) => {
    const paused = $('#ticker').classList.toggle('paused');
    e.currentTarget.textContent = paused ? '▶' : '❚❚';
    e.currentTarget.setAttribute('aria-label', paused ? 'Resume ticker' : 'Pause ticker');
  });
  await refreshStream(true); // traffic, weather and 311 right away
  await ready;               // then add campus reports once the archive has loaded
  await refreshStream(true);
}
