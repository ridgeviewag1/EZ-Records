'use strict';

/* EZ Records — offline herbicide application records (PWA).
   All records and saved fields are stored on this device in IndexedDB. */

const DB_NAME = 'ez-records';
const DB_VERSION = 2;
const RECORDS = 'applications';
const FIELD_STORE = 'fields';
const FIELDS = [
  ['date', 'Date'], ['farm', 'Farm'], ['field', 'Field'], ['crop', 'Crop'],
  ['acres', 'Acres'], ['product', 'Herbicide product'], ['rate', 'Rate per acre'],
  ['unit', 'Rate unit'], ['applicator', 'Applicator'], ['wind', 'Wind'], ['notes', 'Notes'],
];
const REQUIRED = ['date', 'farm', 'field', 'crop', 'acres', 'product', 'rate', 'unit', 'applicator'];
const NUMERIC = ['acres', 'rate'];
const SUGGEST = ['farm', 'field', 'crop', 'product', 'unit', 'applicator'];
const BACKUP_KEY = 'ez-records:lastBackup';
const SOURCE_LABEL = { gps: 'phone GPS', map: 'picked on map', field: 'saved field' };

// Map library (loaded from the internet the first time a map opens, then cached for offline use).
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const SATELLITE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const STREETS = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const $ = (sel) => document.querySelector(sel);
let records = [];
let savedFields = [];
let editingUid = null;
let viewingUid = null;
let gps = null; // { lat, lng, accuracy, source, boundary?, acres? }

