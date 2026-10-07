// GNSS Log Analyzer: session list, replay, analysis, trimming and exports, served by the hub.

import { PALETTES, currentTheme } from './palette.js';
import { SessionData, LOAD_COLS } from './data.js';
import { TrackView } from './trackview.js';
import qrcode from './vendor/qrcode.js';
import { Charts, PANELS, DEFAULT_PANELS, fmtClock, fmtElapsed } from './charts.js';
import { Scrub } from './scrub.js';
import { drawMiniMap } from './minimap.js';
import { tileCache } from './trackview.js';
import { exportImage, download, dataUrl, fmtDateTime, fmtDuration, fmtDistance } from './exporter.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ------------------------------------------------------------------ preferences

const PREF_KEY = 'gnsslog.analyzer';
const PREF_DEFAULTS = {
  theme: 'system',
  mapLayer: 'off',
  seamarks: false,
  colorBy: 'speed',
  speedUnit: 'kn',
  timeMode: 'clock',
  panels: DEFAULT_PANELS,
  playSpeed: 4,
  follow: false,
  exp: { kind: 'report', format: 'svg', range: 'all', theme: 'light', scale: 2, map: true, cursor: false, dformat: 'csv', drange: 'all', every: '0', cols: 'all', tab: 'image' },
};
const prefs = (() => {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    return { ...PREF_DEFAULTS, ...p, exp: { ...PREF_DEFAULTS.exp, ...(p.exp || {}) } };
  } catch {
    return structuredClone(PREF_DEFAULTS);
  }
})();
function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {}
}

const UNITS = { kn: { k: 1.943844, label: 'kn' }, ms: { k: 1, label: 'm/s' }, kmh: { k: 3.6, label: 'km/h' } };
const speedUnit = () => UNITS[prefs.speedUnit] || UNITS.kn;
const CORE_CSV = ['iso', 'segment', 'lat', 'lon', 'sog', 'cog', 'hdg', 'hdgRate', 'gnssAcc', 'markActive', 'markEvent', 'markLat', 'markLon', 'markDist', 'markBrg'];

