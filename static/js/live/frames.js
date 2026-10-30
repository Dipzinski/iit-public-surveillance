// Camera frames: fetch through the server's relay, decode off-screen, track capture time,
// and find the camera nearest to any point.

import { milesBetween } from '../util.js';

const LIVE_MAX_MIN = 10;
const DELAYED_MAX_MIN = 30;

export function roadLine(cam) {
  return [cam.roadName, cam.road !== cam.roadName ? cam.road : '', cam.direction].filter(Boolean).join(' · ');
}

export function formatAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

export function capturedTime(capturedAt, cam) {
  if (capturedAt) return new Date(capturedAt).getTime();
  return Date.now() - (cam.ageMinutes || 0) * 60_000; // no Last-Modified: use the feed's own estimate
}

export function status(captured, error) {
  if (error) return { cls: 'offline', label: 'Offline' };
  const minutes = (Date.now() - captured) / 60_000;
  if (minutes <= LIVE_MAX_MIN) return { cls: 'live', label: 'Live' };
  if (minutes <= DELAYED_MAX_MIN) return { cls: 'delayed', label: 'Delayed' };
  return { cls: 'offline', label: 'Stale' };
}

async function fetchSnapshot(id) {
  const res = await fetch(`/api/snapshot/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  return { capturedAt: res.headers.get('X-Captured-At') || '', blob: await res.blob() };
}

// Decode off-screen so the visible image swaps without a flash. Background tabs can hold
// decode() until they're shown, so don't wait on it for more than a few seconds.
async function decode(blob) {
  const url = URL.createObjectURL(blob);
  const probe = new Image();
  probe.src = url;
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
  try { await Promise.race([probe.decode(), timeout]); } catch { /* still try to show it */ }
  return url;
}

// Fetch a fresh frame for `holder` (a widget or the viewer) and show it in `img`.
// A result is dropped if the holder switched cameras while it was in flight.
export async function loadFrame(holder, id, img) {
  if (holder.loading === id) return false;
  holder.loading = id;
  let snap = null;
  try {
    snap = await fetchSnapshot(id);
    if (snap.capturedAt !== holder.capturedAt || !holder.url) snap.url = await decode(snap.blob);
  } catch {
    snap = null;
  }
  if (holder.loading === id) holder.loading = null;
  if (holder.id !== id) {
    if (snap?.url) URL.revokeObjectURL(snap.url);
    return false;
  }
  holder.error = !snap;
  if (snap?.url) {
    if (holder.url) URL.revokeObjectURL(holder.url);
    img.src = holder.url = snap.url;
    holder.capturedAt = snap.capturedAt;
  }
  return true;
}

// A snapshot URL that the browser can share between cards for a minute.
export const snapshotUrl = (id) => `/api/snapshot/${encodeURIComponent(id)}?m=${Math.floor(Date.now() / 60_000)}`;

export function nearestCamera(lat, lon, cameras) {
  let best = null;
  for (const cam of cameras) {
    const miles = milesBetween({ lat, lon }, cam);
    if (!best || miles < best.miles) best = { cam, miles };
  }
  return best;
}
