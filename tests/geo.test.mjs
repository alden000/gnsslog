import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalFrame, haversine, wrap180, wrap360, bearingXY } from '../js/geo.js';

test('wrap helpers', () => {
  assert.equal(wrap360(-10), 350);
  assert.equal(wrap360(725), 5);
  assert.equal(wrap180(190), -170);
  assert.equal(wrap180(-190), 170);
  assert.equal(wrap180(180), 180);
});

test('local frame round-trips and agrees with haversine', () => {
  const f = new LocalFrame(1.264, 103.84); // Singapore Strait
  const p = f.toXY(1.265, 103.841);
  const back = f.toLatLon(p.x, p.y);
  assert.ok(Math.abs(back.lat - 1.265) < 1e-10);
  assert.ok(Math.abs(back.lon - 103.841) < 1e-10);
  const planar = Math.hypot(p.x, p.y);
  const geo = haversine(1.264, 103.84, 1.265, 103.841);
  assert.ok(Math.abs(planar - geo) / geo < 0.005, `${planar} vs ${geo}`);
});

test('one degree of latitude is ~110.6 km at the equator', () => {
  const f = new LocalFrame(0, 0);
  assert.ok(Math.abs(f.toXY(1, 0).y - 110574) < 5);
});

test('bearing of planar vectors', () => {
  assert.equal(bearingXY(0, 1), 0);
  assert.equal(bearingXY(1, 0), 90);
  assert.equal(bearingXY(0, -1), 180);
  assert.equal(bearingXY(-1, 0), 270);
});
