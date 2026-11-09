// Chicago activity: a Citizen-style feed of citywide incidents beside the map. These are
// official records, not radio traffic: police radio is delayed by the city and licensed by
// Broadcastify, so the feed links to it instead of reproducing it.

import { $, h, getJSON, timeAgo, formatDate } from '../util.js';
import { FAMILY_COLORS } from '../safety/colors.js';
import { setCrashLayer, setPoliceLayer, setTrafficLayer, showOnMap } from '../safety/city-map.js';

const MAX_CARDS = 150;
const state = { tab: 'police', police: null, crashes: null, traffic: null };

const TABS = [['police', 'Police'], ['crashes', 'Injury crashes'], ['traffic', 'Live traffic']];
const when = (item) => item.when || item.start;

const NOTES = {
  police() {
    const latest = state.police?.latest;
    return latest ? `Official reports, newest ${formatDate(latest)}. The city publishes them about a week late.` : '';
  },
  crashes: () => 'Crashes with injuries reported to Chicago Police in the last 4 days.',
  traffic: () => 'Live incidents from Illinois DOT.',
};

const CARD = {
  police: (r) => ({
    dot: FAMILY_COLORS[r.family] || FAMILY_COLORS.other, title: r.type, detail: r.detail,
    where: [r.block, r.area].filter(Boolean).join(' · '), tags: r.arrest ? ['Arrest made'] : [],
  }),
  crashes: (c) => ({
    dot: FAMILY_COLORS.traffic, title: `${c.injuries} injured in crash`, detail: c.type, where: c.address,
    tags: [c.fatal ? `${c.fatal} killed` : '', c.hitAndRun ? 'Hit-and-run' : ''].filter(Boolean),
  }),
  traffic: (i) => ({
    dot: i.critical ? '#d03b3b' : '#fab219', title: `${i.kind}${i.road ? ` · ${i.road}` : ''}`,
    detail: i.description === 'Closed.' ? '' : i.description, where: `${i.distanceMi} mi from campus`, tags: [i.critical ? 'Major' : ''].filter(Boolean),
  }),
};

function callout(view, item) {
  return h('div', { class: 'tip' }, h('strong', {}, view.title), view.detail && h('div', { class: 'tip-row' }, view.detail),
    view.where && h('div', { class: 'tip-row' }, view.where), h('div', { class: 'tip-row muted' }, timeAgo(when(item))));
}

function card(item) {
  const view = CARD[state.tab](item);
  return h('button', { type: 'button', class: 'cz', style: `--dot:${view.dot}`, onclick: () => showOnMap(item.lat, item.lon, callout(view, item)) },
    h('span', { class: 'cz-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'cz-body' },
      h('span', { class: 'cz-top' }, h('strong', {}, view.title), h('time', { class: 'mono' }, timeAgo(when(item)))),
      view.detail && h('span', { class: 'cz-detail' }, view.detail),
      view.where && h('span', { class: 'cz-where' }, view.where),
      view.tags.length ? h('span', { class: 'cz-tags' }, view.tags.map((t) => h('span', { class: 'tag' }, t))) : null));
}

function render() {
  $('#activity-tabs').replaceChildren(...TABS.map(([key, label]) => h('button', {
    type: 'button', class: `seg${state.tab === key ? ' on' : ''}`, 'aria-pressed': String(state.tab === key),
    onclick: () => { state.tab = key; render(); $('#activity-list').scrollTop = 0; },
  }, label, h('span', { class: 'mono muted' }, state[key]?.items?.length?.toLocaleString() ?? '…'))));

  const feed = state[state.tab];
  $('#activity-note').textContent = NOTES[state.tab]();
  if (!feed) {
    $('#activity-list').replaceChildren(h('p', { class: 'quiet' }, 'Loading…'));
  } else if (feed.error) {
    $('#activity-list').replaceChildren(h('p', { class: 'note is-error' }, 'The city’s data service isn’t responding. Trying again shortly.'));
  } else if (!feed.items.length) {
    $('#activity-list').replaceChildren(h('p', { class: 'quiet' }, 'Nothing to show right now.'));
  } else {
    $('#activity-list').replaceChildren(...feed.items.slice(0, MAX_CARDS).map(card));
  }
}

async function load(key, path, layer) {
  const result = await fetch(path).then((r) => r.json()).catch((err) => ({ error: err.message }));
  // Keep the last good data on screen if a later refresh fails.
  if (result.error && state[key]?.items) return;
  state[key] = result;
  if (result.items) layer(result.items);
  render();
}

export function refreshActivity() {
  load('police', 'api/chicago/police', setPoliceLayer);
  load('crashes', 'api/chicago/crashes', setCrashLayer);
  load('traffic', 'api/chicago/traffic', setTrafficLayer);
}

export function initActivity() {
  render();
  refreshActivity();
}