// ------------------------------------------------------------------ helpers

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = `toast${err ? ' err' : ''}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 6000 : 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
  return body;
}

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

/** Wire a .seg group: value from data-v; returns a setter. */
function bindSeg(el, value, onChange) {
  const set = (v) => $$('button', el).forEach((b) => b.setAttribute(el.getAttribute('role') === 'tablist' ? 'aria-selected' : 'aria-checked', String(b.dataset.v === String(v))));
  set(value);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    set(b.dataset.v);
    onChange(b.dataset.v);
  });
  return set;
}

function applyTheme() {
  if (prefs.theme === 'light' || prefs.theme === 'dark') document.documentElement.dataset.theme = prefs.theme;
  else delete document.documentElement.dataset.theme;
  const pal = PALETTES[currentTheme()];
  $('meta[name=theme-color]').content = pal.bg;
  track?.set({ pal });
  charts?.set({ pal });
  scrub?.set({ pal });
  if (!$('#view-list').hidden) drawMinis();
}

// ------------------------------------------------------------------ state

const S = {
  list: [],
  session: null, // summary + events from the hub
  data: null, // SessionData
  cursor: null,
  playing: false,
  sel: null,
  win: null,
  hover: null,
  loadingId: null,
  fetchingMore: false,
};

let track, charts, scrub;

// ------------------------------------------------------------------ list view

function renderList() {
  const q = $('#q').value.trim().toLowerCase();
  const items = S.list.filter((s) => !q || [s.name, s.device, s.notes].some((v) => (v || '').toLowerCase().includes(q)));
  $('#list-empty').hidden = S.list.length > 0;
  const k = speedUnit();
  $('#list').innerHTML = items
    .map((s) => {
      const st = s.stats || {};
      const badges = [
        s.live ? '<span class="badge live"><i></i>Live</span>' : '',
        s.source === 'trim' ? '<span class="badge">Trimmed</span>' : '',
        s.source === 'import' ? '<span class="badge">Imported</span>' : '',
        s.marks ? `<span class="badge">${s.marks} mark${s.marks > 1 ? 's' : ''}</span>` : '',
      ].join('');
      return `<a class="row" role="listitem" href="#/s/${encodeURIComponent(s.id)}">
        <canvas class="mini" data-id="${esc(s.id)}" aria-hidden="true"></canvas>
        <div><div class="name">${esc(s.name)}</div>
          <div class="meta">${s.startedAt ? esc(fmtDateTime(s.startedAt)) : ''}${s.device ? ` · ${esc(s.device)}` : ''} ${badges}</div></div>
        <div class="num"><b>${fmtDuration(st.duration)}</b><span>Duration</span></div>
        <div class="num"><b>${fmtDistance(st.distance)}</b><span>Distance</span></div>
        <div class="num opt opt2"><b>${st.maxSog == null ? '—' : (st.maxSog * k.k).toFixed(1)}</b><span>Max ${k.label}</span></div>
        <div class="num opt opt2"><b>${(s.sampleCount || 0).toLocaleString()}</b><span>Samples</span></div>
      </a>`;
    })
    .join('');
  drawMinis();
}

// Thumbnails redraw while their map tiles arrive (a few seconds at most).
let miniTimer = 0;
function drawMinis(deadline = Date.now() + 8000) {
  clearTimeout(miniTimer);
  const pal = PALETTES[currentTheme()];
  const byId = new Map(S.list.map((x) => [x.id, x]));
  for (const c of $$('#list canvas.mini')) {
    drawMiniMap(c, byId.get(c.dataset.id)?.stats?.track, { pal, layer: prefs.mapLayer, dark: pal.name === 'dark' });
  }
  if (prefs.mapLayer !== 'off' && tileCache.pending() && Date.now() < deadline) miniTimer = setTimeout(() => drawMinis(deadline), 300);
}

async function loadList() {
  try {
    S.list = await api('/api/sessions');
    renderList();
  } catch (err) {
    toast(`Could not load sessions: ${err.message}`, true);
  }
}

// ------------------------------------------------------------------ session view

function panelsAvailable() {
  const d = S.data;
  return PANELS.filter((p) => p.series.some((s) => d?.hasData(s.col)));
}

function renderPanelChips() {
  const avail = panelsAvailable();
  $('#panel-chips').innerHTML = avail
    .map((p) => `<button class="chip" type="button" data-id="${p.id}" aria-pressed="${prefs.panels.includes(p.id)}">${esc(p.title)}</button>`)
    .join('');
  applyPanels();
}

function applyPanels() {
  const avail = panelsAvailable();
  let shown = avail.filter((p) => prefs.panels.includes(p.id));
  if (!shown.length) shown = avail.slice(0, 1);
  charts.set({ panels: shown, plotH: innerWidth < 600 ? 84 : 96 });
}

function renderHeader() {
  const s = S.session;
  $('#s-name').textContent = s.name;
  const bits = [s.startedAt ? fmtDateTime(s.startedAt) : null, s.device ? `Device ${s.device}` : null, s.app ? `App ${s.app}` : null, `${S.data.n.toLocaleString()} samples`];
  if (s.source === 'trim') bits.push('trimmed copy');
  $('#s-sub').textContent = bits.filter(Boolean).join(' · ');
  $('#s-live').hidden = !s.live;
  document.title = `${s.name} · GNSS Log Analyzer`;
}

function renderStats() {
  const d = S.data;
  if (!d) return;
  const [ta, tb] = S.sel || [d.t0, d.t1];
  const st = d.stats(ta, tb);
  const k = speedUnit();
  const tiles = [
    ['Duration', fmtDuration(st.duration)],
    ['Distance', fmtDistance(st.distance)],
    ['Avg speed', st.avgSog == null ? '—' : `${(st.avgSog * k.k).toFixed(2)} ${k.label}`],
    ['Max speed', st.maxSog == null ? '—' : `${(st.maxSog * k.k).toFixed(2)} ${k.label}`],
    ['Moving time', fmtDuration(st.movingTime)],
    [d.marks.length ? 'Closest to mark' : 'Marks', d.marks.length ? (st.minMarkDist == null ? '—' : fmtDistance(st.minMarkDist)) : 'None'],
  ];
  $('#stats').innerHTML = tiles.map(([l, v]) => `<div class="tile"><span>${l}</span><b>${v}</b></div>`).join('');
  $('#stats-label').textContent = S.sel ? `Selection · ${fmtClock(ta)} – ${fmtClock(tb)}` : 'Whole session';
  $('.stats-head').classList.toggle('sel', !!S.sel);
}

function renderReadout() {
  const d = S.data;
  if (!d || S.cursor === null) return;
  const i = d.index(S.hover ?? S.cursor);
  const k = speedUnit();
  const v = (c, dig = 1, unit = '') => (Number.isFinite(d.value(c, i)) ? `${d.value(c, i).toFixed(dig)}${unit}` : '—');
  const sog = d.value('sog', i);
  const mark = d.markAt(d.t[i]);
  const rows = [
    ['Time', fmtClock(d.t[i])],
    ['SOG', Number.isFinite(sog) ? `${(sog * k.k).toFixed(2)} ${k.label}` : '—'],
    ['Heading', v('hdg', 1, '°')],
    ['COG', v('cog', 1, '°')],
    ['Rate of turn', v('hdgRate', 2, '°/s')],
    mark ? [`To ${mark.label}`, Number.isFinite(d.value('markDist', i)) ? (d.value('markDist', i) < 1000 ? `${d.value('markDist', i).toFixed(1)} m` : fmtDistance(d.value('markDist', i))) : '—'] : null,
    ['Accuracy', v('gnssAcc', 1, ' m')],
    ['Position', Number.isFinite(d.value('lat', i)) ? `${d.value('lat', i).toFixed(6)}, ${d.value('lon', i).toFixed(6)}` : '—'],
  ].filter(Boolean);
  // The last two rows are dropped on phones (CSS .opt).
  $('#readout').innerHTML = rows.map(([a, b], k) => { const o = k >= rows.length - 2 ? ' class="opt"' : ''; return `<span${o}>${a}</span><b${o}>${esc(b)}</b>`; }).join('');
}

function renderTime() {
  const d = S.data;
  if (!d || S.cursor === null) return;
  $('#t-clock').textContent = fmtClock(S.cursor);
  $('#t-elapsed').textContent = `${fmtElapsed(S.cursor - d.t0)} / ${fmtElapsed(d.t1 - d.t0)}`;
}

function renderSelection() {
  const on = !!S.sel;
  const lbl = $('#sel-label');
  lbl.classList.toggle('on', on);
  if (on) {
    const [a, b] = S.sel;
    const [i0, i1] = S.data.range(a, b);
    lbl.textContent = `Selection ${fmtClock(a)} – ${fmtClock(b)} · ${fmtElapsed(b - a)} · ${(i1 - i0 + 1).toLocaleString()} samples`;
  } else lbl.textContent = innerWidth < 600 ? 'No selection' : 'No selection · drag across the charts or use Start here / End here';
  for (const id of ['#btn-zoom-sel', '#btn-trim', '#btn-sel-clear']) $(id).disabled = !on;
  track.set({ sel: S.sel });
  charts.set({ sel: S.sel });
  scrub.set({ sel: S.sel });
  renderStats();
}

function setCursor(t, { keepPlaying = true } = {}) {
  const d = S.data;
  if (!d || !d.n) return;
  S.cursor = Math.min(Math.max(t, d.t0), d.t1);
  if (!keepPlaying && S.playing) togglePlay(false);
  // Keep the cursor inside the charts window while playing.
  if (S.win && (S.cursor > S.win[1] || S.cursor < S.win[0])) {
    const w = S.win[1] - S.win[0];
    setWindow([S.cursor - w * 0.1, S.cursor + w * 0.9]);
  }
  track.set({ cursor: S.cursor });
  charts.set({ cursor: S.cursor });
  scrub.set({ cursor: S.cursor });
  renderReadout();
  renderTime();
}

function setWindow(win) {
  const d = S.data;
  if (!win) win = [d.t0, d.t1];
  let [a, b] = win;
  const span = d.t1 - d.t0 || 1000;
  const minW = Math.min(5000, span);
  if (b - a < minW) {
    const m = (a + b) / 2;
    a = m - minW / 2;
    b = m + minW / 2;
  }
  if (b - a > span) (a = d.t0), (b = d.t1);
  if (a < d.t0) (b += d.t0 - a), (a = d.t0);
  if (b > d.t1) (a -= b - d.t1), (b = d.t1);
  S.win = [Math.max(a, d.t0), Math.min(b, d.t1)];
  charts.set({ win: S.win });
  scrub.set({ win: S.win });
}

function setSelection(sel) {
  if (sel && sel[1] - sel[0] < 200) sel = null;
  S.sel = sel;
  renderSelection();
}

// ------------------------------------------------------------------ playback

let lastFrame = 0;
function togglePlay(on = !S.playing) {
  const d = S.data;
  if (!d) return;
  S.playing = on;
  $('#btn-play').classList.toggle('on', on);
  $('#btn-play').setAttribute('aria-label', on ? 'Pause' : 'Play');
  if (on) {
    const [a, b] = S.sel || [d.t0, d.t1];
    if (S.cursor >= b - 1 || S.cursor < a) setCursor(a);
    lastFrame = performance.now();
    requestAnimationFrame(playFrame);
  }
}

function playFrame(now) {
  if (!S.playing) return;
  const d = S.data;
  const dt = Math.min(now - lastFrame, 250);
  lastFrame = now;
  const [a, b] = S.sel || [d.t0, d.t1];
  let t = S.cursor + dt * prefs.playSpeed;
  if (t >= b) {
    if (S.session.live && !S.sel) t = d.t1; // live: wait at the end for more
    else {
      t = b;
      togglePlay(false);
    }
  }
  setCursor(t);
  requestAnimationFrame(playFrame);
}

// ------------------------------------------------------------------ open / live

async function openSession(id) {
  S.loadingId = id;
  togglePlay(false);
  $('#view-list').hidden = true;
  $('#view-session').hidden = false;
  $('#s-name').textContent = 'Loading…';
  $('#s-sub').textContent = '';
  try {
    const [meta, samples] = await Promise.all([api(`/api/sessions/${id}`), api(`/api/sessions/${id}/samples?cols=${LOAD_COLS.join(',')}`)]);
    if (S.loadingId !== id) return;
    S.session = meta;
    S.data = new SessionData(meta, samples);
    S.sel = null;
    S.hover = null;
    track.data = null;
    track.setData(S.data);
    charts.set({ data: S.data, speedUnit: speedUnit(), timeMode: prefs.timeMode });
    scrub.set({ data: S.data });
    renderHeader();
    renderPanelChips();
    setWindow(null);
    setCursor(meta.live ? S.data.t1 : S.data.t0);
    renderSelection();
    if (!S.data.n) toast('This session has no samples yet');
  } catch (err) {
    toast(`Could not open the session: ${err.message}`, true);
    location.hash = '#/';
  }
}

async function fetchMore() {
  const d = S.data;
  if (!d || S.fetchingMore) return;
  S.fetchingMore = true;
  try {
    const wasAtEnd = S.cursor >= d.t1 - 1500;
    const fullWin = S.win && S.win[0] <= d.t0 + 1 && S.win[1] >= d.t1 - 1;
    const more = await api(`/api/sessions/${S.session.id}/samples?afterSeq=${d.maxSeq}&cols=${LOAD_COLS.join(',')}`);
    if (!more.rows.length || S.data !== d) return;
    const firstLoad = !d.n;
    d.append(more);
    if (firstLoad) track.fit();
    charts.invalidate();
    scrub.set({ data: d });
    track.dirty = true;
    if (fullWin) setWindow(null);
    else if (S.win && S.win[1] >= d.t1 - 30000) {
      const w = S.win[1] - S.win[0];
      setWindow([d.t1 - w, d.t1]);
    }
    if (wasAtEnd) setCursor(d.t1);
    renderHeader();
    renderStats();
    if (firstLoad) renderPanelChips();
  } catch (err) {
    console.warn('live update failed', err);
  } finally {
    S.fetchingMore = false;
  }
}

function connectStream() {
  let es;
  const open = () => {
    es = new EventSource('/api/stream');
    es.onopen = () => $('#conn').classList.add('on');
    es.onerror = () => $('#conn').classList.remove('on');
    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'session' && msg.session?.id) {
        const i = S.list.findIndex((s) => s.id === msg.session.id);
        if (i >= 0) S.list[i] = { ...S.list[i], ...msg.session };
        else S.list.unshift(msg.session);
        if (!$('#view-list').hidden) renderList();
        if (S.session && S.session.id === msg.session.id) {
          const { events, name, notes, live } = msg.session;
          Object.assign(S.session, { name, notes, live });
          if (events) S.data.setEvents(events);
          if (msg.session.maxSeq > S.data.maxSeq) fetchMore();
          else renderHeader();
        }
      } else if (msg.type === 'deleted') {
        S.list = S.list.filter((s) => s.id !== msg.id);
        if (!$('#view-list').hidden) renderList();
      }
    };
  };
  open();
}

// ------------------------------------------------------------------ dialogs

function confirmDialog(title, text, okLabel = 'Delete') {
  const dlg = $('#dlg-confirm');
  $('#cf-title').textContent = title;
  $('#cf-text').textContent = text;
  $('#cf-go').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((r) => dlg.addEventListener('close', () => r(dlg.returnValue === 'ok'), { once: true }));
}

function setupExportDialog() {
  const dlg = $('#dlg-export');
  const e = prefs.exp;
  const setTab = bindSeg($('#exp-tab'), e.tab, (v) => {
    e.tab = v;
    showTab();
  });
  const showTab = () => {
    $('#exp-image').hidden = e.tab !== 'image';
    $('#exp-data').hidden = e.tab !== 'data';
    $('#exp-go').textContent = e.tab === 'image' ? 'Save image' : 'Download data';
  };
  const segs = {};
  for (const el of $$('#dlg-export .seg[data-name]')) {
    const name = el.dataset.name;
    segs[name] = bindSeg(el, e[name], (v) => {
      e[name] = name === 'scale' ? Number(v) : v;
      refresh();
    });
  }
  const refresh = () => {
    $$('.raster-only', dlg).forEach((x) => (x.style.visibility = e.format === 'svg' ? 'hidden' : ''));
    $$('.csv-only', dlg).forEach((x) => (x.style.visibility = e.dformat === 'csv' ? '' : 'hidden'));
    const hasSel = !!S.sel;
    for (const n of ['range', 'drange']) {
      const b = $(`.seg[data-name=${n}] button[data-v=selection]`, dlg);
      b.disabled = !hasSel;
    }
    const mapBox = $('input[name=map]', dlg);
    mapBox.disabled = prefs.mapLayer === 'off';
    mapBox.parentElement.style.opacity = mapBox.disabled ? 0.5 : 1;
    $('#exp-data-note').textContent = {
      csv: 'Spreadsheet of every sample column (Core: position, speed, heading and mark columns).',
      json: 'GNSS Log JSON: the full record with events. Can be imported here again.',
      gpx: 'Track with time, speed, course and heading; marks as waypoints. Opens in most chart plotters.',
      geojson: 'Track line with per-point times and speeds, plus mark points. For GIS tools.',
      kml: 'Track and marks for Google Earth.',
    }[e.dformat];
  };
  $('input[name=map]', dlg).checked = e.map;
  $('input[name=cursor]', dlg).checked = e.cursor;
  $('input[name=map]', dlg).onchange = (ev) => (e.map = ev.target.checked);
  $('input[name=cursor]', dlg).onchange = (ev) => (e.cursor = ev.target.checked);

  $('#btn-export').onclick = () => {
    if (!S.data?.n) return toast('Nothing to export yet');
    if (!S.sel) {
      if (e.range === 'selection') e.range = 'all';
      if (e.drange === 'selection') e.drange = 'all';
    }
    for (const [n, set] of Object.entries(segs)) set(e[n]);
    setTab(e.tab);
    showTab();
    refresh();
    dlg.showModal();
  };

  $('#exp-go').onclick = async () => {
    savePrefs();
    const btn = $('#exp-go');
    if (e.tab === 'data') {
      const [t0, t1] = e.drange === 'selection' && S.sel ? S.sel : e.drange === 'view' ? S.win : [undefined, undefined];
      const url = dataUrl(S.session.id, { format: e.dformat, t0, t1, every: Number(e.every) || 0, cols: e.dformat === 'csv' && e.cols === 'core' ? CORE_CSV : null });
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      dlg.close();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      const ctx = {
        data: S.data,
        name: S.session.name,
        device: S.session.device,
        track,
        charts,
        sel: S.sel,
        cursor: S.cursor,
        mapLayer: prefs.mapLayer,
        seamarks: prefs.seamarks,
        colorBy: prefs.colorBy,
        speedUnit: speedUnit(),
        timeMode: prefs.timeMode,
      };
      const { blob, filename } = await exportImage(ctx, { kind: e.kind, format: e.format, scale: e.scale, theme: e.theme, range: e.range, map: e.map, cursor: e.cursor });
      download(blob, filename);
      dlg.close();
      toast(`Saved ${filename}`);
    } catch (err) {
      toast(`Export failed: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      showTab();
    }
  };
}

