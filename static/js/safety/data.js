// Loads the archive dataset once and derives the per-incident fields every view needs.
// All times are handled in Chicago local time; the DST rule is computed directly
// (fast enough for thousands of rows, unlike Intl per row).

const DAY = 86400;

const dstCache = new Map();
function dstBounds(year) {
  if (!dstCache.has(year)) {
    // US rule since 2007: second Sunday of March 2 AM CST to first Sunday of November 2 AM CDT.
    const marchFirst = new Date(Date.UTC(year, 2, 1)).getUTCDay();
    const start = Date.UTC(year, 2, 1 + ((7 - marchFirst) % 7) + 7, 8) / 1000;
    const novFirst = new Date(Date.UTC(year, 10, 1)).getUTCDay();
    const end = Date.UTC(year, 10, 1 + ((7 - novFirst) % 7), 7) / 1000;
    dstCache.set(year, [start, end]);
  }
  return dstCache.get(year);
}

export function chicagoOffset(t) {
  const [start, end] = dstBounds(new Date(t * 1000).getUTCFullYear());
  return t >= start && t < end ? -5 * 3600 : -6 * 3600;
}

// Day number (days since 1970-01-01) of a Unix time, in Chicago.
export const dayOf = (t) => Math.floor((t + chicagoOffset(t)) / DAY);
export const today = () => dayOf(Date.now() / 1000);

// A day number as a Date at UTC midnight. Format it with timeZone 'UTC' to get the Chicago date back.
export const dayDate = (day) => new Date(day * DAY * 1000);
export const dayFromISO = (iso) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);
export const isoOfDay = (day) => dayDate(day).toISOString().slice(0, 10);

const fmt = (opts) => new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
const dayFmt = fmt({ month: 'short', day: 'numeric', year: 'numeric' });
const shortDayFmt = fmt({ month: 'short', day: 'numeric' });
const weekdayFmt = fmt({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
export const formatDay = (day) => dayFmt.format(dayDate(day));
export const formatShortDay = (day) => shortDayFmt.format(dayDate(day));
export const formatWeekday = (day) => weekdayFmt.format(dayDate(day));

const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
export const formatClock = (t) => timeFmt.format(new Date(t * 1000));

export class BuildingArchive extends Error {}

export async function loadDataset() {
  const res = await fetch('/api/safety/dataset', { cache: 'no-cache' });
  if (res.status === 503) throw new BuildingArchive('archive is being built');
  const raw = await res.json();
  if (!res.ok) throw new Error(raw.error || `HTTP ${res.status}`);
  return decode(raw);
}

function decode(raw) {
  const inc = raw.incidents;
  const n = raw.count;
  const day = new Int32Array(n);
  const hour = new Int8Array(n);
  const dow = new Int8Array(n); // 0 = Monday
  const year = new Int16Array(n);
  const text = new Array(n);

  for (let i = 0; i < n; i++) {
    const local = inc.t[i] + chicagoOffset(inc.t[i]);
    day[i] = Math.floor(local / DAY);
    hour[i] = Math.floor((local % DAY) / 3600);
    dow[i] = (day[i] + 3) % 7;
    year[i] = new Date(local * 1000).getUTCFullYear();
    const place = raw.places[inc.place[i]];
    text[i] = [raw.types[inc.type[i]], place.name, place.address, raw.dispositions[inc.disp[i]] || '', inc.notes[i]]
      .join(' ').toLowerCase();
  }

  // One "place" per name, positioned by its most precise mention.
  const RANK = ['address', 'building', 'intersection', 'block', 'notes', 'street', 'campus', 'none'];
  const groups = [];
  const groupOf = new Map();
  const placeGroup = raw.places.map((p) => {
    if (!groupOf.has(p.name)) {
      groupOf.set(p.name, groups.length);
      groups.push({ name: p.name, lat: null, lon: null, quality: 'none', address: '', area: p.area });
    }
    const g = groups[groupOf.get(p.name)];
    if (RANK.indexOf(p.quality) < RANK.indexOf(g.quality)) Object.assign(g, { lat: p.lat, lon: p.lon, quality: p.quality, address: p.address || g.address });
    return groupOf.get(p.name);
  });
  const group = Int32Array.from(inc.place, (p) => placeGroup[p]);
  for (const g of groups) g.mappable = g.lat != null && g.quality !== 'campus' && g.quality !== 'none';

  // Newest first is the order every list starts from.
  const newest = Array.from({ length: n }, (_, i) => i).sort((a, b) => inc.t[b] - inc.t[a]);
  const byId = new Map(inc.id.map((id, i) => [id, i]));

  return {
    ...raw,
    n,
    day,
    hour,
    dow,
    year,
    text,
    newest,
    byId,
    groups,
    group,
    firstDay: Math.min(...day),
    lastDay: Math.max(...day, today()),
  };
}
