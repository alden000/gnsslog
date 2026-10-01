// Cloud upload. Sessions are pushed to the configured endpoint in chunks as JSON POSTs
// whenever the device is online. Progress is stored per session, so uploads resume where
// they stopped after a reload, a lost connection or a server error.
//
// Payload (schema "gnsslog/1"):
//   { schema, sentAt, session: {...meta, events}, chunk: { from, to, count }, samples: [...], final }
// The server must treat (session.id, chunk.from..chunk.to) as idempotent: the same chunk can
// be re-sent if the response was lost.

const RETRY_MIN = 5000;
const RETRY_MAX = 5 * 60 * 1000;
const PERIODIC = 20000;

export class SyncManager extends EventTarget {
  constructor(db, settings) {
    super();
    this.db = db;
    this.settings = settings;
    this.running = false;
    this.again = false;
    this.backoff = 0;
    this.timer = null;
    this.status = { state: 'idle', pendingSamples: 0, pendingSessions: 0, lastSyncAt: null, error: '' };
    window.addEventListener('online', () => this.kick(true));
    window.addEventListener('offline', () => this._set({ state: 'offline' }));
    setInterval(() => this.kick(), PERIODIC);
  }

  get configured() {
    return /^https?:\/\//i.test(this.settings.get('endpoint') || '');
  }

  /** Request a sync pass soon. force ignores the error backoff. */
  kick(force = false) {
    if (force) this.backoff = 0;
    if (this.timer && !force) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.syncAll(force);
    }, force ? 0 : this.backoff);
  }

  async refreshPending() {
    const [sessions, sync] = await Promise.all([this.db.listSessions(), this.db.listSync()]);
    let samples = 0;
    let count = 0;
    for (const s of sessions) {
      const st = sync.get(s.id);
      const synced = st ? st.syncedSeq + 1 : 0;
      const metaOk = st && st.metaVersion >= s.metaVersion;
      if (synced < s.sampleCount || !metaOk) count++;
      samples += Math.max(0, s.sampleCount - synced);
    }
    this._set({ pendingSamples: samples, pendingSessions: count });
    return { sessions, sync };
  }

  async syncAll(manual = false) {
    if (this.running) {
      this.again = true;
      return;
    }
    if (!this.configured) {
      await this.refreshPending();
      this._set({ state: 'unconfigured' });
      return;
    }
    if (!manual && !this.settings.get('autoSync')) {
      await this.refreshPending();
      this._set({ state: 'paused' });
      return;
    }
    if (!navigator.onLine) {
      await this.refreshPending();
      this._set({ state: 'offline' });
      return;
    }
    this.running = true;
    this._set({ state: 'syncing', error: '' });
    try {
      const { sessions, sync } = await this.refreshPending();
      // Oldest first so finished sessions drain before the live one.
      for (const s of [...sessions].reverse()) {
        await this._syncSession(s, sync.get(s.id));
      }
      this.backoff = 0;
      this._set({ state: 'idle', lastSyncAt: Date.now() });
    } catch (err) {
      this.backoff = Math.min(RETRY_MAX, Math.max(RETRY_MIN, this.backoff * 2));
      this._set({ state: 'error', error: String(err.message || err) });
      this.kick();
    } finally {
      this.running = false;
      await this.refreshPending().catch(() => {});
      if (this.again) {
        this.again = false;
        this.kick();
      }
    }
  }

  async _syncSession(session, state) {
    state = state || { sid: session.id, syncedSeq: -1, metaVersion: 0, lastSyncAt: null };
    const chunkSize = Math.max(50, this.settings.get('chunkSize') | 0);
    for (;;) {
      // Re-read: the recorder keeps appending while we upload.
      const fresh = (await this.db.getSession(session.id)) || session;
      const from = state.syncedSeq + 1;
      const needSamples = from < fresh.sampleCount;
      const needMeta = state.metaVersion < fresh.metaVersion;
      if (!needSamples && !needMeta) return;
      const rows = needSamples ? await this.db.getSamples(fresh.id, from, from + chunkSize - 1, chunkSize) : [];
      const to = rows.length ? rows[rows.length - 1].seq : state.syncedSeq;
      const final = fresh.status === 'done' && to >= fresh.sampleCount - 1;
      await this._post({
        schema: 'gnsslog/1',
        sentAt: new Date().toISOString(),
        session: publicMeta(fresh),
        chunk: { from, to, count: rows.length },
        samples: rows.map(({ sid, ...rest }) => rest),
        final,
      });
      state = { ...state, syncedSeq: to, metaVersion: fresh.metaVersion, lastSyncAt: Date.now() };
      await this.db.putSync(state);
      this._emit('progress', { sid: fresh.id, syncedSeq: to });
    }
  }

  async _post(body) {
    const headers = { 'Content-Type': 'application/json' };
    const h = (this.settings.get('authHeader') || '').trim();
    const v = this.settings.get('authValue') || '';
    if (h && v) headers[h] = v;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(this.settings.get('endpoint'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('Upload timed out');
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  _set(patch) {
    Object.assign(this.status, patch);
    this._emit('status', { ...this.status });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export function publicMeta(s) {
  return {
    id: s.id,
    name: s.name,
    notes: s.notes,
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    status: s.status,
    interrupted: !!s.interrupted,
    sampleHz: s.sampleHz,
    sampleCount: s.sampleCount,
    origin: s.origin,
    events: s.events,
    metaVersion: s.metaVersion,
    device: s.device,
    config: s.config,
    app: s.app,
  };
}