function setupTrimDialog() {
  const dlg = $('#dlg-trim');
  $('#btn-trim').onclick = () => {
    if (!S.sel) return;
    const [a, b] = S.sel;
    const [i0, i1] = S.data.range(a, b);
    $('#trim-info').textContent = `${fmtDateTime(a)} – ${fmtClock(b)} · ${fmtElapsed(b - a)} · ${(i1 - i0 + 1).toLocaleString()} samples`;
    $('#trim-name').value = `${S.session.name} (trimmed)`;
    $('#trim-delete').checked = false;
    $('#trim-delete').disabled = !!S.session.live;
    dlg.showModal();
  };
  $('#trim-go').onclick = async () => {
    const [t0, t1] = S.sel;
    const deleteOriginal = $('#trim-delete').checked;
    if (deleteOriginal && !(await confirmDialog('Delete the original?', `"${S.session.name}" will be removed after the trimmed copy is created. This cannot be undone.`))) return;
    try {
      const s = await api(`/api/sessions/${S.session.id}/trim`, { method: 'POST', body: JSON.stringify({ t0: Math.floor(t0), t1: Math.ceil(t1), name: $('#trim-name').value, deleteOriginal }) });
      dlg.close();
      toast(`Created "${s.name}"`);
      location.hash = `#/s/${s.id}`;
    } catch (err) {
      toast(`Trim failed: ${err.message}`, true);
    }
  };
}

