// 24-hour radial clock: one wedge per hour (midnight at the top), wedge length ∝ reports,
// with a hand showing the current time in Chicago. Click a wedge to filter by that hour.

import { $, h } from '../util.js';
import { showTip, hideTip } from '../charts.js';
import { dataset, filtered, filters, subscribe, toggle } from './state.js';

const COLOR = '#5cc8ff';
const label = (hr) => `${hr % 12 || 12} ${hr < 12 ? 'AM' : 'PM'}`;

function chicagoNow() {
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: 'America/Chicago' })
    .formatToParts(new Date());
  return Number(parts.find((p) => p.type === 'hour').value) + Number(parts.find((p) => p.type === 'minute').value) / 60;
}

function render() {
  const el = $('#clock');
  const size = Math.min(320, el.clientWidth || 300);
  const R = size / 2 - 22;
  const r0 = R * 0.3;
  const data = dataset();
  const counts = new Array(24).fill(0);
  for (const i of filtered('hours')) counts[data.hour[i]]++;
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  const busiest = counts.indexOf(max);
  const r = d3.scaleSqrt().domain([0, max]).range([r0, R]);
  const angle = (hr) => (hr / 24) * 2 * Math.PI;

  const svg = d3.create('svg').attr('viewBox', `${-size / 2} ${-size / 2} ${size} ${size}`).attr('width', size).attr('height', size)
    .attr('class', 'clock-svg').attr('role', 'img')
    .attr('aria-label', `Reports by hour of day; busiest ${label(busiest)} to ${label((busiest + 1) % 24)}`);

  for (const f of [0.5, 1]) svg.append('circle').attr('class', 'clock-ring').attr('r', r(max * f));
  svg.append('circle').attr('class', 'clock-ring').attr('r', r0);

  const arc = d3.arc().innerRadius(r0).padAngle(0.012).padRadius(R);
  counts.forEach((n, hr) => {
    const on = filters.hours.has(hr);
    svg.append('path')
      .attr('d', arc({ startAngle: angle(hr), endAngle: angle(hr + 1), outerRadius: r(n) }))
      .attr('fill', COLOR)
      .attr('fill-opacity', filters.hours.size && !on ? 0.25 : 0.85)
      .attr('stroke', on ? '#f5f7fa' : 'none').attr('stroke-width', 2)
      .attr('class', 'clock-wedge')
      .attr('tabindex', 0)
      .attr('aria-label', `${label(hr)}: ${n} reports`)
      .on('mouseenter', (e) => showTip(e.currentTarget, `${label(hr)}–${label((hr + 1) % 24)} · ${n.toLocaleString()} reports (${total ? Math.round((n / total) * 100) : 0}%)`))
      .on('mouseleave', hideTip)
      .on('click', () => toggle('hours', hr))
      .on('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle('hours', hr); } });
  });

  for (const [hr, text] of [[0, '12a'], [6, '6a'], [12, '12p'], [18, '6p']]) {
    const a = angle(hr) - Math.PI / 2;
    svg.append('text').attr('class', 'clock-label').attr('x', Math.cos(a) * (R + 12)).attr('y', Math.sin(a) * (R + 12) + 4)
      .attr('text-anchor', 'middle').text(text);
  }

  // The current time in Chicago.
  const now = angle(chicagoNow()) - Math.PI / 2;
  svg.append('line').attr('class', 'clock-hand').attr('x1', 0).attr('y1', 0).attr('x2', Math.cos(now) * (R + 4)).attr('y2', Math.sin(now) * (R + 4));
  svg.append('circle').attr('class', 'clock-pin').attr('r', 4);
  svg.append('text').attr('class', 'clock-center').attr('y', -4).attr('text-anchor', 'middle').text(total ? label(busiest) : '—');
  svg.append('text').attr('class', 'clock-center-sub').attr('y', 12).attr('text-anchor', 'middle').text('busiest hour');

  el.replaceChildren(svg.node());
  $('#clock-note').textContent = total
    ? `${Math.round((counts.slice(18).concat(counts.slice(0, 6)).reduce((a, b) => a + b, 0) / total) * 100)}% happen between 6 PM and 6 AM · hand = now`
    : 'No reports for these filters';
}

export function initClock() {
  subscribe(render);
  new ResizeObserver(render).observe($('#clock'));
  setInterval(render, 60_000);
  render();
}
