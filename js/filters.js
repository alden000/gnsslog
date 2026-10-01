// Kalman filters used by the fusion engine.
//
// HeadingKF  - 2-state [heading (deg), gyro bias (deg/s)]. The gyroscope yaw rate drives the
//              prediction; the magnetometer (or GNSS course as a fallback) corrects it.
// PositionKF - 4-state constant-velocity model [x, y, vx, vy] in a local East/North frame.
//              GNSS position and GNSS velocity are the measurements. It lets us output a
//              smooth 5 Hz track from a ~1 Hz receiver.

import { wrap180, wrap360 } from './geo.js';

export class HeadingKF {
  constructor({
    qHeadingGyro = 0.05, // deg^2/s  - heading random walk when integrating the gyro
    qHeadingNoGyro = 40, // deg^2/s  - heading random walk with no gyro available
    qBias = 0.0004, //      (deg/s)^2/s - gyro bias random walk
    gate = 16, //           chi^2 gate (4 sigma) for compass innovations
    maxRejects = 15, //     consecutive rejects before we accept the compass again
  } = {}) {
    Object.assign(this, { qHeadingGyro, qHeadingNoGyro, qBias, gate, maxRejects });
    this.reset();
  }

  reset() {
    this.initialized = false;
    this.psi = 0;
    this.bias = 0;
    this.P = [
      [1e4, 0],
      [0, 1],
    ];
    this.t = null; // ms
    this.rate = 0; // last bias-corrected rate, deg/s (heading convention: +ve = turning to starboard)
    this.rejects = 0;
    this.lastInnovation = 0;
  }

  /**
   * Propagate to time t (ms). omega is the measured heading rate in deg/s or null when no
   * gyro sample is available for this interval.
   */
  propagate(t, omega) {
    if (this.t === null) {
      this.t = t;
      return;
    }
    let dt = (t - this.t) / 1000;
    if (dt <= 0) return;
    if (dt > 1) dt = 1; // long gaps: do not integrate a stale rate for ages
    this.t = t;
    if (!this.initialized) return;

    const hasGyro = omega !== null && omega !== undefined && Number.isFinite(omega);
    const r = hasGyro ? omega - this.bias : 0;
    this.rate = r;
    this.psi = wrap360(this.psi + r * dt);

    // P = F P F' + Q, F = [[1, -dt*g], [0, 1]] (g = 1 if gyro used)
    const g = hasGyro ? 1 : 0;
    const [[p00, p01], [p10, p11]] = this.P;
    const f = -dt * g;
    const n00 = p00 + f * (p10 + p01) + f * f * p11;
    const n01 = p01 + f * p11;
    const n10 = p10 + f * p11;
    const qh = (hasGyro ? this.qHeadingGyro : this.qHeadingNoGyro) * dt;
    this.P = [
      [n00 + qh, n01],
      [n10, p11 + this.qBias * dt],
    ];
  }

  /** Absolute heading measurement z (deg) with variance r (deg^2). Returns true if applied. */
  update(z, r) {
    if (!Number.isFinite(z)) return false;
    if (!this.initialized) {
      this.psi = wrap360(z);
      this.bias = 0;
      this.P = [
        [r, 0],
        [0, 0.25],
      ];
      this.initialized = true;
      this.rejects = 0;
      return true;
    }
    const y = wrap180(z - this.psi);
    const S = this.P[0][0] + r;
    this.lastInnovation = y;
    if ((y * y) / S > this.gate) {
      // Magnetic disturbance or a bad sample. If it persists, the filter is the one that is
      // wrong (e.g. it was initialised off a bad reading) so we re-seed from the compass.
      this.rejects++;
      if (this.rejects >= this.maxRejects) {
        this.initialized = false;
        return this.update(z, r);
      }
      return false;
    }
    this.rejects = 0;
    const [[p00, p01], [p10, p11]] = this.P;
    const k0 = p00 / S;
    const k1 = p10 / S;
    this.psi = wrap360(this.psi + k0 * y);
    this.bias += k1 * y;
    this.P = [
      [(1 - k0) * p00, (1 - k0) * p01],
      [p10 - k1 * p00, p11 - k1 * p01],
    ];
    return true;
  }

  /** Heading extrapolated to time t without mutating the filter. */
  peek(t) {
    if (!this.initialized || this.t === null) return null;
    const dt = Math.min(Math.max((t - this.t) / 1000, 0), 0.5);
    return wrap360(this.psi + this.rate * dt);
  }

  get sigma() {
    return Math.sqrt(Math.max(this.P[0][0], 0));
  }
}

