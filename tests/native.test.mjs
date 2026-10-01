import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem() {} };
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };
const { Fusion } = await import('../js/fusion.js');
const { rotationMatrix } = await import('../js/attitude.js');
const mk = (mount) => ({ v: { declination: 0, headingOffset: 0, mount, compassSigma: 6, invertGyro: false, autoDeviation: false, rateSmoothing: 0.5 }, get(k) { return this.v[k]; } });
const angErr = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

for (const [mount, beta, gamma] of [['flat', 3, -2], ['upright', 78, 4], ['upright', 89.5, 0]]) {
  test(`native matrix path matches the browser path (${mount}, beta ${beta})`, () => {
    for (const alpha of [10, 100, 200, 300]) {
      const web = new Fusion(mk(mount));
      const nat = new Fusion(mk(mount));
      const R = rotationMatrix(alpha, beta, gamma);
      for (let i = 0; i < 20; i++) {
        const t = 1e6 + i * 150;
        web.onOrientation({ t, alpha, beta, gamma, absolute: true, compass: null });
        nat.onNativeMotion({ t, R: R.flat(), gyro: null, headingAcc: null });
      }
      const hw = web.peek(1e6 + 3000).hdg, hn = nat.peek(1e6 + 3000).hdg;
      assert.ok(angErr(hw, hn) < 0.5, `alpha ${alpha}: web ${hw} native ${hn}`);
      assert.ok(Math.abs(nat.att.beta - beta) < 0.01);
    }
  });
}

test('native gyro (deg/s, device axes) gives the heading rate for an upright phone', () => {
  const f = new Fusion(mk('upright'));
  let t = 1e6;
  for (let i = 0; i < 25 * 10; i++) {
    t += 40;
    // Upright (beta 90): world up = device +y. Turning to starboard at 2 deg/s means alpha
    // decreases at 2 deg/s and the gyro reads -2 deg/s about +y.
    const R = rotationMatrix((360 - 2 * i * 0.04) % 360, 90, 0).flat();
    f.onNativeMotion({ t, R, gyro: [0, -2, 0], headingAcc: null });
  }
  assert.ok(Math.abs(f.peek(t).hdgRate - 2) < 0.3, `rate ${f.peek(t).hdgRate}`);
});
