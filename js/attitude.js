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
 * gyroscope. rotationRate.alpha/beta/gamma are rates about the device z/x/y axes.
 */
export function headingRateFromGyro(rotationRate, beta, gamma) {
  const wx = rotationRate.beta, wy = rotationRate.gamma, wz = rotationRate.alpha;
  if (![wx, wy, wz].every(Number.isFinite)) return null;
  const u = upInDevice(beta, gamma);
  // Projection onto world-up gives the counter-clockwise yaw rate; heading is clockwise.
  return -(wx * u[0] + wy * u[1] + wz * u[2]);
}
