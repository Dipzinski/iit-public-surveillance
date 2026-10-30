// The four information panels under the cameras, plus their map layers:
// campus safety log, crime near campus, traffic, and alerts & dispatch.

import { $, h, getJSON, timeAgo, formatDate, formatDateTime, formatWhen, plural } from './util.js';
import { barList, hourChart } from './charts.js';
import { SERIES, dot, incidentMarker, popup, swatch } from './map.js';

const IIT_ALERT_URL = 'https://www.iit.edu/iitalert';
const SCANNER_URL = 'https://www.broadcastify.com/listen/ctid/606';

const state = { site: null, mapView: null, layers: {}, panels: [] };

const PANELS = [
  { id: 'crime', url: '/api/crime', everyMs: 30 * 60_000, render: renderCrime },
  { id: 'traffic', url: '/api/traffic', everyMs: 2 * 60_000, render: renderTraffic },
  { id: 'alerts', url: '/api/alerts', everyMs: 2 * 60_000, render: renderAlerts },
];

// ---------- shared panel pieces ----------

function parts(panel) {
  const el = $(`#panel-${panel.id}`);
  return {
    el,
    stat: el.querySelector('.panel-stat'),
    body: el.querySelector('.panel-body'),
    link: el.querySelector('.panel-link'),
    updated: el.querySelector('.panel-updated'),
  };
}

const section = (title, ...children) => h('section', { class: 'panel-section' }, h('h3', {}, title), children);
const note = (...children) => h('p', { class: 'note' }, children);
const failure = (message) => h('p', { class: 'note is-error' }, `Couldn't load this right now. ${message}`);

function statusBadge(level, label) {
  return h('span', { class: `status ${level}` }, h('span', { class: 'status-icon', 'aria-hidden': 'true' }, '!'), label);
}

function stat(value, label) {
  return [h('b', {}, value), ' ', label];
}

const when = (value) => (/^\d{4}-/.test(value || '') ? formatDateTime(value) : value || '');

// A list row that flies the map to its point when it has one.
function row(item, ...children) {
  const go = item.lat != null && state.mapView ? () => state.mapView.focus(item.lat, item.lon) : null;
  return h('li', {},
    go ? h('button', { type: 'button', class: 'row is-link', onclick: go, title: 'Show on map' }, children)
       : h('div', { class: 'row' }, children));
}

// ---------- crime near campus (Chicago Police reports) ----------

function renderCrime(data, p) {
  p.stat.replaceChildren(...stat(data.total, `reports · ${data.windowDays} days`));
  p.link.href = data.sourceUrl;

  if (!data.total) {
    p.body.replaceChildren(note(`No police reports within ${data.radiusMi} mi in the last ${data.windowDays} days of published data.`));
  } else {
    p.body.replaceChildren(
      note(`Within ${data.radiusMi} mi of campus, ${formatDate(data.windowStart)} – ${formatDate(data.latest)}. `,
        `The city publishes reports about a week late. ${plural(data.arrests, 'arrest')} made.`),
      section('By type', barList(data.byType, { series: '--series-crime', unit: 'reports' })),
      section('By hour of day', hourChart(data.byHour, { series: '--series-crime', unit: 'reports' })),
      section('Most recent',
        h('ul', { class: 'rows' }, data.recent.map((r) => row(r,
          h('div', { class: 'row-top' }, h('strong', {}, r.type), r.arrest && h('span', { class: 'tag' }, 'Arrest')),
          h('div', { class: 'row-meta' }, [r.description, r.block].filter(Boolean).join(' · ')),
          h('div', { class: 'row-meta mono' }, formatDateTime(r.date)))))),
    );
  }

  const layer = state.layers.crime;
  if (!layer) return;
  layer.clearLayers();
  for (const r of data.points) {
    dot(r.lat, r.lon, SERIES.crime)
      .bindPopup(popup(r.type, r.description, r.block, formatDateTime(r.date)))
      .addTo(layer);
  }
}

// ---------- traffic: live incidents + crash patterns ----------