// ------------------------------------------------------------------ phones (pairing)

function setupPhonesDialog() {
  const dlg = $('#dlg-phones');
  let poll = 0, code = null, lastQr = null;
  const ago = (t) => {
    if (!t) return 'no uploads yet';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 2 ? 'uploading now' : m < 120 ? `last upload ${m} min ago` : `last upload ${fmtDateTime(t)}`;
  };
  const showList = async () => {
    stop();
    $('#ph-pair-view').hidden = true;
    $('#ph-list-view').hidden = false;
    let r;
    try {
      r = await api('/api/devices');
    } catch (err) {
      toast(`Phones: ${err.message}`, true);
      return;
    }
    const ul = $('#ph-list');
    ul.innerHTML = r.devices.length
      ? r.devices
          .map((d) => `<li data-id="${esc(d.id)}"><span class="ph-name"><b>${esc(d.name)}</b><small>paired ${esc(fmtDateTime(d.createdAt))} · ${esc(ago(d.lastSeen))}</small></span><button class="btn ghost small" type="button" data-act="rename">Rename</button><button class="btn ghost small" type="button" data-act="remove">Remove</button></li>`)
          .join('')
      : '<li class="empty">No paired phones yet</li>';
    $('#ph-legacy').hidden = !r.legacy.configured;
    $('#ph-legacy-state').textContent = r.legacy.enabled ? '· still accepted (phones set up before pairing)' : '· switched off';
    $('#ph-legacy-btn').textContent = r.legacy.enabled ? 'Switch off' : 'Switch on';
    $('#ph-legacy-btn').onclick = async () => {
      if (r.legacy.enabled && !(await confirmDialog('Switch off the old shared key?', 'Phones still using it stop uploading until they are paired. You can switch it back on here.', 'Switch off'))) return dlg.showModal();
      await api('/api/devices/legacy', { method: 'PUT', body: JSON.stringify({ enabled: !r.legacy.enabled }) }).catch((e) => toast(e.message, true));
      if (!dlg.open) dlg.showModal();
      showList();
    };
  };
  {
    $('#ph-list').addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const li = b.closest('li');
      const id = li.dataset.id, name = li.querySelector('b').textContent;
      if (b.dataset.act === 'rename') {
        const n = prompt('Phone name', name);
        if (!n || n === name) return;
        await api(`/api/devices/${id}`, { method: 'PATCH', body: JSON.stringify({ name: n }) }).catch((err) => toast(err.message, true));
      } else {
        const ok = await confirmDialog(`Remove ${name}?`, 'Its key stops working at once; it uploads again only after pairing. Recordings already uploaded stay.', 'Remove');
        if (!dlg.open) dlg.showModal();
        if (!ok) return;
        await api(`/api/devices/${id}`, { method: 'DELETE' }).catch((err) => toast(err.message, true));
      }
      showList();
    });
  }
  const stop = () => {
    clearInterval(poll);
    poll = 0;
  };
  const newCode = async () => {
    stop();
    try {
      code = await api('/api/devices/pair', { method: 'POST' });
    } catch (err) {
      toast(`Pairing: ${err.message}`, true);
      return;
    }
    const host = location.host;
    const qr = qrcode(0, 'M');
    qr.addData(`${location.origin}/pair#${code.code}`);
    qr.make();
    lastQr = { qr, host, display: code.display, expiresAt: code.expiresAt };
    $('#ph-qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    $('#ph-host').textContent = host;
    $('#ph-code').textContent = code.display;
    $('#ph-local').hidden = !/^(localhost|127\.|\[::1\]|192\.168\.|10\.)/.test(location.hostname);
    $('#ph-list-view').hidden = true;
    $('#ph-pair-view').hidden = false;
    const tick = async () => {
      const left = Math.max(0, Math.round((code.expiresAt - Date.now()) / 1000));
      $('#ph-expiry').textContent = left ? `valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · single use` : 'expired: create a new code';
      if (!left) return stop();
      try {
        const st = await api(`/api/devices/pair/${code.code}`);
        if (st.status === 'paired') {
          toast(`Paired: ${st.device?.name || 'phone'}`);
          showList();
        }
      } catch {}
    };
    tick();
    poll = setInterval(tick, 2000);
  };
  $('#btn-phones').onclick = () => {
    dlg.showModal();
    showList();
  };
  $('#ph-pair').onclick = newCode;
  $('#ph-new').onclick = newCode;
  $('#ph-back').onclick = showList;
  // The QR code as a PNG (with the address and code under it) to send to the phone.
  $('#ph-save').onclick = () => {
    if (!lastQr) return;
    const { qr, host, display, expiresAt } = lastQr;
    const n = qr.getModuleCount(), cell = 12, quiet = 4 * cell, size = n * cell + 2 * quiet;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size + 120;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) g.fillRect(quiet + x * cell, quiet + y * cell, cell, cell);
    g.textAlign = 'center';
    g.font = '600 26px system-ui, sans-serif';
    g.fillText(host, size / 2, size + 30);
    g.font = '700 44px ui-monospace, Menlo, Consolas, monospace';
    g.fillText(display, size / 2, size + 80);
    g.font = '500 18px system-ui, sans-serif';
    g.fillStyle = '#555';
    g.fillText(`GNSS Log pairing · single use · until ${new Date(expiresAt).toLocaleTimeString()}`, size / 2, size + 108);
    c.toBlob((b) => b && download(b, `gnsslog-pair-${display}.png`), 'image/png');
  };
  dlg.addEventListener('close', stop);
}

