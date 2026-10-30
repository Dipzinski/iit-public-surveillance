// The case file: everything known about one incident, styled like a typed report,
// with its spot on the map and the history of the same location.

import { $, h } from '../util.js';
import { dataset, filters, only, select, selection, subscribe } from './state.js';
import { formatWeekday, formatClock, formatDay, today } from './data.js';
import { familyColor } from './colors.js';
import { createBaseMap } from './campus-map.js';
import { highlight, step } from './feed.js';

const PLACEMENT = {
  address: 'Exact address in the log',
  building: 'Building named in the log',
  intersection: 'Street corner in the log',
  block: 'Block range in the log',
  notes: 'Corner mentioned in the notes',
  street: 'Street named, no number',
  campus: 'Somewhere on campus (not specified)',
  none: 'Not given',
};

let miniMap;
let lastShown = null;

function field(label, value, cls = '') {
  return [h('dt', {}, label), h('dd', { class: cls }, value || '—')];
}

// Incidents per year at this place, as tiny columns.
function history(data, group, current) {
  const years = new Map();
  const at = [];
  for (const i of data.newest) {
    if (data.group[i] !== group) continue;
    years.set(data.year[i], (years.get(data.year[i]) || 0) + 1);
    if (i !== current) at.push(i);
  }
  const first = Math.min(...data.year), last = Math.max(...data.year);
  const max = Math.max(1, ...years.values());
  const cols = [];
  for (let y = first; y <= last; y++) {
    const n = years.get(y) || 0;
    cols.push(h('span', { class: 'spark-col', title: `${y}: ${n}` },
      h('span', { class: 'spark-bar', style: `height:${n ? Math.max(8, (n / max) * 100) : 0}%` })));
  }
  const total = [...years.values()].reduce((a, b) => a + b, 0);
  return h('section', { class: 'case-section' },
    h('h3', {}, `At this location · ${total.toLocaleString()} on record`),
    h('div', { class: 'spark', 'aria-label': `Incidents per year here, ${first} to ${last}` }, cols),
    h('div', { class: 'spark-axis mono' }, h('span', {}, first), h('span', {}, last)),
    at.length ? h('ul', { class: 'case-related' }, at.slice(0, 5).map((i) => h('li', {}, h('button', {
      type: 'button', onclick: () => select(i),
    }, h('i', { class: 'swatch', style: `background:${familyColor(data.families[data.incidents.family[i]])}` }),
      h('span', {}, data.types[data.incidents.type[i]]), h('span', { class: 'mono muted' }, formatDay(data.day[i])))))) : null);
}

function render() {
  const drawer = $('#drawer');
  const i = selection.index;
  document.body.classList.toggle('case-open', i != null);
  drawer.hidden = i == null;
  if (i == null) { lastShown = null; return; }
  if (i === lastShown && !filters.q) return; // nothing new to show
  lastShown = i;

  const data = dataset();
  const inc = data.incidents;
  const fam = data.families[inc.family[i]];
  const place = data.groups[data.group[i]];
  const post = data.posts[inc.post[i]];
  const disp = data.dispositions[inc.disp[i]];
  const q = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  const ago = today() - data.day[i];

  $('#case-body').replaceChildren(
    h('div', { class: 'case-kicker' },
      h('span', { class: 'case-fam', style: `--fam:${familyColor(fam)}` }, fam.label),
      h('span', { class: 'mono muted' }, `Report #${inc.id[i]}`)),
    h('h2', { id: 'case-title' }, data.types[inc.type[i]]),
    h('p', { class: 'case-when' }, formatWeekday(data.day[i]), ' · ',
      inc.approx[i] ? 'time not recorded' : formatClock(inc.t[i]),
      h('span', { class: 'muted' }, ago === 0 ? ' · today' : ago === 1 ? ' · yesterday' : ` · ${ago.toLocaleString()} days ago`)),
    h('dl', { class: 'case-grid mono' },
      ...field('Location', place.name),
      ...field('Address', place.address),
      ...field('Placement', PLACEMENT[place.quality]),
      ...field('Area', place.area),
      ...field('Outcome', disp),
      ...field('Campus', data.campuses[inc.campus[i]])),
    h('section', { class: 'case-section' },
      h('h3', {}, 'Officer notes'),
      h('p', { class: 'case-notes' }, ...highlight(inc.notes[i] || 'No notes in the log.', q))),
    h('div', { id: 'case-map', class: 'case-map', hidden: !place.mappable }),
    history(data, data.group[i], i),
    h('div', { class: 'case-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => only('places', data.group[i]) }, 'Only this place'),
      h('button', { type: 'button', class: 'btn', onclick: () => only('types', inc.type[i]) }, 'Only this type'),
      h('a', { class: 'btn', href: post.link, target: '_blank', rel: 'noopener' }, 'Original log ↗')),
    h('p', { class: 'case-source muted' }, `Source: ${post.title}`),
  );

  if (place.mappable && window.L) {
    const el = $('#case-map');
    if (miniMap) miniMap.remove();
    miniMap = createBaseMap(el, { zoom: false });
    miniMap.setView([place.lat, place.lon], 17);
    L.circleMarker([place.lat, place.lon], { radius: 9, weight: 3, color: '#f5f7fa', fillColor: familyColor(fam), fillOpacity: 1 }).addTo(miniMap);
  }
}

export function initDrawer() {
  $('#case-close').addEventListener('click', () => select(null));
  $('#case-prev').addEventListener('click', () => step(-1));
  $('#case-next').addEventListener('click', () => step(1));
  subscribe(render);
  render();
}