/* ---------- storage ---------- */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'uid' });
      if (!db.objectStoreNames.contains(FIELD_STORE)) db.createObjectStore(FIELD_STORE, { keyPath: 'uid' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const dbPromise = openDb();
async function tx(storeName, mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const getAll = (s) => tx(s, 'readonly', (st) => new Promise((res) => { const r = st.getAll(); r.onsuccess = () => res(r.result); }));
const putItem = (s, item) => tx(s, 'readwrite', (st) => { st.put(item); });
const deleteItem = (s, key) => tx(s, 'readwrite', (st) => { st.delete(key); });

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

/* ---------- helpers ---------- */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const fieldKey = (farm, field) => norm(farm) + '|' + norm(field);
const round2 = (n) => Math.round(n * 100) / 100;
const ll5 = (lat, lng) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
const gmapsUrl = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
const directionsUrl = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}`;
function nowLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDate(s, withTime = true) {
  const d = new Date(s);
  if (isNaN(d)) return String(s ?? '');
  const opts = withTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return d.toLocaleString(undefined, opts);
}
const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(n ?? ''));
const fmtAcres = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function sorted(list) { return [...list].sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0)); }
const findField = (farm, field) => savedFields.find((f) => fieldKey(f.farm, f.field) === fieldKey(farm, field));

// Area of a lat/lng polygon on the earth's surface, in acres.
function polygonAcres(pts) {
  if (!pts || pts.length < 3) return 0;
  const R = 6378137, rad = Math.PI / 180;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [la1, lo1] = pts[i];
    const [la2, lo2] = pts[(i + 1) % pts.length];
    a += (lo2 - lo1) * rad * (2 + Math.sin(la1 * rad) + Math.sin(la2 * rad));
  }
  return Math.abs((a * R * R) / 2) / 4046.8564224;
}
function centroid(pts) {
  const n = pts.length;
  return { lat: pts.reduce((s, p) => s + p[0], 0) / n, lng: pts.reduce((s, p) => s + p[1], 0) / n };
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3000);
}
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- list ---------- */
function filtered() {
  const q = $('#search').value.trim().toLowerCase();
  if (!q) return records;
  return records.filter((r) => FIELDS.some(([k]) => String(r[k] ?? '').toLowerCase().includes(q)) || fmtDate(r.date).toLowerCase().includes(q));
}
function render() {
  const list = filtered();
  $('#list').innerHTML = list.map((r) => `
    <li><button type="button" data-uid="${esc(r.uid)}">
      <span class="title">${esc(r.farm)} — ${esc(r.field)}</span>
      <span class="sub">${esc(r.product)} • ${esc(fmtNum(r.acres))} acres • ${esc(fmtDate(r.date, false))}</span>
    </button></li>`).join('');
  $('#empty').hidden = records.length > 0;
  if (records.length && !list.length) $('#list').innerHTML = '<li class="empty">No records match your search.</li>';
  renderBackupNote();
  for (const k of SUGGEST) {
    const from = (k === 'farm' || k === 'field') ? [...savedFields, ...records] : records;
    const vals = [...new Set(from.map((r) => r[k]).filter(Boolean))].slice(0, 80);
    $('#dl-' + k).innerHTML = vals.map((v) => `<option value="${esc(v)}">`).join('');
  }
}
function renderBackupNote() {
  const note = $('#backupNote');
  const all = [...records, ...savedFields];
  if (!all.length) { note.hidden = true; return; }
  const last = Number(lsGet(BACKUP_KEY) || 0);
  const newest = Math.max(...all.map((r) => r.updatedAt || r.createdAt || 0));
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  if (last && newest <= last) { note.hidden = true; return; }
  if (last && days < 7) { note.hidden = true; return; }
  note.innerHTML = (last ? `Last backup was ${days} day${days === 1 ? '' : 's'} ago.` : 'Your records have not been backed up yet.') +
    ' Records live only on this device. <button type="button" class="small" data-action="backup">Back up now</button>';
  note.hidden = false;
}
async function reload() {
  const [recs, flds] = await Promise.all([getAll(RECORDS), getAll(FIELD_STORE)]);
  records = sorted(recs);
  savedFields = flds.sort((a, b) => (a.farm + a.field).localeCompare(b.farm + b.field));
  render();
}

/* ---------- map picker ---------- */
let leafletPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = LEAFLET_CSS; css.crossOrigin = '';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = LEAFLET_JS; s.crossOrigin = '';
      s.onload = () => resolve(window.L);
      s.onerror = () => { leafletPromise = null; s.remove(); css.remove(); reject(new Error('Map could not load')); };
      document.head.appendChild(s);
    });
  }
  return leafletPromise;
}

const mapUi = { map: null, layer: null, mode: 'pin', pin: null, pts: [], reference: null, resolve: null };
function lastKnownSpot() {
  const withLoc = [...savedFields, ...records].filter((x) => x.lat != null).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return withLoc[0] || null;
}
function setMapMode(mode) {
  mapUi.mode = mode;
  $('#modePin').classList.toggle('on', mode === 'pin');
  $('#modeOutline').classList.toggle('on', mode === 'outline');
  drawMap();
}
function drawMap() {
  const L = window.L;
  if (!L || !mapUi.map) return;
  mapUi.layer.clearLayers();
  if (mapUi.reference && mapUi.reference.length >= 3) {
    L.polygon(mapUi.reference, { color: '#ffffff', weight: 2, dashArray: '6 6', fill: false, interactive: false }).addTo(mapUi.layer);
  }
  const info = $('#mapInfo');
  if (mapUi.mode === 'outline') {
    const pts = mapUi.pts;
    if (pts.length >= 3) L.polygon(pts, { color: '#ffd23f', weight: 3, fillOpacity: 0.2 }).addTo(mapUi.layer);
    else if (pts.length === 2) L.polyline(pts, { color: '#ffd23f', weight: 3 }).addTo(mapUi.layer);
    pts.forEach((p, i) => {
      const m = L.marker(p, { draggable: true, icon: L.divIcon({ className: 'vertex', iconSize: [16, 16] }) }).addTo(mapUi.layer);
      m.on('dragend', () => { const q = m.getLatLng(); mapUi.pts[i] = [q.lat, q.lng]; drawMap(); });
    });
    info.textContent = pts.length < 3
      ? `Tap around the edge of the field to outline it (${pts.length} of at least 3 points). Drag a point to adjust it.`
      : `${pts.length} points • ${fmtAcres(polygonAcres(pts))} acres. Keep tapping to add points, or drag one to adjust.`;
  } else {
    if (mapUi.pin) {
      const m = L.marker([mapUi.pin.lat, mapUi.pin.lng], { draggable: true }).addTo(mapUi.layer);
      m.on('dragend', () => { const q = m.getLatLng(); mapUi.pin = { lat: q.lat, lng: q.lng }; drawMap(); });
      info.textContent = `Pin at ${ll5(mapUi.pin.lat, mapUi.pin.lng)}. Tap elsewhere or drag the pin to move it.`;
    } else {
      info.textContent = 'Tap the map to drop a pin on the field.';
    }
  }
}
function finishMap(result) {
  const r = mapUi.resolve;
  mapUi.resolve = null;
  if ($('#mapDlg').open) $('#mapDlg').close();
  if (r) r(result);
}
async function openMapEditor({ title = 'Pick location', lat = null, lng = null, boundary = null, reference = null } = {}) {
  mapUi.pin = lat != null ? { lat, lng } : null;
  mapUi.pts = boundary ? boundary.map((p) => [p[0], p[1]]) : [];
  mapUi.reference = reference;
  $('#mapTitle').textContent = title;
  $('#mapInfo').textContent = 'Loading map…';
  $('#mapDlg').showModal();
  const done = new Promise((resolve) => { mapUi.resolve = resolve; });
  let L;
  try {
    L = await loadLeaflet();
  } catch {
    $('#mapInfo').textContent = 'The map needs an internet connection the first time it opens. You can still use “Use my location” offline.';
    return done;
  }
  if (!mapUi.map) {
    const map = L.map('map', { zoomControl: true, attributionControl: true });
    const sat = L.layerGroup([
      L.tileLayer(SATELLITE, { maxZoom: 19, maxNativeZoom: 18, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }),
      L.tileLayer(LABELS, { maxZoom: 19, maxNativeZoom: 18 }),
    ]);
    const streets = L.tileLayer(STREETS, { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' });
    sat.addTo(map);
    L.control.layers({ Satellite: sat, Streets: streets }, null, { position: 'topright' }).addTo(map);
    mapUi.layer = L.layerGroup().addTo(map);
    map.on('click', (e) => {
      if (mapUi.mode === 'outline') mapUi.pts.push([e.latlng.lat, e.latlng.lng]);
      else mapUi.pin = { lat: e.latlng.lat, lng: e.latlng.lng };
      drawMap();
    });
    mapUi.map = map;
  }
  const map = mapUi.map;
  setTimeout(() => {
    map.invalidateSize();
    const outline = mapUi.pts.length >= 3 ? mapUi.pts : (reference && reference.length >= 3 ? reference : null);
    if (outline) map.fitBounds(L.latLngBounds(outline), { padding: [30, 30], maxZoom: 18 });
    else if (mapUi.pin) map.setView([mapUi.pin.lat, mapUi.pin.lng], 16);
    else {
      const spot = lastKnownSpot();
      if (spot) map.setView([spot.lat, spot.lng], 14);
      else map.setView([39.8, -98.6], 4);
    }
  }, 50);
  setMapMode(mapUi.pts.length ? 'outline' : 'pin');
  return done;
}
$('#modePin').addEventListener('click', () => setMapMode('pin'));
$('#modeOutline').addEventListener('click', () => setMapMode('outline'));
$('#mapUndo').addEventListener('click', () => {
  if (mapUi.mode === 'outline') mapUi.pts.pop(); else mapUi.pin = null;
  drawMap();
});
$('#mapClear').addEventListener('click', () => { mapUi.pts = []; mapUi.pin = null; drawMap(); });
$('#mapLocate').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('Location is not available on this device'); return; }
  $('#mapInfo').textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition((p) => {
    const here = { lat: p.coords.latitude, lng: p.coords.longitude };
    if (mapUi.map) mapUi.map.setView([here.lat, here.lng], 17);
    if (mapUi.mode === 'pin') mapUi.pin = here;
    drawMap();
  }, (err) => { drawMap(); toast(err.code === 1 ? 'Location permission was denied' : 'Could not get location'); },
  { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
});
$('#mapCancel').addEventListener('click', () => finishMap(undefined));
$('#mapDlg').addEventListener('close', () => { if (mapUi.resolve) finishMap(undefined); });
$('#mapDone').addEventListener('click', () => {
  if (mapUi.mode === 'outline') {
    if (mapUi.pts.length < 3) { toast('Add at least 3 points around the field, or switch to Drop pin'); return; }
    const c = centroid(mapUi.pts);
    finishMap({ lat: c.lat, lng: c.lng, boundary: mapUi.pts.map((p) => [p[0], p[1]]), acres: round2(polygonAcres(mapUi.pts)) });
  } else {
    if (!mapUi.pin) { toast('Tap the map to drop a pin first'); return; }
    finishMap({ lat: mapUi.pin.lat, lng: mapUi.pin.lng, boundary: null, acres: null });
  }
});

/* ---------- record form ---------- */
const form = $('#recForm');
function setGps(g) {
  gps = g;
  let text = 'Not recorded';
  if (g) {
    const acc = g.accuracy != null ? `±${Math.round(g.accuracy)} m, ` : '';
    text = `${ll5(g.lat, g.lng)} (${acc}${SOURCE_LABEL[g.source] || 'location'})`;
    if (g.boundary && g.acres) text += ` • outlined ${fmtAcres(g.acres)} ac`;
  }
  $('#gpsText').textContent = text;
  $('#gpsClear').hidden = !g;
  updateRemember();
}
function updateRemember() {
  const farm = form.elements.farm.value.trim();
  const field = form.elements.field.value.trim();
  const saved = farm && field ? findField(farm, field) : null;
  const show = !!(gps && gps.source !== 'field' && farm && field && !(saved && saved.lat != null && !gps.boundary));
  $('#rememberWrap').hidden = !show;
  if (show) $('#rememberWrap').lastChild.textContent = saved && saved.lat != null
    ? ' Update the saved outline for this field' : ' Save this location for this field';
}
function applySavedField() {
  const f = findField(form.elements.farm.value, form.elements.field.value);
  const hint = $('#fieldHint');
  if (f && f.lat != null) {
    if (!gps || gps.source === 'field') setGps({ lat: f.lat, lng: f.lng, accuracy: null, source: 'field' });
    if (!form.elements.acres.value && f.acres) form.elements.acres.value = round2(f.acres);
    hint.textContent = `Saved field found${f.acres ? ` (outlined ${fmtAcres(f.acres)} ac)` : ''}. Location filled in.`;
    hint.hidden = false;
  } else {
    if (gps && gps.source === 'field') setGps(null);
    hint.hidden = true;
  }
  updateRemember();
}
function openForm(rec) {
  editingUid = rec ? rec.uid : null;
  form.reset();
  $('#formError').hidden = true;
  $('#fieldHint').hidden = true;
  form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  $('#formTitle').textContent = rec ? 'Edit application' : 'New application';
  for (const [k] of FIELDS) form.elements[k].value = rec ? (rec[k] ?? '') : '';
  $('#rememberField').checked = true;
  setGps(rec && rec.lat != null ? { lat: rec.lat, lng: rec.lng, accuracy: rec.accuracy ?? null, source: rec.locSource || 'gps' } : null);
  if (!rec) {
    form.elements.date.value = nowLocal();
    // Pre-fill applicator and farm from the most recent record to save typing.
    if (records[0]) { form.elements.applicator.value = records[0].applicator || ''; form.elements.farm.value = records[0].farm || ''; }
    applySavedField();
  }
  $('#formDlg').showModal();
}
function validate() {
  const errors = [];
  form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  for (const [k, label] of FIELDS) {
    const el = form.elements[k];
    const v = el.value.trim();
    let bad = false;
    if (REQUIRED.includes(k) && !v) { bad = true; errors.push(`${label} is required`); }
    else if (NUMERIC.includes(k) && (!isFinite(Number(v)) || Number(v) <= 0)) { bad = true; errors.push(`${label} must be a positive number`); }
    if (bad) el.classList.add('invalid');
  }
  return errors;
}
async function rememberFieldLocation(farm, field, g) {
  const existing = findField(farm, field);
  const f = existing ? { ...existing } : { uid: uid(), farm, field, createdAt: Date.now() };
  f.lat = g.lat; f.lng = g.lng;
  if (g.boundary) { f.boundary = g.boundary; f.acres = g.acres; }
  else if (!existing) { f.boundary = null; f.acres = null; }
  f.updatedAt = Date.now();
  await putItem(FIELD_STORE, f);
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errors = validate();
  if (errors.length) {
    $('#formError').textContent = errors.join('. ') + '.';
    $('#formError').hidden = false;
    form.querySelector('.invalid')?.focus();
    return;
  }
  const existing = editingUid ? records.find((r) => r.uid === editingUid) : null;
  const rec = existing ? { ...existing } : { uid: uid(), createdAt: Date.now() };
  for (const [k] of FIELDS) {
    const v = form.elements[k].value.trim();
    rec[k] = NUMERIC.includes(k) ? Number(v) : v;
  }
  if (gps) { rec.lat = gps.lat; rec.lng = gps.lng; rec.accuracy = gps.accuracy; rec.locSource = gps.source; }
  else { delete rec.lat; delete rec.lng; delete rec.accuracy; delete rec.locSource; }
  rec.updatedAt = Date.now();
  try {
    await putRecord(rec);
    if (gps && !$('#rememberWrap').hidden && $('#rememberField').checked) await rememberFieldLocation(rec.farm, rec.field, gps);
  } catch (err) {
    $('#formError').textContent = 'Could not save: ' + (err && err.message ? err.message : err);
    $('#formError').hidden = false;
    return;
  }
  $('#formDlg').close();
  toast(existing ? 'Record updated' : 'Record saved on this device');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await reload();
});
const putRecord = (rec) => putItem(RECORDS, rec);
form.addEventListener('input', (e) => {
  e.target.classList.remove('invalid');
  if (!form.querySelector('.invalid')) $('#formError').hidden = true;
  if (e.target.name === 'farm' || e.target.name === 'field') applySavedField();
});
$('#cancelBtn').addEventListener('click', () => $('#formDlg').close());
$('#addBtn').addEventListener('click', () => openForm(null));
$('#gpsClear').addEventListener('click', () => setGps(null));
$('#gpsBtn').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('Location is not available on this device'); return; }
  $('#gpsText').textContent = 'Getting location…';
  navigator.geolocation.getCurrentPosition(
    (p) => setGps({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, source: 'gps' }),
    (err) => { setGps(gps); toast(err.code === 1 ? 'Location permission was denied' : 'Could not get location'); },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
  );
});
$('#mapPickBtn').addEventListener('click', async () => {
  const saved = findField(form.elements.farm.value, form.elements.field.value);
  const res = await openMapEditor({
    title: 'Pick the field location',
    lat: gps ? gps.lat : null, lng: gps ? gps.lng : null,
    boundary: gps && gps.boundary ? gps.boundary : null,
    reference: saved && saved.boundary ? saved.boundary : null,
  });
  if (!res) return;
  setGps({ lat: res.lat, lng: res.lng, accuracy: null, source: 'map', boundary: res.boundary, acres: res.acres });
  if (res.acres && !form.elements.acres.value) form.elements.acres.value = res.acres;
});

/* ---------- record detail ---------- */
function locationLinks(lat, lng) {
  return `<span class="loc-links"><a class="btn-link" href="${gmapsUrl(lat, lng)}" target="_blank" rel="noopener">Open in Google Maps</a>` +
    `<a class="btn-link" href="${directionsUrl(lat, lng)}" target="_blank" rel="noopener">Directions</a></span>`;
}
function openDetail(u) {
  const r = records.find((x) => x.uid === u);
  if (!r) return;
  viewingUid = u;
  const rows = FIELDS.map(([k, label]) => {
    let v = r[k];
    if (k === 'date') v = fmtDate(v);
    else if (NUMERIC.includes(k)) v = fmtNum(v);
    return `<dt>${esc(label)}</dt><dd>${esc(v || '—')}</dd>`;
  });
  if (r.lat != null) {
    const acc = r.accuracy != null ? `±${Math.round(r.accuracy)} m, ` : '';
    rows.push(`<dt>Location</dt><dd>${esc(ll5(r.lat, r.lng))} (${esc(acc + (SOURCE_LABEL[r.locSource] || 'phone GPS'))})${locationLinks(r.lat, r.lng)}</dd>`);
  }
  const f = findField(r.farm, r.field);
  if (f && f.acres) rows.push(`<dt>Field outline</dt><dd>${esc(fmtAcres(f.acres))} acres (saved field)</dd>`);
  $('#detail').innerHTML = rows.join('');
  $('#detailDlg').showModal();
}
$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-uid]');
  if (b) openDetail(b.dataset.uid);
});
$('#closeBtn').addEventListener('click', () => $('#detailDlg').close());
$('#editBtn').addEventListener('click', () => {
  const r = records.find((x) => x.uid === viewingUid);
  $('#detailDlg').close();
  if (r) openForm(r);
});
$('#deleteBtn').addEventListener('click', async () => {
  const r = records.find((x) => x.uid === viewingUid);
  if (!r) return;
  if (!confirm(`Delete the record for ${r.farm} — ${r.field} on ${fmtDate(r.date, false)}? This can't be undone.`)) return;
  await deleteItem(RECORDS, r.uid);
  $('#detailDlg').close();
  toast('Record deleted');
  await reload();
});