function setupRenameDialog() {
  const dlg = $('#dlg-rename');
  $('#btn-rename').onclick = () => {
    $('#ren-name').value = S.session.name;
    $('#ren-notes').value = S.session.notes || '';
    dlg.showModal();
  };
  $('#ren-go').onclick = async () => {
    try {
      const s = await api(`/api/sessions/${S.session.id}`, { method: 'PATCH', body: JSON.stringify({ name: $('#ren-name').value, notes: $('#ren-notes').value }) });
      S.session.name = s.name;
      S.session.notes = s.notes;
      renderHeader();
      dlg.close();
    } catch (err) {
      toast(`Could not save: ${err.message}`, true);
    }
  };
  $('#btn-delete').onclick = async () => {
    const s = S.session;
    const extra = s.live ? ' It is still uploading: the phone keeps sending, but the hub ignores a deleted session.' : '';
    if (!(await confirmDialog(`Delete "${s.name}"?`, `The recording and its ${S.data.n.toLocaleString()} samples are removed from the hub (the copy on the phone is not affected).${extra}`))) return;
    try {
      await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
      toast('Session deleted');
      location.hash = '#/';
    } catch (err) {
      toast(`Delete failed: ${err.message}`, true);
    }
  };
}

// ------------------------------------------------------------------ wiring

