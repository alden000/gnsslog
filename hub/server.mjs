// GNSS Log hub: receives uploads from the phone app, stores them in SQLite and serves the
// analyser web app plus its API. Runs on any machine with Node.js 22.13+ (no npm install).
//
//   node hub/server.mjs [--config path/to/hub-config.json]
//
// Config (JSON file and/or environment variables):
//   port         8787              HUB_PORT
//   host         127.0.0.1         HUB_HOST   (Cloudflare Tunnel connects locally; use 0.0.0.0 for LAN)
//   dataDir      hub/data          HUB_DATA
//   ingestToken  ''                HUB_INGEST_TOKEN  (phone sends "Authorization: Bearer <token>")
//   backupDir    <dataDir>/backups HUB_BACKUP_DIR    (e.g. a OneDrive folder for an off-site copy)
//   backupKeep   14                HUB_BACKUP_KEEP
//   accessTeam   ''                HUB_ACCESS_TEAM   (Cloudflare Zero Trust team, e.g. "myteam")
//   accessAud    ''                HUB_ACCESS_AUD    (Application Audience tag of the Access app)
//
// Security model: uploads need the ingest token. Everything else (analyser + API) sits behind
// Cloudflare Access: a request that arrives through Cloudflare must carry an Access token
// (Cf-Access-Jwt-Assertion) whose signature, audience, issuer and expiry check out against the
// team's public keys. Anything else is refused, so a hostname without Access (the ingest one)
// only ever reaches /ingest. Requests that do not come through Cloudflare (this PC) are allowed.
//
// Routes
//   POST /ingest                         phone uploads (schema gnsslog/1)
//   GET  /api/health
//   GET  /api/sessions                   list with stats
//   GET  /api/sessions/:id               metadata, events, stats
//   GET  /api/sessions/:id/samples       ?t0&t1&afterSeq&cols=a,b  -> { columns, rows }
//   GET  /api/sessions/:id/export.:fmt   ?t0&t1&cols&every=ms       csv|json|gpx|geojson|kml
//   PATCH  /api/sessions/:id             { name, notes }
//   DELETE /api/sessions/:id
//   POST /api/sessions/:id/trim          { t0, t1, name, deleteOriginal }
//   POST /api/import                     GNSS Log JSON export
//   GET  /api/stream                     server-sent events: { type: 'session', session }
//   GET  /                               analyser

import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { timingSafeEqual, createPublicKey, verify as verifySig } from 'node:crypto';
import { Store, HttpError } from './store.mjs';
import { serialize, decimate, fileName, FORMATS } from './web/js/formats.js';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`GNSS Log hub needs Node.js 22.13 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

const REPO = fileURLToPath(new URL('..', import.meta.url));
const MAX_BODY = 50 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
// Files the analyser may load: its own folder, the phone app's shared modules and icons.
const STATIC_DIRS = ['hub/web/', 'js/', 'icons/'];

export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--config');
  const file = i >= 0 ? argv[i + 1] : env.HUB_CONFIG;
  let fromFile = {};
  if (file) fromFile = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); // Windows editors may add a BOM
  const cfg = {
    port: 8787,
    host: '127.0.0.1',
    dataDir: join(REPO, 'hub', 'data'),
    ingestToken: '',
    backupDir: null,
    backupKeep: 14,
    ...fromFile,
  };
  if (env.HUB_PORT) cfg.port = Number(env.HUB_PORT);
  if (env.HUB_HOST) cfg.host = env.HUB_HOST;
  if (env.HUB_DATA) cfg.dataDir = env.HUB_DATA;
  if (env.HUB_INGEST_TOKEN) cfg.ingestToken = env.HUB_INGEST_TOKEN;
  if (env.HUB_BACKUP_DIR) cfg.backupDir = env.HUB_BACKUP_DIR;
  if (env.HUB_BACKUP_KEEP) cfg.backupKeep = Number(env.HUB_BACKUP_KEEP);
  if (env.HUB_ACCESS_TEAM) cfg.accessTeam = env.HUB_ACCESS_TEAM;
  if (env.HUB_ACCESS_AUD) cfg.accessAud = env.HUB_ACCESS_AUD;
  cfg.dataDir = resolve(cfg.dataDir);
  cfg.backupDir = resolve(cfg.backupDir || join(cfg.dataDir, 'backups'));
  return cfg;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(req, res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !/^image\/png/.test(type)) {
    buf = gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(code, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Payload too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** "myteam", "myteam.cloudflareaccess.com" or a URL -> "https://myteam.cloudflareaccess.com". */
export function accessIssuer(team) {
  const t = String(team || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!t) return '';
  return `https://${t.includes('.') ? t : `${t}.cloudflareaccess.com`}`;
}

