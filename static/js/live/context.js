// Context cards beside the live stream: the neighborhood around campus, and dispatch & contacts.

import { $, h, getJSON } from '../util.js';
import { barList, hourChart } from '../charts.js';
import { dataset } from '../safety/state.js';

const IIT_ALERT_URL = 'https://www.iit.edu/iitalert';
const SCANNER_URL = 'https://www.broadcastify.com/listen/ctid/606';
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });

const big = (value, label) => h('div', { class: 'cmp' }, h('b', {}, value), h('span', {}, label));

// On campus (IIT Public Safety) vs. the blocks around it (Chicago Police), over the same dates.
export async function renderNeighborhood(ready) {
  const el = $('#neighborhood-body');
  const [crime, traffic] = await Promise.all([
    getJSON('/api/crime').catch((e) => ({ error: e.message })),
    getJSON('/api/traffic').catch((e) => ({ crashes: { error: e.message } })),
  ]);
  await ready;
  const parts = [];

  if (crime.error) {
    parts.push(h('p', { class: 'note is-error' }, `Chicago Police data unavailable: ${crime.error}`));
  } else {
    const data = dataset();
    const from = Date.parse(crime.windowStart) / 1000;
    const to = Date.parse(crime.latest) / 1000 + 86400;
    const campus = data ? data.incidents.t.filter((t) => t >= from && t < to).length : null;
    parts.push(
      h('div', { class: 'cmp-row' },
        big(campus == null ? '—' : campus.toLocaleString(), 'IIT Public Safety reports on campus'),
        h('span', { class: 'cmp-vs mono' }, 'vs'),
        big(crime.total.toLocaleString(), `Chicago Police reports within ${crime.radiusMi} mi`)),
      h('p', { class: 'note' }, `${dateFmt.format(new Date(crime.windowStart))} – ${dateFmt.format(new Date(crime.latest))}, the latest 30 days the city has published (it runs about a week behind). `,
        'Police reports cover the streets, businesses and homes around campus; Public Safety covers campus property.'),
      h('div', { class: 'ctx-cols' },
        h('section', {}, h('h3', {}, 'Police reports by type'), barList(crime.byType, { series: '--series-cpd', unit: 'reports' })),
        h('section', {}, h('h3', {}, 'Police reports by hour'), hourChart(crime.byHour, { series: '--series-cpd', unit: 'reports' }))),
    );
  }

  const c = traffic.crashes;
  if (c && !c.error) {
    parts.push(h('section', { class: 'ctx-crashes' },
      h('h3', {}, `Crashes within ${c.radiusMi} mi · last ${c.windowDays} days`),
      h('div', { class: 'mini-stats' },
        h('span', {}, h('b', {}, c.total), ' crashes'),
        h('span', {}, h('b', {}, c.withInjuries), ' with injuries'),
        h('span', {}, h('b', {}, c.hitAndRun), ' hit-and-run'),
        h('span', {}, 'worst: ', h('b', {}, c.topStreets[0]?.label || '—')))));
  }
  el.replaceChildren(...parts);
}

export async function renderDispatch(site) {
  const alerts = await getJSON('/api/alerts').catch(() => null);
  const requests = alerts?.requests;
  $('#dispatch-body').replaceChildren(
    h('ul', { class: 'contacts' }, site.contacts.map((c) =>
      h('li', {}, h('span', {}, c.label), h('a', { href: `tel:${c.phone.replace(/\D/g, '')}`, class: 'mono' }, c.phone)))),
    h('p', { class: 'note' }, h('a', { href: IIT_ALERT_URL, target: '_blank', rel: 'noopener' }, 'Sign up for IIT Alert ↗'),
      ' for official campus emergency texts.'),
    requests && !requests.error && h('p', { class: 'note' },
      `${requests.total} city 311 requests within ${requests.radiusMi} mi this week, ${requests.open} still open (in the live feed).`),
    h('p', { class: 'note' }, 'There is no public live dispatch feed: Chicago police radio has been encrypted since 2024 and ',
      'the city’s 911 dispatch data is internal. Fire and EMS scanner audio: ',
      h('a', { href: SCANNER_URL, target: '_blank', rel: 'noopener' }, 'Broadcastify · Cook County ↗')));
}
