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
