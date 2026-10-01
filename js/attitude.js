// Device attitude helpers built on the W3C DeviceOrientation convention:
//   world frame: x = East, y = North, z = Up
//   device frame: x = right edge, y = top edge, z = out of the screen
//   R = Rz(alpha) * Rx(beta) * Ry(gamma) maps device vectors into the world frame.

import { D2R, R2D, wrap360 } from './geo.js';

/** Forward axis of the phone in the device frame for each mounting style. */
export const MOUNT_FORWARD = {
  flat: [0, 1, 0], // lying flat, top edge pointing to the bow
  upright: [0, 0, -1], // standing up (portrait), back camera looking at the bow
};

/**
 * Auto mounting: heading from the top edge while the screen faces up ('flat'), from the back
 * camera while the phone stands up ('upright'). The top edge points straight up when the phone
 * is upright, so its compass direction is undefined there and swings wildly with small tilts.
 * upZ = world-up expressed along the screen normal (1 = screen up, 0 = screen vertical).
 * Hysteresis around 45 degrees stops it flipping back and forth.
 */
export function autoMountMode(upZ, prev) {
  const a = Math.abs(upZ);
  if (prev === 'flat') return a < 0.62 ? 'upright' : 'flat'; // switch beyond ~52 deg tilt
  if (prev === 'upright') return a > 0.8 ? 'flat' : 'upright'; // back below ~37 deg tilt
  return a >= 0.71 ? 'flat' : 'upright';
}

export function rotationMatrix(alpha, beta, gamma) {
  const ca = Math.cos(alpha * D2R), sa = Math.sin(alpha * D2R);
  const cb = Math.cos(beta * D2R), sb = Math.sin(beta * D2R);
  const cg = Math.cos(gamma * D2R), sg = Math.sin(gamma * D2R);
  return [
    [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
    [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
    [-cb * sg, sb, cb * cg],
  ];
}

/**
 * Heading of the mount's forward axis from a full rotation matrix (device → East/North/Up),
 * e.g. Android's TYPE_ROTATION_VECTOR matrix. Null when the axis is (nearly) vertical.
 */
export function headingFromMatrix(R, mount = 'flat') {
  const f = MOUNT_FORWARD[mount] || MOUNT_FORWARD.flat;
  const e = R[0][0] * f[0] + R[0][1] * f[1] + R[0][2] * f[2];
  const n = R[1][0] * f[0] + R[1][1] * f[1] + R[1][2] * f[2];
  if (Math.hypot(e, n) < 0.25) return null;
  return wrap360(Math.atan2(e, n) * R2D);
}

/** W3C beta/gamma (deg) from a rotation matrix, for logging pitch/roll. */
export function betaGammaFromMatrix(R) {
  return {
    beta: Math.asin(Math.max(-1, Math.min(1, R[2][1]))) * R2D,
    gamma: Math.atan2(-R[2][0], R[2][2]) * R2D,
  };
}

/**
 * Heading rate (deg/s, +ve = to starboard) from device-axis gyro rates and world-up in device axes.
 * rotationRate.alpha/beta/gamma = rates about device x/y/z (W3C DeviceMotionEventRotationRate).
 */
export function headingRateFromUp(rotationRate, up) {
  const wx = rotationRate.alpha, wy = rotationRate.beta, wz = rotationRate.gamma;
  if (![wx, wy, wz].every(Number.isFinite)) return null;
  return -(wx * up[0] + wy * up[1] + wz * up[2]);
}

/**
 * Heading (deg clockwise from north) of the mount's forward axis, using an earth-referenced
 * alpha. Returns null when the forward axis points (nearly) straight up or down.
 */
export function headingFromOrientation(alpha, beta, gamma, mount = 'flat') {
  const f = MOUNT_FORWARD[mount] || MOUNT_FORWARD.flat;
  const R = rotationMatrix(alpha, beta, gamma);
  const e = R[0][0] * f[0] + R[0][1] * f[1] + R[0][2] * f[2];
  const n = R[1][0] * f[0] + R[1][1] * f[1] + R[1][2] * f[2];
  if (Math.hypot(e, n) < 0.25) return null; // within ~15 deg of vertical: heading undefined
  return wrap360(Math.atan2(e, n) * R2D);
}

/** World "up" expressed in the device frame (third row of R; independent of alpha). */
export function upInDevice(beta, gamma) {
  const cb = Math.cos(beta * D2R), sb = Math.sin(beta * D2R);
  const cg = Math.cos(gamma * D2R), sg = Math.sin(gamma * D2R);
  return [-cb * sg, sb, cb * cg];
}

/**
 * Heading rate (deg/s, +ve = clockwise seen from above, i.e. turning to starboard) from the
 * gyroscope. Per the W3C spec (and Chrome/Safari), rotationRate.alpha/beta/gamma are the rates
 * about the device x/y/z axes. (Older docs describe alpha as the z rate; that is wrong.)
 */
export function headingRateFromGyro(rotationRate, beta, gamma) {
  const wx = rotationRate.alpha, wy = rotationRate.beta, wz = rotationRate.gamma;
  if (![wx, wy, wz].every(Number.isFinite)) return null;
  const u = upInDevice(beta, gamma);
  // Projection onto world-up gives the counter-clockwise yaw rate; heading is clockwise.
  return -(wx * u[0] + wy * u[1] + wz * u[2]);
}