/* ---------- saved farms & fields ---------- */
let fieldEdit = null; // { uid?, lat, lng, boundary, acres }
function renderFieldList() {
  $('#fieldList').innerHTML = savedFields.map((f) => {
    const status = f.lat == null ? 'No location yet' : f.boundary ? `Outlined • ${fmtAcres(f.acres || 0)} acres` : 'Location pinned';
    return `<li><button type="button" data-field="${esc(f.uid)}"><span class="title">${esc(f.farm)} — ${esc(f.field)}</span><span class="sub">${esc(status)}</span></button></li>`;
  }).join('');
  $('#fieldsEmpty').hidden = savedFields.length > 0;
}
function openFieldsList() { renderFieldList(); $('#fieldsDlg').showModal(); }
function renderFieldLoc() {
  const t = $('#fieldLocText');
  const g = $('#fieldGmaps');
  if (fieldEdit.lat == null) { t.textContent = 'Not set'; g.hidden = true; return; }
  t.textContent = ll5(fieldEdit.lat, fieldEdit.lng) + (fieldEdit.boundary ? ` • outlined ${fmtAcres(fieldEdit.acres || 0)} acres` : ' • pin only');
  g.href = gmapsUrl(fieldEdit.lat, fieldEdit.lng);
  g.hidden = false;
}
function openFieldEditor(f) {
  const ff = $('#fieldForm');
  ff.reset();
  $('#fieldError').hidden = true;
  fieldEdit = f ? { ...f } : { lat: null, lng: null, boundary: null, acres: null };
  ff.elements.farm.value = f ? f.farm : (records[0] ? records[0].farm : '');
  ff.elements.field.value = f ? f.field : '';
  $('#fieldTitle').textContent = f ? 'Edit field' : 'Add field';
  $('#fieldDeleteBtn').hidden = !f;
  renderFieldLoc();
  $('#fieldDlg').showModal();
}
$('#fieldList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-field]');
  if (b) openFieldEditor(savedFields.find((f) => f.uid === b.dataset.field));
});
$('#addFieldBtn').addEventListener('click', () => openFieldEditor(null));
$('#fieldCancelBtn').addEventListener('click', () => $('#fieldDlg').close());
$('#fieldMapBtn').addEventListener('click', async () => {
  const ff = $('#fieldForm');
  const name = [ff.elements.farm.value.trim(), ff.elements.field.value.trim()].filter(Boolean).join(' — ');
  const res = await openMapEditor({ title: name ? `Map: ${name}` : 'Field location', lat: fieldEdit.lat, lng: fieldEdit.lng, boundary: fieldEdit.boundary });
  if (!res) return;
  Object.assign(fieldEdit, res);
  renderFieldLoc();
});
$('#fieldForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ff = e.target;
  const farm = ff.elements.farm.value.trim();
  const field = ff.elements.field.value.trim();
  const err = $('#fieldError');
  if (!farm || !field) { err.textContent = 'Farm and field are both required.'; err.hidden = false; return; }
  const dup = findField(farm, field);
  if (dup && dup.uid !== fieldEdit.uid) { err.textContent = `${dup.farm} — ${dup.field} is already saved. Edit that one instead.`; err.hidden = false; return; }
  const item = { ...fieldEdit, uid: fieldEdit.uid || uid(), farm, field, createdAt: fieldEdit.createdAt || Date.now(), updatedAt: Date.now() };
  await putItem(FIELD_STORE, item);
  $('#fieldDlg').close();
  await reload();
  renderFieldList();
  toast('Field saved');
});
$('#fieldDeleteBtn').addEventListener('click', async () => {
  if (!fieldEdit || !fieldEdit.uid) return;
  if (!confirm(`Delete the saved location for ${fieldEdit.farm} — ${fieldEdit.field}? Your spray records are not affected.`)) return;
  await deleteItem(FIELD_STORE, fieldEdit.uid);
  $('#fieldDlg').close();
  await reload();
  renderFieldList();
  toast('Field deleted');
});

