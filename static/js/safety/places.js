// Top locations: the places with the most reports for the current filters, each with a
// sparkline of reports per year and its trend over the last 12 months vs. the 12 before.

import { $, h } from '../util.js';
import { dataset, filtered, filters, subscribe, toggle } from './state.js';
import { today } from './data.js';

const LIMIT = 10;

function sparkline(perYear, first, last) {
  const max = Math.max(1, ...perYear.values());
  const w = 120;
  const hgt = 26;
  const step = w / (last - first);
  const points = [];
  for (let y = first; y <= last; y++) points.push([(y - first) * step, hgt - 2 - ((perYear.get(y) || 0) / max) * (hgt - 6)]);
  const svg = d3.create('svg').attr('width', w).attr('height', hgt).attr('class', 'place-spark').attr('aria-hidden', 'true');
  svg.append('path').attr('d', d3.line().curve(d3.curveMonotoneX)(points)).attr('class', 'spark-line');
  const [lx, ly] = points[points.length - 1];
  svg.append('circle').attr('cx', lx).attr('cy', ly).attr('r', 3).attr('class', 'spark-end');
  return svg.node();
}

function render() {
  const data = dataset();
  const inRange = filtered('places');
  const allTime = filtered(['places', 'range']);
  const counts = new Map();
  for (const i of inRange) {
    const g = data.group[i];
    const q = data.groups[g].quality;
    if (q === 'none' || q === 'campus') continue; // not a specific place
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, LIMIT);
  const wanted = new Set(top.map(([g]) => g));

  const perYear = new Map([...wanted].map((g) => [g, new Map()]));
  const t = today();
  const trend = new Map([...wanted].map((g) => [g, [0, 0]]));
  for (const i of allTime) {
    const g = data.group[i];
    if (!wanted.has(g)) continue;
    const years = perYear.get(g);
    years.set(data.year[i], (years.get(data.year[i]) || 0) + 1);
    const age = t - data.day[i];
    if (age < 365) trend.get(g)[0]++;
    else if (age < 730) trend.get(g)[1]++;
  }
  const first = Math.min(...data.year);
  const last = Math.max(...data.year);
  const max = Math.max(1, ...top.map(([, n]) => n));
  const total = inRange.length;

  $('#places').replaceChildren(...top.map(([g, n], rank) => {
    const place = data.groups[g];
    const [now, before] = trend.get(g);
    const change = before ? Math.round(((now - before) / before) * 100) : null;
    const on = filters.places.has(g);
    return h('li', {}, h('button', { type: 'button', class: `place-row${on ? ' on' : ''}`, onclick: () => toggle('places', g) },
      h('span', { class: 'place-rank mono' }, String(rank + 1).padStart(2, '0')),
      h('span', { class: 'place-main' },
        h('span', { class: 'place-name' }, place.name),
        h('span', { class: 'place-bar' }, h('span', { style: `width:${(n / max) * 100}%` })),
        h('span', { class: 'place-meta mono' }, `${n.toLocaleString()} · ${Math.round((n / total) * 100)}% of view`)),
      sparkline(perYear.get(g), first, last),
      h('span', { class: `place-trend mono ${change > 0 ? 'up' : change < 0 ? 'down' : ''}`, title: 'Last 12 months vs. the 12 before' },
        change == null ? 'new' : `${change > 0 ? '▲' : change < 0 ? '▼' : '='} ${Math.abs(change)}%`)));
  }));
  $('#places-note').textContent = `${first}–${last} sparkline per place · trend = last 12 months vs. the 12 before`;
}

export function initPlaces() {
  subscribe(render);
  render();
}
