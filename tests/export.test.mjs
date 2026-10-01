import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCSV, withMarkColumns } from '../js/export.js';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ seq: i, t: 1000 + i * 200 }));
const events = [
  { type: 'start', t: 1000, seq: 0 },
  { type: 'mark', t: 1400, seq: 2, lat: 1.5, lon: 103.5 },
  { type: 'mark_clear', t: 2000, seq: 5 },
  { type: 'mark', t: 2200, seq: 6, lat: 1.6, lon: 103.6 },
  { type: 'stop', t: 2600, seq: 8 },
];

test('derives marked-location state for rows recorded without the columns', () => {
  const out = withMarkColumns(rows(8), events);
  assert.deepEqual(out.map((r) => r.markActive), [0, 0, 1, 1, 1, 0, 1, 1]);
  assert.deepEqual(out.map((r) => r.markEvent), ['', '', 'mark', '', '', 'clear', 'mark', '']);
  assert.equal(out[3].markLat, 1.5);
  assert.equal(out[5].markLat, null);
  assert.equal(out[7].markLon, 103.6);
});

test('a spot set before recording shows as active from row 0', () => {
  const out = withMarkColumns(rows(3), [{ type: 'mark_active', t: 0, seq: 0, lat: 1, lon: 2 }]);
  assert.deepEqual(out.map((r) => [r.markActive, r.markEvent]), [[1, 'active'], [1, ''], [1, '']]);
});

test('rows that already carry the columns are kept as recorded', () => {
  const recorded = [{ seq: 0, t: 0, markActive: 1, markEvent: 'mark', markLat: 9, markLon: 9 }];
  assert.equal(withMarkColumns(recorded, [])[0].markLat, 9);
});

test('CSV has the marked-location columns', () => {
  const [header, , , row2] = toCSV(rows(3), events).split('\n');
  const cols = header.split(',');
  for (const c of ['markActive', 'markEvent', 'markLat', 'markLon']) assert.ok(cols.includes(c), c);
  const v = row2.split(',');
  assert.equal(v[cols.indexOf('markEvent')], 'mark');
  assert.equal(v[cols.indexOf('markActive')], '1');
  assert.equal(v[cols.indexOf('markLat')], '1.5');
});
