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

test('the ICD example (docs/ICD.md 8.1) is accepted by the reference hub', async () => {
  const { readFileSync } = await import('node:fs');
  const md = readFileSync(new URL('../docs/ICD.md', import.meta.url), 'utf8');
  const example = JSON.parse(/### 8\.1[\s\S]*?```json\n([\s\S]*?)```/.exec(md)[1]);
  const r = await post('/ingest', example);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.received, example.samples.length);
  const s = await (await fetch(`${base}/api/sessions/${example.session.id}`)).json();
  assert.equal(s.name, example.session.name);
  assert.equal(s.marks, 1);
  // a repeat of the same chunk is harmless
  assert.equal((await post('/ingest', example)).status, 200);
  assert.equal((await (await fetch(`${base}/api/sessions/${example.session.id}`)).json()).sampleCount, 1);
});

test('session list carries a simplified thumbnail track', async () => {
  const { simplifyTrack } = await import('../hub/web/js/stats.js');
  // an L-shaped walk of 2000 points: the corner must survive, the straights collapse
  const lat = [], lon = [];
  for (let i = 0; i < 1000; i++) (lat.push(1.3 + i * 1e-6), lon.push(103.8));
  for (let i = 0; i < 1000; i++) (lat.push(1.300999), lon.push(103.8 + i * 1e-6));
  const tr = simplifyTrack(lat, lon);
  assert.ok(tr.length / 2 <= 150 && tr.length / 2 >= 3, `${tr.length / 2} points`);
  assert.ok(tr.some((v, i) => i % 2 === 0 && Math.abs(v - 1.300999) < 2e-6 && Math.abs(tr[i + 1] - 103.8) < 2e-5), 'corner kept');
  // long tracks (> 6000 points) go through a pre-thinning step: it must keep both arrays aligned
  const la = [], lo = [];
  for (let i = 0; i < 20000; i++) (la.push(1.3 + Math.sin(i / 900) * 0.01), lo.push(103.8 + i * 1e-6));
  const long = simplifyTrack(la, lo);
  assert.ok(long.length / 2 >= 3 && long.length / 2 <= 150 && long.every(Number.isFinite), `long track: ${long.length / 2} points`);
  const list = await (await fetch(`${base}/api/sessions`)).json();
  const s = list.find((x) => x.id === ID);
  assert.ok(Array.isArray(s.stats.track) && s.stats.track.length >= 4 && s.stats.track.length <= 300);
});

test('pairing: one-time code -> own token; revoke; the shared token can be switched off', async () => {
  const dir3 = mkdtempSync(join(tmpdir(), 'hub3-'));
  const hub3 = createHub({ dataDir: dir3, ingestToken: TOKEN, quiet: true, noBackup: true });
  const b3 = `http://127.0.0.1:${(await hub3.listen(0, '127.0.0.1')).port}`;
  const j = (path, method = 'GET', body, headers = {}) =>
    fetch(b3 + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const upload = (auth, id = 'bbbbbbbb-1111-2222-3333-444444444444') =>
    j('/ingest', 'POST', { schema: 'gnsslog/1', session: session(id), chunk: { from: 0, to: 0, count: 1 }, samples: [sample(0)] }, auth ? { Authorization: auth } : {});
  try {
    const code = await (await j('/api/devices/pair', 'POST')).json();
    assert.match(code.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal((await (await j(`/api/devices/pair/${code.code}`)).json()).status, 'pending');

    // The phone types it with a dash, in lower case, through Cloudflare (no Access token needed).
    const r = await j('/ingest/pair', 'POST', { code: code.display.toLowerCase(), device: 'S24U' }, { 'cf-ray': 'x' });
    assert.equal(r.status, 200);
    const { token, deviceId, name } = await r.json();
    assert.equal(name, 'S24U');
    assert.ok(token.length >= 40);
    // single use
    assert.equal((await j('/ingest/pair', 'POST', { code: code.code, device: 'other' })).status, 403);
    const st = await (await j(`/api/devices/pair/${code.code}`)).json();
    assert.equal(st.status, 'paired');
    assert.equal(st.device.id, deviceId);

    assert.equal((await upload(`Bearer ${token}`)).status, 200);
    assert.equal((await upload(`Bearer ${TOKEN}`)).status, 200, 'shared token still on');
    assert.equal((await upload('Bearer nope')).status, 401);
    assert.equal((await upload(null)).status, 401);

    const list = await (await j('/api/devices')).json();
    assert.deepEqual(list.devices.map((d) => d.name), ['S24U']);
    assert.ok(list.devices[0].lastSeen);
    assert.deepEqual(list.legacy, { configured: true, enabled: true });
    assert.equal((await (await j(`/api/devices/${deviceId}`, 'PATCH', { name: 'Tender 2' })).json()).name, 'Tender 2');

    // Shared token off: only paired phones upload.
    await j('/api/devices/legacy', 'PUT', { enabled: false });
    assert.equal((await upload(`Bearer ${TOKEN}`)).status, 401);
    assert.equal((await upload(`Bearer ${token}`)).status, 200);

    // Removed phone: its token stops working.
    assert.equal((await j(`/api/devices/${deviceId}`, 'DELETE')).status, 200);
    assert.equal((await upload(`Bearer ${token}`)).status, 401);
    assert.equal((await (await j('/api/devices')).json()).devices.length, 0);

    // Admin routes are not reachable through Cloudflare without Access; wrong codes are rate-limited.
    assert.equal((await j('/api/devices/pair', 'POST', undefined, { 'cf-ray': 'x' })).status, 403);
    let last;
    for (let i = 0; i < 11; i++) last = await j('/ingest/pair', 'POST', { code: 'ZZZZZZZZ', device: 'x' });
    assert.equal(last.status, 429);
  } finally {
    await hub3.close();
    rmSync(dir3, { recursive: true, force: true });
  }
});
