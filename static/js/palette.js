// ⌘K / Ctrl+K command palette: jump to a building, incident type, family, outcome, date range
// or camera, or run an action, without touching the mouse.

import { $, h } from './util.js';
import { clearAll, dataset, only, select, setRange } from './safety/state.js';
import { today } from './safety/data.js';
import { familyColor } from './safety/colors.js';
import { areaCameras, openViewer } from './live/widgets.js';

const MAX_RESULTS = 40;
let items = [];
let results = [];
let active = 0;

const jan1 = (year) => Math.floor(Date.UTC(year, 0, 1) / 86400000);
const toSafety = () => document.getElementById('safety').scrollIntoView({ behavior: 'smooth', block: 'start' });

function buildItems() {
  const data = dataset();
  const list = [
    { kind: 'Action', label: 'Clear all filters', run: clearAll },
    { kind: 'Action', label: 'Replay the map', run: () => { toSafety(); $('#replay-btn').click(); } },
    { kind: 'Action', label: 'Export the current view as CSV', run: () => $('#export-csv').click() },
    { kind: 'Action', label: 'Copy a link to this view', run: () => $('#copy-link').click() },
    { kind: 'Action', label: 'Open the latest report', run: () => data && select(data.newest[0]) },
    { kind: 'Action', label: 'Go to live cameras', run: () => $('#live').scrollIntoView({ behavior: 'smooth' }) },
  ];
  const t = today();
  for (const [label, back] of [['Last 7 days', 6], ['Last 30 days', 29], ['Last 90 days', 89], ['Last 12 months', 364]]) {
    list.push({ kind: 'Dates', label, run: () => setRange([t - back, t]) });
  }
  if (data) {
    list.push({ kind: 'Dates', label: 'All time (since 2014)', run: () => setRange([data.firstDay, data.lastDay]) });
    for (let y = new Date().getUTCFullYear(); y >= Math.min(...data.year); y--) {
      list.push({ kind: 'Dates', label: `Year ${y}`, run: () => setRange([jan1(y), jan1(y + 1) - 1]) });
    }
    data.families.forEach((f, i) => list.push({ kind: 'Family', label: f.label, color: familyColor(f), run: () => only('families', i) }));
    const counts = new Map();
    for (const g of data.group) counts.set(g, (counts.get(g) || 0) + 1);
    [...counts].sort((a, b) => b[1] - a[1]).forEach(([g, n]) => {
      const place = data.groups[g];
      if (place.quality !== 'none') list.push({ kind: 'Place', label: place.name, hint: `${n} reports`, run: () => only('places', g) });
    });
    const typeCounts = new Map();
    for (const ty of data.incidents.type) typeCounts.set(ty, (typeCounts.get(ty) || 0) + 1);
    [...typeCounts].sort((a, b) => b[1] - a[1]).forEach(([ty, n]) =>
      list.push({ kind: 'Type', label: data.types[ty], hint: `${n} reports`, run: () => only('types', ty) }));
    data.dispositions.forEach((d, i) => list.push({ kind: 'Outcome', label: d, run: () => only('disps', i) }));
  }
  for (const cam of areaCameras()) list.push({ kind: 'Camera', label: cam.name, hint: cam.roadName, run: () => openViewer(cam.id), camera: true });
  return list;
}

// Prefix > word start > substring > letters in order.
function score(label, q) {
  const text = label.toLowerCase();
  if (text.startsWith(q)) return 4;
  if (text.includes(` ${q}`)) return 3;
  if (text.includes(q)) return 2;
  let k = 0;
  for (const ch of text) if (ch === q[k]) k++;
  return k === q.length ? 1 : 0;
}

function render() {
  const q = $('#palette-input').value.trim().toLowerCase();
  results = q
    ? items.map((it) => [it, score(it.label, q)]).filter(([, s]) => s).sort((a, b) => b[1] - a[1]).map(([it]) => it)
    : items.filter((it) => it.kind === 'Action' || it.kind === 'Dates').slice(0, 10);
  results = results.slice(0, MAX_RESULTS);
  active = Math.min(active, Math.max(0, results.length - 1));
  $('#palette-list').replaceChildren(...(results.length ? results.map((it, i) => h('li', {
    role: 'option', id: `pal-${i}`, 'aria-selected': String(i === active), class: i === active ? 'on' : '',
    onmousemove: () => { if (active !== i) { active = i; render(); } },
    onclick: () => run(it),
  },
    h('span', { class: 'pal-kind mono' }, it.kind),
    it.color && h('i', { class: 'swatch', style: `background:${it.color}` }),
    h('span', { class: 'pal-label' }, it.label),
    it.hint && h('span', { class: 'pal-hint mono' }, it.hint))) : [h('li', { class: 'pal-empty' }, 'No matches')]));
  $('#palette-input').setAttribute('aria-activedescendant', results.length ? `pal-${active}` : '');
  $(`#pal-${active}`)?.scrollIntoView({ block: 'nearest' });
}

function run(item) {
  $('#palette').close();
  item.run();
  if (!item.camera && !['Copy a link to this view', 'Go to live cameras', 'Export the current view as CSV'].includes(item.label)) toSafety();
}

export function openPalette() {
  items = buildItems();
  active = 0;
  $('#palette-input').value = '';
  render();
  $('#palette').showModal();
  $('#palette-input').focus();
}

export function initPalette() {
  $('#palette-btn').addEventListener('click', openPalette);
  $('#palette-input').addEventListener('input', () => { active = 0; render(); });
  $('#palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(results.length - 1, active + 1); render(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    if (e.key === 'Enter' && results[active]) { e.preventDefault(); run(results[active]); }
  });
  $('#palette').addEventListener('click', (e) => { if (e.target === $('#palette')) $('#palette').close(); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if ($('#palette').open) $('#palette').close();
      else openPalette();
    }
  });
}
