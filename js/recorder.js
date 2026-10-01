// Test-case recorder: owns the active session, turns fused state into 5 Hz sample rows,
// buffers them and flushes to IndexedDB. Also logs events (start/stop/skyhook marks).

export const SAMPLE_HZ = 5;
export const SAMPLE_INTERVAL = 1000 / SAMPLE_HZ;
const FLUSH_EVERY = SAMPLE_HZ; // ~1 s of samples per write

/** Columns of a sample row, in CSV order. */
export const SAMPLE_COLUMNS = [
  'seq', 't', 'iso',
  'lat', 'lon', 'x', 'y', 'vx', 'vy', 'sog', 'cog',
  'hdg', 'hdgMag', 'hdgRate', 'hdgSigma', 'hdgSrc', 'gyroRate', 'gyroBias', 'compass', 'compassDev', 'pitch', 'roll',
  'posSigma', 'gnssAcc', 'gnssAge', 'gnssNew', 'gnssT', 'gnssLat', 'gnssLon', 'gnssAlt', 'gnssSpeed', 'gnssCog',
  'skyActive', 'skyEvent', 'skyLat', 'skyLon', 'skyDist', 'skyBrg',
];

const r = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Short label for the skyEvent column: the row whose seq equals the event's seq gets it. */
export const SKY_EVENT_LABEL = { skyhook: 'mark', skyhook_clear: 'clear', skyhook_active: 'active' };

