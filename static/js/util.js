// Small helpers shared by the dashboard modules.

export const $ = (sel, root = document) => root.querySelector(sel);

// Build DOM without innerHTML, so text from outside feeds can never inject markup.
//   h('p', { class: 'note' }, 'Hello ', h('b', {}, 'world'))
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function milesBetween(a, b) {
  const dx = (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, a.lat - b.lat) * 69.05;
}

export function formatMiles(mi) {
  return mi < 0.1 ? '<0.1 mi' : `${mi.toFixed(1)} mi`;
}

export function timeAgo(value) {
  const s = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

export const formatDate = (value) => dateFmt.format(new Date(value));
export const formatDateTime = (value) => dateTimeFmt.format(new Date(value));

// Just the time for today, the date and time otherwise.
export function formatWhen(value) {
  const sameDay = dateFmt.format(new Date(value)) === dateFmt.format(new Date());
  return sameDay ? timeFmt.format(new Date(value)) : dateTimeFmt.format(new Date(value));
}

export function chicagoHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Chicago' }).format(date));
}

export function hourLabel(hour) {
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${hour % 12 || 12} ${suffix}`;
}

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
