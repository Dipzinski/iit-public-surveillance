// Two small HTML charts: a ranked bar list and a 24-hour column chart.
// Both are single-series, so the panel title names them and no legend is needed.
// Marks carry the series color; every label and value uses text colors.

import { h, chicagoHour, hourLabel } from './util.js';

const tooltip = h('div', { class: 'chart-tip', role: 'status', hidden: true });
document.body.append(tooltip);

export function showTip(target, text) {
  if (text instanceof Node) tooltip.replaceChildren(text);
  else tooltip.textContent = text;
  tooltip.hidden = false;
  const box = target.getBoundingClientRect();
  const tip = tooltip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - tip.width - 8, Math.max(8, box.left + box.width / 2 - tip.width / 2));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(8, box.top - tip.height - 8)}px`;
}

export function hideTip() {
  tooltip.hidden = true;
}

function withTip(el, text) {
  el.addEventListener('mouseenter', () => showTip(el, text));
  el.addEventListener('focus', () => showTip(el, text));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('blur', hideTip);
  return el;
}

// Horizontal bars, longest first. items: [{ label, count }]
export function barList(items, { series, unit }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return h('ul', { class: 'bar-list', style: `--series: var(${series})` },
    items.map((item) =>
      h('li', {},
        h('span', { class: 'bar-label' }, item.label),
        h('span', { class: 'bar-track' },
          h('span', { class: 'bar', style: `width: ${(item.count / max) * 100}%` })),
        h('span', { class: 'bar-value mono' }, item.count),
      ),
    ),
    h('li', { class: 'sr-only' }, `Counts of ${unit} by type.`),
  );
}

// 24 columns, midnight to 11 PM, with the current hour marked.
export function hourChart(counts, { series, unit }) {
  const max = Math.max(1, ...counts);
  const now = chicagoHour();
  const busiest = counts.indexOf(Math.max(...counts));
  const total = counts.reduce((a, b) => a + b, 0);

  const columns = counts.map((n, hour) => {
    const label = `${hourLabel(hour)}–${hourLabel((hour + 1) % 24)}: ${n} ${unit}`;
    return withTip(
      h('span', { class: `col${hour === now ? ' is-now' : ''}`, tabindex: '0', 'aria-label': label },
        h('span', { class: 'col-bar', style: `height: ${n ? Math.max(4, (n / max) * 100) : 0}%` })),
      label,
    );
  });

  return h('figure', { class: 'hours', style: `--series: var(${series})` },
    h('div', { class: 'hours-plot' }, columns),
    h('div', { class: 'hours-axis mono', 'aria-hidden': 'true' },
      h('span', {}, '12a'), h('span', {}, '6a'), h('span', {}, '12p'), h('span', {}, '6p'), h('span', {}, '12a')),
    h('figcaption', {},
      total ? `Busiest: ${hourLabel(busiest)}–${hourLabel((busiest + 1) % 24)} · ` : '',
      h('span', { class: 'now-key' }, 'outlined'), ' = this hour'),
    // Table view of the same numbers for screen readers.
    h('table', { class: 'sr-only' },
      h('caption', {}, `${unit} by hour of day`),
      h('tbody', {}, counts.map((n, hour) => h('tr', {}, h('th', {}, hourLabel(hour)), h('td', {}, n))))),
  );
}
