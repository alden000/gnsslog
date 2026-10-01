// Compass deviation learned from GNSS course over ground.
//
// A magnet or steel near the phone (MagSafe ring, mount, speaker, engine) bends the field the
// magnetometer sees. Because it moves with the phone, the error depends on the heading:
//   deviation(θ) ≈ A + B·sinθ + C·cosθ + D·sin2θ + E·cos2θ      (classic ship's-compass model)
// A: constant offset; B, C: hard iron (permanent magnets); D, E: soft iron (steel).
// While the vessel runs straight and fast, GNSS course ≈ true heading, so each such second
// gives one observation of the deviation at the current compass heading. The coefficients are
// estimated with a small Kalman filter (random-walk coefficients, Gaussian prior around zero).

import { D2R, wrap180 } from './geo.js';

const KEY = 'gnsslog.deviation';
const PRIOR = [20 ** 2, 15 ** 2, 15 ** 2, 6 ** 2, 6 ** 2]; // deg^2
const Q = PRIOR.map((p) => p * 2e-5); // slow drift per update
const R = 12 ** 2; // per-observation noise (COG vs heading: waves, crab, GNSS noise)

export class DeviationEstimator {
  constructor() {
    this.reset(false);
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && s.theta?.length === 5 && s.P?.length === 5) Object.assign(this, s);
    } catch {}
  }

  reset(save = true) {
    this.theta = [0, 0, 0, 0, 0];
    this.P = PRIOR.map((p, i) => PRIOR.map((_, j) => (i === j ? p : 0)));
    this.n = 0; // accepted observations (≈ seconds of straight running)
    this.headingsSeen = 0; // bitmask of 8 heading sectors observed
    this.updatedAt = null;
    if (save) this.save();
  }

  save() {
    try {
      const { theta, P, n, headingsSeen, updatedAt } = this;
      localStorage.setItem(KEY, JSON.stringify({ theta, P, n, headingsSeen, updatedAt }));
    } catch {}
  }

  static features(magDeg) {
    const t = magDeg * D2R;
    return [1, Math.sin(t), Math.cos(t), Math.sin(2 * t), Math.cos(2 * t)];
  }

  /** Correction (deg) to add to a raw magnetic heading. */
  correction(magDeg) {
    if (!Number.isFinite(magDeg)) return 0;
    const f = DeviationEstimator.features(magDeg);
    return f.reduce((s, v, i) => s + v * this.theta[i], 0);
  }

  /** Observation: observed deviation (deg) = true course - known offsets - raw magnetic heading. */
  update(magDeg, observed) {
    const f = DeviationEstimator.features(magDeg);
    const y = wrap180(observed - this.correction(magDeg));
    if (Math.abs(y) > 50) return false; // crab angle, a turn, or a bad fix
    for (let i = 0; i < 5; i++) this.P[i][i] += Q[i];
    const Pf = this.P.map((row) => row.reduce((s, v, j) => s + v * f[j], 0));
    const S = f.reduce((s, v, i) => s + v * Pf[i], 0) + R;
    const K = Pf.map((v) => v / S);
    for (let i = 0; i < 5; i++) this.theta[i] += K[i] * y;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) this.P[i][j] -= K[i] * Pf[j];
    this.n++;
    this.headingsSeen |= 1 << Math.floor((((magDeg % 360) + 360) % 360) / 45);
    this.updatedAt = Date.now();
    if (this.n % 10 === 0) this.save();
    return true;
  }

  /** Number of 45° heading sectors with data (more sectors → better heading-dependent fit). */
  get sectors() {
    let c = 0;
    for (let b = this.headingsSeen; b; b >>= 1) c += b & 1;
    return c;
  }
}
