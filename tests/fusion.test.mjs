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
