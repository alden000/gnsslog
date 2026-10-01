// Reference upload receiver for GNSS Log (schema "gnsslog/1"). No dependencies.
//   node server/receiver.mjs [port]           -> POST http://host:port/ingest
//   RECEIVER_TOKEN=secret node server/receiver.mjs   (requires "Authorization: Bearer secret")
//
// Storage layout (server/data/<sessionId>/):
//   session.json             latest session meta + events (overwritten by newer metaVersion)
//   chunk-<from>-<to>.json   samples of one upload chunk (idempotent: re-sends overwrite)
// GET /sessions lists sessions; GET /sessions/<id>.csv returns merged samples as CSV.
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || process.env.PORT || 8787);
const dataDir = process.env.RECEIVER_DATA || fileURLToPath(new URL('./data/', import.meta.url));
const token = process.env.RECEIVER_TOKEN || '';
const MAX_BODY = 20 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Payload too large'), { code: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function ingest(body) {
  if (body.schema !== 'gnsslog/1') throw Object.assign(new Error('Unknown schema'), { code: 400 });
  const s = body.session;
  if (!s || !ID_RE.test(s.id)) throw Object.assign(new Error('Bad session id'), { code: 400 });
  const dir = join(dataDir, s.id);
  await mkdir(dir, { recursive: true });
  let prev = null;
  try {
    prev = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'));
  } catch {}
  if (!prev || (s.metaVersion ?? 0) >= (prev.metaVersion ?? 0)) {
    await writeFile(join(dir, 'session.json'), JSON.stringify({ ...s, receivedAt: new Date().toISOString(), final: !!body.final }, null, 2));
  }
  const { from, to, count } = body.chunk || {};
  if (count > 0 && Number.isInteger(from) && Number.isInteger(to)) {
    await writeFile(join(dir, `chunk-${String(from).padStart(9, '0')}-${String(to).padStart(9, '0')}.json`), JSON.stringify(body.samples));
  }
  return { ok: true, session: s.id, received: count || 0, to };
}

async function mergedSamples(id) {
  const dir = join(dataDir, id);
  const files = (await readdir(dir)).filter((f) => f.startsWith('chunk-')).sort();
  const bySeq = new Map();
  for (const f of files) for (const row of JSON.parse(await readFile(join(dir, f), 'utf8'))) bySeq.set(row.seq, row);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const url = new URL(req.url, 'http://x');
  try {
    if (token && req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'Unauthorized' });
    if (req.method === 'POST' && (url.pathname === '/ingest' || url.pathname === '/')) {
      const result = await ingest(JSON.parse(await readBody(req)));
      console.log(new Date().toISOString(), 'ingest', result.session, `+${result.received}`, `to=${result.to}`);
      return send(res, 200, result);
    }
    if (req.method === 'GET' && url.pathname === '/sessions') {
      await mkdir(dataDir, { recursive: true });
      const out = [];
      for (const id of await readdir(dataDir)) {
        try {
          const s = JSON.parse(await readFile(join(dataDir, id, 'session.json'), 'utf8'));
          out.push({ id, name: s.name, startedAt: s.startedAt, sampleCount: s.sampleCount, status: s.status, final: s.final });
        } catch {}
      }
      return send(res, 200, out);
    }
    const m = url.pathname.match(/^\/sessions\/([A-Za-z0-9-]+)\.(csv|json)$/);
    if (req.method === 'GET' && m && ID_RE.test(m[1])) {
      const rows = await mergedSamples(m[1]);
      if (m[2] === 'json') return send(res, 200, rows);
      const cols = rows.length ? Object.keys(rows[0]) : [];
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n');
      return send(res, 200, csv + '\n', 'text/csv');
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, err.code >= 400 && err.code < 600 ? err.code : 400, { error: String(err.message || err) });
  }
}).listen(port, () => console.log(`GNSS Log receiver on http://localhost:${port}/ingest -> ${dataDir}`));
