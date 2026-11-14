'use strict';

/* EZ Records — offline herbicide application records (PWA).
   All records are stored on this device in IndexedDB. */

const DB_NAME = 'ez-records';
const STORE = 'applications';
const FIELDS = [
  ['date', 'Date'], ['farm', 'Farm'], ['field', 'Field'], ['crop', 'Crop'],
  ['acres', 'Acres'], ['product', 'Herbicide product'], ['rate', 'Rate per acre'],
  ['unit', 'Rate unit'], ['applicator', 'Applicator'], ['wind', 'Wind'], ['notes', 'Notes'],
];
const REQUIRED = ['date', 'farm', 'field', 'crop', 'acres', 'product', 'rate', 'unit', 'applicator'];
const NUMERIC = ['acres', 'rate'];
const SUGGEST = ['farm', 'field', 'crop', 'product', 'unit', 'applicator'];
const BACKUP_KEY = 'ez-records:lastBackup';

const $ = (sel) => document.querySelector(sel);
let records = [];
let editingUid = null;
let viewingUid = null;
let gps = null;

/* ---------- storage ---------- */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'uid' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const dbPromise = openDb();
async function tx(mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const getAll = () => tx('readonly', (s) => new Promise((res) => { const r = s.getAll(); r.onsuccess = () => res(r.result); }));
const putRecord = (rec) => tx('readwrite', (s) => { s.put(rec); });
const deleteRecord = (uid) => tx('readwrite', (s) => { s.delete(uid); });

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

/* ---------- helpers ---------- */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
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
function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function sorted(list) { return [...list].sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0)); }

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
    const vals = [...new Set(records.map((r) => r[k]).filter(Boolean))].slice(0, 50);
    $('#dl-' + k).innerHTML = vals.map((v) => `<option value="${esc(v)}">`).join('');
  }
}
function renderBackupNote() {
  const note = $('#backupNote');
  if (!records.length) { note.hidden = true; return; }
  const last = Number(lsGet(BACKUP_KEY) || 0);
  const newest = Math.max(...records.map((r) => r.updatedAt || r.createdAt || 0));
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  if (last && newest <= last) { note.hidden = true; return; }
  if (last && days < 7) { note.hidden = true; return; }
  note.innerHTML = (last ? `Last backup was ${days} day${days === 1 ? '' : 's'} ago.` : 'Your records have not been backed up yet.') +
    ' Records live only on this device. <button type="button" class="small" data-action="backup">Back up now</button>';
  note.hidden = false;
}
async function reload() { records = sorted(await getAll()); render(); }

/* ---------- form ---------- */
const form = $('#recForm');
function setGps(g) {
  gps = g;
  $('#gpsText').textContent = g ? `${g.lat.toFixed(5)}, ${g.lng.toFixed(5)} (±${Math.round(g.accuracy)} m)` : 'Not recorded';
  $('#gpsClear').hidden = !g;
}
function openForm(rec) {
  editingUid = rec ? rec.uid : null;
  form.reset();
  $('#formError').hidden = true;
  form.querySelectorAll('.invalid').forEach((el) => el.classList.remove('invalid'));
  $('#formTitle').textContent = rec ? 'Edit application' : 'New application';
  for (const [k] of FIELDS) form.elements[k].value = rec ? (rec[k] ?? '') : '';
  if (!rec) {
    form.elements.date.value = nowLocal();
    // Pre-fill applicator and farm from the most recent record to save typing.
    if (records[0]) { form.elements.applicator.value = records[0].applicator || ''; form.elements.farm.value = records[0].farm || ''; }
  }
  setGps(rec && rec.lat != null ? { lat: rec.lat, lng: rec.lng, accuracy: rec.accuracy || 0 } : null);
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
  if (gps) { rec.lat = gps.lat; rec.lng = gps.lng; rec.accuracy = gps.accuracy; }
  else { delete rec.lat; delete rec.lng; delete rec.accuracy; }
  rec.updatedAt = Date.now();
  try {
    await putRecord(rec);
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
form.addEventListener('input', (e) => {
  e.target.classList.remove('invalid');
  if (!form.querySelector('.invalid')) $('#formError').hidden = true;
});
$('#cancelBtn').addEventListener('click', () => $('#formDlg').close());
$('#addBtn').addEventListener('click', () => openForm(null));
$('#gpsClear').addEventListener('click', () => setGps(null));
$('#gpsBtn').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('Location is not available on this device'); return; }
  $('#gpsText').textContent = 'Getting location…';
  navigator.geolocation.getCurrentPosition(
    (p) => setGps({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
    (err) => { setGps(gps); toast(err.code === 1 ? 'Location permission was denied' : 'Could not get location'); },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
  );
});

/* ---------- detail ---------- */
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
    const ll = `${r.lat.toFixed(5)},${r.lng.toFixed(5)}`;
    rows.push(`<dt>Location</dt><dd><a href="https://maps.google.com/?q=${ll}" target="_blank" rel="noopener">${ll}</a> (±${Math.round(r.accuracy || 0)} m)</dd>`);
  }
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
  await deleteRecord(r.uid);
  $('#detailDlg').close();
  toast('Record deleted');
  await reload();
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
  const head = [...FIELDS.map(([, l]) => l), 'Latitude', 'Longitude', 'GPS accuracy (m)'];
  const rows = list.map((r) => [...FIELDS.map(([k]) => (k === 'date' ? String(r.date).replace('T', ' ') : r[k])), r.lat ?? '', r.lng ?? '', r.accuracy != null ? Math.round(r.accuracy) : '']);
  const csv = '﻿' + [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  download(`ez-records-${today()}.csv`, csv, 'text/csv;charset=utf-8');
}
function backup() {
  if (!records.length) { toast('No records to back up'); return; }
  const data = { app: 'ez-records', version: 1, exportedAt: new Date().toISOString(), records };
  download(`ez-records-backup-${today()}.json`, JSON.stringify(data, null, 2), 'application/json');
  lsSet(BACKUP_KEY, String(Date.now()));
  renderBackupNote();
  toast(`Backup downloaded (${records.length} record${records.length === 1 ? '' : 's'})`);
}
async function restore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file is not a valid backup'); return; }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.records) ? data.records : null;
  if (!list) { toast('That file is not an EZ Records backup'); return; }
  const have = new Map(records.map((r) => [r.uid, r]));
  let added = 0, updated = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || !raw.farm) continue;
    const r = { ...raw, uid: raw.uid || uid() };
    for (const k of NUMERIC) r[k] = Number(r[k]);
    const cur = have.get(r.uid);
    if (cur && (cur.updatedAt || 0) >= (r.updatedAt || 0)) continue;
    await putRecord(r);
    cur ? updated++ : added++;
  }
  await reload();
  toast(`Restore finished: ${added} added, ${updated} updated`);
}
function printRecords() {
  const list = filtered();
  if (!list.length) { toast('No records to print'); return; }
  const q = $('#search').value.trim();
  const cols = FIELDS.map(([, l]) => `<th>${esc(l)}</th>`).join('') + '<th>Location</th>';
  const body = list.map((r) => '<tr>' + FIELDS.map(([k]) => {
    const v = k === 'date' ? fmtDate(r.date) : NUMERIC.includes(k) ? fmtNum(r[k]) : r[k];
    return `<td>${esc(v)}</td>`;
  }).join('') + `<td>${r.lat != null ? esc(`${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`) : ''}</td></tr>`).join('');
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
  $('#storageInfo').textContent = `${records.length} record${records.length === 1 ? '' : 's'} on this device. ${info}`;
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
