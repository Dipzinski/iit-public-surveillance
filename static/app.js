'use strict';

(() => {
  const SLOTS = 10;
  const REFRESH_MS = 30_000;          // how often each tile asks for a new frame
  const FEED_REFRESH_MS = 5 * 60_000; // how often the camera list itself is reloaded
  const STAGGER_MS = 150;             // spread tile requests out a little
  const LIVE_MAX_MIN = 10;
  const DELAYED_MAX_MIN = 30;
  const STORAGE_KEY = 'chicams.selection.v1';

  // A spread across the city: downtown, North Side, O'Hare, West Side, lakefront, South Side.
  const DEFAULT_IDS = [
    'IL-IDOTD1_1_Cook_NB_I-290_4187577_-8764458_1_NONE', // Jane Byrne Interchange
    'IL-IDOTD1_1_Cook_NWB_I-90_4189675_-8765812_1_NONE', // Kennedy @ Chicago Ave
    'IL-IDOTD1_1_Cook_SEB_I-90_4194360_-8771720_1_NONE', // Kennedy @ Addison
    'IL-IDOTD1_1_Cook_NB_I-94_4196750_-8774710_1_NONE',  // Edens @ Lawrence
    'IL-IDOTD1_1_Cook_EB_I-90_4198336_-8784695_1_NONE',  // Kennedy @ I-190 (O'Hare)
    'IL-IDOTD1_1_Cook_WB_I-290_4187527_-8770277_1_NONE', // Eisenhower @ Sacramento
    'IL-IDOTD1_1_Cook_NB_US-41_4184799_-8761203_1_NONE', // Lake Shore Dr @ I-55
    'IL-IDOTD1_1_Cook_WB_I-55_4181825_-8774008_1_NONE',  // Stevenson @ Cicero
    'IL-IDOTD1_1_Cook_NB_I-90_4183094_-8763017_1_NONE',  // Dan Ryan @ 35th
    'IL-IDOTD1_1_Cook_SB_I-94_4172000_-8762497_1_NONE',  // Dan Ryan @ 96th
  ];

  const $ = (sel) => document.querySelector(sel);

  const state = {
    cameras: new Map(),
    order: [],          // all camera ids, north to south
    selection: [],      // camera ids on the dashboard, one per slot
    tiles: [],
    paused: false,
    refreshing: 0,
    nextRefreshAt: 0,
    nextFeedAt: 0,
    map: null,
    markerLayer: null,
    pins: [],
    viewer: { id: null, list: [], url: null, capturedAt: null, error: false, loading: null },
  };

  // ---------- helpers ----------

  function storageGet() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
  }
  function storageSet(value) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* private mode */ }
  }
  function storageClear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
  }

  function roadLine(cam) {
    const parts = [cam.roadName, cam.road !== cam.roadName ? cam.road : '', cam.direction];
    return parts.filter(Boolean).join(' · ');
  }

  function formatAge(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ${m % 60}m ago`;
  }

  function capturedTime(capturedAt, cam) {
    if (capturedAt) return new Date(capturedAt).getTime();
    // No Last-Modified from the source: fall back to the feed's own age estimate.
    return Date.now() - (cam.ageMinutes || 0) * 60_000;
  }

  function status(captured, error) {
    if (error) return { cls: 'offline', label: 'Offline' };
    const minutes = (Date.now() - captured) / 60_000;
    if (minutes <= LIVE_MAX_MIN) return { cls: 'live', label: 'Live' };
    if (minutes <= DELAYED_MAX_MIN) return { cls: 'delayed', label: 'Delayed' };
    return { cls: 'offline', label: 'Stale' };
  }

  function distance(a, b) {
    const dx = (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180);
    const dy = a.lat - b.lat;
    return dx * dx + dy * dy;
  }

  async function fetchSnapshot(id) {
    const res = await fetch(`/api/snapshot/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    const capturedAt = res.headers.get('X-Captured-At') || '';
    const blob = await res.blob();
    return { capturedAt, blob };
  }

  // Decode off-screen first so the visible image swaps without a flash.
  async function decode(blob) {
    const url = URL.createObjectURL(blob);
    const probe = new Image();
    probe.src = url;
    try { await probe.decode(); } catch { /* still try to show it */ }
    return url;
  }

  // Fetch a fresh frame for `holder` (a tile or the viewer) and show it in `img`.
  // A result is dropped if the holder switched cameras while it was in flight.
  async function loadFrame(holder, id, img) {
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

  // ---------- camera list ----------

  async function loadCameras() {
    const chip = $('#feed-status');
    state.nextFeedAt = Date.now() + FEED_REFRESH_MS;
    try {
      const res = await fetch('/api/cameras', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      state.cameras = new Map(data.cameras.map((c) => [c.id, c]));
      state.order = data.cameras.map((c) => c.id);
      setFeedStatus(data.stale ? 'warn' : 'ok', data.stale ? 'Feed delayed' : 'Live');
      chip.title = `${data.source}\nList updated ${new Date(data.fetchedAt).toLocaleTimeString()}`;
      return true;
    } catch (err) {
      console.error(err);
      setFeedStatus('error', 'Feed offline');
      chip.title = String(err.message || err);
      state.nextFeedAt = Date.now() + 15_000;
      return false;
    }
  }

  function setFeedStatus(kind, label) {
    const chip = $('#feed-status');
    chip.className = `chip ${state.paused ? 'paused' : kind}`;
    chip.dataset.kind = kind;
    chip.querySelector('.label').textContent = state.paused ? 'Paused' : label;
    chip.dataset.label = label;
  }

  function updateCount() {
    $('#camera-count').textContent = `${state.selection.length} of ${state.cameras.size} city cameras`;
  }

  // Saved picks first, then the defaults, then the cameras farthest from those already chosen.
  function chooseSelection() {
    const saved = storageGet();
    const preferred = Array.isArray(saved) && saved.length ? saved : DEFAULT_IDS;
    const ids = [];
    for (const id of [...preferred, ...DEFAULT_IDS]) {
      if (ids.length < SLOTS && state.cameras.has(id) && !ids.includes(id)) ids.push(id);
    }

    const chosen = ids.map((id) => state.cameras.get(id));
    const pool = [...state.cameras.values()].filter((c) => !c.tooOld && !ids.includes(c.id));
    while (chosen.length < SLOTS && pool.length) {
      let best = 0;
      let bestDist = -1;
      pool.forEach((c, i) => {
        const d = chosen.length ? Math.min(...chosen.map((o) => distance(c, o))) : 0;
        if (d > bestDist) { bestDist = d; best = i; }
      });
      chosen.push(pool.splice(best, 1)[0]);
    }
    return chosen.map((c) => c.id);
  }

  // ---------- tiles ----------

  function buildTiles() {
    state.tiles.forEach((t) => { t.el.remove(); t.id = null; if (t.url) URL.revokeObjectURL(t.url); });
    const grid = $('#grid');
    const template = $('#tile-template');

    state.tiles = state.selection.map((id, slot) => {
      const el = template.content.firstElementChild.cloneNode(true);
      const tile = {
        el,
        slot,
        id: null,
        cam: null,
        img: el.querySelector('img'),
        pill: el.querySelector('.pill'),
        age: el.querySelector('.cam-age'),
        url: null,
        capturedAt: null,
        error: false,
        loading: null,
      };
      el.querySelector('.slot').textContent = String(slot + 1).padStart(2, '0');
      el.querySelector('.cam-media').addEventListener('click', () => openViewer(tile.id, state.selection));
      el.addEventListener('mouseenter', () => highlight(slot, true));
      el.addEventListener('mouseleave', () => highlight(slot, false));
      setTileCamera(tile, state.cameras.get(id));
      grid.appendChild(el);
      return tile;
    });
  }

  function setTileCamera(tile, cam) {
    if (tile.url) URL.revokeObjectURL(tile.url);
    tile.img.removeAttribute('src');
    tile.url = null;
    tile.id = cam.id;
    tile.cam = cam;
    tile.capturedAt = null;
    tile.error = false;
    tile.el.classList.add('is-loading');
    tile.el.classList.remove('is-offline');
    tile.el.querySelector('.cam-name').textContent = cam.name;
    tile.el.querySelector('.cam-name').title = cam.name;
    tile.el.querySelector('.cam-road').textContent = roadLine(cam);
    tile.el.querySelector('.cam-media').setAttribute('aria-label', `Open ${cam.name} camera`);
    tile.img.alt = `Traffic camera view: ${cam.name}, ${roadLine(cam)}`;
    tile.pill.textContent = '';
    tile.age.textContent = '';
  }

  async function refreshTile(tile) {
    if (!(await loadFrame(tile, tile.id, tile.img))) return;
    tile.el.classList.remove('is-loading');
    renderTileStatus(tile);
  }

  function renderTileStatus(tile) {
    tile.el.classList.toggle('is-offline', tile.error);
    if (!tile.url && !tile.error) return;
    const captured = capturedTime(tile.capturedAt, tile.cam);
    const s = status(captured, tile.error);
    tile.pill.className = `pill ${s.cls}`;
    tile.pill.textContent = s.label;
    tile.age.textContent = tile.error ? 'no signal' : formatAge(Date.now() - captured);
    tile.age.title = tile.error ? '' : `Captured ${new Date(captured).toLocaleString()}`;
  }

  async function refreshAll() {
    state.refreshing++;
    state.nextRefreshAt = Date.now() + REFRESH_MS;
    renderCountdown();
    const jobs = state.tiles.map((tile, i) =>
      new Promise((r) => setTimeout(r, i * STAGGER_MS)).then(() => refreshTile(tile)));
    if (state.viewer.id) jobs.push(refreshViewer());
    await Promise.all(jobs);
    state.refreshing--;
    renderCountdown();
  }

  // ---------- map ----------

  async function initMap() {
    const el = $('#map');
    if (!window.L) {
      el.innerHTML = '<div class="map-error">Map library could not load. Camera feeds still work.</div>';
      return;
    }
    const map = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.25, maxZoom: 16 }).setView([41.84, -87.69], 10);
    // Esri's dark canvas basemap: free to use with attribution, no API key.
    const esri = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas';
    L.tileLayer(`${esri}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 16,
      attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
    }).addTo(map);
    L.tileLayer(`${esri}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16 }).addTo(map);
    state.map = map;
    state.markerLayer = L.layerGroup().addTo(map);

    let cityBounds = null;
    const fitCity = () => cityBounds && map.fitBounds(cityBounds, { padding: [8, 8] });

    // Re-measure and re-center whenever the grid reflows the card.
    new ResizeObserver(() => { map.invalidateSize(); fitCity(); }).observe(el);

    try {
      const boundary = await (await fetch('/api/boundary')).json();
      const outline = L.geoJSON(boundary, {
        interactive: false,
        style: { color: '#5cc8ff', weight: 1.5, opacity: 0.55, fillColor: '#5cc8ff', fillOpacity: 0.04 },
      }).addTo(map);
      cityBounds = outline.getBounds();
      fitCity();
    } catch (err) {
      console.warn('boundary unavailable', err);
    }
  }

  function renderMarkers() {
    if (!state.map) return;
    state.markerLayer.clearLayers();
    const pinned = new Set(state.selection);

    for (const cam of state.cameras.values()) {
      if (pinned.has(cam.id)) continue;
      L.circleMarker([cam.lat, cam.lon], {
        radius: 4,
        weight: 1,
        color: '#0b0e13',
        fillColor: '#7d8899',
        fillOpacity: 0.9,
      })
        .bindTooltip(cam.name, { direction: 'top', offset: [0, -4] })
        .on('click', () => openViewer(cam.id, state.order))
        .addTo(state.markerLayer);
    }

    state.pins = state.selection.map((id, slot) => {
      const cam = state.tiles[slot]?.cam || state.cameras.get(id);
      if (!cam) return null;
      const marker = L.marker([cam.lat, cam.lon], {
        icon: L.divIcon({ className: '', html: `<div class="pin">${slot + 1}</div>`, iconSize: [24, 24] }),
        zIndexOffset: 1000,
        keyboard: false,
      })
        .bindTooltip(`${slot + 1}. ${cam.name}`, { direction: 'top', offset: [0, -12] })
        .on('click', () => openViewer(id, state.selection))
        .on('mouseover', () => highlight(slot, true))
        .on('mouseout', () => highlight(slot, false))
        .addTo(state.markerLayer);
      return marker;
    });
  }

  function highlight(slot, on) {
    state.tiles[slot]?.el.classList.toggle('hot', on);
    const pinEl = state.pins[slot]?.getElement()?.querySelector('.pin');
    pinEl?.classList.toggle('hot', on);
  }

  // ---------- viewer ----------

  const viewer = $('#viewer');

  function openViewer(id, list) {
    const v = state.viewer;
    v.id = id;
    v.list = list.includes(id) ? list : state.order;
    v.capturedAt = null;
    v.error = false;

    const cam = state.cameras.get(id) || state.tiles.find((t) => t.id === id)?.cam;
    $('#viewer-title').textContent = cam.name;
    $('#viewer-road').textContent = roadLine(cam);
    $('#viewer-time').textContent = 'Loading…';
    $('#viewer-pill').className = 'pill';
    $('#viewer-pill').textContent = '';
    $('#viewer-source').href = cam.sourceUrl || 'https://www.travelmidwest.com/';
    $('#viewer-maps').href = `https://www.google.com/maps/search/?api=1&query=${cam.lat},${cam.lon}`;
    const img = $('#viewer-img');
    img.alt = `Traffic camera view: ${cam.name}`;

    // Show the tile's current frame immediately while the fresh one loads.
    const tile = state.tiles.find((t) => t.id === id);
    img.removeAttribute('src');
    if (tile?.img.src) img.src = tile.img.src;

    renderSwapControls();
    const multiple = v.list.length > 1;
    $('#viewer-prev').hidden = !multiple;
    $('#viewer-next').hidden = !multiple;

    if (!viewer.open) viewer.showModal();
    refreshViewer();
  }

  function renderSwapControls() {
    const id = state.viewer.id;
    const slot = state.selection.indexOf(id);
    $('#viewer-swap').hidden = slot !== -1;
    $('#viewer-slot').textContent = slot !== -1 ? `On dashboard · slot ${slot + 1}` : '';
    if (slot === -1) {
      $('#swap-slot').replaceChildren(...state.tiles.map((t, i) => new Option(`${i + 1} — ${t.cam.name}`, i)));
    }
  }

  async function refreshViewer() {
    const v = state.viewer;
    if (v.id && (await loadFrame(v, v.id, $('#viewer-img')))) renderViewerStatus();
  }

  function renderViewerStatus() {
    const v = state.viewer;
    const cam = state.cameras.get(v.id) || state.tiles.find((t) => t.id === v.id)?.cam;
    if (!v.id || !cam || (!v.url && !v.error)) return;
    const captured = capturedTime(v.capturedAt, cam);
    const s = status(captured, v.error);
    $('#viewer-pill').className = `pill ${s.cls}`;
    $('#viewer-pill').textContent = s.label;
    $('#viewer-time').textContent = v.error
      ? 'Camera not responding'
      : `Captured ${new Date(captured).toLocaleTimeString()} (${formatAge(Date.now() - captured)}) · ${cam.lat.toFixed(4)}, ${cam.lon.toFixed(4)}`;
  }

  function stepViewer(delta) {
    const v = state.viewer;
    if (!v.id || v.list.length < 2) return;
    const i = v.list.indexOf(v.id);
    const next = v.list[(i + delta + v.list.length) % v.list.length];
    openViewer(next, v.list);
  }

  function closeViewer() {
    // 'close' fires asynchronously, so ignore it if the viewer was reopened meanwhile.
    if (viewer.open) return;
    const v = state.viewer;
    v.id = null;
    if (v.url) URL.revokeObjectURL(v.url);
    v.url = null;
  }

  function swapIntoSlot() {
    const id = state.viewer.id;
    const slot = Number($('#swap-slot').value);
    if (!id || Number.isNaN(slot)) return;
    state.selection[slot] = id;
    storageSet(state.selection);
    const tile = state.tiles[slot];
    setTileCamera(tile, state.cameras.get(id));
    refreshTile(tile);
    renderMarkers();
    renderSwapControls();
  }

  // ---------- header controls ----------

  function renderCountdown() {
    const el = $('#countdown');
    if (state.paused) { el.textContent = 'Paused'; return; }
    if (state.refreshing) { el.textContent = 'Updating…'; return; }
    const s = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
    el.textContent = `Next 0:${String(s).padStart(2, '0')}`;
  }

  function setPaused(paused) {
    state.paused = paused;
    const btn = $('#pause-btn');
    btn.textContent = paused ? 'Resume' : 'Pause';
    btn.setAttribute('aria-pressed', String(paused));
    const chip = $('#feed-status');
    setFeedStatus(chip.dataset.kind || 'ok', chip.dataset.label || 'Live');
    if (!paused) state.nextRefreshAt = Date.now();
    renderCountdown();
  }

  function resetSelection() {
    storageClear();
    resetFromFeed();
  }

  // ---------- main loop ----------

  async function tick() {
    renderCountdown();
    if (state.paused || document.hidden) return;
    if (Date.now() >= state.nextFeedAt && (await loadCameras())) {
      if (!state.selection.length) resetFromFeed();
      else { renderMarkers(); updateCount(); }
    }
    if (state.selection.length && Date.now() >= state.nextRefreshAt) refreshAll();
  }

  function wireEvents() {
    $('#refresh-btn').addEventListener('click', () => refreshAll());
    $('#pause-btn').addEventListener('click', () => setPaused(!state.paused));
    $('#reset-btn').addEventListener('click', resetSelection);
    $('#viewer-close').addEventListener('click', () => viewer.close());
    $('#viewer-prev').addEventListener('click', () => stepViewer(-1));
    $('#viewer-next').addEventListener('click', () => stepViewer(1));
    $('#swap-btn').addEventListener('click', swapIntoSlot);
    viewer.addEventListener('close', closeViewer);
    viewer.addEventListener('click', (e) => { if (e.target === viewer) viewer.close(); });
    document.addEventListener('keydown', (e) => {
      if (!viewer.open || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowLeft') stepViewer(-1);
      if (e.key === 'ArrowRight') stepViewer(1);
    });
    // Catch up right away when the tab comes back into view.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  }

  async function start() {
    wireEvents();
    initMap();
    if ((await loadCameras()) && state.cameras.size) resetFromFeed();
    else $('#camera-count').textContent = 'No cameras available';
    setInterval(tick, 1000);
    setInterval(() => { state.tiles.forEach(renderTileStatus); renderViewerStatus(); }, 10_000);
  }

  function resetFromFeed() {
    state.selection = chooseSelection();
    buildTiles();
    renderMarkers();
    updateCount();
    refreshAll();
  }

  start();
})();