export function sampleFromState(s, sid, seq, lastGnssT) {
  const g = s.gnss;
  return {
    sid,
    seq,
    t: s.t,
    iso: new Date(s.t).toISOString(),
    lat: r(s.lat, 8),
    lon: r(s.lon, 8),
    x: r(s.x, 3),
    y: r(s.y, 3),
    vx: r(s.vx, 3),
    vy: r(s.vy, 3),
    sog: r(s.sog, 3),
    cog: r(s.cog, 2),
    hdg: r(s.hdg, 2),
    hdgMag: r(s.hdgMag, 2),
    hdgRate: r(s.hdgRate, 3),
    hdgSigma: r(s.hdgSigma, 2),
    hdgSrc: s.hdgSrc,
    gyroRate: r(s.gyroRate, 3),
    gyroBias: r(s.gyroBias, 4),
    compass: r(s.compass, 2),
    compassDev: r(s.compassDev, 2),
    pitch: r(s.pitch, 2),
    roll: r(s.roll, 2),
    posSigma: r(s.posSigma, 2),
    gnssAcc: g ? r(g.acc, 2) : null,
    gnssAge: s.gnssAge === null ? null : Math.round(s.gnssAge),
    gnssNew: g ? (g.t !== lastGnssT ? 1 : 0) : 0,
    gnssT: g ? g.fixT : null,
    gnssLat: g ? g.lat : null,
    gnssLon: g ? g.lon : null,
    gnssAlt: g ? r(g.alt, 2) : null,
    gnssSpeed: g ? r(g.speed, 3) : null,
    gnssCog: g ? r(g.cog, 2) : null,
    skyActive: s.skySpot ? 1 : 0,
    skyEvent: '',
    skyLat: s.skySpot ? s.skySpot.lat : null,
    skyLon: s.skySpot ? s.skySpot.lon : null,
    skyDist: s.sky ? r(s.sky.dist, 3) : null,
    skyBrg: s.sky ? r(s.sky.brg, 2) : null,
  };
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class Recorder extends EventTarget {
  constructor(db, settings) {
    super();
    this.db = db;
    this.settings = settings;
    this.session = null;
    this.buffer = [];
    this.seq = 0;
    this.lastGnssT = null;
    this.wakeLock = null;
    this._writing = Promise.resolve();
    document.addEventListener('visibilitychange', () => {
      if (!this.session) return;
      if (document.visibilityState === 'hidden') this.flush();
      else this._acquireWakeLock();
    });
    window.addEventListener('pagehide', () => this.flush());
  }

  get active() {
    return !!this.session;
  }

  /** Close sessions left 'recording' by a crash, reload or killed tab. */
  async recoverInterrupted() {
    const sessions = await this.db.listSessions();
    for (const s of sessions) {
      if (s.status !== 'recording') continue;
      const last = s.sampleCount > 0 ? (await this.db.getSamples(s.id, s.sampleCount - 1))[0] : null;
      s.status = 'done';
      s.endedAt = last ? last.t : s.startedAt;
      s.interrupted = true;
      s.events.push({ type: 'stop', t: s.endedAt, seq: s.sampleCount, reason: 'interrupted' });
      s.metaVersion++;
      await this.db.putSession(s);
    }
  }

  async start({ name, notes = '', origin = null, skyhook = null }) {
    if (this.session) return this.session;
    const now = Date.now();
    this.seq = 0;
    this.buffer = [];
    this.lastGnssT = null;
    this.pendingSky = skyhook ? ['active'] : [];
    this.session = {
      id: uuid(),
      name: name || defaultName(new Date(now)),
      notes,
      createdAt: now,
      startedAt: now,
      endedAt: null,
      status: 'recording',
      sampleHz: SAMPLE_HZ,
      sampleCount: 0,
      origin,
      events: [{ type: 'start', t: now, seq: 0 }],
      metaVersion: 1,
      device: { ua: navigator.userAgent, name: this.settings.get('deviceName') || null },
      config: this.settings.snapshot(),
      app: { version: window.GNSSLOG_VERSION || 'dev' },
    };
    if (skyhook) this.session.events.push(skyhookEvent('skyhook_active', skyhook, 0));
    await this.db.putSession(this.session);
    this._acquireWakeLock();
    this._emit('change');
    return this.session;
  }

  /** Called by the 5 Hz ticker with the fused state. */
  add(state) {
    if (!this.session) return;
    if (!this.session.origin && state.origin) this.session.origin = state.origin;
    const row = sampleFromState(state, this.session.id, this.seq++, this.lastGnssT);
    if (this.pendingSky?.length) {
      row.skyEvent = this.pendingSky.join(';');
      this.pendingSky = [];
    }
    if (state.gnss) this.lastGnssT = state.gnss.t;
    this.buffer.push(row);
    if (this.buffer.length >= FLUSH_EVERY) this.flush();
  }

  /** Serialised writes so samples always land in order. */
  flush() {
    if (!this.session) return this._writing;
    const rows = this.buffer;
    this.buffer = [];
    const session = this.session;
    session.sampleCount = this.seq;
    const snapshot = structuredClone(session);
    this._writing = this._writing
      .then(() => this.db.appendSamples(snapshot, rows))
      .catch((err) => {
        console.error('Failed to write samples', err);
        this._emit('error', err);
      });
    return this._writing;
  }

  async logEvent(type, data = {}) {
    if (!this.session) return;
    this.session.events.push({ type, t: Date.now(), seq: this.seq, ...data });
    if (SKY_EVENT_LABEL[type]) (this.pendingSky ||= []).push(SKY_EVENT_LABEL[type]);
    this.session.metaVersion++;
    await this.flush();
    this._emit('change');
  }

  markSkyhook(sky) {
    return this.logEvent('skyhook', skyhookEvent('skyhook', sky).data);
  }

  async rename(name, notes) {
    if (!this.session) return;
    this.session.name = name;
    if (notes !== undefined) this.session.notes = notes;
    this.session.metaVersion++;
    await this.flush();
    this._emit('change');
  }

  async stop() {
    if (!this.session) return null;
    const now = Date.now();
    this.session.events.push({ type: 'stop', t: now, seq: this.seq });
    this.session.status = 'done';
    this.session.endedAt = now;
    this.session.metaVersion++;
    await this.flush();
    const finished = this.session;
    this.session = null;
    this._releaseWakeLock();
    this._emit('change');
    this._emit('stopped', finished);
    return finished;
  }

  async _acquireWakeLock() {
    if (!('wakeLock' in navigator) || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => (this.wakeLock = null));
    } catch (err) {
      console.warn('Wake lock unavailable', err);
    }
  }

  _releaseWakeLock() {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function skyhookEvent(type, sky, seq) {
  const data = { lat: sky.lat, lon: sky.lon, x: sky.x, y: sky.y, acc: sky.acc ?? null, markedAt: sky.t };
  return seq === undefined ? { type, data } : { type, t: Date.now(), seq, ...data };
}

export function defaultName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `Test ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
