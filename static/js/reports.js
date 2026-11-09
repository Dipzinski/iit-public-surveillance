// The Reports page: every IIT Public Safety report as one scrollable list, with its breakdown
// and case file. Filters live in the URL hash, so they carry over from the map page.

import { $, h } from './util.js';
import { loadDataset } from './safety/data.js';
import { init, subscribe } from './safety/state.js';
import { initFilterBar } from './safety/filterbar.js';
import { renderQuickRanges } from './safety/timeline.js';
import { initFeed, initShortcuts } from './safety/feed.js';
import { initFacets } from './safety/facets.js';
import { initDrawer } from './safety/drawer.js';
import { loadMapStyles } from './safety/city-map.js';

try {
  init(await loadDataset());
  initFilterBar();
  const ranges = () => renderQuickRanges($('#report-ranges'));
  subscribe(ranges);
  ranges();
  initFeed();
  initFacets();
  await loadMapStyles().catch(() => {}); // without them the case file just skips its mini-map
  initDrawer();
  initShortcuts();
} catch (err) {
  $('#safety').prepend(h('p', { class: 'note is-error' }, `The Public Safety archive couldn't load: ${err.message}`));
}
