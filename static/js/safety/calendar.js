// Every day since the archive began: one row per year, one cell per day (weeks run left
// to right, Monday at the top). Days outside the chosen range are dimmed. Click a day to
// zoom everything to it, or a year label to select that year.

import { $, h } from '../util.js';
import { showTip, hideTip } from '../charts.js';
import { dataset, filtered, filters, setRange, subscribe } from './state.js';
import { formatWeekday } from './data.js';
import { rampColor, familyColor } from './colors.js';

const LABEL_W = 40;
const GAP = 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const jan1 = (year) => Math.floor(Date.UTC(year, 0, 1) / 86400000);
const RECENT_YEARS = 5;
let allYears = false;

function render() {
  const el = $('#calendar');
  const width = el.clientWidth;
  if (!width) return;
  const data = dataset();
  const counts = new Map();
  const fams = new Map();
  for (const i of filtered('range')) {
    const d = data.day[i];
    counts.set(d, (counts.get(d) || 0) + 1);
    if (!fams.has(d)) fams.set(d, new Map());
    const f = data.incidents.family[i];
    fams.get(d).set(f, (fams.get(d).get(f) || 0) + 1);
  }
  const max = Math.max(1, ...counts.values());
  const oldest = data.year[data.newest[data.newest.length - 1]];
  const last = new Date().getUTCFullYear();
  const first = allYears ? oldest : Math.max(oldest, last - RECENT_YEARS + 1);
  const cell = Math.max(5, Math.min(12, Math.floor((width - LABEL_W) / 54) - GAP));
  const step = cell + GAP;
  const rowH = 7 * step + 10;
  const [from, to] = filters.range;

  const svg = d3.create('svg').attr('width', LABEL_W + 54 * step).attr('height', (last - first + 1) * rowH + 16).attr('class', 'calendar-svg');
  // Month labels along the top.
  MONTHS.forEach((m, k) => {
    const offset = Math.floor((Date.UTC(2021, k, 1) / 86400000 - jan1(2021) + 4) / 7); // 2021 starts on a Friday; close enough for labels
    svg.append('text').attr('class', 'cal-month').attr('x', LABEL_W + offset * step).attr('y', 10).text(m);
  });

  for (let year = last; year >= first; year--) {
    const top = 16 + (last - year) * rowH;
    const start = jan1(year);
    const startDow = (start + 3) % 7; // Monday = 0
    svg.append('text').attr('class', `cal-year${from <= start && to >= jan1(year + 1) - 1 ? ' on' : ''}`)
      .attr('x', 0).attr('y', top + 3.5 * step + 4).text(year)
      .on('click', () => setRange([start, jan1(year + 1) - 1]));
    for (let d = start; d < jan1(year + 1); d++) {
      const week = Math.floor((d - start + startDow) / 7);
      const dow = (d + 3) % 7;
      const n = counts.get(d) || 0;
      const inRange = d >= from && d <= to;
      svg.append('rect')
        .attr('x', LABEL_W + week * step).attr('y', top + dow * step)
        .attr('width', cell).attr('height', cell).attr('rx', 2)
        .attr('fill', rampColor(n, max) || '#1a212d')
        .attr('opacity', inRange ? 1 : 0.28)
        .attr('class', 'cal-day')
        .on('mouseenter', (e) => showTip(e.currentTarget, dayTip(data, d, n, fams.get(d))))
        .on('mouseleave', hideTip)
        .on('click', () => setRange([d, d]));
    }
  }
  el.replaceChildren(svg.node());
  const toggleBtn = $('#calendar-years');
  toggleBtn.textContent = allYears ? `Show last ${RECENT_YEARS} years` : `Show all ${last - oldest + 1} years`;

  const busiest = [...counts].sort((a, b) => b[1] - a[1])[0];
  $('#calendar-note').textContent = busiest
    ? `Busiest day on record for these filters: ${formatWeekday(busiest[0])} (${busiest[1]} reports) · click a day or a year`
    : 'No reports for these filters';
}

function dayTip(data, day, n, fams) {
  return h('div', { class: 'tip' },
    h('strong', {}, `${formatWeekday(day)} · ${n} ${n === 1 ? 'report' : 'reports'}`),
    fams && [...fams].sort((a, b) => b[1] - a[1]).map(([f, c]) => h('div', { class: 'tip-row' },
      h('i', { class: 'swatch', style: `background:${familyColor(data.families[f])}` }), `${data.families[f].label}: ${c}`)),
    h('div', { class: 'tip-hint' }, 'Click to see this day'));
}

export function initCalendar() {
  $('#calendar-years').addEventListener('click', () => { allYears = !allYears; render(); });
  subscribe(render);
  new ResizeObserver(render).observe($('#calendar'));
  render();
  $('#calendar-legend').replaceChildren(
    h('span', {}, 'Fewer'),
    ...['#1a212d', ...['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4']].map((c) => h('i', { class: 'ramp-step', style: `background:${c}` })),
    h('span', {}, 'More'));
}
