import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };
const { Fusion } = await import('../js/fusion.js');
const settings = { v: { declination: 0, headingOffset: 0, mount: 'flat', compassSigma: 6, invertGyro: false, autoDeviation: false, rateSmoothing: 0.5 }, get(k) { return this.v[k]; } };

test('fused track stays close to the GNSS fixes on a real walking log (regression)', () => {
  // v0.1 trusted the chipset's smoothed velocity so much that this log drifted ~10 m off the fixes.
  const { fixes } = JSON.parse(readFileSync(new URL('./fixtures/walk-fixes.json', import.meta.url)));
  const f = new Fusion(settings);
  const off = [];
  for (const [t, lat, lon, acc, speed, cog] of fixes) {
    f.onGnss({ t, fixT: t, lat, lon, acc, alt: null, altAcc: null, speed, cog });
    const s = f.state(t);
    const p = f.frame.toXY(s.lat, s.lon);
    const q = f.frame.toXY(lat, lon);
    off.push(Math.hypot(p.x - q.x, p.y - q.y));
  }
  off.sort((a, b) => a - b);
  const p95 = off[Math.floor(off.length * 0.95)];
  assert.ok(p95 < 4, `p95 offset from fixes ${p95.toFixed(2)} m`);
});

// A straight drive due east at 7 m/s (local metres → lat/lon near the equator).
const M = 111320;
const LAT0 = 1.44, LON0 = 103.8;
const at = (x, y) => ({ lat: LAT0 + y / M, lon: LON0 + x / (M * Math.cos((LAT0 * Math.PI) / 180)) });
function offAt(f, t, x, y) {
  const s = f.state(t);
  const p = f.frame.toXY(s.lat, s.lon);
  const q = f.frame.toXY(at(x, y).lat, at(x, y).lon);
  return Math.hypot(p.x - q.x, p.y - q.y);
}

test('fixes delivered 1.1 s after their own time: the track is where the vehicle is now, not 1.1 s behind', () => {
  // Field logs: the fused provider delivers each fix ~1.1 s after its timestamp (and the gyro
  // agrees the timestamp is right). Applying it at arrival left the track ~8 m behind at 7 m/s.
  const f = new Fusion(settings);
  const v = 7;
  const off = [];
  for (let i = 0; i < 60; i++) {
    const fixT = 1e6 + i * 1000;
    f.onGnss({ t: fixT + 1100, fixT, ...at(v * i, 0), acc: 4, speed: v, cog: 90 });
    if (i > 10) off.push(offAt(f, fixT + 1100, v * (i + 1.1), 0));
  }
  assert.ok(Math.max(...off) < 1.5, `max offset ${Math.max(...off).toFixed(2)} m`);
});

test('a course that contradicts the fixes is ignored (no sideways drift)', () => {
  // Field log: driving SSE on a straight road, the phone reported a course ~90 deg off for
  // 10 s. Trusting it, the track drifted sideways, then jumped 45 m back to the fixes.
  const f = new Fusion(settings);
  const v = 7;
  let worst = 0;
  for (let i = 0; i < 40; i++) {
    const fixT = 1e6 + i * 1000;
    const cog = i >= 15 && i < 27 ? 0 : 90; // course says north while the car keeps going east
    f.onGnss({ t: fixT + 1100, fixT, ...at(v * i, 0), acc: 3.8, speed: v, cog });
    for (let k = 1; k <= 5; k++) worst = Math.max(worst, offAt(f, fixT + 1100 + k * 200, v * (i + 1.1 + k * 0.2), 0));
  }
  assert.ok(worst < 4, `worst offset ${worst.toFixed(2)} m`);
});

test('the second copy of each fix (background service + in-app watcher) is ignored, also out of order', () => {
  const f = new Fusion(settings);
  const seen = [];
  f.onGnss({ t: 1e6 + 100, fixT: 1e6, ...at(0, 0), acc: 4, speed: 0, cog: null });
  seen.push(f.lastFixT);
  f.onGnss({ t: 1e6 + 1150, fixT: 1e6 + 1000, ...at(1, 0), acc: 4, speed: 1, cog: 90 });
  seen.push(f.lastFixT);
  f.onGnss({ t: 1e6 + 1200, fixT: 1e6 + 1060, ...at(1.2, 0), acc: 4, speed: 1, cog: 90 }); // near copy
  f.onGnss({ t: 1e6 + 1250, fixT: 1e6 + 300, ...at(-9, 0), acc: 4, speed: 1, cog: 90 }); // late, older
  assert.deepEqual(seen, [1e6, 1e6 + 1000]);
  assert.equal(f.lastFixT, 1e6 + 1000);
  assert.ok(offAt(f, 1e6 + 1250, 1, 0) < 1.5);
});

test('indoors, lying still: sparse Wi-Fi fixes tens of metres apart do not send the track coasting', () => {
  // Field log: a fix every ~10 s, 23-75 m accuracy, each 45-70 m from the last; the track picked
  // up ~5 m/s from each and coasted 50 m before the next. Lying still now means not moving.
  const f = new Fusion(settings);
  f.att = { up: [0, 0, 1] };
  const fixes = [[0, 0, 30], [60, 5, 25], [10, -40, 40], [55, 30, 23], [-5, 10, 35], [40, -30, 27]];
  let t = 1e6, maxSpeed = 0, n = 0;
  const pos = [];
  for (let s = 0; s < 90; s++) {
    for (let k = 0; k < 50; k++) {
      t += 20;
      f.onMotion({ t, rot: { alpha: 0, beta: 0, gamma: 0.05 * Math.sin(k) } });
    }
    if (s % 10 === 5) {
      const [x, y, acc] = fixes[n++ % fixes.length];
      f.onGnss({ t, fixT: t - 5000, ...at(x, y), acc, speed: null, cog: null });
    }
    const st = f.state(t);
    if (s > 30) {
      maxSpeed = Math.max(maxSpeed, st.sog);
      pos.push(f.frame.toXY(st.lat, st.lon));
    }
  }
  const span = Math.max(...pos.map((p) => Math.hypot(p.x - pos[0].x, p.y - pos[0].y)));
  assert.ok(maxSpeed < 0.5, `speed while still ${maxSpeed.toFixed(2)} m/s`);
  assert.ok(span < 25, `track wandered ${span.toFixed(1)} m`);
});
