// The report slider along the bottom of the map: the newest reports matching the current
// filters as cards you can drag, swipe or arrow through. Opening one flies the map to it.

import { $, h } from '../util.js';
import { dataset, filtered, select, selection, subscribe } from './state.js';
import { formatDay, formatClock } from './data.js';
import { familyColor } from './colors.js';
import { renderQuickRanges } from './timeline.js';

const MAX_CARDS = 120;
let track;
let lastKey = '';
let lastPick = null;
let dragged = false;

function card(i) {
  const data = dataset();
  const inc = data.incidents;
  const disp = data.dispositions[inc.disp[i]];
  return h('button', {
    type: 'button', class: 'rcard', 'data-i': i, style: `--fam:${familyColor(data.families[inc.family[i]])}`,
    onclick: () => { if (!dragged) select(i); },
  },
    h('span', { class: 'rcard-when mono' }, `${formatDay(data.day[i])}${inc.approx[i] ? '' : ` · ${formatClock(inc.t[i])}`}`),
    h('strong', {}, data.types[inc.type[i]]),
    h('span', { class: 'rcard-place' }, data.groups[data.group[i]].name),
    h('span', { class: 'rcard-notes' }, inc.notes[i] || disp || 'No notes in the log.'));
}

function render() {
  const data = dataset();
  const rows = filtered();
  const newest = rows.slice(0, MAX_CARDS);
  const key = newest.join(',');
  if (key !== lastKey) {
    lastKey = key;
    track.replaceChildren(...(newest.length ? newest.map(card) : [h('p', { class: 'quiet rcard-empty' }, 'No reports match these filters.')]));
    track.scrollLeft = 0;
  }
  $('#slider-count').textContent = rows.length > MAX_CARDS
    ? `newest ${MAX_CARDS} of ${rows.length.toLocaleString()}`
    : `${rows.length.toLocaleString()} of ${data.n.toLocaleString()}`;
  renderQuickRanges($('#slider-ranges'));

  track.querySelector('.rcard.on')?.classList.remove('on');
  const active = selection.index == null ? null : track.querySelector(`[data-i="${selection.index}"]`);
  if (active) {
    active.classList.add('on');
    if (selection.index !== lastPick) track.scrollTo({ left: active.offsetLeft - (track.clientWidth - active.offsetWidth) / 2, behavior: 'smooth' });
  }
  lastPick = selection.index;
}

// Click and drag with a mouse, the way a touch screen already swipes.
function dragScroll() {
  let startX = 0;
  let startLeft = 0;
  let down = false;
  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    down = true;
    dragged = false;
    startX = e.clientX;
    startLeft = track.scrollLeft;
  });
  window.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (Math.abs(e.clientX - startX) > 5) dragged = true;
    if (dragged) track.scrollLeft = startLeft - (e.clientX - startX);
  });
  window.addEventListener('pointerup', () => {
    down = false;
    setTimeout(() => { dragged = false; }, 0); // let the click that ends a drag be ignored first
  });
}

export function initSlider() {
  track = $('#slider-track');
  dragScroll();
  const page = (direction) => track.scrollBy({ left: direction * track.clientWidth * 0.8, behavior: 'smooth' });
  $('#slider-prev').addEventListener('click', () => page(-1));
  $('#slider-next').addEventListener('click', () => page(1));
  $('#to-dashboard').addEventListener('click', () => $('#safety').scrollIntoView({ behavior: 'smooth' }));
  subscribe(render);
  render();
}
