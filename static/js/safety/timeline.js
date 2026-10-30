// Focus + context timeline (D3).
//   context (bottom): weekly totals for the whole archive; drag the brush to choose a date range
//   focus   (top):    the chosen range, stacked by family, binned by day / week / month to fit
// Both respect every other filter, so filtering to "Theft" redraws the whole history of thefts.

import { $, h } from '../util.js';
import { showTip, hideTip } from '../charts.js';
import { dataset, filtered, filters, setRange, subscribe, toggle } from './state.js';
import { dayDate, formatDay, today } from './data.js';
import { familyColor } from './colors.js';

const FOCUS_H = 200;
const CONTEXT_H = 64;
const M = { l: 36, r: 10, t: 10, b: 22 };
const SURFACE = '#131821';

let focusRoot;
let contextRoot;
let brush;
let brushLayer;
let contextX;
let contextKey = '';
let moving = false;   // the brush is being moved by code, not by the user
let dragging = false; // the user is dragging the brush
let pending = null;

// ---------- binning ----------

function binSize(span) {
  if (span <= 120) return 'day';
  if (span <= 1100) return 'week';
  return 'month';
}

function binStart(day, size) {
  if (size === 'day') return day;
  if (size === 'week') return day - ((day + 3) % 7); // Monday
  const d = dayDate(day);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86400000);
}

function nextBin(start, size) {
  if (size === 'day') return start + 1;
  if (size === 'week') return start + 7;
  const d = dayDate(start);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 86400000);
}

const binLabel = (start, size) => (size === 'day' ? formatDay(start)
  : size === 'week' ? `Week of ${formatDay(start)}`
  : new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(dayDate(start)));

// ---------- render ----------

function render() {
  const data = dataset();
  const width = focusRoot.clientWidth;
  if (!width) return;
  const rows = filtered('range');
  const [from, to] = filters.range;
  const size = binSize(to - from + 1);
  const nFam = data.families.length;

  // Focus bins: counts per family.
  const bins = new Map();
  for (const i of rows) {
    const d = data.day[i];
    if (d < from || d > to) continue;
    const start = binStart(d, size);
    if (!bins.has(start)) bins.set(start, new Array(nFam).fill(0));
    bins.get(start)[data.incidents.family[i]]++;
  }
  const binList = [];
  for (let s = binStart(from, size); s <= to; s = nextBin(s, size)) binList.push({ start: s, counts: bins.get(s) || new Array(nFam).fill(0) });
  const maxTotal = Math.max(1, ...binList.map((b) => b.counts.reduce((a, c) => a + c, 0)));

  const svg = d3.create('svg').attr('width', width).attr('height', FOCUS_H).attr('class', 'timeline-svg');
  const x = d3.scaleUtc().domain([dayDate(from), dayDate(to + 1)]).range([M.l, width - M.r]);
  const y = d3.scaleLinear().domain([0, maxTotal]).nice(4).range([FOCUS_H - M.b, M.t]);

  // Recessive grid and axes.
  svg.append('g').attr('class', 'grid').attr('transform', `translate(${M.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(-(width - M.l - M.r)).tickFormat(d3.format('d')))
    .call((g) => g.select('.domain').remove());
  svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${FOCUS_H - M.b})`)
    .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(width / 110))).tickSizeOuter(0));

  // Stacked columns. A 1px surface stroke on every segment leaves a 2px gap between neighbors.
  const focus = svg.append('g');
  for (const bin of binList) {
    // The first bin can start before the range (e.g. mid-week); clip it at the axis.
    const x0 = Math.max(M.l, x(dayDate(bin.start)));
    const x1 = x(dayDate(Math.min(nextBin(bin.start, size), to + 1)));
    const w = Math.max(1, x1 - x0);
    let acc = 0;
    bin.counts.forEach((count, fam) => {
      if (!count) return;
      focus.append('rect')
        .attr('x', x0).attr('width', w)
        .attr('y', y(acc + count)).attr('height', Math.max(0.5, y(acc) - y(acc + count)))
        .attr('fill', familyColor(data.families[fam]))
        .attr('stroke', w > 3 ? SURFACE : 'none').attr('stroke-width', 1);
      acc += count;
    });
    // Hover / click target covering the whole column.
    const total = bin.counts.reduce((a, c) => a + c, 0);
    focus.append('rect').attr('class', 'hit')
      .attr('x', x0).attr('width', w).attr('y', M.t).attr('height', FOCUS_H - M.b - M.t)
      .attr('fill', 'transparent')
      .on('mouseenter', (event) => showTip(event.currentTarget, binTip(data, bin, total, size)))
      .on('mouseleave', hideTip)
      .on('click', () => { if (size !== 'day') setRange([bin.start, nextBin(bin.start, size) - 1]); });
  }

  focusRoot.replaceChildren(svg.node());

  // The context strip only depends on the non-date filters; rebuilding it mid-drag would drop the brush.
  const key = [width, ...['families', 'types', 'places', 'disps', 'hours', 'days'].map((k) => [...filters[k]].join(',')), filters.q].join('|');
  if (key !== contextKey) {
    contextKey = key;
    drawContext(data, rows, width);
  } else if (!dragging) {
    moveBrush();
  }
  $('#timeline-bin').textContent = `${total(binList)} incidents · per ${size}`;
}

