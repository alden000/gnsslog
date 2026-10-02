// SQLite storage for the GNSS Log hub (node:sqlite, no dependencies).
//
// sessions  one row per recording; the phone's metadata as JSON plus edits made in the analyser
// samples   one row per 5 Hz sample, keyed (session_id, seq). Columns follow the phone's sample
//           fields; a field the hub has not seen before gets its own column automatically, so
//           everything is queryable with plain SQL.
// deleted   tombstones: uploads for a deleted session are ignored (the phone may retry).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { upgradeSession, upgradeSample } from '../js/compat.js';
import { computeStats } from './web/js/stats.js';

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const COL_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_COLUMNS = 160;
const LIVE_MS = 2 * 60 * 1000; // a session counts as live while uploads keep arriving
const STAT_COLS = ['t', 'lat', 'lon', 'sog', 'markDist'];

export class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const q = (c) => `"${c}"`;

function toSql(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function newId() {
  return crypto.randomUUID();
}

export class Store {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        meta TEXT NOT NULL,
        meta_version INTEGER NOT NULL DEFAULT 0,
        edits TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL DEFAULT 'phone',
        parent_id TEXT,
        final INTEGER NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        max_seq INTEGER NOT NULL DEFAULT -1,
        first_t INTEGER,
        last_t INTEGER,
        received_at INTEGER,
        created_at INTEGER NOT NULL,
        stats TEXT,
        stats_count INTEGER NOT NULL DEFAULT -1
      );
      CREATE TABLE IF NOT EXISTS samples (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        t INTEGER,
        PRIMARY KEY (session_id, seq)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS samples_t ON samples (session_id, t);
      CREATE TABLE IF NOT EXISTS deleted (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
    this.columns = new Set(this.db.prepare('PRAGMA table_info(samples)').all().map((r) => r.name));
    this.inserts = new Map();
  }

  close() {
    this.db.close();
  }

  // ------------------------------------------------------------------ helpers

  _tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  _ensureColumns(keys) {
    for (const k of keys) {
      if (this.columns.has(k)) continue;
      if (!COL_RE.test(k) || k === 'session_id') continue;
      if (this.columns.size >= MAX_COLUMNS) continue;
      this.db.exec(`ALTER TABLE samples ADD COLUMN ${q(k)}`);
      this.columns.add(k);
    }
  }

  _insertStmt(keys) {
    const sig = keys.join(',');
    let st = this.inserts.get(sig);
    if (!st) {
      const cols = ['session_id', ...keys];
      st = this.db.prepare(`INSERT OR REPLACE INTO samples (${cols.map(q).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      this.inserts.set(sig, st);
    }
    return st;
  }

  _row(id) {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  }

  _refreshCounts(id) {
    const c = this.db.prepare('SELECT count(*) AS n, max(seq) AS maxSeq, min(t) AS t0, max(t) AS t1 FROM samples WHERE session_id = ?').get(id);
    this.db
      .prepare('UPDATE sessions SET sample_count = ?, max_seq = ?, first_t = ?, last_t = ? WHERE id = ?')
      .run(c.n, c.maxSeq ?? -1, c.t0 ?? null, c.t1 ?? null, id);
  }

  _insertSamples(id, rawRows) {
    const rows = rawRows.map(upgradeSample);
    const keys = new Set();
    for (const r of rows) for (const k of Object.keys(r)) if (k !== 'sid') keys.add(k);
    this._ensureColumns(keys);
    let n = 0;
    for (const r of rows) {
      if (!Number.isInteger(r.seq) || r.seq < 0) continue;
      const ks = Object.keys(r).filter((k) => this.columns.has(k) && k !== 'session_id').sort();
      this._insertStmt(ks).run(id, ...ks.map((k) => toSql(r[k])));
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ ingest

  /** One upload from the phone (schema gnsslog/1). Idempotent per (session, seq). */
  ingest(body, now = Date.now()) {
    if (!body || body.schema !== 'gnsslog/1') throw new HttpError(400, 'Unknown schema');
    const s = upgradeSession(body.session);
    if (!s || !ID_RE.test(s.id || '')) throw new HttpError(400, 'Bad session id');
    if (this.db.prepare('SELECT 1 FROM deleted WHERE id = ?').get(s.id)) return { ok: true, session: s.id, ignored: 'deleted' };
    const samples = Array.isArray(body.samples) ? body.samples : [];
    return this._tx(() => {
      const prev = this._row(s.id);
      const mv = Number(s.metaVersion) || 0;
      if (!prev) {
        this.db
          .prepare('INSERT INTO sessions (id, meta, meta_version, source, final, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(s.id, JSON.stringify(s), mv, body.source || 'phone', body.final ? 1 : 0, now, now);
      } else {
        if (mv >= prev.meta_version) this.db.prepare('UPDATE sessions SET meta = ?, meta_version = ? WHERE id = ?').run(JSON.stringify(s), mv, s.id);
        this.db.prepare('UPDATE sessions SET received_at = ?, final = max(final, ?) WHERE id = ?').run(now, body.final ? 1 : 0, s.id);
      }
      const n = this._insertSamples(s.id, samples);
      this._refreshCounts(s.id);
      const row = this._row(s.id);
      return { ok: true, session: s.id, received: n, to: body.chunk?.to ?? null, sampleCount: row.sample_count, maxSeq: row.max_seq, lastT: row.last_t };
    });
  }

  /** A GNSS Log JSON export ({ schema, session, samples }) uploaded from the analyser. */
  importExport(doc) {
    if (!doc || doc.schema !== 'gnsslog/1' || !doc.session) throw new HttpError(400, 'Not a GNSS Log JSON export');
    const session = { ...doc.session };
    if (!ID_RE.test(session.id || '') || this._row(session.id)) session.id = newId();
    this.db.prepare('DELETE FROM deleted WHERE id = ?').run(session.id);
    return this.ingest({ schema: 'gnsslog/1', session, samples: doc.samples || [], final: true, source: 'import' });
  }

  // ------------------------------------------------------------------ read

  _summary(row, now = Date.now()) {
    const meta = JSON.parse(row.meta);
    const edits = JSON.parse(row.edits || '{}');
    const live = !row.final && meta.status !== 'done' && row.received_at && now - row.received_at < LIVE_MS;
    return {
      id: row.id,
      name: edits.name ?? meta.name ?? 'Untitled',
      notes: edits.notes ?? meta.notes ?? '',
      startedAt: meta.startedAt ?? row.first_t,
      endedAt: meta.endedAt ?? null,
      status: meta.status ?? null,
      device: meta.device?.name || null,
      app: meta.app?.version || null,
      source: row.source,
      parentId: row.parent_id,
      final: !!row.final,
      live: !!live,
      sampleCount: row.sample_count,
      maxSeq: row.max_seq,
      firstT: row.first_t,
      lastT: row.last_t,
      receivedAt: row.received_at,
      marks: (meta.events || []).filter((e) => e.type === 'mark').length,
    };
  }

  _stats(row) {
    if (row.stats && row.stats_count === row.sample_count) return JSON.parse(row.stats);
    const cols = this.columns;
    const sel = STAT_COLS.filter((c) => cols.has(c));
    const rows = this.db.prepare(`SELECT ${sel.map(q).join(',')} FROM samples WHERE session_id = ? ORDER BY seq`).all(row.id);
    const arrays = {};
    for (const c of sel) arrays[c] = rows.map((r) => r[c]);
    const stats = computeStats(arrays);
    this.db.prepare('UPDATE sessions SET stats = ?, stats_count = ? WHERE id = ?').run(JSON.stringify(stats), row.sample_count, row.id);
    return stats;
  }

  list() {
    const now = Date.now();
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY coalesce(first_t, created_at) DESC')
      .all()
      .map((row) => ({ ...this._summary(row, now), stats: this._stats(row) }));
  }

  get(id) {
    const row = this._row(id);
    if (!row) throw new HttpError(404, 'No such session');
    const meta = JSON.parse(row.meta);
    return {
      ...this._summary(row),
      stats: this._stats(row),
      events: meta.events || [],
      origin: meta.origin || null,
      config: meta.config || null,
      meta,
      columns: [...this.columns].filter((c) => c !== 'session_id'),
    };
  }

  /**
   * Samples as columns: { columns, rows: [[...], ...] }.
   * opts: t0/t1 (ms, inclusive), afterSeq, cols (subset), limit.
   */
  samples(id, { t0, t1, afterSeq, cols, limit } = {}) {
    if (!this._row(id)) throw new HttpError(404, 'No such session');
    let columns = cols && cols.length ? cols.filter((c) => this.columns.has(c) && c !== 'session_id') : [...this.columns].filter((c) => c !== 'session_id');
    columns = ['seq', 't', ...columns.filter((c) => c !== 'seq' && c !== 't')];
    const where = ['session_id = ?'];
    const args = [id];
    const add = (sql, v) => (where.push(sql), args.push(v));
    if (Number.isFinite(t0)) add('t >= ?', t0);
    if (Number.isFinite(t1)) add('t <= ?', t1);
    if (Number.isFinite(afterSeq)) add('seq > ?', afterSeq);
    const lim = Number.isFinite(limit) && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '';
    const st = this.db.prepare(`SELECT ${columns.map(q).join(',')} FROM samples WHERE ${where.join(' AND ')} ORDER BY seq${lim}`);
    const rows = st.all(...args).map((r) => columns.map((c) => r[c]));
    return { columns, rows };
  }

  /** Sample objects (for exports). */
  sampleObjects(id, opts) {
    const { columns, rows } = this.samples(id, opts);
    return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
  }

  // ------------------------------------------------------------------ edit

  update(id, patch = {}) {
    const row = this._row(id);
    if (!row) throw new HttpError(404, 'No such session');
    const edits = JSON.parse(row.edits || '{}');
    if (typeof patch.name === 'string') edits.name = patch.name.trim().slice(0, 200) || undefined;
    if (typeof patch.notes === 'string') edits.notes = patch.notes.slice(0, 5000);
    this.db.prepare('UPDATE sessions SET edits = ? WHERE id = ?').run(JSON.stringify(edits), id);
    return this.get(id);
  }

  delete(id) {
    if (!this._row(id)) throw new HttpError(404, 'No such session');
    this._tx(() => {
      this.db.prepare('DELETE FROM samples WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.db.prepare('INSERT OR REPLACE INTO deleted (id, at) VALUES (?, ?)').run(id, Date.now());
    });
    return { ok: true };
  }

  /**
   * Copy the samples between t0 and t1 into a new session (the original is kept unless
   * deleteOriginal). Sequence numbers restart at 0; a location that was marked before t0 is
   * carried in as a 'mark_active' event so the trimmed session still measures to it.
   */
  trim(id, { t0, t1, name, deleteOriginal = false } = {}) {
    const src = this._row(id);
    if (!src) throw new HttpError(404, 'No such session');
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) throw new HttpError(400, 'Bad time range');
    const summary = this._summary(src);
    if (deleteOriginal && summary.live) throw new HttpError(409, 'The original is still uploading; keep it until the recording stops');
    const meta = JSON.parse(src.meta);
    const { columns, rows } = this.samples(id, { t0, t1 });
    if (!rows.length) throw new HttpError(400, 'No samples in that range');
    const seqIdx = columns.indexOf('seq');
    const tIdx = columns.indexOf('t');
    const seq0 = rows[0][seqIdx];
    const first = rows[0][tIdx], last = rows[rows.length - 1][tIdx];

    const events = [];
    let activeMark = null;
    for (const e of meta.events || []) {
      if (e.t < first) {
        if (e.type === 'mark' || e.type === 'mark_active') activeMark = e;
        if (e.type === 'mark_clear') activeMark = null;
        continue;
      }
      if (e.t > last) continue;
      events.push({ ...e, seq: Math.max(0, (e.seq ?? seq0) - seq0) });
    }
    if (activeMark) events.unshift({ ...activeMark, type: 'mark_active', t: first, seq: 0 });
    if (!events.length || events[0].type !== 'start') events.unshift({ type: 'start', t: first, seq: 0 });
    if (events[events.length - 1].type !== 'stop') events.push({ type: 'stop', t: last, seq: rows.length });

    const newIdv = newId();
    const newMeta = {
      ...meta,
      id: newIdv,
      name: (name && String(name).trim()) || `${summary.name} (trimmed)`,
      notes: summary.notes,
      startedAt: first,
      endedAt: last,
      status: 'done',
      sampleCount: rows.length,
      events,
      trimmedFrom: { id, t0: first, t1: last },
    };
    const now = Date.now();
    this._tx(() => {
      this.db
        .prepare('INSERT INTO sessions (id, meta, meta_version, source, parent_id, final, received_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
        .run(newIdv, JSON.stringify(newMeta), 1, 'trim', id, now, now);
      const objs = rows.map((r) => {
        const o = Object.fromEntries(columns.map((c, i) => [c, r[i]]));
        o.seq -= seq0;
        return o;
      });
      this._insertSamples(newIdv, objs);
      this._refreshCounts(newIdv);
    });
    if (deleteOriginal) this.delete(id);
    return this.get(newIdv);
  }

  // ------------------------------------------------------------------ maintenance

  /** Consistent copy of the database (safe while running); keeps the newest `keep` files. */
  backup(dir, keep = 14, now = new Date()) {
    mkdirSync(dir, { recursive: true });
    const stamp = now.toISOString().slice(0, 10);
    const file = join(dir, `gnsslog-${stamp}.db`);
    rmSync(file, { force: true });
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const old = readdirSync(dir).filter((f) => /^gnsslog-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(keep);
    for (const f of old) rmSync(join(dir, f), { force: true });
    return file;
  }
}
