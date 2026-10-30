// How the archive was built: posts parsed, reports found, how precisely each is placed,
// and how many reports each year contributes. Not filtered: it describes the data itself.

import { $, h, getJSON, timeAgo } from '../util.js';

// Ordered from most to least precise, on the sequential ramp (brightest = most precise).
const PLACEMENT = [
  ['address', 'Street address', '#9ec5f4'],
  ['building', 'Named building', '#6da7ec'],
  ['intersection', 'Street corner', '#3987e5'],
  ['block', 'Block range', '#2a78d6'],
  ['notes', 'Corner in notes', '#256abf'],
  ['street', 'Street only', '#1c5cab'],
  ['campus', 'Campus only', '#184f95'],
  ['none', 'Not placed', '#2b3443'],
];

const pct = (n, total) => `${Math.round((n / total) * 100)}%`;

export async function initQuality() {
  const s = await getJSON('/api/safety/status').catch(() => null);
  if (!s) return;
  const geoTotal = Object.values(s.geoQuality).reduce((a, b) => a + b, 0);
  const precise = ['address', 'building', 'intersection', 'block'].reduce((n, k) => n + (s.geoQuality[k] || 0), 0);
  const years = Object.entries(s.byYear).sort();
  const maxYear = Math.max(...years.map(([, n]) => n));

  $('#quality').replaceChildren(
    h('div', { class: 'q-stats' },
      stat(s.posts.toLocaleString(), 'blog posts read'),
      stat((s.postKinds.log || 0).toLocaleString(), 'daily logs with reports'),
      stat((s.postKinds.empty || 0).toLocaleString(), '“no incidents” days'),
      stat(geoTotal.toLocaleString(), 'Mies reports'),
      stat(pct(s.withTime, s.incidents), 'have a time'),
      stat(pct(precise, geoTotal), 'placed precisely')),
    h('h3', {}, 'How each report is placed on the map'),
    h('div', { class: 'q-bar', role: 'img', 'aria-label': PLACEMENT.map(([k, l]) => `${l} ${s.geoQuality[k] || 0}`).join(', ') },
      PLACEMENT.map(([k, label, color]) => (s.geoQuality[k]
        ? h('span', { style: `flex:${s.geoQuality[k]}; background:${color}`, title: `${label}: ${s.geoQuality[k]}` }) : null))),
    h('ul', { class: 'q-legend' }, PLACEMENT.map(([k, label, color]) => h('li', {},
      h('i', { class: 'swatch', style: `background:${color}` }), label, h('span', { class: 'mono muted' }, (s.geoQuality[k] || 0).toLocaleString())))),
    h('h3', {}, 'Reports per year in the archive'),
    h('div', { class: 'q-years' }, years.map(([y, n]) => h('span', { class: 'q-year', title: `${y}: ${n} reports` },
      h('span', { class: 'q-year-bar', style: `height:${(n / maxYear) * 100}%` }), h('span', { class: 'mono' }, `’${y.slice(2)}`)))),
    h('p', { class: 'hint' }, `Parser v${s.parserVersion} reads every log format since 2014 · last checked ${s.sync.lastSync ? timeAgo(s.sync.lastSync * 1000) : 'at startup'}`),
  );
}

function stat(value, label) {
  return h('div', { class: 'q-stat' }, h('b', {}, value), h('span', {}, label));
}
