// Headline numbers for the current filters (all except the date range, since these
// tiles compare fixed recent windows against the past).

import { $, h } from '../util.js';
import { filtered, filters, dataset, subscribe } from './state.js';
import { today, formatDay } from './data.js';

const fmt = new Intl.NumberFormat('en-US');

function countBetween(days, from, to) {
  let n = 0;
  for (const d of days) if (d >= from && d <= to) n++;
  return n;
}

function delta(now, before) {
  if (!before) return now ? { text: 'new', cls: 'up' } : { text: 'no change', cls: '' };
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { text: 'no change', cls: '' };
  return { text: `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%`, cls: pct > 0 ? 'up' : 'down' };
}

function tile(label, value, sub, extra) {
  return h('div', { class: 'kpi' },
    h('span', { class: 'kpi-label' }, label),
    h('span', { class: 'kpi-value' }, value),
    sub && h('span', { class: `kpi-sub ${sub.cls || ''}` }, sub.text),
    extra);
}

// Last 7 days against the average week of the previous 12, as a meter.
function activityMeter(last7, avg) {
  const ratio = avg ? last7 / avg : 0;
  const label = !avg ? 'Not enough history' : ratio < 0.75 ? 'Quieter than usual' : ratio > 1.25 ? 'Busier than usual' : 'About typical';
  const pos = Math.min(100, (ratio / 2) * 100);
  return h('div', { class: 'kpi kpi-meter' },
    h('span', { class: 'kpi-label' }, 'This week vs. usual'),
    h('span', { class: 'kpi-value meter-label' }, label),
    h('div', { class: 'meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '2', 'aria-valuenow': ratio.toFixed(2),
      'aria-label': `${last7} incidents in the last 7 days; a typical week has ${avg.toFixed(1)}` },
      h('span', { class: 'meter-typical' }),
      h('span', { class: 'meter-mark', style: `left: ${pos}%` })),
    h('span', { class: 'kpi-sub' }, `${last7} vs. ${avg.toFixed(1)} a week (12-week average)`));
}

function render() {
  const data = dataset();
  const rows = filtered('range');
  const days = rows.map((i) => data.day[i]);
  const t = today();

  const last7 = countBetween(days, t - 6, t);
  const avg = countBetween(days, t - 90, t - 7) / 12;
  const last30 = countBetween(days, t - 29, t);
  const prior30 = countBetween(days, t - 394, t - 365);

  const jan1 = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 86400000);
  const ytd = countBetween(days, jan1, t);
  const lastYtd = countBetween(days, jan1 - 365, t - 365);

  // Most common family over the last 30 days.
  const famCounts = new Map();
  for (const i of rows) if (data.day[i] >= t - 29) famCounts.set(data.incidents.family[i], (famCounts.get(data.incidents.family[i]) || 0) + 1);
  const [topFam, topN] = [...famCounts].sort((a, b) => b[1] - a[1])[0] || [null, 0];

  const lastDay = rows.length ? data.day[rows[0]] : null;
  const subject = filters.families.size === 1 ? data.families[[...filters.families][0]].label.toLowerCase()
    : filters.types.size === 1 ? data.types[[...filters.types][0]].toLowerCase() : 'incident';

  $('#kpis').replaceChildren(
    activityMeter(last7, avg),
    tile('Last 30 days', fmt.format(last30), { ...delta(last30, prior30), text: `${delta(last30, prior30).text} vs. same days last year` }),
    tile('Year to date', fmt.format(ytd), { ...delta(ytd, lastYtd), text: `${delta(ytd, lastYtd).text} vs. ${fmt.format(lastYtd)} last year` }),
    tile('Most common lately', topFam == null ? '—' : data.families[topFam].label,
      { text: topFam == null ? 'nothing in 30 days' : `${topN} of ${last30} in the last 30 days` }),
    tile(`Days since last ${subject}`, lastDay == null ? '—' : fmt.format(Math.max(0, t - lastDay)),
      { text: lastDay == null ? 'none on record' : formatDay(lastDay) }),
  );
}

export function initKpis() {
  subscribe(render);
  render();
}
