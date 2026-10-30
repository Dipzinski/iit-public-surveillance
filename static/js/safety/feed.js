// The incident feed: thousands of rows, but only the ~20 on screen exist in the DOM
// (virtual scrolling), with search terms highlighted and arrow-key / j-k navigation.

import { $, h } from '../util.js';
import { dataset, filtered, filters, select, selection, subscribe } from './state.js';
import { formatDay, formatClock } from './data.js';
import { familyColor } from './colors.js';

const ROW = 84;      // px, must match .feed-row height in CSS
const OVERSCAN = 6;

let list;
let spacer;
let rows = [];
let order = 'newest';
let lastVersionKey = '';

// Wrap each search term in <mark>.
export function highlight(text, terms) {
  if (!terms.length || !text) return [text];
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(pattern).map((part, i) => (i % 2 ? h('mark', {}, part) : part));
}

const terms = () => filters.q.toLowerCase().split(/\s+/).filter(Boolean);

function rowEl(i, top) {
  const data = dataset();
  const inc = data.incidents;
  const fam = data.families[inc.family[i]];
  const place = data.groups[data.group[i]];
  const disp = data.dispositions[inc.disp[i]];
  const q = terms();
  return h('button', {
    type: 'button',
    class: `feed-row${selection.index === i ? ' on' : ''}`,
    style: `top:${top}px; --fam:${familyColor(fam)}`,
    'data-i': i,
    onclick: () => select(i),
  },
    h('div', { class: 'feed-top' },
      h('strong', {}, ...highlight(data.types[inc.type[i]], q)),
      h('span', { class: 'feed-when mono' }, `${formatDay(data.day[i])} · ${inc.approx[i] ? 'time n/a' : formatClock(inc.t[i])}`)),
    h('div', { class: 'feed-meta' }, ...highlight(place.name, q), disp && h('span', { class: 'tag' }, disp)),
    h('div', { class: 'feed-notes' }, ...highlight(inc.notes[i] || 'No notes.', q)));
}

function paint() {
  const height = list.clientHeight || 600;
  const first = Math.max(0, Math.floor(list.scrollTop / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((list.scrollTop + height) / ROW) + OVERSCAN);
  const els = [];
  for (let k = first; k < last; k++) els.push(rowEl(rows[k], k * ROW));
  spacer.replaceChildren(...els);
}

function render() {
  const data = dataset();
  rows = filtered();
  if (order === 'oldest') rows = [...rows].reverse();
  spacer.style.height = `${rows.length * ROW}px`;
  // New filters start the list at the top; selecting a row keeps your place.
  const key = `${filters.range}|${filters.q}|${['families', 'types', 'places', 'disps', 'hours', 'days'].map((k) => [...filters[k]]).join(';')}|${order}`;
  if (key !== lastVersionKey) list.scrollTop = 0;
  lastVersionKey = key;
  paint();
  $('#feed-count').textContent = `${rows.length.toLocaleString()} of ${data.n.toLocaleString()} incidents`;
  $('#feed-empty').hidden = rows.length > 0;
}

// Move the selection by `delta` rows and keep it in view.
export function step(delta) {
  if (!rows.length) return;
  const k = rows.indexOf(selection.index);
  const next = Math.min(rows.length - 1, Math.max(0, k === -1 ? 0 : k + delta));
  const top = next * ROW;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + ROW > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW - list.clientHeight;
  select(rows[next]);
}

export function currentRows() {
  return rows;
}

export function initFeed() {
  list = $('#feed-list');
  spacer = h('div', { class: 'feed-spacer' });
  list.replaceChildren(spacer);
  list.addEventListener('scroll', paint, { passive: true });
  new ResizeObserver(paint).observe(list);
  $('#feed-order').addEventListener('change', (e) => { order = e.target.value; render(); });
  subscribe(render);
  render();
}
