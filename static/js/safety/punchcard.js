// Day-of-week × hour-of-day heatmap. Click a cell for that weekday and hour,
// a weekday label for the whole day, an hour label for that hour every day.

import { $, h } from '../util.js';
import { showTip, hideTip } from '../charts.js';
import { dataset, filtered, filters, setDayHour, subscribe, toggle } from './state.js';
import { rampColor, RAMP } from './colors.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLabel = (hr) => `${hr % 12 || 12}${hr < 12 ? 'a' : 'p'}`;

function render() {
  const data = dataset();
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const i of filtered(['days', 'hours'])) grid[data.dow[i]][data.hour[i]]++;
  const max = Math.max(1, ...grid.flat());

  const cells = [h('span', {})];
  for (let hr = 0; hr < 24; hr++) {
    cells.push(h('button', {
      type: 'button', class: `pc-hour mono${filters.hours.has(hr) ? ' on' : ''}`, onclick: () => toggle('hours', hr),
      'aria-label': `Filter to ${hourLabel(hr)} every day`,
    }, hr % 3 === 0 ? hourLabel(hr) : ''));
  }
  grid.forEach((row, d) => {
    cells.push(h('button', { type: 'button', class: `pc-day${filters.days.has(d) ? ' on' : ''}`, onclick: () => toggle('days', d) }, DAYS[d]));
    row.forEach((n, hr) => {
      const selected = filters.days.has(d) && filters.hours.has(hr);
      const dim = (filters.days.size && !filters.days.has(d)) || (filters.hours.size && !filters.hours.has(hr));
      const cell = h('button', {
        type: 'button',
        class: `pc-cell${selected ? ' on' : ''}${dim ? ' dim' : ''}`,
        style: `background:${rampColor(n, max) || 'var(--surface-2)'}`,
        'aria-label': `${DAYS[d]} ${hourLabel(hr)}: ${n} reports`,
        onclick: () => setDayHour(d, hr),
      });
      cell.addEventListener('mouseenter', () => showTip(cell, `${DAYS[d]} ${hourLabel(hr)}–${hourLabel((hr + 1) % 24)} · ${n} reports`));
      cell.addEventListener('mouseleave', hideTip);
      cells.push(cell);
    });
  });

  $('#punchcard').replaceChildren(h('div', { class: 'pc-grid' }, cells));
  $('#punchcard-legend').replaceChildren(
    h('span', {}, 'Fewer'),
    ...RAMP.map((c) => h('i', { class: 'ramp-step', style: `background:${c}` })),
    h('span', {}, 'More'));
}

export function initPunchcard() {
  subscribe(render);
  render();
}