export class PositionKF {
  constructor({ q = 0.4 /* m^2/s^3 white-acceleration density */, gate = 25, maxRejects = 4 } = {}) {
    Object.assign(this, { q, gate, maxRejects });
    this.reset();
  }

  reset() {
    this.initialized = false;
    this.x = [0, 0, 0, 0]; // x, y, vx, vy
    this.P = identity(4, 1e6);
    this.t = null;
    this.rejects = 0;
  }

  init(t, x, y, rPos, vx = 0, vy = 0, rVel = 4) {
    this.x = [x, y, vx, vy];
    this.P = [
      [rPos, 0, 0, 0],
      [0, rPos, 0, 0],
      [0, 0, rVel, 0],
      [0, 0, 0, rVel],
    ];
    this.t = t;
    this.initialized = true;
    this.rejects = 0;
  }

  predict(t) {
    if (!this.initialized) return;
    let dt = (t - this.t) / 1000;
    if (dt <= 0) return;
    this.t = t;
    if (dt > 5) dt = 5;
    const [x, y, vx, vy] = this.x;
    this.x = [x + vx * dt, y + vy * dt, vx, vy];
    const F = [
      [1, 0, dt, 0],
      [0, 1, 0, dt],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    const q = this.q;
    const a = (q * dt ** 3) / 3;
    const b = (q * dt ** 2) / 2;
    const c = q * dt;
    const Q = [
      [a, 0, b, 0],
      [0, a, 0, b],
      [b, 0, c, 0],
      [0, b, 0, c],
    ];
    this.P = add(mul(mul(F, this.P), transpose(F)), Q);
  }

  /** Position measurement (metres) with variance r per axis. */
  updatePosition(t, mx, my, r) {
    if (!this.initialized) {
      this.init(t, mx, my, r);
      return true;
    }
    this.predict(t);
    const ok = this._update([0, 1], [mx, my], r);
    if (!ok && ++this.rejects >= this.maxRejects) {
      // Consistent large jumps: trust the receiver and restart from it.
      this.init(t, mx, my, r, this.x[2], this.x[3]);
      return true;
    }
    if (ok) this.rejects = 0;
    return ok;
  }

  /** Velocity measurement (m/s) with variance r per axis. */
  updateVelocity(t, vx, vy, r) {
    if (!this.initialized) return false;
    this.predict(t);
    return this._update([2, 3], [vx, vy], r, Infinity);
  }

  _update(idx, z, r, gate = this.gate) {
    const [i, j] = idx;
    const P = this.P;
    const y0 = z[0] - this.x[i];
    const y1 = z[1] - this.x[j];
    // S = H P H' + R (2x2)
    const s00 = P[i][i] + r;
    const s01 = P[i][j];
    const s10 = P[j][i];
    const s11 = P[j][j] + r;
    const det = s00 * s11 - s01 * s10;
    if (!(Math.abs(det) > 1e-12)) return false;
    const i00 = s11 / det;
    const i01 = -s01 / det;
    const i10 = -s10 / det;
    const i11 = s00 / det;
    const d2 = y0 * (i00 * y0 + i01 * y1) + y1 * (i10 * y0 + i11 * y1);
    if (d2 > gate) return false;
    // K = P H' S^-1 (4x2)
    const K = P.map((row) => [row[i] * i00 + row[j] * i10, row[i] * i01 + row[j] * i11]);
    for (let k = 0; k < 4; k++) this.x[k] += K[k][0] * y0 + K[k][1] * y1;
    // P = (I - K H) P
    const n = 4;
    const IKH = identity(n, 1);
    for (let k = 0; k < n; k++) {
      IKH[k][i] -= K[k][0];
      IKH[k][j] -= K[k][1];
    }
    this.P = mul(IKH, P);
    return true;
  }

  /** State extrapolated to time t without mutating the filter. */
  peek(t) {
    if (!this.initialized) return null;
    const dt = Math.min(Math.max((t - this.t) / 1000, 0), 5);
    const [x, y, vx, vy] = this.x;
    return { x: x + vx * dt, y: y + vy * dt, vx, vy };
  }

  get sigmaPos() {
    return Math.sqrt(Math.max((this.P[0][0] + this.P[1][1]) / 2, 0));
  }
}

function identity(n, v) {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? v : 0)));
}
function transpose(A) {
  return A[0].map((_, j) => A.map((row) => row[j]));
}
function mul(A, B) {
  return A.map((row) => B[0].map((_, j) => row.reduce((s, a, k) => s + a * B[k][j], 0)));
}
function add(A, B) {
  return A.map((row, i) => row.map((a, j) => a + B[i][j]));
}
