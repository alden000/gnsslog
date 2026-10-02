import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHub, accessIssuer } from '../hub/server.mjs';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { computeStats } from '../hub/web/js/stats.js';
import { serialize, decimate } from '../hub/web/js/formats.js';

const TOKEN = 'test-token';
let hub, base, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hub-'));
  hub = createHub({ dataDir: dir, backupDir: join(dir, 'backups'), backupKeep: 2, ingestToken: TOKEN, quiet: true, noBackup: true });
  const a = await hub.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${a.port}`;
});
after(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 9, 1, 2, 0, 0);
function sample(seq, extra = {}) {
  // 1 m/s due north from (1.29, 103.79)
  const t = T0 + seq * 200;
  return { seq, t, iso: new Date(t).toISOString(), lat: 1.29 + (seq * 0.2) / 111320, lon: 103.79, sog: 1, cog: 0, hdg: 1, hdgRate: 0.01, gnssAcc: 3, markActive: 0, markEvent: '', ...extra };
}
function session(id, events = [], extra = {}) {
  return { id, name: 'Harbour run', notes: '', startedAt: T0, status: 'recording', sampleHz: 5, metaVersion: 1, events: [{ type: 'start', t: T0, seq: 0 }, ...events], device: { name: 'S24' }, app: { version: '0.7.4' }, ...extra };
}
const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body) });
const chunk = (s, from, to, final = false, mk = sample) =>
  post('/ingest', { schema: 'gnsslog/1', session: s, chunk: { from, to, count: to - from + 1 }, samples: Array.from({ length: to - from + 1 }, (_, i) => mk(from + i)), final });

const ID = 'aaaaaaaa-1111-2222-3333-444444444444';

test('ingest needs the token', async () => {
  const r = await post('/ingest', { schema: 'gnsslog/1', session: session(ID), samples: [] }, { Authorization: 'Bearer nope' });
  assert.equal(r.status, 401);
  const pre = await fetch(base + '/ingest', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
});

test('ingest is idempotent and resumes', async () => {
  assert.equal((await chunk(session(ID), 0, 499)).status, 200);
  assert.equal((await chunk(session(ID), 0, 499)).status, 200); // response lost -> re-sent
  const markEv = { type: 'mark', t: T0 + 600 * 200, seq: 600, lat: 1.2905, lon: 103.79 };
  const r = await chunk(session(ID, [markEv], { metaVersion: 2, status: 'done', endedAt: T0 + 999 * 200 }), 500, 999, true);
  const j = await r.json();
  assert.equal(j.sampleCount, 1000);
  const list = await (await fetch(base + '/api/sessions')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].sampleCount, 1000);
  assert.equal(list[0].marks, 1);
  assert.equal(list[0].live, false);
  assert.ok(Math.abs(list[0].stats.distance - 199.8) < 4, `distance ${list[0].stats.distance}`);
  assert.equal(list[0].stats.maxSog, 1);
});

test('samples: columns, time range, afterSeq, gzip', async () => {
  const all = await (await fetch(`${base}/api/sessions/${ID}/samples?cols=lat,lon,sog`)).json();
  assert.deepEqual(all.columns, ['seq', 't', 'lat', 'lon', 'sog']);
  assert.equal(all.rows.length, 1000);
  const part = await (await fetch(`${base}/api/sessions/${ID}/samples?t0=${T0 + 1000}&t1=${T0 + 2000}`)).json();
  assert.equal(part.rows.length, 6);
  const tail = await (await fetch(`${base}/api/sessions/${ID}/samples?afterSeq=995&cols=t`)).json();
  assert.deepEqual(tail.rows.map((r) => r[0]), [996, 997, 998, 999]);
  // raw socket check that big responses are compressed
  const res = await fetch(`${base}/api/sessions/${ID}/samples`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(res.headers.get('content-encoding'), 'gzip');
});

test('new sample fields become columns', async () => {
  const id = 'bbbbbbbb-1111-2222-3333-444444444444';
  await chunk(session(id), 0, 9, false, (i) => sample(i, { newField: i * 2, skyDist: 5 }));
  const r = await (await fetch(`${base}/api/sessions/${id}/samples?cols=newField,markDist`)).json();
  assert.deepEqual(r.rows[3], [3, T0 + 600, 6, 5]); // old skyDist upgraded to markDist
  assert.equal((await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' })).status, 200);
  // the phone retries after the delete: ignored
  const again = await (await chunk(session(id), 0, 9)).json();
  assert.equal(again.ignored, 'deleted');
  assert.equal((await fetch(`${base}/api/sessions/${id}`)).status, 404);
});

test('rename, trim (keeps the active mark), delete original refused while live', async () => {
  const p = await fetch(`${base}/api/sessions/${ID}`, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) });
  assert.equal((await p.json()).name, 'Renamed');
  const tr = await post(`/api/sessions/${ID}/trim`, { t0: T0 + 700 * 200, t1: T0 + 799 * 200 });
  const s = await tr.json();
  assert.equal(tr.status, 200, JSON.stringify(s));
  assert.equal(s.sampleCount, 100);
  assert.equal(s.name, 'Renamed (trimmed)');
  assert.equal(s.parentId, ID);
  assert.equal(s.events[0].type, 'start');
  assert.equal(s.events[1].type, 'mark_active');
  assert.equal(s.events[1].seq, 0);
  const rows = await (await fetch(`${base}/api/sessions/${s.id}/samples?cols=t`)).json();
  assert.deepEqual(rows.rows[0], [0, T0 + 700 * 200]);
  // a session that is still uploading cannot be replaced
  const live = 'cccccccc-1111-2222-3333-444444444444';
  await chunk(session(live), 0, 99);
  const refused = await post(`/api/sessions/${live}/trim`, { t0: T0, t1: T0 + 5000, deleteOriginal: true });
  assert.equal(refused.status, 409);
});

test('exports', async () => {
  const csv = await (await fetch(`${base}/api/sessions/${ID}/export.csv?cols=lat,lon&t0=${T0}&t1=${T0 + 400}`)).text();
  assert.equal(csv, `seq,t,lat,lon\n0,${T0},1.29,103.79\n1,${T0 + 200},${1.29 + 0.2 / 111320},103.79\n2,${T0 + 400},${1.29 + 0.4 / 111320},103.79\n`);
  const gpxRes = await fetch(`${base}/api/sessions/${ID}/export.gpx?every=1000`);
  assert.match(gpxRes.headers.get('content-disposition'), /Renamed\.gpx/);
  const gpx = await gpxRes.text();
  assert.equal((gpx.match(/<trkpt /g) || []).length, 200);
  assert.equal((gpx.match(/<wpt /g) || []).length, 1);
  const gj = await (await fetch(`${base}/api/sessions/${ID}/export.geojson`)).json();
  assert.equal(gj.features[0].geometry.coordinates.length, 1000);
  assert.equal(gj.features[1].geometry.type, 'Point');
  const kml = await (await fetch(`${base}/api/sessions/${ID}/export.kml`)).text();
  assert.match(kml, /<LineString>/);
  const json = await (await fetch(`${base}/api/sessions/${ID}/export.json?t0=${T0}&t1=${T0 + 1000}`)).json();
  assert.equal(json.schema, 'gnsslog/1');
  assert.equal(json.samples.length, 6);
  // ... which imports again as a new session
  const imp = await (await post('/api/import', json)).json();
  assert.notEqual(imp.session, ID);
  assert.equal(imp.sampleCount, 6);
});

test('through Cloudflare: only /ingest without a verified Access token', async () => {
  // Hub without Access configured: everything but /ingest is refused via Cloudflare.
  assert.equal((await fetch(`${base}/api/sessions`, { headers: { 'cf-ray': 'x' } })).status, 403);
  assert.equal((await fetch(`${base}/`, { headers: { 'cf-ray': 'x', 'cf-access-authenticated-user-email': 'a@b.c' } })).status, 403);
  assert.equal((await chunk(session(ID), 0, 0)).status, 200);

  // A team signing key served like https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const certs = createServer((req, res) => res.end(JSON.stringify({ keys: [jwk] })));
  await new Promise((r) => certs.listen(0, '127.0.0.1', r));
  const dir2 = mkdtempSync(join(tmpdir(), 'hub2-'));
  const hub2 = createHub({ dataDir: dir2, ingestToken: TOKEN, quiet: true, noBackup: true, accessTeam: 'testteam', accessAud: 'aud123', accessCertsUrl: `http://127.0.0.1:${certs.address().port}/` });
  const b2 = `http://127.0.0.1:${(await hub2.listen(0, '127.0.0.1')).port}`;
  const jwt = (claims, key = privateKey, kid = 'k1') => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
    const body = enc({ iss: 'https://testteam.cloudflareaccess.com', aud: ['aud123'], email: 'me@example.com', exp: Date.now() / 1000 + 600, ...claims });
    return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
  };
  const get = (headers) => fetch(`${b2}/api/health`, { headers: { 'cf-ray': 'x', ...headers } });
  try {
    const ok = await get({ 'cf-access-jwt-assertion': jwt({}) });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).user, 'me@example.com');
    assert.equal((await get({ cookie: `CF_Authorization=${jwt({})}` })).status, 200);
    assert.equal((await get({ 'cf-access-authenticated-user-email': 'me@example.com' })).status, 403, 'spoofed header');
    assert.equal((await get({ 'cf-access-jwt-assertion': jwt({ aud: ['other'] }) })).status, 403, 'wrong audience');
    assert.equal((await get({ 'cf-access-jwt-assertion': jwt({ iss: 'https://evil.cloudflareaccess.com' }) })).status, 403, 'wrong issuer');
    assert.equal((await get({ 'cf-access-jwt-assertion': jwt({ exp: Date.now() / 1000 - 3600 }) })).status, 403, 'expired');
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    assert.equal((await get({ 'cf-access-jwt-assertion': jwt({}, other) })).status, 403, 'forged signature');
    assert.equal((await get({ 'cf-access-jwt-assertion': 'abc.def.ghi' })).status, 403, 'garbage');
    // Local requests (no cf-ray) need nothing.
    assert.equal((await fetch(`${b2}/api/health`)).status, 200);
  } finally {
    await hub2.close();
    certs.close();
    rmSync(dir2, { recursive: true, force: true });
  }
  assert.equal(accessIssuer('myteam'), 'https://myteam.cloudflareaccess.com');
  assert.equal(accessIssuer('https://myteam.cloudflareaccess.com/'), 'https://myteam.cloudflareaccess.com');
});

test('static files: analyser and shared modules only', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/js/geo.js`)).status, 200);
  assert.equal((await fetch(`${base}/hub/store.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/hub/data/gnsslog.db`)).status, 404);
  assert.equal((await fetch(`${base}/js/../hub/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
});

test('backup keeps the newest files', () => {
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) hub.store.backup(join(dir, 'backups'), 2, new Date(d));
  assert.deepEqual(readdirSync(join(dir, 'backups')).sort(), ['gnsslog-2026-09-02.db', 'gnsslog-2026-09-03.db']);
});

test('stats and formats are pure', () => {
  const t = [0, 1000, 2000, 60000], lat = [0, 0.0001, 0.0002, 0.0002], lon = [0, 0, 0, 0], sog = [0, 11, 11, 0];
  const s = computeStats({ t, lat, lon, sog });
  assert.ok(Math.abs(s.distance - 22.1) < 0.5);
  assert.equal(s.duration, 60);
  assert.equal(s.maxSog, 11);
  assert.equal(decimate(t.map((x) => ({ t: x })), 1500).length, 3);
  assert.match(serialize('gpx', { meta: { name: 'a<b' }, rows: [] }), /a&lt;b/);
});
