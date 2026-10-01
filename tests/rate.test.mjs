import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };
const { Fusion } = await import('../js/fusion.js');
const settings = { v: { declination: 0, headingOffset: 0, mount: 'flat', compassSigma: 6, invertGyro: false, autoDeviation: false, rateSmoothing: 0.5 }, get(k) { return this.v[k]; } };

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const sd = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

test('rate of turn stays steady under vibration while static', () => {
  const r = rng(5);
  const f = new Fusion(settings);
  const raw = [], out = [];
  let t = 1e6;
  for (let i = 0; i < 60 * 30; i++) {
    t += 1000 / 60;
    f.onOrientation({ t, alpha: 0, beta: 70, gamma: 0, absolute: true, compass: null });
    // Phone upright in a holder: yaw is about the device y axis. 2 deg/s rms vibration.
    const w = gauss(r) * 2;
    f.onMotion({ t, rot: { alpha: gauss(r) * 2, beta: w, gamma: gauss(r) * 2 } }); // beta = y-axis rate
    if (i % 12 === 0 && i > 300) {
      raw.push(f.gyroRate);
      out.push(f.peek(t).hdgRate);
    }
  }
  assert.ok(sd(raw) > 1.5, `raw sd ${sd(raw)}`);
  assert.ok(sd(out) < 0.4, `smoothed sd ${sd(out).toFixed(2)} (raw ${sd(raw).toFixed(2)})`);
});

test('rate of turn follows a real turn', () => {
  const f = new Fusion(settings);
  let t = 1e6;
  for (let i = 0; i < 60 * 20; i++) {
    t += 1000 / 60;
    const hdg = (3 * i) / 60; // turning to starboard at 3 deg/s
    f.onOrientation({ t, alpha: (360 - hdg) % 360, beta: 0, gamma: 0, absolute: true, compass: null });
    f.onMotion({ t, rot: { alpha: 0, beta: 0, gamma: -3 } }); // flat phone: z rate (gamma) -3 = turning to starboard
  }
  const v = f.peek(t).hdgRate;
  assert.ok(Math.abs(v - 3) < 0.6, `rate ${v}`);
});

// Lying still: a constant +0.1 deg/s gyro bias plus sensor noise. The compass is steady.
function stillRun({ bias = 0.1, seconds = 60, speed = 0, turn = 0, compassDrift = 0 } = {}) {
  const r = rng(11);
  const f = new Fusion(settings);
  let t = 1e6;
  for (let i = 0; i < 60 * seconds; i++) {
    t += 1000 / 60;
    if (i % 60 === 0) f.onGnss({ t, lat: 1.3, lon: 103.8, acc: 4, speed, cog: null });
    const hdg = 90 + ((turn + compassDrift) * i) / 60;
    f.onOrientation({ t, alpha: (360 - hdg + gauss(r) * 0.5 + 360) % 360, beta: 0, gamma: 0, absolute: true, compass: null });
    f.onMotion({ t, rot: { alpha: 0, beta: 0, gamma: -(bias + turn) + gauss(r) * 0.05 } });
  }
  return f;
}

test('lying still: gyro bias is calibrated out and the rate of turn reads ~0', () => {
  const f = stillRun();
  const s = f.peek(f.gyroT);
  assert.ok(Math.abs(s.gyroBias - 0.1) < 0.01, `bias ${s.gyroBias}`);
  assert.ok(Math.abs(s.hdgRate) < 0.02, `rate ${s.hdgRate}`);
  assert.equal(s.still, true);
});

test('no zero-rate update while GNSS says we are moving', () => {
  const f = stillRun({ speed: 3 });
  assert.equal(f.stillT, 0);
});

test('a slow real turn is not mistaken for bias', () => {
  const f = stillRun({ bias: 0, turn: 0.3 });
  assert.equal(f.stillT, 0);
  assert.ok(Math.abs(f.peek(f.gyroT).hdgRate - 0.3) < 0.1);
});

test('lying still: a slowly drifting compass does not show up as a rate of turn', () => {
  // Gyro unbiased, compass creeping 0.1 deg/s: without the zero-rate update the filter blamed
  // the gyro and reported a steady +0.1 deg/s turn.
  const f = stillRun({ bias: 0, compassDrift: 0.1 });
  const s = f.peek(f.gyroT);
  assert.ok(Math.abs(s.hdgRate) < 0.02, `rate ${s.hdgRate}`);
  assert.ok(Math.abs(s.gyroBias) < 0.02, `bias ${s.gyroBias}`);
});