/* ---------- export / backup ---------- */
function csvCell(v) {
  let s = String(v ?? '');
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from treating text as formulas
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportCsv() {
  const list = filtered();
  if (!list.length) { toast('No records to export'); return; }
  const head = [...FIELDS.map(([, l]) => l), 'Latitude', 'Longitude', 'GPS accuracy (m)', 'Location source'];
  const rows = list.map((r) => [
    ...FIELDS.map(([k]) => (k === 'date' ? String(r.date).replace('T', ' ') : r[k])),
    r.lat ?? '', r.lng ?? '', r.accuracy != null ? Math.round(r.accuracy) : '', r.lat != null ? (SOURCE_LABEL[r.locSource] || 'phone GPS') : '',
  ]);
  const csv = '﻿' + [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  download(`ez-records-${today()}.csv`, csv, 'text/csv;charset=utf-8');
}
function backup() {
  if (!records.length && !savedFields.length) { toast('Nothing to back up yet'); return; }
  const data = { app: 'ez-records', version: 2, exportedAt: new Date().toISOString(), records, fields: savedFields };
  download(`ez-records-backup-${today()}.json`, JSON.stringify(data, null, 2), 'application/json');
  lsSet(BACKUP_KEY, String(Date.now()));
  renderBackupNote();
  toast(`Backup downloaded (${records.length} record${records.length === 1 ? '' : 's'}, ${savedFields.length} field${savedFields.length === 1 ? '' : 's'})`);
}
async function mergeInto(storeName, current, incoming, valid) {
  const have = new Map(current.map((r) => [r.uid, r]));
  let added = 0, updated = 0;
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object' || !valid(raw)) continue;
    const r = { ...raw, uid: raw.uid || uid() };
    const cur = have.get(r.uid);
    if (cur && (cur.updatedAt || 0) >= (r.updatedAt || 0)) continue;
    await putItem(storeName, r);
    cur ? updated++ : added++;
  }
  return { added, updated };
}
async function restore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file is not a valid backup'); return; }
  const recs = Array.isArray(data) ? data : data && Array.isArray(data.records) ? data.records : null;
  if (!recs) { toast('That file is not an EZ Records backup'); return; }
  for (const r of recs) if (r && typeof r === 'object') for (const k of NUMERIC) r[k] = Number(r[k]);
  const a = await mergeInto(RECORDS, records, recs, (r) => !!r.farm);
  const b = await mergeInto(FIELD_STORE, savedFields, Array.isArray(data.fields) ? data.fields : [], (f) => !!(f.farm && f.field));
  await reload();
  toast(`Restore finished: ${a.added} records added, ${a.updated} updated, ${b.added + b.updated} fields`);
}
function printRecords() {
  const list = filtered();
  if (!list.length) { toast('No records to print'); return; }
  const q = $('#search').value.trim();
  const cols = FIELDS.map(([, l]) => `<th>${esc(l)}</th>`).join('') + '<th>Location</th>';
  const body = list.map((r) => '<tr>' + FIELDS.map(([k]) => {
    const v = k === 'date' ? fmtDate(r.date) : NUMERIC.includes(k) ? fmtNum(r[k]) : r[k];
    return `<td>${esc(v)}</td>`;
  }).join('') + `<td>${r.lat != null ? esc(ll5(r.lat, r.lng)) : ''}</td></tr>`).join('');
  $('#printArea').innerHTML = `<h1>EZ Records — herbicide application records</h1>
    <p>Printed ${esc(fmtDate(new Date().toISOString()))} • ${list.length} record${list.length === 1 ? '' : 's'}${q ? ` matching “${esc(q)}”` : ''}</p>
    <table><thead><tr>${cols}</tr></thead><tbody>${body}</tbody></table>`;
  window.print();
}