function setup() {
  const pal = PALETTES[currentTheme()];
  track = new TrackView($('#track'), { onSeek: (t) => setCursor(t, { keepPlaying: false }) });
  track.set({ pal, speedUnit: speedUnit() });
  track.setOptions({ map: prefs.mapLayer, seamarks: prefs.seamarks, colorBy: prefs.colorBy, follow: prefs.follow });
  charts = new Charts($('#charts'), {
    onSeek: (t) => setCursor(t, { keepPlaying: false }),
    onSelect: (sel) => setSelection(sel),
    onWindow: (w) => setWindow(w),
    onHover: (t) => {
      S.hover = t;
      charts.set({ hover: t });
      renderReadout();
    },
  });
  charts.set({ pal, speedUnit: speedUnit(), timeMode: prefs.timeMode });
  scrub = new Scrub($('#scrub-canvas'), { onSeek: (t) => setCursor(t, { keepPlaying: false }), onSelect: (sel) => setSelection(sel) });
  scrub.set({ pal });

  bindSeg($('#map-seg'), prefs.mapLayer, (v) => {
    prefs.mapLayer = v;
    savePrefs();
    track.setOptions({ map: v });
  });
  bindSeg($('#color-seg'), prefs.colorBy, (v) => {
    prefs.colorBy = v;
    savePrefs();
    track.setOptions({ colorBy: v });
  });
  const toggleChip = (el, key, apply) => {
    el.setAttribute('aria-pressed', String(!!prefs[key]));
    el.onclick = () => {
      prefs[key] = !prefs[key];
      el.setAttribute('aria-pressed', String(prefs[key]));
      savePrefs();
      apply(prefs[key]);
    };
  };
  toggleChip($('#btn-seamarks'), 'seamarks', (v) => track.setOptions({ seamarks: v }));
  toggleChip($('#btn-follow'), 'follow', (v) => track.setOptions({ follow: v }));
  track.onViewChange = () => {
    if (prefs.follow) {
      prefs.follow = false;
      $('#btn-follow').setAttribute('aria-pressed', 'false');
      savePrefs();
    }
  };
  $('#btn-fit').onclick = () => (S.sel ? track.fit(...S.sel) : track.fit());
  $('#btn-zin').onclick = () => track.zoom(1 / 1.6);
  $('#btn-zout').onclick = () => track.zoom(1.6);

  $('#panel-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const id = b.dataset.id;
    prefs.panels = prefs.panels.includes(id) ? prefs.panels.filter((x) => x !== id) : [...prefs.panels, id];
    b.setAttribute('aria-pressed', String(prefs.panels.includes(id)));
    savePrefs();
    applyPanels();
  });
  $('#unit').value = prefs.speedUnit;
  $('#unit').onchange = (e) => {
    prefs.speedUnit = e.target.value;
    savePrefs();
    charts.set({ speedUnit: speedUnit() });
    track.set({ speedUnit: speedUnit() });
    renderStats();
    renderReadout();
  };
  $('#timemode').value = prefs.timeMode;
  $('#timemode').onchange = (e) => {
    prefs.timeMode = e.target.value;
    savePrefs();
    charts.set({ timeMode: prefs.timeMode });
    charts.invalidate();
  };
  $('#btn-zoom-reset').onclick = () => setWindow(null);

  $('#btn-play').onclick = () => togglePlay();
  $('#speed').value = String(prefs.playSpeed);
  $('#speed').onchange = (e) => {
    prefs.playSpeed = Number(e.target.value);
    savePrefs();
  };
  $('#btn-sel-start').onclick = () => selEdge('start');
  $('#btn-sel-end').onclick = () => selEdge('end');
  $('#btn-sel-clear').onclick = () => setSelection(null);
  $('#btn-zoom-sel').onclick = () => {
    if (!S.sel) return;
    const pad = (S.sel[1] - S.sel[0]) * 0.05;
    setWindow([S.sel[0] - pad, S.sel[1] + pad]);
    track.fit(...S.sel);
  };

  setupExportDialog();
  setupTrimDialog();
  setupRenameDialog();
  setupPhonesDialog();

  $('#btn-theme').onclick = () => {
    prefs.theme = { system: 'light', light: 'dark', dark: 'system' }[prefs.theme] || 'system';
    savePrefs();
    applyTheme();
    toast(`Theme: ${prefs.theme}`);
  };
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

  $('#q').addEventListener('input', renderList);
  $('#file-import').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const r = await api('/api/import', { method: 'POST', body: await f.text() });
      toast(`Imported ${r.sampleCount.toLocaleString()} samples`);
      location.hash = `#/s/${r.session}`;
    } catch (err) {
      toast(`Import failed: ${err.message}`, true);
    }
  };

  document.addEventListener('keydown', (e) => {
    if ($('#view-session').hidden || !S.data?.n || e.target.closest('input, textarea, select, dialog')) return;
    const step = e.shiftKey ? 10000 : 1000;
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowRight') setCursor(S.cursor + step, { keepPlaying: false });
    else if (e.key === 'ArrowLeft') setCursor(S.cursor - step, { keepPlaying: false });
    else if (e.key === 'Home') setCursor(S.data.t0, { keepPlaying: false });
    else if (e.key === 'End') setCursor(S.data.t1, { keepPlaying: false });
    else if (e.key === '[') selEdge('start');
    else if (e.key === ']') selEdge('end');
    else if (e.key === 'Escape') setSelection(null);
    else return;
    if (e.key !== ' ') e.preventDefault();
  });

  addEventListener('hashchange', route);
  addEventListener('resize', () => S.data && applyPanels());
}

function selEdge(which) {
  const d = S.data;
  if (!d?.n) return;
  const [a, b] = S.sel || [d.t0, d.t1];
  const t = S.cursor;
  if (which === 'start') setSelection(t < b ? [t, b] : [t, d.t1]);
  else setSelection(t > a ? [a, t] : [d.t0, t]);
}

function route() {
  const m = location.hash.match(/^#\/s\/([A-Za-z0-9-]+)/);
  document.body.classList.toggle('in-session', !!m);
  if (m) return openSession(decodeURIComponent(m[1]));
  togglePlay(false);
  S.session = null;
  S.data = null;
  S.loadingId = null;
  $('#view-session').hidden = true;
  $('#view-list').hidden = false;
  document.title = 'GNSS Log Analyzer';
  loadList();
}

setup();
applyTheme();
connectStream();
route();

if ('serviceWorker' in navigator && !navigator.webdriver) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
