import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanFixes, smoothTrack, lineAt } from '../js/trackline.js';

// A 90 deg corner of radius 20 m driven at 7 m/s, one fix per second.
function corner() {
  const fixes = [];
  let t = 0;
  for (let i = 0; i < 6; i++) fixes.push({ t: (t += 1000), x: -40 + 7 * i, y: 0, acc: 4, speed: 7 });
  for (let a = 7 / 20; a < Math.PI / 2; a += 7 / 20) fixes.push({ t: (t += 1000), x: 20 * Math.sin(a) - 5, y: -20 + 20 * Math.cos(a), acc: 4, speed: 7 });
  for (let i = 1; i < 6; i++) fixes.push({ t: (t += 1000), x: 15, y: -20 - 7 * i, acc: 4, speed: 7 });
  return fixes;
}

test('the curve passes through every fix and stays close to the true path in a corner', () => {
  const fixes = corner();
  const L = smoothTrack(fixes);
  for (const f of fixes) {
    const j = L.t.indexOf(f.t);
    assert.ok(j >= 0 && L.x[j] === f.x && L.y[j] === f.y, 'fix on the curve');
  }
  // every curve point lies within 0.5 m of the true 20 m arc / straights
  const dist = (x, y) => {
    if (x <= -5) return Math.abs(y);
    if (y <= -20) return Math.abs(x - 15);
    return Math.abs(Math.hypot(x + 5, y + 20) - 20);
  };
  let worst = 0;
  for (let j = 0; j < L.n; j++) worst = Math.max(worst, dist(L.x[j], L.y[j]));
  assert.ok(worst < 0.5, `max ${worst.toFixed(2)} m off the path`);
  assert.ok(L.n > fixes.length * 3, 'densified between fixes');
});

test('copies and late fixes are dropped; long gaps and glitches break the line', () => {
  const f = cleanFixes([{ t: 1000, x: 0, y: 0 }, { t: 2000, x: 5, y: 0 }, { t: 2030, x: 5.2, y: 0 }, { t: 1500, x: -9, y: 0 }, { t: 3000, x: 10, y: 0 }]);
  assert.deepEqual(f.map((p) => p.t), [1000, 2000, 3000]);
  const L = smoothTrack([...f, { t: 30000, x: 20, y: 0, acc: 4 }, { t: 31000, x: 5000, y: 0, acc: 4 }]);
  assert.equal(L.brk.filter(Boolean).length, 3); // start, after the 27 s gap, after the 5 km jump
  assert.equal(lineAt(L, 15000), null); // inside the gap
  assert.ok(Math.abs(lineAt(L, 2500).x - 7.5) < 0.5);
});

test('stretches between poor fixes are straight and flagged; they do not bend the good track', () => {
  const fixes = [
    { t: 1000, x: 0, y: 0, acc: 4 }, { t: 2000, x: 7, y: 0, acc: 4 }, { t: 3000, x: 14, y: 0, acc: 4 },
    { t: 4000, x: 30, y: 40, acc: 300 }, { t: 5000, x: -20, y: 60, acc: 300 },
  ];
  const L = smoothTrack(fixes);
  for (let j = 0; j < L.n; j++) {
    if (L.t[j] <= 3000) {
      assert.ok(Math.abs(L.y[j]) < 1e-9, 'good stretch stays straight');
      assert.equal(L.poor[j], false);
    } else assert.equal(L.poor[j], true);
  }
});
