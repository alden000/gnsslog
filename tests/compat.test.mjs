import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeEvent, upgradeSession, upgradeSample } from '../js/compat.js';
import { toCSV } from '../js/export.js';

test('old "skyhook" events read as mark events', () => {
  assert.equal(upgradeEvent({ type: 'skyhook', t: 1 }).type, 'mark');
  assert.equal(upgradeEvent({ type: 'skyhook_clear', t: 1 }).type, 'mark_clear');
  assert.equal(upgradeEvent({ type: 'skyhook_active', t: 1 }).type, 'mark_active');
  assert.equal(upgradeEvent({ type: 'stop', t: 1 }).type, 'stop');
  const s = { id: 'a', events: [{ type: 'start' }, { type: 'skyhook', lat: 1, lon: 2 }] };
  assert.deepEqual(upgradeSession(s).events.map((e) => e.type), ['start', 'mark']);
  const cur = { id: 'b', events: [{ type: 'mark' }] };
  assert.equal(upgradeSession(cur), cur, 'current data is returned untouched');
});

test('old sample columns read under the new names, in order', () => {
  const r = upgradeSample({ seq: 3, t: 9, skyActive: 1, skyEvent: 'mark', skyLat: 1.5, skyLon: 103.5, skyDist: 4.2, skyBrg: 210 });
  assert.deepEqual(Object.keys(r), ['seq', 't', 'markActive', 'markEvent', 'markLat', 'markLon', 'markDist', 'markBrg']);
  assert.equal(r.markDist, 4.2);
  const cur = { seq: 1, markDist: 2 };
  assert.equal(upgradeSample(cur), cur);
});

test('an old session exports with the new column names and values', () => {
  const rows = [0, 1, 2].map((i) => upgradeSample({ seq: i, t: i * 200, skyDist: i ? 1.5 : null, skyActive: i ? 1 : 0, skyEvent: i === 1 ? 'mark' : '', skyLat: i ? 1.3 : null, skyLon: i ? 103.8 : null, skyBrg: null }));
  const [head, , row1] = toCSV(rows, []).trim().split('\n');
  const cols = head.split(',');
  assert.ok(!cols.some((c) => c.startsWith('sky')), 'no old column names');
  const v = row1.split(',');
  assert.equal(v[cols.indexOf('markDist')], '1.5');
  assert.equal(v[cols.indexOf('markEvent')], 'mark');
});
