// Simulated vessel runs for the hub (tests and local demos). Posts through /ingest exactly like
// the phone does.  node tests/e2e/hub-seed.mjs http://127.0.0.1:8787 [token]
import { LocalFrame, haversine, wrap360 } from '../../js/geo.js';

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/**
 * A harbour run: transit, a starboard turn, a slow approach, then holding position on a marked
 * location (with a pause in the middle), then a run home. Returns { session, samples }.
 */
export function makeRun({ id, name, t0 = Date.UTC(2026, 9, 1, 1, 30, 0), lat0 = 1.2655, lon0 = 103.8302, seconds = 900, seed = 7, device = 'Galaxy S24 Ultra' }) {
  const r = rng(seed);
  const f = new LocalFrame(lat0, lon0);
  const samples = [];
  const events = [{ type: 'start', t: t0, seq: 0 }];
  let x = 0, y = 0, hdg = 40, speed = 0;
  let mark = null;
  let seq = 0;
  let segment = 0;
  const dt = 0.2;
  for (let k = 0; k * dt < seconds; k++) {
    const s = k * dt;
    // Pause between 520 s and 545 s (app in the background): no samples.
    if (s >= 520 && s < 545) {
      if (s === 520) events.push({ type: 'pause', t: t0 + s * 1000, seq, reason: 'hidden' });
      continue;
    }
    if (s >= 545 && samples.length && samples[samples.length - 1].t < t0 + 545000) {
      segment++;
      events.push({ type: 'resume', t: t0 + s * 1000, seq, gapMs: 25000, segment });
    }
    let rate = 0, target = 0;
    if (s < 15) target = 2.5 * (s / 15);
    else if (s < 180) target = 4.2;
    else if (s < 210) (target = 3.5), (rate = 3);
    else if (s < 330) target = 3.6 + Math.sin(s / 20) * 0.4;
    else if (s < 360) (target = 2), (rate = -2.5);
    else if (s < 400) target = 1.2;
    else if (s < 700) (target = 0.25 + 0.15 * Math.sin(s / 13)), (rate = 0.6 * Math.sin(s / 25));
    else if (s < 730) (target = 2.5), (rate = 6);
    else target = 4.8;
    speed += (target - speed) * 0.05;
    hdg = wrap360(hdg + rate * dt + gauss(r) * 0.05);
    const cog = wrap360(hdg + 4 * Math.sin(s / 40));
    x += speed * Math.sin((cog * Math.PI) / 180) * dt;
    y += speed * Math.cos((cog * Math.PI) / 180) * dt;
    const t = t0 + Math.round(s * 1000);
    const pos = f.toLatLon(x + gauss(r) * 0.25, y + gauss(r) * 0.25);
    if (Math.abs(s - 400) < 1e-6) {
      mark = { lat: pos.lat, lon: pos.lon };
      events.push({ type: 'mark', t, seq, lat: mark.lat, lon: mark.lon, acc: 3 });
    }
    if (Math.abs(s - 760) < 1e-6) {
      events.push({ type: 'mark_clear', t, seq });
      mark = null;
    }
    const acc = 2.5 + Math.abs(gauss(r)) * 1.2;
    samples.push({
      seq: seq++,
      t,
      iso: new Date(t).toISOString(),
      segment,
      lat: +pos.lat.toFixed(8),
      lon: +pos.lon.toFixed(8),
      x: +x.toFixed(3),
      y: +y.toFixed(3),
      vx: +(speed * Math.sin((cog * Math.PI) / 180)).toFixed(3),
      vy: +(speed * Math.cos((cog * Math.PI) / 180)).toFixed(3),
      sog: +(speed + gauss(r) * 0.04).toFixed(3),
      cog: speed > 0.5 ? +cog.toFixed(2) : null,
      hdg: +hdg.toFixed(2),
      hdgRate: +(rate + gauss(r) * 0.08).toFixed(3),
      hdgSigma: +(1.5 + Math.abs(gauss(r)) * 0.3).toFixed(2),
      hdgSrc: 'compass',
      gyroRate: +(rate + gauss(r) * 0.6).toFixed(3),
      gyroBias: +(0.08 + 0.02 * Math.sin(s / 200)).toFixed(4),
      pitch: +(gauss(r) * 2).toFixed(2),
      roll: +(gauss(r) * 4).toFixed(2),
      posSigma: +(acc * 0.5).toFixed(2),
      gnssAcc: +acc.toFixed(2),
      gnssNew: k % 5 === 0 ? 1 : 0,
      gnssSpeed: +(speed + gauss(r) * 0.15).toFixed(3),
      mount: 'flat',
      markActive: mark ? 1 : 0,
      markEvent: Math.abs(s - 400) < 1e-6 ? 'mark' : Math.abs(s - 760) < 1e-6 ? 'clear' : '',
      markLat: mark ? mark.lat : null,
      markLon: mark ? mark.lon : null,
      markDist: mark ? +haversine(mark.lat, mark.lon, pos.lat, pos.lon).toFixed(3) : null,
      markBrg: null,
    });
  }
  const last = samples[samples.length - 1];
  events.push({ type: 'stop', t: last.t, seq });
  const session = {
    id,
    name,
    notes: 'Simulated harbour run',
    createdAt: t0,
    startedAt: t0,
    endedAt: last.t,
    status: 'done',
    sampleHz: 5,
    sampleCount: samples.length,
    origin: { lat: lat0, lon: lon0 },
    events,
    metaVersion: 3,
    device: { name: device },
    app: { version: '0.7.5' },
  };
  return { session, samples };
}

export async function post(base, token, body) {
  const res = await fetch(`${base}/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`ingest ${res.status} ${await res.text()}`);
  return res.json();
}

/** Upload a run in chunks; `upTo` limits how many samples are sent (to fake a live session). */
export async function upload(base, token, { session, samples }, { upTo = samples.length, chunk = 1000, live = false } = {}) {
  const meta = live ? { ...session, status: 'recording', endedAt: null, events: session.events.filter((e) => e.t <= samples[upTo - 1].t && e.type !== 'stop') } : session;
  for (let from = 0; from < upTo; from += chunk) {
    const rows = samples.slice(from, Math.min(from + chunk, upTo));
    const to = rows[rows.length - 1].seq;
    await post(base, token, { schema: 'gnsslog/1', sentAt: new Date().toISOString(), session: meta, chunk: { from, to, count: rows.length }, samples: rows, final: !live && to === samples.length - 1 });
  }
}

if (process.argv[1] && process.argv[1].endsWith('hub-seed.mjs')) {
  const base = process.argv[2] || 'http://127.0.0.1:8787';
  const token = process.argv[3] || '';
  await upload(base, token, makeRun({ id: '0a1b2c3d-0000-4000-8000-000000000001', name: 'Harbour run — skyhook test' }));
  await upload(base, token, makeRun({ id: '0a1b2c3d-0000-4000-8000-000000000002', name: 'Evening transit', seed: 3, lat0: 1.262, lon0: 103.84, t0: Date.UTC(2026, 9, 1, 10, 0, 0), seconds: 600 }));
  console.log('seeded');
}
