// GNSS Log — application shell: wires sensors → fusion → 5 Hz ticker → recorder / visualiser,
// storage and cloud sync, and drives the UI.

import { Settings } from './settings.js';
import { openDB } from './db.js';
import { Sensors } from './sensors.js';
import { Fusion } from './fusion.js';
import { Recorder, SAMPLE_INTERVAL, defaultName } from './recorder.js';
import { SyncManager } from './sync.js';
import { Visualizer, fmtDist } from './visualizer.js';
import { exportSession } from './export.js';
import { LocalFrame, wrap180, wrap360, haversine } from './geo.js';
import { isNative, plugin } from './native.js';
import { MAP_SOURCES, SEAMARKS } from './maptiles.js';

const VERSION = '0.6.2';
window.GNSSLOG_VERSION = VERSION;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- formatting

const SPEED = {
  kn: { k: 1.943844, label: 'kn' },
  ms: { k: 1, label: 'm/s' },
  kmh: { k: 3.6, label: 'km/h' },
};
const isNum = (v) => v !== null && v !== undefined && Number.isFinite(v);
const fmtSpeed = (ms, unit) => (isNum(ms) ? (ms * SPEED[unit].k).toFixed(ms * SPEED[unit].k < 10 ? 2 : 1) : '—');
const fmtDeg = (d) => (isNum(d) ? `${Math.round(wrap360(d)).toString().padStart(3, '0')}°` : '—');
const fmtSigned = (v, dp = 2) => (isNum(v) ? (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(dp) : '—');
const fmtLL = (lat, lon, sep = '  ') =>
  isNum(lat) ? `${Math.abs(lat).toFixed(6)}°${lat >= 0 ? 'N' : 'S'}${sep}${Math.abs(lon).toFixed(6)}°${lon >= 0 ? 'E' : 'W'}` : '—';
function fmtDuration(ms) {
  if (!isNum(ms) || ms < 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}
const fmtDate = (t) =>
  new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------- UI primitives

function toast(msg, { kind = '', action, onAction, ms = 3200 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${kind ? '<i class="dot"></i>' : ''}<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.onclick = () => {
      onAction?.();
      close();
    };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  if (ms) setTimeout(close, ms);
  return close;
}

let sheetClose = null;
function openSheet(html, onMount) {
  closeSheet(true);
  const sheet = $('#sheet');
  const scrim = $('#sheet-scrim');
  sheet.innerHTML = `<div class="grabber"></div>${html}`;
  sheet.hidden = false;
  scrim.hidden = false;
  sheet.classList.remove('closing');
  scrim.classList.remove('closing');
  const close = (instant = false) => {
    if (sheetClose !== close) return;
    sheetClose = null;
    if (instant) {
      sheet.hidden = scrim.hidden = true;
      return;
    }
    sheet.classList.add('closing');
    scrim.classList.add('closing');
    setTimeout(() => {
      if (sheetClose) return; // another sheet opened meanwhile
      sheet.hidden = scrim.hidden = true;
    }, 300);
  };
  sheetClose = close;
  scrim.onclick = () => close();
  onMount?.(sheet, close);
  initSegmented(sheet);
  return close;
}
function closeSheet(instant) {
  sheetClose?.(instant);
}

/** Segmented controls: gliding indicator under the pressed button. */
function initSegmented(root = document) {
  for (const seg of $$('.segmented', root)) {
    if (!seg.querySelector('.indicator')) {
      const ind = document.createElement('i');
      ind.className = 'indicator';
      seg.prepend(ind);
    }
    placeIndicator(seg);
  }
}
function placeIndicator(seg) {
  const ind = seg.querySelector('.indicator');
  const on = seg.querySelector('button[aria-pressed="true"]');
  if (!ind) return;
  if (!on) {
    ind.style.width = '0px';
    return;
  }
  ind.style.width = `${on.offsetWidth}px`;
  ind.style.transform = `translateX(${on.offsetLeft}px)`;
}
function setSegmented(seg, value) {
  for (const b of $$('button', seg)) b.setAttribute('aria-pressed', String(b.dataset.v === String(value)));
  placeIndicator(seg);
}

function setChip(el, cls, text) {
  el.classList.remove('ok', 'warn', 'err', 'busy');
  if (cls) el.classList.add(cls);
  el.querySelector('span').textContent = text;
}

// ---------------------------------------------------------------- core objects

const settings = new Settings();
const db = await openDB();
const sensors = new Sensors();
const fusion = new Fusion(settings);
const recorder = new Recorder(db, settings);
recorder.keepRunningInBackground = isNative;
const sync = new SyncManager(db, settings);
// A recording cut off by the phone closing the app can be resumed (asked at start-up below);
// anything older, or any extra open session, is closed now.
const RESUME_WINDOW = 12 * 3600 * 1000;
let interrupted = await recorder.findInterrupted();
if (interrupted && Date.now() - interrupted.lastT > RESUME_WINDOW) interrupted = null;
await recorder.recoverInterrupted(interrupted?.session.id);

sensors.addEventListener('gnss', (e) => fusion.onGnss(e.detail));
sensors.addEventListener('orientation', (e) => fusion.onOrientation(e.detail));
sensors.addEventListener('motion', (e) => fusion.onMotion(e.detail));
sensors.addEventListener('nativeMotion', (e) => {
  fusion.onNativeMotion(e.detail);
  maybeTick(); // native 25 Hz heartbeat keeps the 5 Hz logger on time even if timers are throttled
});

let origin = null;
fusion.addEventListener('frame', (e) => {
  origin = e.detail;
  trail.length = 0; // coordinates of the old frame no longer apply
});

// ---------------------------------------------------------------- 5 Hz ticker

const trail = [];
let lastState = null;

function trailCap() {
  return Math.max(1, settings.get('trailMinutes')) * 60 * (1000 / SAMPLE_INTERVAL);
}

let nextTick = Math.ceil(Date.now() / SAMPLE_INTERVAL) * SAMPLE_INTERVAL;
let tickTimer = 0;
function maybeTick() {
  if (Date.now() >= nextTick - 10) tick();
}
function tick() {
  clearTimeout(tickTimer);
  const now = Date.now();
  const s = fusion.state(now);
  s.origin = origin;
  lastState = s;
  if (s.hasFix) {
    trail.push({ x: s.x, y: s.y });
    const cap = trailCap();
    if (trail.length > cap) trail.splice(0, trail.length - cap);
  }
  recorder.add(s);
  if (document.visibilityState === 'visible') renderLive(s);
  // Drift-free schedule on the 200 ms grid; skip missed slots after a stall.
  nextTick += SAMPLE_INTERVAL;
  const t = Date.now();
  if (nextTick < t) nextTick = Math.ceil(t / SAMPLE_INTERVAL) * SAMPLE_INTERVAL;
  tickTimer = setTimeout(tick, nextTick - t);
}
tickTimer = setTimeout(tick, nextTick - Date.now());

// ---------------------------------------------------------------- live screen

const viz = new Visualizer($('#viz'), { onModeChange: (auto) => $('#btn-auto').setAttribute('aria-pressed', String(auto)) });
viz.start(() => {
  const s = fusion.peek(Date.now());
  if (!s.hasFix) return { vessel: null, trail, sky: null };
  return {
    vessel: { x: s.x, y: s.y, hdg: s.hdg, acc: s.acc, vx: s.vx, vy: s.vy },
    trail: trail.concat([{ x: s.x, y: s.y }]),
    geo: fusion.frame, // lets the visualiser place map tiles
    sky: s.sky,
    headingUp: settings.get('orientUp') === 'heading',
  };
});
$('#btn-zoom-in').onclick = () => viz.zoom(1 / 1.5);
$('#btn-zoom-out').onclick = () => viz.zoom(1.5);
$('#btn-auto').onclick = () => viz.setAuto(!viz.auto);
$('#btn-orient').onclick = () => settings.set('orientUp', settings.get('orientUp') === 'heading' ? 'north' : 'heading');

function renderOrient() {
  const h = settings.get('orientUp') === 'heading';
  for (const id of ['#btn-orient', '#pb-orient']) $(id).textContent = h ? 'H↑' : 'N↑';
  const seg = $('[data-setting="orientUp"]');
  if (seg) setSegmented(seg, settings.get('orientUp'));
}

function renderLive(s) {
  const unit = settings.get('speedUnit');
  $('#r-sog').textContent = fmtSpeed(s.sog, unit);
  $('#r-sog-u').textContent = SPEED[unit].label;
  $('#r-hdg').textContent = fmtDeg(s.hdg);
  $('#r-hdg-src').textContent = s.hdgSrc === 'none' ? '°T' : `°T · ${s.hdgSrc}${isNum(s.hdgSigma) ? ` ±${s.hdgSigma.toFixed(0)}°` : ''}`;
  $('#r-cog').textContent = fmtDeg(s.cog);
  $('#r-rot').textContent = fmtSigned(s.hdgRate, 1);
  $('#r-vx').textContent = fmtSigned(s.vx);
  $('#r-vy').textContent = fmtSigned(s.vy);
  $('#r-pos').textContent = fmtLL(s.lat, s.lon, '\n');
  $('#r-acc').textContent = s.gnss
    ? `±${s.gnss.acc.toFixed(1)} m GNSS · fix ${(s.gnssAge / 1000).toFixed(1)} s ago`
    : 'no fix';

  const sky = s.sky;
  $('#sky-readout').hidden = !sky;
  if (sky) {
    $('#sky-dist').textContent = fmtDist(sky.dist);
    $('#sky-sub').textContent = `bearing ${fmtDeg(sky.brg)} · marked ${fmtDuration(Date.now() - sky.t)} ago`;
  }
  const mode = $('#viz-mode');
  mode.textContent = sky ? 'Skyhook centred' : 'Vessel centred';
  mode.classList.toggle('sky', !!sky);

  // Status chips.
  const st = sensors.status;
  const chipG = $('#chip-gnss');
  if (st.gnss === 'ok' && s.gnss) {
    const stale = s.gnssAge > 3000;
    setChip(chipG, stale ? 'warn' : s.gnss.acc <= 10 ? 'ok' : 'warn', `±${s.gnss.acc.toFixed(s.gnss.acc < 10 ? 1 : 0)} m`);
  } else if (st.gnss === 'waiting') setChip(chipG, 'busy', 'GNSS…');
  else if (st.gnss === 'denied') setChip(chipG, 'err', 'GNSS denied');
  else if (st.gnss === 'error' || st.gnss === 'unsupported') setChip(chipG, 'err', 'No GNSS');
  else setChip(chipG, '', 'GNSS off');

  const chipH = $('#chip-hdg');
  const gyro = st.motion === 'ok';
  if (s.hdgSrc === 'compass' && fusion.magAccuracy !== null && fusion.magAccuracy <= 1) setChip(chipH, 'warn', 'Calibrate compass');
  else if (s.hdgSrc === 'compass') setChip(chipH, 'ok', gyro ? 'Compass+Gyro' : 'Compass');
  else if (s.hdgSrc === 'cog') setChip(chipH, 'warn', 'COG');
  else if (st.orientation === 'waiting') setChip(chipH, 'busy', 'Compass…');
  else if (st.orientation === 'denied') setChip(chipH, 'err', 'Compass denied');
  else if (st.orientation === 'relative') setChip(chipH, 'warn', 'No north ref');
  else setChip(chipH, st.orientation === 'off' ? '' : 'err', 'No compass');

  if (recorder.active) {
    const dur = Date.now() - recorder.session.startedAt;
    $('#btn-rec-label').textContent = `Stop ${fmtDuration(dur)}`;
    $('#rec-sub').textContent = `● ${recorder.session.name} · ${recorder.seq} samples`;
  }
}

function renderRecorder() {
  const on = recorder.active;
  $('#btn-rec').classList.toggle('busy', on);
  $('#rec-sub').classList.toggle('rec', on);
  if (!on) {
    $('#btn-rec-label').textContent = 'Start recording';
    $('#rec-sub').textContent = 'Not recording';
  }
}
recorder.addEventListener('change', () => {
  sensors.setBackground(recorder.active); // Android app: foreground service + wake lock while recording
  renderRecorder();
  if (currentTab === 'sessions') renderSessions();
});
recorder.addEventListener('stopped', () => sync.kick(true));
recorder.addEventListener('resumed', (e) => {
  trail.push(null); // break the breadcrumb line across the gap
  toast(`Recording was paused for ${fmtDuration(e.detail.gapMs)} while the app was in the background`, { kind: 'warn', ms: 6000 });
});
recorder.addEventListener('error', (e) => toast(`Storage error: ${e.detail?.message || e.detail}`, { kind: 'err' }));

function renderSkyButtons() {
  const on = !!fusion.skyhook;
  $('#btn-sky').classList.toggle('active', on);
  $('#btn-sky-label').textContent = on ? 'Re-mark' : 'Skyhook';
  $('#btn-sky-clear').hidden = !on;
}
fusion.addEventListener('skyhook', renderSkyButtons);

$('#btn-sky').onclick = async () => {
  const sky = fusion.markSkyhook();
  if (!sky) {
    toast('No position yet — wait for a GNSS fix', { kind: 'warn' });
    return;
  }
  navigator.vibrate?.(30);
  if (recorder.active) await recorder.markSkyhook(sky);
  toast(`Skyhook marked${recorder.active ? ' and logged' : ''} · ${fmtLL(sky.lat, sky.lon)}`, { kind: 'ok' });
};
$('#btn-sky-clear').onclick = async () => {
  const prev = fusion.skyhook;
  fusion.clearSkyhook();
  if (recorder.active) await recorder.logEvent('skyhook_clear');
  toast('Skyhook cleared', {
    action: 'Undo',
    onAction: async () => {
      fusion.skyhook = prev;
      fusion._saveSkyhook();
      fusion.dispatchEvent(new CustomEvent('skyhook', { detail: prev }));
      if (recorder.active) await recorder.markSkyhook(prev);
    },
  });
};

$('#btn-rec').onclick = () => {
  if (recorder.active) {
    openSheet(
      `<h3>Stop recording?</h3>
       <p class="sub">${esc(recorder.session.name)} · ${fmtDuration(Date.now() - recorder.session.startedAt)} · ${recorder.seq} samples</p>
       <div class="stack"><div class="btn-pair">
         <button class="btn-glass pressable" data-act="cancel">Keep going</button>
         <button class="btn-aurora pressable" data-act="stop">Stop</button>
       </div></div>`,
      (sheet, close) => {
        $('[data-act="cancel"]', sheet).onclick = () => close();
        $('[data-act="stop"]', sheet).onclick = async () => {
          close();
          const s = await recorder.stop();
          toast(`Saved “${s.name}” · ${s.sampleCount} samples`, { kind: 'ok' });
        };
      },
    );
    return;
  }
  openSheet(
    `<h3>New test case</h3>
     <p class="sub">Logged at 5 Hz with timestamps. You can rename it later.</p>
     <div class="stack">
       <label class="col"><span class="section-label">Name</span>
         <input class="field" id="new-name" type="text" maxlength="120" value="${esc(defaultName())}" /></label>
       <label class="col"><span class="section-label">Notes</span>
         <textarea class="field" id="new-notes" maxlength="2000" placeholder="Conditions, sea state, setup…"></textarea></label>
       ${isNative
         ? '<p class="hint">Recording continues with the screen off or while you use other apps. A notification shows while it runs.</p>'
         : '<p class="hint">Keep GNSS Log on screen while recording: phones pause web apps in the background. To use other apps, open it in split screen or pop-up view.</p>'}
       <div id="battery-hint"></div>
       ${!fusion.gnss ? '<p class="hint">No GNSS fix yet — recording will start now and fill in once a fix arrives.</p>' : ''}
       <button class="btn-aurora pressable" id="new-start"><span>Start recording</span></button>
     </div>`,
    (sheet, close) => {
      const name = $('#new-name', sheet);
      name.select();
      if (isNative) {
        plugin('VesselSensors').batteryStatus().then(({ unrestricted }) => {
          if (unrestricted) return;
          $('#battery-hint', sheet).innerHTML =
            '<p class="hint">Battery optimisation can stop long recordings. <button class="btn-glass pressable small" id="btn-batt">Allow unrestricted</button></p>';
          $('#btn-batt', sheet).onclick = () => plugin('VesselSensors').requestUnrestrictedBattery();
        });
      }
      $('#new-start', sheet).onclick = async () => {
        if (!sensors.running) await enableSensors();
        await recorder.start({
          name: name.value.trim(),
          notes: $('#new-notes', sheet).value.trim(),
          origin,
          skyhook: fusion.skyhook && Number.isFinite(fusion.skyhook.x) ? fusion.skyhook : null,
        });
        close();
        navigator.vibrate?.(30);
        toast('Recording', { kind: 'ok' });
      };
    },
  );
};

// ---------------------------------------------------------------- sensors / permissions

async function enableSensors() {
  if (isNative && sensors.status.gnss === 'denied') {
    sensors.openSettings();
    return;
  }
  try {
    await sensors.start();
  } catch (err) {
    toast(`Could not start sensors: ${err.message}`, { kind: 'err' });
  }
  renderPerm();
}
$('#btn-perm').onclick = enableSensors;

function renderPerm() {
  const st = sensors.status;
  const needGnss = st.gnss === 'off' || st.gnss === 'denied';
  const needMotion = !sensors.motionStarted || st.orientation === 'denied';
  $('#perm-card').hidden = !(needGnss || needMotion);
  const strong = $('#perm-card strong');
  const span = $('#perm-card .perm-text span');
  if (st.gnss === 'denied') {
    strong.textContent = 'Location access denied';
    span.textContent = isNative
      ? 'Tap Enable to open app settings, allow Location (and Notifications), then return.'
      : 'Allow location for this site in your browser settings, then reload.';
  } else if (st.orientation === 'denied') {
    strong.textContent = 'Motion access denied';
    span.textContent = 'Heading needs motion & orientation access. Tap Enable to ask again.';
  } else if (needMotion && !needGnss) {
    strong.textContent = 'Enable compass & gyro';
    span.textContent = 'Tap Enable to allow motion sensors for heading.';
  }
}
sensors.addEventListener('status', renderPerm);

// Start what we can without a gesture, then ask for the rest with a clear start-up prompt
// (iOS, and newer Android Chrome, only grant motion sensors from a tap).
(async () => {
  let geoGranted = false;
  try {
    const p = await navigator.permissions?.query({ name: 'geolocation' });
    geoGranted = p?.state === 'granted';
  } catch {}
  if (isNative) {
    // Android app: the location permission prompt is native; no tap needed for sensors.
    try {
      await sensors.start();
    } catch (err) {
      console.error(err);
      toast(`Sensors failed to start: ${err.message || err}`, { kind: 'err', ms: 0 });
    }
    renderPerm();
    if (interrupted) showResume(interrupted);
    return;
  }
  if (geoGranted) sensors.startGnss();
  if (!sensors.needsMotionPermission) sensors.startMotion();
  renderPerm();
  if (interrupted) showResume(interrupted);
  else if (sensors.needsMotionPermission || !geoGranted) showOnboarding();
})();

function showResume({ session, lastT }) {
  const ago = fmtDuration(Date.now() - lastT);
  let decided = false;
  openSheet(
    `<h3>Continue recording?</h3>
     <p class="sub">“${esc(session.name)}” stopped ${ago} ago when the phone closed the app
       (${session.sampleCount} samples saved).</p>
     <div class="stack">
       <p class="hint">Continuing keeps the same test case. The gap is logged as a pause/resume event and the
         <b>segment</b> column goes up by one.</p>
       <button class="btn-aurora pressable" data-act="resume"><span>Continue recording</span></button>
       <button class="btn-glass pressable" data-act="finish">Finish it</button>
     </div>`,
    (sheet, close) => {
      $('[data-act="resume"]', sheet).onclick = async () => {
        decided = true;
        close();
        if (session.origin) fusion.setOrigin(session.origin.lat, session.origin.lon);
        const sky = fusion.skyhook && Number.isFinite(fusion.skyhook.x) ? fusion.skyhook : null;
        await recorder.resumeSession(session, lastT, sky);
        if (!sensors.running || !sensors.motionStarted) await enableSensors(); // this tap grants motion access
        toast('Recording continued', { kind: 'ok' });
      };
      $('[data-act="finish"]', sheet).onclick = async () => {
        decided = true;
        close();
        await recorder.recoverInterrupted();
        renderSessions();
        if (sensors.needsMotionPermission || sensors.status.gnss === 'off') showOnboarding();
      };
      // Dismissing without choosing finishes it, so a session is never left open.
      $('#sheet-scrim').addEventListener('click', () => !decided && recorder.recoverInterrupted(), { once: true });
    },
  );
}

function showOnboarding() {
  const row = (icon, title, text) => `
    <div class="ob-row"><span class="icon-tile" aria-hidden="true">${icon}</span>
      <div><strong>${title}</strong><span>${text}</span></div></div>`;
  openSheet(
    `<h3>Start sensors</h3>
     <p class="sub">GNSS Log uses the phone as the vessel's sensor. Allow these when asked.</p>
     <div class="stack">
       ${row('<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z" /></svg>', 'Location (GNSS)', 'Position, speed and course')}
       ${row('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" /></svg>', 'Compass', 'Magnetometer heading')}
       ${row('<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></svg>', 'Gyroscope', 'Smooth heading and rate of turn')}
       <p class="hint">Keep magnets (MagSafe rings, magnetic mounts) and steel away from the phone; they bend the compass.</p>
       <button class="btn-aurora pressable" data-act="go"><span>Enable sensors</span></button>
       <button class="btn-glass pressable" data-act="later">Not now</button>
     </div>`,
    (sheet, close) => {
      $('[data-act="go"]', sheet).onclick = async () => {
        await enableSensors();
        close();
        const st = sensors.status;
        if (st.orientation === 'denied' || st.motion === 'denied') toast('Motion access was declined — heading will use GNSS course', { kind: 'warn', ms: 5000 });
      };
      $('[data-act="later"]', sheet).onclick = () => close();
    },
  );
}

// ---------------------------------------------------------------- tabs / navigation

const TABS = ['live', 'sessions', 'settings'];
let currentTab = 'live';

function showTab(tab) {
  if (tab === currentTab) return;
  const from = TABS.indexOf(currentTab);
  const to = TABS.indexOf(tab);
  const prevEl = $(`[data-screen="${currentTab}"]`);
  const el = $(`[data-screen="${tab}"]`);
  prevEl.hidden = true;
  el.hidden = false;
  el.classList.remove('enter-left', 'enter-right');
  void el.offsetWidth;
  el.classList.add(to > from ? 'enter-right' : 'enter-left');
  for (const r of $$('.reveal', el)) {
    r.style.animation = 'none';
    void r.offsetWidth;
    r.style.animation = '';
  }
  currentTab = tab;
  window.scrollTo(0, 0);
  for (const b of $$('.dock-tab')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (tab === 'sessions') {
    animateList = true;
    renderSessions();
    sync.refreshPending();
  }
  if (tab === 'settings') {
    renderSettings();
    renderStorage();
  }
}
for (const b of $$('.dock-tab')) b.onclick = () => showTab(b.dataset.tab);

// ---------------------------------------------------------------- sessions

let animateList = false;
async function renderSessions() {
  const animate = animateList;
  animateList = false;
  const [sessions, syncMap] = await Promise.all([db.listSessions(), db.listSync()]);
  const list = $('#session-list');
  $('#session-empty').hidden = sessions.length > 0;
  list.innerHTML = sessions
    .map((s, i) => {
      const live = recorder.active && recorder.session.id === s.id;
      const count = live ? recorder.seq : s.sampleCount;
      const dur = (live ? Date.now() : s.endedAt || s.startedAt) - s.startedAt;
      const st = syncMap.get(s.id);
      const synced = st ? st.syncedSeq + 1 : 0;
      const metaOk = st && st.metaVersion >= s.metaVersion;
      let badge;
      if (live) badge = '<span class="badge rec">● REC</span>';
      else if (synced >= s.sampleCount && metaOk) badge = '<span class="badge ok">Uploaded</span>';
      else if (synced > 0) badge = `<span class="badge warn">${Math.floor((100 * synced) / Math.max(1, s.sampleCount))}%</span>`;
      else badge = '<span class="badge">On device</span>';
      const skyCount = s.events.filter((e) => e.type === 'skyhook').length;
      return `<button class="session glass pressable${animate ? ' reveal' : ''}" style="--i:${Math.min(i + 2, 10)}" data-id="${s.id}">
        <span class="icon-tile ${live ? 'danger' : ''}" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 17c3-1 4-6 9-6s6 5 9 6" /><circle cx="12" cy="7" r="2.5" /></svg></span>
        <span class="meta"><strong>${esc(s.name)}</strong>
          <span class="tnum">${fmtDate(s.startedAt)} · ${fmtDuration(dur)} · ${count} pts${skyCount ? ` · ${skyCount} skyhook` : ''}${s.interrupted ? ' · interrupted' : ''}</span></span>
        ${badge}
      </button>`;
    })
    .join('');
  for (const el of $$('.session', list)) el.onclick = () => openSessionSheet(el.dataset.id);
}
sync.addEventListener('progress', () => currentTab === 'sessions' && renderSessions());

async function openSessionSheet(id) {
  const s = await db.getSession(id);
  if (!s) return;
  const live = recorder.active && recorder.session.id === id;
  const st = await db.getSync(id);
  const synced = st ? st.syncedSeq + 1 : 0;
  const dur = (live ? Date.now() : s.endedAt || s.startedAt) - s.startedAt;
  const skyEvents = s.events.filter((e) => e.type === 'skyhook' || e.type === 'skyhook_active');
  openSheet(
    `<h3>Session</h3>
     <p class="sub tnum">${fmtDate(s.startedAt)}${live ? ' · recording' : ''}${s.interrupted ? ' · interrupted' : ''}</p>
     <div class="stack">
       <label class="col"><span class="section-label">Name</span>
         <input class="field" id="ss-name" type="text" maxlength="120" value="${esc(s.name)}" /></label>
       <label class="col"><span class="section-label">Notes</span>
         <textarea class="field" id="ss-notes" maxlength="2000">${esc(s.notes)}</textarea></label>
       <div class="stats">
         <div class="tile"><span class="section-label">Duration</span><b class="tnum">${fmtDuration(dur)}</b></div>
         <div class="tile"><span class="section-label">Samples</span><b class="tnum">${live ? recorder.seq : s.sampleCount}</b></div>
         <div class="tile"><span class="section-label">Uploaded</span><b class="tnum">${s.sampleCount ? Math.floor((100 * synced) / s.sampleCount) : 0}%</b></div>
       </div>
       ${skyEvents.length ? `<p class="hint tnum">Skyhook marks: ${skyEvents.map((e) => `${new Date(e.t).toLocaleTimeString()} (${e.lat.toFixed(6)}, ${e.lon.toFixed(6)})`).join(' · ')}</p>` : ''}
       <button class="btn-aurora pressable" data-act="play" ${s.sampleCount ? '' : 'disabled'}><span>Play back</span></button>
       <div class="btn-pair">
         <button class="btn-glass pressable" data-act="csv">Export CSV</button>
         <button class="btn-glass pressable" data-act="json">Export JSON</button>
       </div>
       <button class="btn-glass pressable danger" data-act="delete" ${live ? 'disabled' : ''}>Delete</button>
     </div>`,
    (sheet, close) => {
      const save = async () => {
        const name = $('#ss-name', sheet).value.trim() || s.name;
        const notes = $('#ss-notes', sheet).value.trim();
        if (name === s.name && notes === (s.notes || '')) return;
        if (recorder.active && recorder.session.id === id) await recorder.rename(name, notes);
        else {
          const fresh = await db.getSession(id);
          Object.assign(fresh, { name, notes, metaVersion: fresh.metaVersion + 1 });
          await db.putSession(fresh);
        }
        Object.assign(s, { name, notes });
        renderSessions();
        sync.kick();
      };
      $('#ss-name', sheet).onchange = save;
      $('#ss-notes', sheet).onchange = save;
      $('[data-act="play"]', sheet).onclick = async () => {
        await save();
        close();
        openPlayback(id);
      };
      $('[data-act="csv"]', sheet).onclick = async () => {
        await recorder.flush();
        exportSession(db, await db.getSession(id), 'csv');
      };
      $('[data-act="json"]', sheet).onclick = async () => {
        await recorder.flush();
        exportSession(db, await db.getSession(id), 'json');
      };
      $('[data-act="delete"]', sheet).onclick = (e) => {
        const b = e.currentTarget;
        if (b.dataset.confirm) {
          db.deleteSession(id).then(() => {
            close();
            renderSessions();
            sync.refreshPending();
            toast('Session deleted');
          });
          return;
        }
        b.dataset.confirm = '1';
        b.textContent = synced >= s.sampleCount ? 'Tap again to delete' : 'Not uploaded — tap again to delete';
      };
    },
  );
}

function renderSync(st) {
  const chip = $('#chip-sync');
  const pending = st.pendingSamples;
  const detail = $('#sync-detail');
  const icon = $('#sync-icon');
  icon.className = 'icon-tile';
  $('#sync-progress').hidden = st.state !== 'syncing';
  $('#sync-progress').classList.toggle('indeterminate', st.state === 'syncing');
  const last = st.lastSyncAt ? ` · last ${new Date(st.lastSyncAt).toLocaleTimeString()}` : '';
  switch (st.state) {
    case 'unconfigured':
      setChip(chip, '', pending ? `${st.pendingSessions} local` : 'Local');
      $('#sync-title').textContent = 'Cloud sync not set up';
      detail.textContent = 'Add an endpoint in Settings. Data stays on this device until then.';
      break;
    case 'offline':
      setChip(chip, 'warn', 'Offline');
      $('#sync-title').textContent = 'Offline';
      detail.textContent = `${pending} samples waiting · will upload when online`;
      icon.classList.add('warning');
      break;
    case 'syncing':
      setChip(chip, 'busy', 'Syncing');
      $('#sync-title').textContent = 'Uploading…';
      detail.textContent = `${pending} samples left`;
      break;
    case 'error':
      setChip(chip, 'err', 'Sync error');
      $('#sync-title').textContent = 'Upload failed — retrying';
      detail.textContent = st.error;
      icon.classList.add('danger');
      break;
    case 'paused':
      setChip(chip, pending ? 'warn' : 'ok', pending ? 'Paused' : 'Synced');
      $('#sync-title').textContent = 'Auto upload off';
      detail.textContent = `${pending} samples waiting${last}`;
      break;
    default:
      setChip(chip, pending ? 'warn' : 'ok', pending ? `${pending} pending` : 'Synced');
      $('#sync-title').textContent = pending ? 'Waiting to upload' : 'All uploaded';
      detail.textContent = `${pending} samples pending${last}`;
      if (!pending) icon.classList.add('success');
  }
}
sync.addEventListener('status', (e) => renderSync(e.detail));
$('#btn-sync-now').onclick = () => {
  if (!sync.configured) {
    toast('Set an endpoint URL in Settings first', { kind: 'warn' });
    showTab('settings');
    setTimeout(() => $('[data-setting="endpoint"]').focus(), 350);
    return;
  }
  sync.syncAll(true);
};

// ---------------------------------------------------------------- playback

const pb = {
  session: null,
  samples: [],
  pts: [],
  sky: [],
  playing: false,
  t: 0,
  speed: 1,
  lastFrame: 0,
  viz: null,
};

async function openPlayback(id) {
  await recorder.flush();
  const session = await db.getSession(id);
  const samples = await db.getSamples(id);
  const first = samples.find((s) => isNum(s.lat));
  if (!first) {
    toast('This session has no positions to play back', { kind: 'warn' });
    return;
  }
  const frame = new LocalFrame(first.lat, first.lon);
  pb.session = session;
  pb.samples = samples;
  pb.pts = samples.map((s) => (isNum(s.lat) ? frame.toXY(s.lat, s.lon) : null));
  pb.frame = frame;
  // Skyhook timeline: [{ t, spot | null }]
  pb.sky = session.events
    .filter((e) => ['skyhook', 'skyhook_active', 'skyhook_clear'].includes(e.type))
    .sort((a, b) => a.t - b.t)
    .map((e) => ({ t: e.type === 'skyhook_active' ? session.startedAt : e.t, spot: e.type === 'skyhook_clear' ? null : { ...frame.toXY(e.lat, e.lon), lat: e.lat, lon: e.lon, markedAt: e.markedAt ?? e.t } }));
  pb.t0 = samples[0].t;
  pb.t1 = samples[samples.length - 1].t;
  pb.t = pb.t0;
  pb.playing = false;

  $('#pb-name').textContent = session.name;
  $('#pb-meta').textContent = `${fmtDate(session.startedAt)} · ${samples.length} samples · ${fmtDuration(pb.t1 - pb.t0)}`;
  const scrub = $('#pb-scrub');
  scrub.max = String(pb.t1 - pb.t0);
  scrub.value = '0';
  $('#pb-dur').textContent = fmtDuration(pb.t1 - pb.t0);
  setSegmented($('#pb-speed'), pb.speed);

  const screen = $('#screen-playback');
  screen.hidden = false;
  screen.classList.remove('push-out');
  screen.classList.add('push-in');
  $('#screens').classList.remove('pushed-back');
  $('#screens').classList.add('pushed-under');
  $('.dock').classList.add('hidden');
  initSegmented(screen);
  if (!pb.viz) {
    pb.viz = new Visualizer($('#pb-viz'), { onModeChange: (a) => $('#pb-auto').setAttribute('aria-pressed', String(a)) });
    applyMap();
  }
  pb.viz.setAuto(true);
  pb.lastFrame = performance.now();
  pb.viz.start(playbackFrame);
  renderPlayPause();
}

function closePlayback() {
  pb.playing = false;
  const screen = $('#screen-playback');
  screen.classList.remove('push-in');
  screen.classList.add('push-out');
  $('#screens').classList.remove('pushed-under');
  $('#screens').classList.add('pushed-back');
  $('.dock').classList.remove('hidden');
  setTimeout(() => {
    screen.hidden = true;
    screen.classList.remove('push-out');
    $('#screens').classList.remove('pushed-back');
    pb.viz?.stop();
  }, 300);
}

/** Index of the last sample with t <= time. */
function sampleIndexAt(time) {
  const a = pb.samples;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid].t <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function playbackFrame() {
  const now = performance.now();
  const dt = now - pb.lastFrame;
  pb.lastFrame = now;
  if (pb.playing) {
    pb.t += dt * pb.speed;
    if (pb.t >= pb.t1) {
      pb.t = pb.t1;
      pb.playing = false;
      renderPlayPause();
    }
  }
  const i = sampleIndexAt(pb.t);
  const a = pb.samples[i];
  const b = pb.samples[Math.min(i + 1, pb.samples.length - 1)];
  const pa = pb.pts[i], pbb = pb.pts[Math.min(i + 1, pb.pts.length - 1)];
  const f = b.t > a.t && b.t - a.t <= 2000 ? Math.min(1, Math.max(0, (pb.t - a.t) / (b.t - a.t))) : 0;
  const lerp = (u, v) => (isNum(u) && isNum(v) ? u + (v - u) * f : isNum(u) ? u : null);

  let vessel = null;
  if (pa) {
    const p2 = pbb || pa;
    const hdg = isNum(a.hdg) && isNum(b.hdg) ? wrap360(a.hdg + wrap180(b.hdg - a.hdg) * f) : a.hdg;
    vessel = { x: pa.x + (p2.x - pa.x) * f, y: pa.y + (p2.y - pa.y) * f, hdg, acc: a.gnssAcc, vx: lerp(a.vx, b.vx), vy: lerp(a.vy, b.vy) };
  }

  let spot = null;
  for (const e of pb.sky) if (e.t <= pb.t) spot = e.spot;
  let sky = null;
  if (spot && vessel) {
    const dx = vessel.x - spot.x, dy = vessel.y - spot.y;
    sky = { ...spot, dist: Math.hypot(dx, dy), brg: wrap360((Math.atan2(-dx, -dy) * 180) / Math.PI) };
  }

  // Trail: last N minutes up to the playhead.
  const cap = trailCap();
  const tr = [];
  for (let k = Math.max(0, i - cap); k <= i; k++) {
    if (!pb.pts[k]) continue;
    if (k > 0 && pb.samples[k].t - pb.samples[k - 1].t > 2000) tr.push(null); // gap: break the line
    tr.push(pb.pts[k]);
  }
  if (vessel) tr.push({ x: vessel.x, y: vessel.y });

  // Readouts (throttled to ~15 fps by cheap comparisons; DOM writes are small).
  const unit = settings.get('speedUnit');
  $('#pb-sog').textContent = fmtSpeed(lerp(a.sog, b.sog), unit);
  $('#pb-sog-u').textContent = SPEED[unit].label;
  $('#pb-hdg').textContent = fmtDeg(vessel?.hdg);
  $('#pb-vx').textContent = fmtSigned(vessel?.vx);
  $('#pb-vy').textContent = fmtSigned(vessel?.vy);
  $('#pb-sky').hidden = !sky;
  if (sky) {
    $('#pb-sky-dist').textContent = fmtDist(sky.dist);
    $('#pb-sky-sub').textContent = `bearing ${fmtDeg(sky.brg)}`;
  }
  $('#pb-mode').textContent = sky ? 'Skyhook centred' : 'Vessel centred';
  $('#pb-mode').classList.toggle('sky', !!sky);
  const scrub = $('#pb-scrub');
  const rel = pb.t - pb.t0;
  if (!scrub.matches(':active')) scrub.value = String(rel);
  scrub.style.setProperty('--p', `${(100 * rel) / Math.max(1, pb.t1 - pb.t0)}%`);
  $('#pb-t').textContent = fmtDuration(rel);
  $('#pb-clock').textContent = new Date(pb.t).toLocaleTimeString();

  return { vessel, trail: tr, sky, geo: pb.frame, headingUp: settings.get('orientUp') === 'heading' };
}

function renderPlayPause() {
  $('#pb-play').classList.toggle('playing', pb.playing);
  $('#pb-play').setAttribute('aria-label', pb.playing ? 'Pause' : 'Play');
}
$('#pb-back').onclick = closePlayback;
$('#pb-play').onclick = () => {
  if (!pb.playing && pb.t >= pb.t1) pb.t = pb.t0;
  pb.playing = !pb.playing;
  renderPlayPause();
};
$('#pb-scrub').oninput = (e) => {
  pb.t = pb.t0 + Number(e.target.value);
};
$('#pb-auto').onclick = () => pb.viz.setAuto(!pb.viz.auto);
$('#pb-orient').onclick = $('#btn-orient').onclick;
for (const b of $$('#pb-speed button')) {
  b.onclick = () => {
    pb.speed = Number(b.dataset.v);
    setSegmented($('#pb-speed'), pb.speed);
  };
}

// ---------------------------------------------------------------- settings screen

// ---------------------------------------------------------------- map background

const MAP_CYCLE = ['off', 'street', 'satellite'];
const MAP_LABEL = { off: 'Map off', street: 'Street map', satellite: 'Satellite map' };

function isDarkTheme() {
  const t = settings.get('theme');
  return t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyMap() {
  const layer = settings.get('mapLayer');
  const base = layer === 'off' ? null : layer;
  const opts = { base, seamarks: !!base && settings.get('seamarks'), dark: isDarkTheme() };
  viz.setMap(opts);
  pb.viz?.setMap(opts);
  const credits = base ? [MAP_SOURCES[base]] : [];
  if (opts.seamarks) credits.push(SEAMARKS);
  for (const a of $$('.map-attrib')) {
    a.hidden = !credits.length;
    a.textContent = credits.map((c) => c.attribution).join(' · ');
    a.href = credits[0]?.link || '#';
  }
  for (const b of $$('.map-btn')) {
    b.classList.toggle('on', !!base);
    b.setAttribute('aria-label', `${MAP_LABEL[layer]} (tap to change)`);
  }
}

for (const id of ['#btn-map', '#pb-map']) {
  $(id).onclick = () => {
    const next = MAP_CYCLE[(MAP_CYCLE.indexOf(settings.get('mapLayer')) + 1) % MAP_CYCLE.length];
    settings.set('mapLayer', next);
    toast(MAP_LABEL[next], { ms: 1500 });
  };
}

function applyTheme() {
  const t = settings.get('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name="theme-color"]').content = dark ? '#041113' : '#F1F7F6';
  viz.refreshTheme();
  pb.viz?.refreshTheme();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  applyTheme();
  applyMap();
});

function renderSettings() {
  for (const el of $$('[data-setting]')) {
    const k = el.dataset.setting;
    const v = settings.get(k);
    if (el.classList.contains('segmented')) setSegmented(el, v);
    else if (el.classList.contains('switch')) el.setAttribute('aria-checked', String(!!v));
    else if (document.activeElement !== el) el.value = v ?? '';
  }
}

for (const el of $$('[data-setting]')) {
  const k = el.dataset.setting;
  if (el.classList.contains('segmented')) {
    for (const b of $$('button', el)) b.onclick = () => settings.set(k, b.dataset.v);
  } else if (el.classList.contains('switch')) {
    el.onclick = () => settings.set(k, !settings.get(k));
  } else {
    el.onchange = () => {
      let v = el.value;
      if (el.type === 'number') {
        v = Number(v);
        if (!Number.isFinite(v)) return renderSettings();
        if (el.min !== '') v = Math.max(Number(el.min), v);
        if (el.max !== '') v = Math.min(Number(el.max), v);
      } else v = v.trim();
      settings.set(k, v);
    };
  }
}

settings.addEventListener('change', (e) => {
  const k = e.detail.key;
  renderSettings();
  if (k === 'theme') applyTheme();
  if (k === 'theme' || k === 'mapLayer' || k === 'seamarks') applyMap();
  if (k === 'orientUp') renderOrient();
  if (k === 'mount') fusion.resetDeviation(); // different geometry, different deviation
  if (k === 'invertGyro' || k === 'autoDeviation') fusion.hkf.reset();
  if (['endpoint', 'authHeader', 'authValue', 'autoSync'].includes(k)) sync.kick(true);
});

async function renderStorage() {
  try {
    const est = await navigator.storage?.estimate();
    const persisted = await navigator.storage?.persisted?.();
    if (est) $('#storage-detail').textContent = `${(est.usage / 1048576).toFixed(1)} MB of ${(est.quota / 1048576).toFixed(0)} MB${persisted ? ' · protected' : ''}`;
    $('#btn-persist').hidden = !!persisted || !navigator.storage?.persist;
  } catch {}
}
$('#btn-persist').onclick = async () => {
  const ok = await navigator.storage.persist();
  toast(ok ? 'Data protected from automatic cleanup' : 'The browser declined — install the app to the home screen and try again', { kind: ok ? 'ok' : 'warn', ms: 4500 });
  renderStorage();
};

// Live sensor diagnostics on the settings page.
setInterval(() => {
  if (currentTab !== 'settings') return;
  const s = lastState;
  if (!s) return;
  const st = sensors.status;
  $('#diag').textContent = [
    `GNSS ${st.gnss}${st.gnssError ? ` (${st.gnssError})` : ''} · orientation ${st.orientation} · gyro ${st.motion}`,
    `mount ${s.mount || '—'}${settings.get('mount') === 'auto' ? ' (auto)' : ''} · compass (mag) ${isNum(s.compass) ? s.compass.toFixed(1) + '°' : '—'} · filtered ${isNum(s.hdg) ? s.hdg.toFixed(1) + '°T' : '—'} ±${isNum(s.hdgSigma) ? s.hdgSigma.toFixed(1) : '—'}°`,
    `gyro yaw ${isNum(s.gyroRate) ? s.gyroRate.toFixed(2) : '—'}°/s · bias ${isNum(s.gyroBias) ? s.gyroBias.toFixed(3) : '—'}°/s · pitch ${isNum(s.pitch) ? s.pitch.toFixed(0) : '—'}° roll ${isNum(s.roll) ? s.roll.toFixed(0) : '—'}°`,
  ].join('\n');
  const d = fusion.dev;
  const on = settings.get('autoDeviation');
  $('#dev-detail').textContent = !on
    ? 'Off'
    : d.n === 0
      ? 'Learns while running straight above 4 kn'
      : `${d.n} s learned · ${d.sectors}/8 headings · now ${fmtSigned(s.compassDev, 1)}°`;
  $('#dev-check').textContent = isNum(fusion.devResidual)
    ? `Compass vs GNSS course (last straight run): ${fmtSigned(fusion.devResidual, 1)}°`
    : 'Compass vs GNSS course: needs a straight run above 4 kn';
}, 500);
$('#btn-dev-reset').onclick = () => {
  fusion.resetDeviation();
  toast('Compass correction reset');
};

$('#app-version').textContent = `GNSS Log ${VERSION} · logging at 5 Hz`;

// ---------------------------------------------------------------- service worker

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !isNative) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Update available', {
            action: recorder.active ? undefined : 'Reload',
            onAction: () => nw.postMessage('skipWaiting'),
            ms: 0,
          });
        }
      });
    });
  }).catch((err) => console.warn('SW registration failed', err));
  // Only reload when an existing worker is replaced (an update), not on first install.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading || recorder.active) return;
    reloading = true;
    location.reload();
  });
}

// ---------------------------------------------------------------- boot

applyTheme();
applyMap();
renderSettings();
renderOrient();
renderRecorder();
renderSkyButtons();
initSegmented();
sync.kick(true);
window.addEventListener('resize', () => $$('.segmented').forEach(placeIndicator));

// Exposed for debugging from the console.
window.gnsslog = { settings, db, sensors, fusion, recorder, sync, haversine };