function renderTraffic(data, p) {
  const { live, crashes } = data;
  const sections = [];

  if (live.error) {
    sections.push(section('Live now', failure(live.error)));
  } else {
    const active = live.incidents.filter((i) => !i.longTerm);
    const longTerm = live.incidents.length - active.length;
    p.stat.replaceChildren(...stat(active.length, `live ${active.length === 1 ? 'incident' : 'incidents'}`));
    sections.push(section(`Live now · within ${live.areaMi} mi`,
      active.length
        ? h('ul', { class: 'rows' }, active.map((i) => row(i,
            h('div', { class: 'row-top' },
              statusBadge(i.critical ? 'critical' : 'warning', i.kind),
              h('strong', {}, i.road || (i.closed ? 'Road closed' : ''))),
            i.description && i.description !== 'Closed.' && h('div', { class: 'row-meta' }, i.description),
            h('div', { class: 'row-meta mono' },
              `${i.distanceMi} mi away`, i.start ? ` · since ${formatWhen(i.start)}` : '', i.end ? ` · until ${formatWhen(i.end)}` : ''))))
        : h('p', { class: 'quiet' }, 'No active incidents right now.'),
      longTerm ? note(`Plus ${plural(longTerm, 'long-term closure or construction project', 'long-term closures and construction projects')}, shown on the map.`) : null));
    p.link.href = live.sourceUrl;
  }

  if (crashes.error) {
    sections.push(section('Crash patterns', failure(crashes.error)));
  } else {
    sections.push(section(`Crash patterns · within ${crashes.radiusMi} mi · last ${crashes.windowDays} days`,
      h('div', { class: 'mini-stats' },
        h('span', {}, h('b', {}, crashes.total), ' crashes'),
        h('span', {}, h('b', {}, crashes.withInjuries), ' with injuries'),
        h('span', {}, h('b', {}, crashes.hitAndRun), ' hit-and-run')),
      hourChart(crashes.byHour, { series: '--series-crash', unit: 'crashes' }),
      h('h4', {}, 'Most crashes on'),
      barList(crashes.topStreets.filter((s) => s.label !== 'Other'), { series: '--series-crash', unit: 'crashes' })));
  }
  p.body.replaceChildren(...sections);

  if (state.layers.traffic && !live.error) {
    state.layers.traffic.clearLayers();
    for (const i of live.incidents) {
      incidentMarker(i.lat, i.lon, i.critical)
        .bindPopup(popup(`${i.kind}${i.road ? ` · ${i.road}` : ''}`, i.description,
          i.start && `Since ${formatDateTime(i.start)}`, i.end && `Until ${formatDateTime(i.end)}`))
        .addTo(state.layers.traffic);
    }
  }
  if (state.layers.crash && !crashes.error) {
    state.layers.crash.clearLayers();
    for (const c of crashes.points) {
      dot(c.lat, c.lon, SERIES.crash)
        .bindPopup(popup(c.type || 'Crash', c.address, formatDateTime(c.date),
          c.injuries ? plural(c.injuries, 'injury', 'injuries') : 'No injuries reported', c.hitAndRun && 'Hit-and-run'))
        .addTo(state.layers.crash);
    }
  }
}

// ---------- alerts & dispatch ----------

const SEVERITY = { Extreme: 'critical', Severe: 'critical', Moderate: 'serious', Minor: 'warning' };

