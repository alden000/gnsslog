import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCSV, withSkyhookColumns } from '../js/export.js';

const rows = (n) => Array.from({ length: n }, (_, i) => ({ seq: i, t: 1000 + i * 200 }));
const events = [
  { type: 'start', t: 1000, seq: 0 },
  { type: 'skyhook', t: 1400, seq: 2, lat: 1.5, lon: 103.5 },
  { type: 'skyhook_clear', t: 2000, seq: 5 },
  { type: 'skyhook', t: 2200, seq: 6, lat: 1.6, lon: 103.6 },
  { type: 'stop', t: 2600, seq: 8 },
];

test('derives skyhook state for rows recorded without the columns', () => {
  const out = withSkyhookColumns(rows(8), events);
  assert.deepEqual(out.map((r) => r.skyActive), [0, 0, 1, 1, 1, 0, 1, 1]);
  assert.deepEqual(out.map((r) => r.skyEvent), ['', '', 'mark', '', '', 'clear', 'mark', '']);
  assert.equal(out[3].skyLat, 1.5);
  assert.equal(out[5].skyLat, null);
  assert.equal(out[7].skyLon, 103.6);
});

test('a spot set before recording shows as active from row 0', () => {
  const out = withSkyhookColumns(rows(3), [{ type: 'skyhook_active', t: 0, seq: 0, lat: 1, lon: 2 }]);
  assert.deepEqual(out.map((r) => [r.skyActive, r.skyEvent]), [[1, 'active'], [1, ''], [1, '']]);
});

test('rows that already carry the columns are kept as recorded', () => {
  const recorded = [{ seq: 0, t: 0, skyActive: 1, skyEvent: 'mark', skyLat: 9, skyLon: 9 }];
  assert.equal(withSkyhookColumns(recorded, [])[0].skyLat, 9);
});

test('CSV has the skyhook columns', () => {
  const [header, , , row2] = toCSV(rows(3), events).split('\n');
  const cols = header.split(',');
  for (const c of ['skyActive', 'skyEvent', 'skyLat', 'skyLon']) assert.ok(cols.includes(c), c);
  const v = row2.split(',');
  assert.equal(v[cols.indexOf('skyEvent')], 'mark');
  assert.equal(v[cols.indexOf('skyActive')], '1');
  assert.equal(v[cols.indexOf('skyLat')], '1.5');
});
