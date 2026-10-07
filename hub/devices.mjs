// Paired phones for the GNSS Log hub.
//
// Each phone gets its own upload token by pairing: the analyser (behind Cloudflare Access) asks
// for a one-time code, shown as a QR code and as text; the phone sends the code to
// POST /ingest/pair and receives its token. Only SHA-256 hashes of tokens are stored. A phone is
// removed by revoking it. The old shared token (config.ingestToken) keeps working until it is
// switched off in the analyser.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LEN = 8;
const CODE_TTL_MS = 10 * 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_MAX_PER_IP = 10; // wrong codes per address per window
const FAIL_MAX_TOTAL = 50; // ...and in total, whoever sends them
const NAME_MAX = 60;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Normalise what a person typed: case, spaces and dashes do not matter. */
export function normaliseCode(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function cleanName(s, fallback) {
  const n = String(s || '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, NAME_MAX);
  return n || fallback;
}

export class Devices {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS pair_codes (
        code TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        device_id TEXT
      );
      CREATE TABLE IF NOT EXISTS hub_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.fails = []; // [{ at, ip }]
    this.seen = new Map(); // device id -> last_seen written (throttles writes)
  }

  // ---------------------------------------------------------------- settings

  get legacyEnabled() {
    const r = this.db.prepare(`SELECT value FROM hub_settings WHERE key = 'legacyToken'`).get();
    return !r || r.value !== 'off';
  }

  setLegacyEnabled(on) {
    this.db.prepare(`INSERT INTO hub_settings (key, value) VALUES ('legacyToken', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(on ? 'on' : 'off');
  }

  // ---------------------------------------------------------------- pairing

  /** A new one-time code (analyser). */
  createCode(now = Date.now()) {
    this.db.prepare('DELETE FROM pair_codes WHERE expires_at < ?').run(now - 24 * 3600 * 1000);
    let code = '';
    const bytes = randomBytes(CODE_LEN);
    for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    const expiresAt = now + CODE_TTL_MS;
    this.db.prepare('INSERT INTO pair_codes (code, created_at, expires_at) VALUES (?, ?, ?)').run(code, now, expiresAt);
    return { code, display: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
  }

  /** Where a code stands (analyser polls this while the QR code is shown). */
  codeStatus(code, now = Date.now()) {
    const r = this.db.prepare('SELECT * FROM pair_codes WHERE code = ?').get(normaliseCode(code));
    if (!r) return { status: 'unknown' };
    if (r.device_id) return { status: 'paired', device: this.get(r.device_id) };
    if (r.expires_at < now) return { status: 'expired' };
    return { status: 'pending', expiresAt: r.expires_at };
  }

  /** The phone redeems a code. Returns { device, token } or throws { code, message }. */
  pair(rawCode, deviceName, ip = '?', now = Date.now()) {
    this.fails = this.fails.filter((f) => now - f.at < FAIL_WINDOW_MS);
    if (this.fails.length >= FAIL_MAX_TOTAL || this.fails.filter((f) => f.ip === ip).length >= FAIL_MAX_PER_IP) {
      throw Object.assign(new Error('Too many wrong codes. Wait 10 minutes and create a new code.'), { code: 429 });
    }
    const code = normaliseCode(rawCode);
    const r = code.length === CODE_LEN ? this.db.prepare('SELECT * FROM pair_codes WHERE code = ?').get(code) : null;
    if (!r || r.device_id || r.expires_at < now) {
      this.fails.push({ at: now, ip });
      throw Object.assign(new Error(r && r.expires_at < now ? 'This code has expired. Create a new one in the analyser.' : 'Unknown or already used code.'), { code: 403 });
    }
    const token = randomBytes(32).toString('base64url');
    const id = crypto.randomUUID();
    const name = cleanName(deviceName, 'Phone');
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(id, name, sha256(token), now);
      this.db.prepare('UPDATE pair_codes SET device_id = ? WHERE code = ?').run(id, code);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { device: this.get(id), token };
  }

  // ---------------------------------------------------------------- tokens

  /** The paired, not revoked device this token belongs to, or null. */
  byToken(token, now = Date.now()) {
    if (!token) return null;
    const r = this.db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(token));
    if (!r) return null;
    if (now - (this.seen.get(r.id) || 0) > 60000) {
      this.seen.set(r.id, now);
      this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(now, r.id);
    }
    return this._out(r);
  }

  /** Constant-time comparison for the old shared token. */
  static sameSecret(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
  }

  // ---------------------------------------------------------------- management

  list() {
    return this.db.prepare('SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at').all().map((r) => this._out(r));
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    return r ? this._out(r) : null;
  }

  rename(id, name) {
    const n = cleanName(name, '');
    if (!n) throw Object.assign(new Error('Name required'), { code: 400 });
    const r = this.db.prepare('UPDATE devices SET name = ? WHERE id = ? AND revoked_at IS NULL').run(n, id);
    if (!r.changes) throw Object.assign(new Error('No such phone'), { code: 404 });
    return this.get(id);
  }

  revoke(id, now = Date.now()) {
    const r = this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id);
    if (!r.changes) throw Object.assign(new Error('No such phone'), { code: 404 });
    return { ok: true };
  }

  _out(r) {
    return { id: r.id, name: r.name, createdAt: r.created_at, lastSeen: r.last_seen ?? null };
  }
}