const total = (bins) => bins.reduce((n, b) => n + b.counts.reduce((a, c) => a + c, 0), 0).toLocaleString();

function binTip(data, bin, total, size) {
  const lines = bin.counts.map((c, fam) => [c, fam]).filter(([c]) => c).sort((a, b) => b[0] - a[0]);
  return h('div', { class: 'tip' },
    h('strong', {}, `${binLabel(bin.start, size)} · ${total} ${total === 1 ? 'incident' : 'incidents'}`),
    lines.map(([c, fam]) => h('div', { class: 'tip-row' },
      h('i', { class: 'swatch', style: `background:${familyColor(data.families[fam])}` }), `${data.families[fam].label}: ${c}`)),
    size !== 'day' && h('div', { class: 'tip-hint' }, 'Click to zoom in'));
}

function drawContext(data, rows, width) {
  const svg = d3.create('svg').attr('width', width).attr('height', CONTEXT_H).attr('class', 'timeline-svg');
  const g = svg.append('g');
  const first = binStart(data.firstDay, 'week');
  const last = data.lastDay;
  const weeks = new Map();
  for (const i of rows) {
    const w = binStart(data.day[i], 'week');
    weeks.set(w, (weeks.get(w) || 0) + 1);
  }
  const series = [];
  for (let w = first; w <= last; w += 7) series.push([w, weeks.get(w) || 0]);

  contextX = d3.scaleUtc().domain([dayDate(first), dayDate(last + 1)]).range([M.l, width - M.r]);
  const cy = d3.scaleLinear().domain([0, d3.max(series, (d) => d[1]) || 1]).range([CONTEXT_H - 20, 2]);
  g.append('path')
    .datum(series)
    .attr('class', 'context-area')
    .attr('d', d3.area().curve(d3.curveStepAfter).x((d) => contextX(dayDate(d[0]))).y0(CONTEXT_H - 20).y1((d) => cy(d[1])));
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${CONTEXT_H - 20})`)
    .call(d3.axisBottom(contextX).ticks(d3.utcYear.every(width > 700 ? 1 : 2)).tickFormat(d3.utcFormat('%Y')).tickSizeOuter(0));

  brush = d3.brushX()
    .extent([[M.l, 0], [width - M.r, CONTEXT_H - 20]])
    .on('start', (event) => { if (event.sourceEvent) dragging = true; })
    .on('brush', brushed)
    .on('end', (event) => { brushed(event); dragging = false; });
  brushLayer = g.append('g').attr('class', 'brush').call(brush);
  contextRoot.replaceChildren(svg.node());
  moveBrush();
}

function moveBrush() {
  if (!brushLayer) return;
  moving = true;
  brushLayer.call(brush.move, [contextX(dayDate(filters.range[0])), contextX(dayDate(filters.range[1] + 1))]);
  moving = false;
}

function brushed(event) {
  if (moving || !event.sourceEvent) return;
  if (!event.selection) { moveBrush(); return; } // a click without a drag keeps the current range
  const [a, b] = event.selection.map((px) => Math.round(contextX.invert(px).getTime() / 86400000));
  const range = [a, Math.max(a, b - 1)];
  // Re-filtering everything on every mouse move is wasteful; settle at ~15 updates a second.
  clearTimeout(pending);
  if (event.type === 'end') setRange(range);
  else pending = setTimeout(() => setRange(range), 60);
}

// ---------- header: quick ranges + family legend ----------

function renderHeader() {
  const data = dataset();
  const t = today();
  const quick = [['30D', 29], ['90D', 89], ['1Y', 364], ['3Y', 365 * 3 - 1], ['All', null]];
  const [from, to] = filters.range;
  $('#timeline-quick').replaceChildren(...quick.map(([label, back]) => {
    const range = back == null ? [data.firstDay, data.lastDay] : [t - back, t];
    const on = from === range[0] && to === range[1];
    return h('button', { type: 'button', class: `seg${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: () => setRange(range) }, label);
  }));
  $('#timeline-range').textContent = `${formatDay(from)} – ${formatDay(to)}`;

  // Legend doubles as the family filter.
  const rows = filtered('families');
  const counts = new Array(data.families.length).fill(0);
  for (const i of rows) counts[data.incidents.family[i]]++;
  $('#family-legend').replaceChildren(...data.families.map((fam, i) => {
    const on = filters.families.has(i);
    const dim = filters.families.size && !on;
    return h('button', {
      type: 'button', class: `legend-chip${on ? ' on' : ''}${dim ? ' dim' : ''}`, 'aria-pressed': String(on),
      onclick: () => toggle('families', i), title: `Show only ${fam.label} (toggle)`,
    }, h('i', { class: 'swatch', style: `background:${familyColor(fam)}` }), fam.label, h('span', { class: 'mono' }, counts[i].toLocaleString()));
  }));
}

export function initTimeline() {
  focusRoot = $('#timeline-focus');
  contextRoot = $('#timeline-context');
  const draw = () => { renderHeader(); render(); };
  subscribe(draw);
  new ResizeObserver(() => render()).observe(focusRoot);
  draw();
}
