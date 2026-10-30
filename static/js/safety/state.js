// Crossfilter state shared by every Safety Log view.
//
// Each view asks for `filtered(exceptKey)`: the incidents that pass every filter
// except its own dimension, so a chart keeps showing the alternatives you could
// pick (e.g. the timeline still shows the whole archive while you brush a range).
// Filters are mirrored in the URL hash, so any view can be shared or bookmarked.

import { dayFromISO, isoOfDay, today } from './data.js';

let data = null;
let version = 0;
const listeners = new Set();
const cache = new Map();

export const filters = {
  range: null,          // [fromDay, toDay] inclusive, Chicago days
  families: new Set(),  // family indexes
  types: new Set(),     // type indexes
  places: new Set(),    // place group indexes (one per place name)
  disps: new Set(),     // disposition indexes
  hours: new Set(),     // 0-23
  days: new Set(),      // weekday 0 (Mon) - 6 (Sun)
  q: '',
};

export const selection = { index: null }; // incident open in the case file

export function init(dataset) {
  data = dataset;
  readHash();
  if (!filters.range) filters.range = [today() - 364, today()];
  window.addEventListener('hashchange', () => { readHash(); changed(false); });
}

export const dataset = () => data;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(writeUrl = true) {
  version++;
  cache.clear();
  if (writeUrl) writeHash();
  for (const fn of listeners) fn();
}

// ---------- mutations ----------

export function setRange(range) {
  const next = range && [Math.max(range[0], data.firstDay), Math.min(range[1], data.lastDay)];
  if (String(next) === String(filters.range)) return;
  filters.range = next;
  changed();
}

export function toggle(key, value) {
  const set = filters[key];
  if (set.has(value)) set.delete(value);
  else set.add(value);
  changed();
}

export function only(key, value) {
  filters[key].clear();
  if (value != null) filters[key].add(value);
  changed();
}

export function setQuery(q) {
  if (q === filters.q) return;
  filters.q = q;
  changed();
}

export function clearAll() {
  for (const key of ['families', 'types', 'places', 'disps', 'hours', 'days']) filters[key].clear();
  filters.q = '';
  changed();
}

export function select(index) {
  selection.index = index;
  changed();
}

// ---------- reading ----------

// Filter set -> the per-incident column it tests.
const columns = () => ({
  families: data.incidents.family,
  types: data.incidents.type,
  places: data.group,
  disps: data.incidents.disp,
});

// Incident indexes (newest first) that pass every filter except `except`.
export function filtered(except = null) {
  const key = except || '*';
  if (cache.has(key)) return cache.get(key);
  const cols = columns();
  const terms = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  const [from, to] = filters.range || [-Infinity, Infinity];
  const out = [];
  for (const i of data.newest) {
    if (except !== 'range' && (data.day[i] < from || data.day[i] > to)) continue;
    let ok = true;
    for (const [set, column] of Object.entries(cols)) {
      if (except !== set && filters[set].size && !filters[set].has(column[i])) { ok = false; break; }
    }
    if (!ok) continue;
    if (except !== 'hours' && filters.hours.size && !filters.hours.has(data.hour[i])) continue;
    if (except !== 'days' && filters.days.size && !filters.days.has(data.dow[i])) continue;
    if (except !== 'q' && terms.length && !terms.every((term) => data.text[i].includes(term))) continue;
    out.push(i);
  }
  cache.set(key, out);
  return out;
}

export const activeCount = () =>
  ['families', 'types', 'places', 'disps', 'hours', 'days'].reduce((n, k) => n + filters[k].size, 0) + (filters.q ? 1 : 0);

export const stateVersion = () => version;

// ---------- URL hash ----------

const NONE = '(none)'; // "no outcome recorded" is a filterable value too

const LIST_KEYS = {
  fam: ['families', (d) => d.families.map((f) => f.id)],
  type: ['types', (d) => d.types],
  place: ['places', (d) => d.groups.map((g) => g.name)],
  disp: ['disps', (d) => d.dispositions],
};

function writeHash() {
  const p = new URLSearchParams();
  if (filters.range) {
    p.set('from', isoOfDay(filters.range[0]));
    p.set('to', isoOfDay(filters.range[1]));
  }
  for (const [param, [key, names]] of Object.entries(LIST_KEYS)) {
    if (filters[key].size) p.set(param, [...filters[key]].map((i) => (i === -1 ? NONE : names(data)[i])).join('|'));
  }
  if (filters.hours.size) p.set('hour', [...filters.hours].join(','));
  if (filters.days.size) p.set('dow', [...filters.days].join(','));
  if (filters.q) p.set('q', filters.q);
  if (selection.index != null) p.set('id', data.incidents.id[selection.index]);
  const hash = `#${p.toString()}`;
  if (hash !== location.hash) history.replaceState(null, '', hash);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const from = p.get('from');
  const to = p.get('to');
  if (from && to) filters.range = [dayFromISO(from), dayFromISO(to)];
  for (const [param, [key, names]] of Object.entries(LIST_KEYS)) {
    filters[key].clear();
    const list = names(data);
    for (const name of (p.get(param) || '').split('|').filter(Boolean)) {
      const i = name === NONE ? -1 : list.indexOf(name);
      if (i !== -1 || name === NONE) filters[key].add(i);
    }
  }
  filters.hours = new Set((p.get('hour') || '').split(',').filter(Boolean).map(Number));
  filters.days = new Set((p.get('dow') || '').split(',').filter(Boolean).map(Number));
  filters.q = p.get('q') || '';
  const id = Number(p.get('id'));
  selection.index = id && data.byId.has(id) ? data.byId.get(id) : null;
}
