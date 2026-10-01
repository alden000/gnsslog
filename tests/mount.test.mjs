import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem() {} };
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };
const { Fusion } = await import('../js/fusion.js');
const { autoMountMode, headingFromOrientation } = await import('../js/attitude.js');
const mk = (mount) => ({ v: { declination: 0, headingOffset: 0, mount, compassSigma: 6, invertGyro: false, autoDeviation: false, rateSmoothing: 0.5 }, get(k) { return this.v[k]; } });
const angErr = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// Phone held upright in portrait, screen towards you, back camera looking ahead. Turning on the
// spot changes alpha; tipping it forward/back changes beta around 90.
test('upright phone: auto heading follows turning 1:1 (back-camera direction)', () => {
  const f = new Fusion(mk('auto'));
  for (let i = 0; i <= 72; i++) {
    const t = 1e6 + i * 120;
    const alpha = (360 - i * 5) % 360; // turning right 5 deg per step
    f.onOrientation({ t, alpha, beta: 85, gamma: 0, absolute: true, compass: null });
  }
  assert.equal(f.mountMode, 'upright');
  // After turning 360 deg right in 5 deg steps, heading = 360 - alpha of the last step.
  const raw = f.magHeadingRaw;
  assert.ok(angErr(raw, 0) < 1, `camera heading ${raw}`);
  for (const alpha of [0, 45, 90, 180, 270]) {
    const h = headingFromOrientation(alpha, 85, 0, 'upright');
    assert.ok(angErr(h, 360 - alpha) < 1e-6);
  }
});

test('upright phone: tilting forward/back barely moves the auto heading (it swung wildly with Flat)', () => {
  const auto = new Fusion(mk('auto'));
  const flat = new Fusion(mk('flat'));
  const autoH = [], flatH = [];
  for (const beta of [70, 75, 80, 85, 88, 92, 95, 100, 105]) {
    for (const [fz, out] of [[auto, autoH], [flat, flatH]]) {
      fz.onOrientation({ t: 1e6 + beta * 1000, alpha: 30, beta, gamma: 4, absolute: true, compass: null });
      if (fz.magHeadingRaw !== null) out.push(fz.magHeadingRaw);
    }
  }
  const spread = (a) => Math.max(...a.map((x) => angErr(x, a[0])));
  assert.ok(spread(autoH) < 3, `auto spread ${spread(autoH).toFixed(1)} deg`);
  assert.ok(flatH.length === 0 || spread(flatH) > 30, `flat spread ${flatH.length ? spread(flatH).toFixed(1) : 'n/a'} deg`);
});

test('flat on the table: auto uses the top edge, with hysteresis around 45 deg', () => {
  assert.equal(autoMountMode(0.99, null), 'flat');
  assert.equal(autoMountMode(0.1, null), 'upright');
  assert.equal(autoMountMode(0.68, 'flat'), 'flat'); // inside the band: keep
  assert.equal(autoMountMode(0.68, 'upright'), 'upright');
  assert.equal(autoMountMode(0.55, 'flat'), 'upright');
  assert.equal(autoMountMode(0.85, 'upright'), 'flat');
  const f = new Fusion(mk('auto'));
  f.onOrientation({ t: 1e6, alpha: 300, beta: 5, gamma: -3, absolute: true, compass: null });
  assert.equal(f.mountMode, 'flat');
  assert.ok(angErr(f.magHeadingRaw, 60) < 1);
});

test('auto switch at ~45 deg pitch keeps the same heading (no jump)', () => {
  const a = headingFromOrientation(40, 45, 0, 'flat');
  const b = headingFromOrientation(40, 45, 0, 'upright');
  assert.ok(angErr(a, b) < 1e-6, `${a} vs ${b}`);
});

test('old default "flat" setting migrates to auto; a chosen "upright" is kept', async () => {
  const { Settings } = await import('../js/settings.js');
  localStorage._s = { 'gnsslog.settings': JSON.stringify({ mount: 'flat', theme: 'dark' }) };
  assert.equal(new Settings().get('mount'), 'auto');
  localStorage._s = { 'gnsslog.settings': JSON.stringify({ mount: 'upright' }) };
  assert.equal(new Settings().get('mount'), 'upright');
  localStorage._s = {};
  assert.equal(new Settings().get('mount'), 'auto');
});