/**
 * Verifies Cloudflare Access tokens (RS256 JWTs) against the team's signing keys.
 * Returns the user's email, or null.
 */
function accessVerifier(config) {
  const issuer = accessIssuer(config.accessTeam);
  const certsUrl = config.accessCertsUrl || `${issuer}/cdn-cgi/access/certs`;
  let keys = new Map();
  let fetchedAt = 0;
  async function loadKeys(force) {
    if (!force && Date.now() - fetchedAt < 3600e3 && keys.size) return;
    if (force && Date.now() - fetchedAt < 30e3) return; // unknown kid: refetch at most every 30 s
    const res = await fetch(certsUrl);
    if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
    const body = await res.json();
    keys = new Map((body.keys || []).map((k) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
    fetchedAt = Date.now();
  }
  const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  return async function verifyAccess(token) {
    if (!issuer || !config.accessAud || !token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let header, payload;
    try {
      header = b64json(parts[0]);
      payload = b64json(parts[1]);
    } catch {
      return null;
    }
    if (header.alg !== 'RS256') return null;
    await loadKeys(false);
    if (!keys.has(header.kid)) await loadKeys(true);
    const key = keys.get(header.kid);
    if (!key) return null;
    const ok = verifySig('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!ok) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const now = Date.now() / 1000;
    if (!aud.includes(config.accessAud) || payload.iss !== issuer) return null;
    if (!(payload.exp > now - 60) || (payload.nbf && payload.nbf > now + 60)) return null;
    return payload.email || payload.common_name || 'service';
  };
}

function cookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

const numParam = (u, k) => (u.searchParams.has(k) && u.searchParams.get(k) !== '' ? Number(u.searchParams.get(k)) : undefined);
const listParam = (u, k) => (u.searchParams.get(k) || '').split(',').map((s) => s.trim()).filter(Boolean);

export function createHub(config) {
  mkdirSync(config.dataDir, { recursive: true });
  const store = new Store(join(config.dataDir, 'gnsslog.db'));
  const clients = new Set();
  const logFile = join(config.dataDir, 'hub.log');
  const verifyAccess = accessVerifier(config);

  function log(...parts) {
    const line = `${new Date().toISOString()} ${parts.join(' ')}`;
    if (!config.quiet) console.log(line);
    try {
      if (existsSync(logFile) && statSync(logFile).size > 5 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
      appendFileSync(logFile, line + '\n');
    } catch {}
  }

  function broadcast(msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(data);
  }

  async function serveStatic(req, res, path) {
    if (path === '/' || path === '/index.html') path = '/hub/web/index.html';
    if (path === '/sw.js') path = '/hub/web/sw.js';
    if (path === '/manifest.webmanifest') path = '/hub/web/manifest.webmanifest';
    const rel = path.replace(/^\/+/, '');
    if (!STATIC_DIRS.some((d) => rel.startsWith(d))) throw new HttpError(404, 'Not found');
    const file = normalize(join(REPO, rel));
    if (!file.startsWith(REPO) || file.includes(`${sep}..`)) throw new HttpError(404, 'Not found');
    try {
      if (!(await stat(file)).isFile()) throw new Error();
    } catch {
      throw new HttpError(404, 'Not found');
    }
    send(req, res, 200, await readFile(file), TYPES[extname(file)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://hub');
    const path = decodeURIComponent(url.pathname);
    const viaCloudflare = !!req.headers['cf-ray'];

    // ---- uploads from the phone (token, CORS: the PWA posts cross-origin)
    if (path === '/ingest') {
      cors(res);
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST');
      if (config.ingestToken) {
        const auth = req.headers.authorization || '';
        const key = req.headers['x-api-key'] || '';
        if (!safeEqual(auth, `Bearer ${config.ingestToken}`) && !safeEqual(key, config.ingestToken)) throw new HttpError(401, 'Unauthorized');
      }
      const result = store.ingest(await readBody(req));
      if (result.received || result.ignored) log('ingest', result.session, `+${result.received ?? 0}`, `count=${result.sampleCount ?? '-'}`, result.ignored || '');
      if (!result.ignored) broadcast({ type: 'session', session: summaryOf(result.session) });
      return send(req, res, 200, result);
    }

    // ---- everything else: through Cloudflare only with a valid Access login
    let user = null;
    if (viaCloudflare) {
      if (!config.accessTeam || !config.accessAud) {
        throw new HttpError(403, 'Cloudflare Access is not configured on the hub (accessTeam / accessAud, see hub/README.md).');
      }
      try {
        user = await verifyAccess(req.headers['cf-access-jwt-assertion'] || cookie(req, 'CF_Authorization'));
      } catch (err) {
        log('access check failed', err.message);
        throw new HttpError(503, 'Could not check the Cloudflare Access login, try again shortly.');
      }
      if (!user) throw new HttpError(403, 'Log in through Cloudflare Access to use the analyser.');
    }

    if (path === '/api/health') return send(req, res, 200, { ok: true, version: 1, node: process.versions.node, user });

    if (path === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (path === '/api/sessions' && req.method === 'GET') return send(req, res, 200, store.list());

    if (path === '/api/import' && req.method === 'POST') {
      const r = store.importExport(await readBody(req));
      log('import', r.session, `+${r.received}`);
      broadcast({ type: 'session', session: summaryOf(r.session) });
      return send(req, res, 200, r);
    }

    const m = path.match(/^\/api\/sessions\/([A-Za-z0-9-]{8,64})(?:\/(samples|trim|export\.(\w+)))?$/);
    if (m) {
      const [, id, sub, fmt] = m;
      if (!sub && req.method === 'GET') return send(req, res, 200, store.get(id));
      if (!sub && req.method === 'PATCH') {
        const s = store.update(id, await readBody(req));
        broadcast({ type: 'session', session: summaryOf(id) });
        return send(req, res, 200, s);
      }
      if (!sub && req.method === 'DELETE') {
        const r = store.delete(id);
        log('delete', id);
        broadcast({ type: 'deleted', id });
        return send(req, res, 200, r);
      }
      if (sub === 'samples' && req.method === 'GET') {
        return send(req, res, 200, store.samples(id, { t0: numParam(url, 't0'), t1: numParam(url, 't1'), afterSeq: numParam(url, 'afterSeq'), cols: listParam(url, 'cols'), limit: numParam(url, 'limit') }));
      }
      if (sub === 'trim' && req.method === 'POST') {
        const b = await readBody(req);
        const s = store.trim(id, { t0: Number(b.t0), t1: Number(b.t1), name: b.name, deleteOriginal: !!b.deleteOriginal });
        log('trim', id, '->', s.id, `${s.sampleCount} samples`);
        broadcast({ type: 'session', session: summaryOf(s.id) });
        if (b.deleteOriginal) broadcast({ type: 'deleted', id });
        return send(req, res, 200, s);
      }
      if (fmt && req.method === 'GET') {
        if (!FORMATS[fmt]) throw new HttpError(400, 'Unknown format');
        const meta = store.get(id);
        const t0 = numParam(url, 't0'), t1 = numParam(url, 't1');
        const cols = listParam(url, 'cols');
        let rows = store.sampleObjects(id, { t0, t1, cols: fmt === 'csv' && cols.length ? cols : undefined });
        rows = decimate(rows, numParam(url, 'every') || 0);
        const columns = fmt === 'csv' ? (cols.length ? ['seq', 't', ...cols.filter((c) => c !== 'seq' && c !== 't')] : meta.columns) : undefined;
        const sessionMeta = { ...meta.meta, name: meta.name, notes: meta.notes };
        const body = serialize(fmt, { meta: sessionMeta, rows, columns, events: meta.events });
        const ranged = Number.isFinite(t0) || Number.isFinite(t1) ? '_extract' : '';
        return send(req, res, 200, body, FORMATS[fmt].type, {
          'Content-Disposition': `attachment; filename="${fileName(meta.name, fmt, ranged)}"`,
        });
      }
      throw new HttpError(405, 'Method not allowed');
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, path);
    throw new HttpError(404, 'Not found');
  }

  function summaryOf(id) {
    try {
      const s = store.get(id);
      delete s.meta;
      delete s.config;
      return s;
    } catch {
      return { id };
    }
  }

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      const code = err instanceof HttpError ? err.code : 500;
      if (code === 500) log('error', req.method, req.url, err.stack || err);
      if (!res.headersSent) send(req, res, code, { error: String(err.message || err) });
      else res.end();
    }
  });

  // Daily backup (first one a minute after start).
  let backupTimer = null;
  function runBackup() {
    try {
      log('backup', store.backup(config.backupDir, config.backupKeep));
    } catch (err) {
      log('backup failed', err.message);
    }
  }
  if (!config.noBackup) {
    backupTimer = setTimeout(function tick() {
      runBackup();
      backupTimer = setTimeout(tick, 24 * 3600 * 1000);
    }, 60 * 1000);
    backupTimer.unref?.();
  }

  return {
    server,
    store,
    log,
    listen(port = config.port, host = config.host) {
      return new Promise((r) => server.listen(port, host, () => r(server.address())));
    },
    close() {
      clearTimeout(backupTimer);
      for (const c of clients) c.end();
      return new Promise((r) => server.close(() => (store.close(), r())));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const hub = createHub(config);
  const addr = await hub.listen();
  hub.log(`GNSS Log hub on http://${addr.address}:${addr.port} data=${config.dataDir}${config.ingestToken ? '' : ' (WARNING: no ingest token set)'}`);
  const stop = () => hub.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
