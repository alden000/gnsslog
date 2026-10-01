// Detects when the phone is lying still, so the gyro's own reading can be taken as its bias.
//
// The heading filter otherwise learns gyro bias only from the compass, which is deliberately
// slow (magnetic disturbances must not be mistaken for bias), leaving a residual of ~0.1 deg/s
// in the rate of turn. When the phone is truly still the mean gyro rate *is* the bias, so we
// measure it directly ("zero-rate update").
//
// Data is collected in 1 s bins; the last WINDOW bins must all be quiet:
//   - yaw rate scatter within each bin is small (no vibration / handling),
//   - the mean rate is small (a real turn is not mistaken for bias),
//   - the compass heading barely changes between the first and last bins (catches a slow
//     real turn that the gyro alone could not tell apart from bias).

import { wrap180 } from './geo.js';

const D2R = Math.PI / 180;

export class StillDetector {
  constructor({ window = 10, maxSd = 0.3, maxMean = 0.5, maxCompassDrift = 1.5, binMs = 1000 } = {}) {
    Object.assign(this, { window, maxSd, maxMean, maxCompassDrift, binMs });
    this.reset();
  }

  reset() {
    this.bins = [];
    this.cur = null;
    this.still = false;
    this.pending = false;
  }

  _bin(t) {
    if (this.cur && t - this.cur.t0 >= this.binMs) {
      this.bins.push(this.cur);
      if (this.bins.length > this.window) this.bins.shift();
      this.cur = null;
      this.pending = true; // a bin closed: evaluate on the next rate sample
    }
    if (this.cur && t < this.cur.t0) this.reset(); // clock went backwards
    if (!this.cur) this.cur = { t0: t, n: 0, s: 0, ss: 0, cs: 0, cc: 0, cn: 0 };
    return this.cur;
  }

  addCompass(t, mag) {
    if (!Number.isFinite(mag)) return;
    const b = this._bin(t);
    b.cs += Math.sin(mag * D2R);
    b.cc += Math.cos(mag * D2R);
    b.cn++;
  }

  /**
   * Add one yaw-rate sample (deg/s). Returns { mean, varMean } once per closed bin while the
   * phone has been still for the whole window, otherwise null.
   */
  addRate(t, rate) {
    if (!Number.isFinite(rate)) return null;
    const b = this._bin(t);
    b.n++;
    b.s += rate;
    b.ss += rate * rate;
    if (!this.pending) return null;
    this.pending = false;
    return this._evaluate();
  }

  _evaluate() {
    const bins = this.bins;
    this.still = false;
    if (bins.length < this.window) return null;
    // Bins must be back to back (no gaps from the app being paused).
    if (bins[bins.length - 1].t0 - bins[0].t0 > (this.window - 1) * this.binMs * 1.5) return null;
    let n = 0, s = 0, ss = 0;
    for (const b of bins) {
      if (b.n < 5) return null;
      const m = b.s / b.n;
      const v = Math.max(b.ss / b.n - m * m, 0);
      if (Math.sqrt(v) > this.maxSd) return null;
      n += b.n;
      s += b.s;
      ss += b.ss;
    }
    const mean = s / n;
    if (Math.abs(mean) > this.maxMean) return null;
    const first = bins[0], last = bins[bins.length - 1];
    if (first.cn && last.cn) {
      const h0 = Math.atan2(first.cs, first.cc) / D2R;
      const h1 = Math.atan2(last.cs, last.cc) / D2R;
      if (Math.abs(wrap180(h1 - h0)) > this.maxCompassDrift) return null;
    }
    this.still = true;
    const v = Math.max(ss / n - mean * mean, 0);
    return { mean, varMean: v / n };
  }
}