/* ---------- menu ---------- */
const menu = $('#menu');
function toggleMenu(open) {
  menu.hidden = !open;
  $('#menuBtn').setAttribute('aria-expanded', String(open));
}
$('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(menu.hidden); });
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target)) toggleMenu(false);
  const a = e.target.closest('[data-action]');
  if (!a) return;
  toggleMenu(false);
  ({
    fields: openFieldsList,
    print: printRecords,
    csv: exportCsv,
    backup,
    restore: () => $('#restoreFile').click(),
    about: showAbout,
  })[a.dataset.action]?.();
});
document.addEventListener('click', (e) => { if (e.target.matches('[data-close]')) e.target.closest('dialog').close(); });
$('#restoreFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) restore(f);
});
async function showAbout() {
  let info = '';
  try {
    if (navigator.storage) {
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      info = persisted ? 'This browser has agreed to keep your records safe from automatic cleanup.' : 'Tip: install EZ Records to your home screen so the browser is less likely to clear its data.';
    }
  } catch { /* ignore */ }
  $('#storageInfo').textContent = `${records.length} record${records.length === 1 ? '' : 's'} and ${savedFields.length} saved field${savedFields.length === 1 ? '' : 's'} on this device. ${info}`;
  $('#aboutDlg').showModal();
}
$('#search').addEventListener('input', render);

/* ---------- start ---------- */
reload().catch((err) => {
  $('#empty').hidden = false;
  $('#empty').textContent = 'Could not open storage on this device: ' + (err && err.message ? err.message : err) +
    '. Private browsing modes can block offline storage.';
});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
