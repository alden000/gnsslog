import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeadingKF, PositionKF } from '../js/filters.js';

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
function gauss(r) {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}
const angErr = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('heading KF tracks a turn, estimates gyro bias and beats the raw compass', () => {
  const r = rng(7);
  const kf = new HeadingKF();
  const bias = 0.8; // deg/s
  let truth = 350;
  let t = 0;
  let rawErr = 0, kfErr = 0, n = 0;
  for (let i = 0; i < 60 * 50; i++) {
    t += 20; // 50 Hz gyro
    const rate = i > 1500 && i < 2100 ? 3 : 0; // 12 s turn at 3 deg/s
    truth = (truth + rate * 0.02 + 360) % 360;
    kf.propagate(t, rate + bias + gauss(r) * 0.3);
    if (i % 5 === 0) {
      const z = (truth + gauss(r) * 6 + 360) % 360;
      kf.update(z, 36);
      if (i > 500) {
        rawErr += angErr(z, truth) ** 2;
        kfErr += angErr(kf.psi, truth) ** 2;
        n++;
      }
    }
  }
  const rawRms = Math.sqrt(rawErr / n), kfRms = Math.sqrt(kfErr / n);
  assert.ok(kfRms < rawRms / 2, `kf ${kfRms.toFixed(2)} raw ${rawRms.toFixed(2)}`);
  assert.ok(Math.abs(kf.bias - bias) < 0.2, `bias ${kf.bias}`);
});

test('heading KF wraps across north without a jump', () => {
  const kf = new HeadingKF();
  kf.propagate(0, 0);
  kf.update(359, 4);
  kf.propagate(100, 0);
  kf.update(1, 4);
  assert.ok(angErr(kf.psi, 0) < 1.5, `${kf.psi}`);
});

test('heading KF recovers from a persistent offset (re-seed)', () => {
  const kf = new HeadingKF();
  kf.propagate(0, 0);
  kf.update(10, 4);
  for (let i = 1; i < 40; i++) {
    kf.propagate(i * 100, 0);
    kf.update(190, 4);
  }
  assert.ok(angErr(kf.psi, 190) < 5, `${kf.psi}`);
});

test('position KF smooths a 1 Hz track and recovers velocity', () => {
  const r = rng(3);
  const kf = new PositionKF();
  const vx = 1.5, vy = -0.5;
  let errRaw = 0, errKf = 0, n = 0;
  for (let k = 0; k <= 120; k++) {
    const t = k * 1000;
    const x = vx * k, y = vy * k;
    const mx = x + gauss(r) * 3, my = y + gauss(r) * 3;
    kf.updatePosition(t, mx, my, 9);
    kf.updateVelocity(t, vx + gauss(r) * 0.2, vy + gauss(r) * 0.2, 0.04); // GNSS Doppler velocity
    if (k > 20) {
      errRaw += (mx - x) ** 2 + (my - y) ** 2;
      errKf += (kf.x[0] - x) ** 2 + (kf.x[1] - y) ** 2;
      n++;
    }
  }
  assert.ok(Math.sqrt(errKf / n) < Math.sqrt(errRaw / n), 'filtered error should be lower');
  assert.ok(Math.abs(kf.x[2] - vx) < 0.25 && Math.abs(kf.x[3] - vy) < 0.25, `v=${kf.x[2]},${kf.x[3]}`);
  const p = kf.peek(120200);
  assert.ok(Math.abs(p.x - kf.x[0] - kf.x[2] * 0.2) < 1e-9);
});

test('position KF accepts a persistent jump after a few rejects', () => {
  const kf = new PositionKF();
  kf.updatePosition(0, 0, 0, 4);
  for (let k = 1; k <= 6; k++) kf.updatePosition(k * 1000, 500, 500, 4);
  assert.ok(Math.hypot(kf.x[0] - 500, kf.x[1] - 500) < 5);
});
