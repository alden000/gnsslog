import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage for the module under test.
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
const { DeviationEstimator } = await import('../js/deviation.js');

function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const angErr = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('learns a magnet-style (hard iron) deviation from straight runs on several headings', () => {
  const r = rng(11);
  // True deviation: 4 deg offset + 15 deg hard iron.
  const trueDev = (m) => 4 + 15 * Math.sin((m * Math.PI) / 180) - 6 * Math.cos((m * Math.PI) / 180);
  const est = new DeviationEstimator();
  est.reset(false);
  for (const course of [10, 100, 190, 280, 55, 235]) {
    for (let k = 0; k < 60; k++) {
      // Find the raw compass reading that corresponds to this true course.
      let mag = course;
      for (let it = 0; it < 20; it++) mag = course - trueDev(mag);
      const cogNoisy = course + gauss(r) * 4;
      est.update(mag, cogNoisy - mag);
    }
  }
  for (const m of [0, 45, 90, 135, 180, 225, 270, 315]) {
    assert.ok(angErr(est.correction(m), trueDev(m)) < 2.5, `at ${m}: ${est.correction(m).toFixed(1)} vs ${trueDev(m).toFixed(1)}`);
  }
  assert.equal(est.sectors >= 5, true);
});

test('rejects outliers such as a turn', () => {
  const est = new DeviationEstimator();
  est.reset(false);
  assert.equal(est.update(90, 120), false);
  assert.equal(est.n, 0);
});
