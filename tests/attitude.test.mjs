import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headingFromOrientation, headingRateFromGyro } from '../js/attitude.js';

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(((a - b + 540) % 360) - 180) < tol, `${a} vs ${b}`);

test('flat phone: heading = 360 - alpha', () => {
  close(headingFromOrientation(0, 0, 0, 'flat'), 0);
  close(headingFromOrientation(90, 0, 0, 'flat'), 270);
  close(headingFromOrientation(300, 0, 0, 'flat'), 60);
});

test('flat mount tolerates moderate pitch and roll', () => {
  close(headingFromOrientation(45, 20, -15, 'flat'), 315, 6);
});

test('upright phone: back camera direction', () => {
  // Portrait, upright (beta = 90), alpha = 0 → back camera looks north.
  close(headingFromOrientation(0, 90, 0, 'upright'), 0);
  close(headingFromOrientation(90, 90, 0, 'upright'), 270);
});

test('heading undefined when forward axis is vertical', () => {
  assert.equal(headingFromOrientation(0, 0, 0, 'upright'), null);
  assert.equal(headingFromOrientation(0, 90, 0, 'flat'), null);
});

test('gyro: CCW rotation of a flat phone decreases heading', () => {
  assert.equal(headingRateFromGyro({ alpha: 10, beta: 0, gamma: 0 }, 0, 0), -10);
});

test('gyro: upright phone yaw comes from the device y axis', () => {
  // Upright (beta = 90): world up is the device +y axis, so yaw = rotation about y (gamma rate).
  const r = headingRateFromGyro({ alpha: 0, beta: 0, gamma: 12 }, 90, 0);
  assert.ok(Math.abs(r + 12) < 1e-9);
});
