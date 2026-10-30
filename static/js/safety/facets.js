// Facets: ranked counts by type, place and outcome for the current filters.
// Each row is also a filter toggle; selected values stay pinned at the top.

import { $, h } from '../util.js';
import { dataset, filtered, filters, subscribe, toggle } from './state.js';
import { familyColor } from './colors.js';

const NEUTRAL = '#8b97a8';
const LIMIT = 14;

const TABS = [
  { key: 'types', label: 'Type', column: (d) => d.incidents.type, name: (d, v) => d.types[v] },
  { key: 'places', label: 'Place', column: (d) => d.group, name: (d, v) => d.groups[v].name },
  { key: 'disps', label: 'Outcome', column: (d) => d.incidents.disp, name: (d, v) => (v === -1 ? 'No outcome recorded' : d.dispositions[v]) },
];

let active = TABS[0];
let search = '';
let typeFamily = null; // type index -> most common family, for coloring type bars

function familyOfType(data) {
  if (!typeFamily) {
    const votes = new Map();
    data.incidents.type.forEach((t, i) => {
      const fam = data.incidents.family[i];
      const m = votes.get(t) || new Map();
      m.set(fam, (m.get(fam) || 0) + 1);
      votes.set(t, m);
    });
    typeFamily = new Map([...votes].map(([t, m]) => [t, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
  }
  return typeFamily;
}

function render() {
  const data = dataset();
  const column = active.column(data);
  const counts = new Map();
  for (const i of filtered(active.key)) counts.set(column[i], (counts.get(column[i]) || 0) + 1);
  const chosen = filters[active.key];
  const q = search.toLowerCase();
  let items = [...counts].filter(([v]) => !q || active.name(data, v).toLowerCase().includes(q));
  items.sort((a, b) => (chosen.has(b[0]) - chosen.has(a[0])) || b[1] - a[1]);
  const total = items.length;
  items = items.slice(0, Math.max(LIMIT, chosen.size));
  const max = Math.max(1, ...items.map(([, n]) => n));
  const fams = active.key === 'types' ? familyOfType(data) : null;

  $('#facet-tabs').replaceChildren(...TABS.map((tab) =>
    h('button', {
      type: 'button', role: 'tab', class: `seg${tab === active ? ' on' : ''}`, 'aria-selected': String(tab === active),
      onclick: () => { active = tab; search = ''; $('#facet-search').value = ''; render(); },
    }, tab.label, filters[tab.key].size ? h('span', { class: 'seg-count' }, filters[tab.key].size) : null)));

  $('#facet-list').replaceChildren(...items.map(([value, n]) => {
    const on = chosen.has(value);
    const color = fams ? familyColor(data.families[fams.get(value)]) : NEUTRAL;
    return h('li', {}, h('button', {
      type: 'button', class: `facet${on ? ' on' : ''}`, 'aria-pressed': String(on),
      onclick: () => toggle(active.key, value), title: on ? 'Click to remove this filter' : 'Click to filter',
    },
      h('span', { class: 'facet-label' }, active.name(data, value)),
      h('span', { class: 'facet-track' }, h('span', { class: 'facet-bar', style: `width:${(n / max) * 100}%; background:${color}` })),
      h('span', { class: 'facet-n mono' }, n.toLocaleString())));
  }));
  $('#facet-more').textContent = total > items.length ? `Top ${items.length} of ${total} · search to find the rest` : `${total} shown`;
}

export function initFacets() {
  $('#facet-search').addEventListener('input', (e) => { search = e.target.value; render(); });
  subscribe(render);
  render();
}
