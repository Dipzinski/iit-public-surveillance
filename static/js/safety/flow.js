// Alluvial flow from incident family (left) to recorded outcome (right). Band width ∝ reports.
// Click a family or an outcome to filter by it. Logs before 2017 rarely recorded an outcome,
// so "No outcome recorded" is shown as its own node rather than hidden.

import { $, h } from '../util.js';
import { showTip, hideTip } from '../charts.js';
import { dataset, filtered, filters, subscribe, toggle } from './state.js';
import { familyColor } from './colors.js';

const TOP_OUTCOMES = 6;
const NODE_W = 10;
const PAD = 6;
const NONE = -1;
const OTHER = -2;

function render() {
  const el = $('#flow');
  const width = el.clientWidth;
  if (!width) return;
  const data = dataset();
  const rows = filtered(['families', 'disps']);
  const inc = data.incidents;

  const outcomeCounts = new Map();
  for (const i of rows) if (inc.disp[i] !== NONE) outcomeCounts.set(inc.disp[i], (outcomeCounts.get(inc.disp[i]) || 0) + 1);
  const top = [...outcomeCounts].sort((a, b) => b[1] - a[1]).slice(0, TOP_OUTCOMES).map(([d]) => d);
  const outcomeOf = (d) => (d === NONE ? NONE : top.includes(d) ? d : OTHER);
  const outcomeName = (o) => (o === NONE ? 'No outcome recorded' : o === OTHER ? 'Other outcomes' : data.dispositions[o]);

  const links = new Map(); // "fam|outcome" -> count
  const left = new Map();
  const right = new Map();
  for (const i of rows) {
    const f = inc.family[i];
    const o = outcomeOf(inc.disp[i]);
    links.set(`${f}|${o}`, (links.get(`${f}|${o}`) || 0) + 1);
    left.set(f, (left.get(f) || 0) + 1);
    right.set(o, (right.get(o) || 0) + 1);
  }
  const total = rows.length;
  if (!total) { el.replaceChildren(h('p', { class: 'quiet' }, 'No reports for these filters.')); return; }

  // Label columns scale with the card; long names are shortened to fit (full text in the tooltip).
  const labelL = Math.min(170, Math.round(width * 0.3));
  const labelR = Math.min(210, Math.round(width * 0.34));
  const fit = (text, px) => (text.length * 6.6 > px ? `${text.slice(0, Math.max(3, Math.floor(px / 6.6) - 1))}…` : text);
  const height = 300;
  const leftNodes = data.families.map((_, f) => f).filter((f) => left.has(f));
  const rightNodes = [...top, OTHER, NONE].filter((o) => right.has(o));
  const scale = (n) => (height - PAD * (Math.max(leftNodes.length, rightNodes.length) - 1)) * (n / total);

  const place = (nodes, counts) => {
    let y = 0;
    const pos = new Map();
    for (const node of nodes) { pos.set(node, { y, h: scale(counts.get(node)) }); y += scale(counts.get(node)) + PAD; }
    return pos;
  };
  const L = place(leftNodes, left);
  const R = place(rightNodes, right);
  const x0 = labelL;
  const x1 = width - labelR;
  const svg = d3.create('svg').attr('width', width).attr('height', height + 4).attr('class', 'flow-svg');

  // Bands, stacked within each node in the other side's order so they don't cross more than needed.
  const lOff = new Map(leftNodes.map((f) => [f, 0]));
  const rOff = new Map(rightNodes.map((o) => [o, 0]));
  for (const f of leftNodes) {
    for (const o of rightNodes) {
      const n = links.get(`${f}|${o}`);
      if (!n) continue;
      const w = scale(n);
      const ya = L.get(f).y + lOff.get(f);
      const yb = R.get(o).y + rOff.get(o);
      lOff.set(f, lOff.get(f) + w);
      rOff.set(o, rOff.get(o) + w);
      const xm = (x0 + NODE_W + x1) / 2;
      const d = `M${x0 + NODE_W},${ya} C${xm},${ya} ${xm},${yb} ${x1},${yb} L${x1},${yb + w} C${xm},${yb + w} ${xm},${ya + w} ${x0 + NODE_W},${ya + w} Z`;
      const fam = data.families[f];
      svg.append('path').attr('d', d).attr('class', 'flow-band').attr('fill', familyColor(fam))
        .attr('fill-opacity', (filters.families.size && !filters.families.has(f)) ? 0.08 : 0.32)
        .on('mouseenter', (e) => showTip(e.currentTarget, `${fam.label} → ${outcomeName(o)}: ${n.toLocaleString()} (${Math.round((n / left.get(f)) * 100)}% of ${fam.label.toLowerCase()})`))
        .on('mouseleave', hideTip);
    }
  }

  for (const f of leftNodes) {
    const { y, h: hh } = L.get(f);
    const fam = data.families[f];
    const on = filters.families.has(f);
    const g = svg.append('g').attr('class', 'flow-node').on('click', () => toggle('families', f));
    g.append('rect').attr('x', x0).attr('y', y).attr('width', NODE_W).attr('height', Math.max(1, hh)).attr('fill', familyColor(fam))
      .attr('stroke', on ? '#f5f7fa' : 'none').attr('stroke-width', 2);
    if (hh >= 9) g.append('text').attr('x', x0 - 8).attr('y', y + hh / 2 + 4).attr('text-anchor', 'end').text(fit(`${fam.label} ${left.get(f)}`, labelL - 10));
    g.append('title').text(`${fam.label}: ${left.get(f)}`);
  }
  for (const o of rightNodes) {
    const { y, h: hh } = R.get(o);
    const on = o !== OTHER && filters.disps.has(o);
    const g = svg.append('g').attr('class', `flow-node${o === OTHER ? ' static' : ''}`);
    if (o !== OTHER) g.on('click', () => toggle('disps', o));
    g.append('rect').attr('x', x1).attr('y', y).attr('width', NODE_W).attr('height', Math.max(1, hh)).attr('fill', '#8b97a8')
      .attr('stroke', on ? '#f5f7fa' : 'none').attr('stroke-width', 2);
    if (hh >= 9) g.append('text').attr('x', x1 + NODE_W + 8).attr('y', y + hh / 2 + 4).text(fit(`${outcomeName(o)} ${right.get(o)}`, labelR - NODE_W - 10));
    g.append('title').text(`${outcomeName(o)}: ${right.get(o)}`);
  }
  el.replaceChildren(svg.node());
}

export function initFlow() {
  subscribe(render);
  new ResizeObserver(render).observe($('#flow'));
  render();
}
