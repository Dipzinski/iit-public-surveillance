// Search box, active-filter chips, and the share / export actions.

import { $, h } from '../util.js';
import { activeCount, clearAll, dataset, filtered, filters, setQuery, subscribe, toggle } from './state.js';
import { isoOfDay } from './data.js';
import { familyColor } from './colors.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourName = (h24) => `${h24 % 12 || 12} ${h24 < 12 ? 'AM' : 'PM'}`;

function chip(label, onRemove, color) {
  return h('span', { class: 'chip-filter' },
    color && h('i', { class: 'swatch', style: `background:${color}` }),
    label,
    h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove filter ${label}`, onclick: onRemove }, '×'));
}

function render() {
  const data = dataset();
  const chips = [];
  for (const i of filters.families) chips.push(chip(data.families[i].label, () => toggle('families', i), familyColor(data.families[i])));
  for (const i of filters.types) chips.push(chip(data.types[i], () => toggle('types', i)));
  for (const i of filters.places) chips.push(chip(data.groups[i].name, () => toggle('places', i)));
  for (const i of filters.disps) chips.push(chip(i === -1 ? 'No outcome recorded' : data.dispositions[i], () => toggle('disps', i)));
  for (const d of filters.days) chips.push(chip(WEEKDAYS[d], () => toggle('days', d)));
  for (const hr of filters.hours) chips.push(chip(`${hourName(hr)} hour`, () => toggle('hours', hr)));
  if (filters.q) chips.push(chip(`“${filters.q}”`, () => { $('#search').value = ''; setQuery(''); }));

  $('#filter-chips').replaceChildren(...chips);
  $('#clear-filters').hidden = activeCount() === 0;
  if (document.activeElement !== $('#search')) $('#search').value = filters.q;
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
}

// The current view as a CSV file, built in the browser.
function exportCsv() {
  const data = dataset();
  const inc = data.incidents;
  const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['report_id', 'date', 'time', 'family', 'type', 'place', 'address', 'placement', 'outcome', 'notes', 'source'];
  const lines = [header.join(',')];
  for (const i of filtered()) {
    const place = data.groups[data.group[i]];
    const time = inc.approx[i] ? '' : new Date(inc.t[i] * 1000).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' });
    lines.push([inc.id[i], isoOfDay(data.day[i]), time, data.families[inc.family[i]].label, data.types[inc.type[i]], place.name,
      place.address, place.quality, data.dispositions[inc.disp[i]] || '', inc.notes[i], data.posts[inc.post[i]].link].map(quote).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `iit-dps-incidents-${isoOfDay(filters.range[0])}-to-${isoOfDay(filters.range[1])}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${(lines.length - 1).toLocaleString()} incidents`);
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link to this view copied');
  } catch {
    toast('Copy the address bar to share this view');
  }
}

export function initFilterBar() {
  const search = $('#search');
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => setQuery(search.value.trim()), 120);
  });
  $('#clear-filters').addEventListener('click', clearAll);
  $('#export-csv').addEventListener('click', exportCsv);
  $('#copy-link').addEventListener('click', copyLink);
  subscribe(render);
  render();
}

export { toast };