function renderAlerts(data, p) {
  const { weather, requests } = data;
  const sections = [];
  const banner = $('#alert-banner');

  if (weather.error) {
    sections.push(section('Weather & sirens', failure(weather.error)));
  } else {
    const alerts = weather.alerts;
    p.stat.replaceChildren(...stat(alerts.length, `weather ${alerts.length === 1 ? 'alert' : 'alerts'}`));
    sections.push(section('Weather & sirens', alerts.length
      ? h('ul', { class: 'rows' }, alerts.map((a) => h('li', {}, h('div', { class: 'row' },
          h('div', { class: 'row-top' }, statusBadge(SEVERITY[a.severity] || 'warning', a.severity), h('strong', {}, a.event)),
          h('div', { class: 'row-meta' }, a.headline),
          a.expires && h('div', { class: 'row-meta mono' }, `Until ${formatDateTime(a.expires)}`)))))
      : note('No active weather alerts for campus. Chicago tests its outdoor warning sirens the first Tuesday of each month at 10 a.m.')));

    // Severe weather is the one thing that should be loud: put it across the top.
    banner.hidden = !alerts.length;
    if (alerts.length) {
      const top = alerts[0];
      const sirens = /tornado warning/i.test(top.event) ? ' Outdoor warning sirens may sound.' : '';
      banner.className = `alert-banner ${SEVERITY[top.severity] || 'warning'}`;
      banner.replaceChildren(statusBadge(SEVERITY[top.severity] || 'warning', top.event), h('span', {}, `${top.headline}${sirens}`));
    }
  }

  if (requests.error) {
    sections.push(section('City 311 requests', failure(requests.error)));
  } else {
    sections.push(section(`City 311 requests · within ${requests.radiusMi} mi · last ${requests.windowDays} days`,
      note(`${plural(requests.total, 'request')}, ${requests.open} still open. Non-emergency city work orders like broken signals, potholes and graffiti.`),
      h('ul', { class: 'rows' }, requests.recent.slice(0, 8).map((r) => h('li', {}, h('div', { class: 'row' },
        h('div', { class: 'row-top' }, h('strong', {}, r.type), h('span', { class: 'tag' }, r.status)),
        h('div', { class: 'row-meta' }, r.address, ' · ', timeAgo(r.created))))))));
  }

  sections.push(section('Emergency contacts',
    h('ul', { class: 'contacts' }, state.site.contacts.map((c) =>
      h('li', {}, h('span', {}, c.label), h('a', { href: `tel:${c.phone.replace(/\D/g, '')}`, class: 'mono' }, c.phone)))),
    note(h('a', { href: IIT_ALERT_URL, target: '_blank', rel: 'noopener' }, 'Sign up for IIT Alert ↗'), ' for official campus emergency texts.')));

  sections.push(section('Dispatch',
    note('Chicago police radio has been encrypted since 2024, and the city’s 911 dispatch data isn’t public, so there’s no live police dispatch feed. ',
      'Fire and EMS scanner audio: ', h('a', { href: SCANNER_URL, target: '_blank', rel: 'noopener' }, 'Broadcastify · Cook County ↗'))));

  p.body.replaceChildren(...sections);
  p.link.href = weather.sourceUrl || 'https://www.weather.gov/lot/';
}

// ---------- loading & scheduling ----------

async function load(panel) {
  panel.nextAt = Date.now() + panel.everyMs;
  const p = parts(panel);
  p.el.classList.add('is-busy');
  try {
    const data = await getJSON(panel.url);
    panel.render(data, p);
    panel.fetchedAt = data.fetchedAt || data.live?.fetchedAt || data.weather?.fetchedAt || new Date().toISOString();
    panel.stale = Boolean(data.stale || data.live?.stale || data.weather?.stale);
    panel.failed = false;
  } catch (err) {
    console.error(err);
    panel.failed = true;
    panel.nextAt = Date.now() + 60_000; // retry sooner
    if (!panel.fetchedAt) p.body.replaceChildren(failure(err.message));
  } finally {
    p.el.classList.remove('is-busy');
    renderUpdated(panel);
  }
}

function renderUpdated(panel) {
  const { updated } = parts(panel);
  if (!panel.fetchedAt) { updated.textContent = panel.failed ? 'Unavailable' : 'Loading…'; return; }
  updated.textContent = `${panel.failed || panel.stale ? 'Last good copy' : 'Updated'} ${timeAgo(panel.fetchedAt)}`;
}

export function renderAges() {
  state.panels.forEach(renderUpdated);
}

// Called every second by main.js while the dashboard isn't paused.
export function tick() {
  for (const panel of state.panels) {
    if (Date.now() >= panel.nextAt) load(panel);
  }
}

export function refreshAll() {
  state.panels.forEach(load);
}

export function initPanels(site, mapView) {
  state.site = site;
  state.mapView = mapView;
  state.panels = PANELS.map((panel) => ({ ...panel, nextAt: 0, fetchedAt: null, failed: false, stale: false }));
  if (mapView) {
    state.layers.traffic = mapView.overlay(`${swatch('#fab219', 'tri')}Traffic incidents (live)`, L.layerGroup());
    state.layers.crime = mapView.overlay(`${swatch(SERIES.crime)}Crime reports (30 days)`, L.layerGroup());
    state.layers.crash = mapView.overlay(`${swatch(SERIES.crash)}Crashes (30 days)`, L.layerGroup(), { visible: false });
  }
}
