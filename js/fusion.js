// Sensor fusion: turns raw sensor events into a single vessel state.
//
// Heading: HeadingKF integrates the gyro yaw rate and is corrected by the magnetometer
//          heading (converted to true with the configured declination). With no compass
//          the GNSS course over ground is used while making way.
// Position/velocity: PositionKF in a local East/North frame anchored at the first fix.

import { LocalFrame, haversine, bearingXY, wrap360, wrap180 } from './geo.js';
import { HeadingKF, PositionKF } from './filters.js';
import { headingFromOrientation, headingFromMatrix, betaGammaFromMatrix, headingRateFromUp, upInDevice, autoMountMode } from './attitude.js';
import { DeviationEstimator } from './deviation.js';
import { StillDetector } from './still.js';

const COMPASS_MIN_INTERVAL = 100; // ms: ~10 Hz compass corrections (samples are correlated)
const GYRO_STALE = 500; // ms
const COMPASS_STALE = 3000; // ms
const COG_MIN_SPEED = 1.0; // m/s: below this GNSS course is noise
const DEV_MIN_SPEED = 2.0; // m/s (~4 kn): learn compass deviation only when making way
const DEV_MAX_TURN = 3; // deg/s: ...and running straight
const STILL_MAX_SPEED = 0.5; // m/s: GNSS must agree the phone is not moving before a zero-rate update
const ZERO_RATE_SIGMA = 0.02; // deg/s: floor on the zero-rate bias measurement
const ZUPT_SIGMA = 0.05; // m/s: lying still also means not moving (zero-velocity update)
const FIX_DUP_MS = 150; // fixes this close to (or older than) the last applied one are dropped
const MAX_LATENCY_S = 3; // fixes up to this old are projected to the present with the filter velocity
const COURSE_LAG_S = 1; // the chipset's course lags the turn by about this much
const TURN_SPEED_ONLY = 5; // deg/s: turning faster than this, the course is not used (speed only)
const TURN_MEM_S = 2; // s: ...and keeps catching up for about this long after the turn ends
const VEL_GATE = 16; // chi-square (2 dof, ~0.03%): a velocity this inconsistent is not used
const VEL_CHECK_TOL = 2; // m/s: chipset velocity vs fix-to-fix movement, plus a share of the accuracy
const STILL_POOR_ACC = 15;
const STEER_AFTER_MS = 0; // steer the predicted track with the gyro from the start (corners, outages)
const STEER_MAX_MS = 20000; // ...but not beyond this (gyro and speed both drift)
const STEER_MIN_SPEED = 1.5; // m/s: driving, not a phone turning in the hand
const STEER_RATE_SIGMA = 1; // deg/s: assumed error of the gyro rate of turn while steering
const SNAP_TAU_MS = 300; // ms: a fix's correction is blended into the output over ~this, not in one step
const SNAP_MAX = 15; // m: bigger corrections are real jumps (reacquisition) and are shown at once
const STEER_FIX_ACC = 30; // m: fixes worse than this (car parks, tunnels) do not count as fixes here // m: while still, fixes worse than this barely move the position

export class Fusion extends EventTarget {
  constructor(settings) {
    super();
    this.settings = settings;
    this.hkf = new HeadingKF();
    this.pkf = new PositionKF();
    this.frame = null;
    this.gnss = null; // last raw fix
    this.snap = null; // { t, dx, dy }: output offset blending out the last fix's correction
    this.lastFixT = null; // fixT of the last fix applied
    this.prevFix = null; // { t: fixT, x, y, acc } of the last fix, for the velocity check
    this.goodFixT = 0; // data time the last usable fix was applied (gyro steering in between)
    this.steerT = 0; // last gyro steering step
    this.steerOk = false; // the last usable fix said we were driving
    this.turn = 0; // gyro heading change since that fix, deg
    this._steerAfter = STEER_AFTER_MS;
    this._snapTau = SNAP_TAU_MS;
    this.steered = 0; // ...of which already applied to the velocity
    this.att = null; // last { alpha, beta, gamma, t }
    this.magHeadingRaw = null; // last magnetometer heading of the mount (magnetic, deg)
    this.compassT = 0;
    this.gyroT = 0;
    this.gyroRate = null; // last raw heading rate from the gyro, deg/s
    this.rateLP = null; // low-pass filtered, bias-corrected rate of turn, deg/s
    this.turnMem = 0; // recent peak |rate of turn|, deg/s
    this.yaw = 0; // integrated gyro heading, deg (only differences matter)
    this.yawHist = []; // [t, yaw] over the last 4 s
    this.headingSource = 'none'; // compass | cog | gyro | none
    this.iosAlphaOffset = null; // iOS: alpha is not north-referenced; offset from compass
    this.mark = null; // { lat, lon, x, y, t, acc }
    this.magAccuracy = null;
    this.mountMode = null; // flat | upright actually in use (resolves the 'auto' setting) // Android: magnetometer calibration 0 (unreliable) .. 3 (high)
    this.dev = new DeviationEstimator();
    this.stillDet = new StillDetector();
    this.stillT = 0; // last zero-rate (still) bias update
    this.magSum = { s: 0, c: 0, n: 0 }; // circular mean of raw compass since the last fix
    this.prevCog = null;
    this.devResidual = null; // last (COG - corrected compass), for diagnostics
    this._restoreMark();
  }

  // ---------------------------------------------------------------- inputs

  onGnss(fix) {
    // The background service and the in-app watcher both deliver the phone's fixes, with
    // slightly different timestamps: keep one monotonic stream.
    const fixT = Number.isFinite(fix.fixT) ? fix.fixT : fix.t;
    if (this.lastFixT !== null && fixT <= this.lastFixT + FIX_DUP_MS) return;
    this.lastFixT = fixT;
    if (!this.frame) {
      this.frame = new LocalFrame(fix.lat, fix.lon);
      if (this.mark) Object.assign(this.mark, this.frame.toXY(this.mark.lat, this.mark.lon));
      this._emit('frame', { lat: fix.lat, lon: fix.lon });
    }
    this.gnss = fix;
    const pkf = this.pkf;
    // Applied at its arrival (or later, if the filter is already past it), but it describes
    // where the phone was at fixT: ~1.1 s earlier on the phone's fused provider. Project it to
    // the present with the filter's velocity, or the track lags and overshoots at every change.
    const t = pkf.initialized ? Math.max(fix.t, pkf.t) : fix.t;
    pkf.predict(t);
    const lag = Math.max(0, (t - fixT) / 1000);
    let { x, y } = this.frame.toXY(fix.lat, fix.lon);
    const acc = Math.max(fix.acc || 10, 1);
    const moved = this._fixVelocity(fixT, x, y, acc);
    // Reported accuracy is a ~68% horizontal radius; per-axis 1-sigma is about 0.7 of it.
    let r = (0.7 * acc) ** 2;
    if (!pkf.initialized) {
      // Start moving: from the fix's own velocity, projected to the present like any other fix.
      const c = fix.cog !== null && fix.speed > 0 ? (fix.cog * Math.PI) / 180 : null;
      const vx = c === null ? 0 : fix.speed * Math.sin(c);
      const vy = c === null ? 0 : fix.speed * Math.cos(c);
      const l = Math.min(lag, MAX_LATENCY_S);
      pkf.init(t, x + vx * l, y + vy * l, r, vx, vy);
    } else {
      if (lag > 0) {
        const l = Math.min(lag, MAX_LATENCY_S);
        // Along the arc the gyro saw since fixT, not a straight line: on the mid-way course.
        const back = (-this._turnSince(t - l * 1000) / 2) * (Math.PI / 180);
        const c = Math.cos(back), sn = Math.sin(back);
        x += (c * pkf.x[2] + sn * pkf.x[3]) * l;
        y += (-sn * pkf.x[2] + c * pkf.x[3]) * l;
        r += ((pkf.P[2][2] + pkf.P[3][3]) / 2) * l * l + (lag - l) ** 2; // stale beyond that: ~1 m/s unknown motion
      }
      if (t - this.stillT < 3000 && acc > STILL_POOR_ACC) r *= 4; // lying still: Wi-Fi fixes indoors wander by tens of metres
      const before = this._snapOffset(t);
      const [bx, by] = [pkf.x[0] + before.dx, pkf.x[1] + before.dy];
      pkf.updatePosition(t, x, y, r);
      this._holdSnap(t, bx, by);
    }

    if (fix.speed !== null && lag <= MAX_LATENCY_S) {
      // Phone GNSS velocity is smoothed by the chipset; trusting it too much makes the
      // track integrate velocity and drift metres away from the fixes (seen in field logs).
      // Its course also lags in turns (by ~90 deg at a corner in field logs): allow for the
      // turn the gyro sees, and drop a velocity that disagrees with the track outright.
      // the course still lags for a second or two after the turn ends: use the recent turning
      const turning = t - this.gyroT < GYRO_STALE ? this.turnMem : 0;
      const courseErr = Math.min(turning * (lag + COURSE_LAG_S), 90) * (Math.PI / 180);
      const velVar = (Math.max(0.5, 0.1 * acc) + 0.05 * fix.speed) ** 2 + (fix.speed * Math.sin(courseErr)) ** 2;
      let v = null;
      if (fix.speed < 0.3) v = [0, 0];
      else if (fix.cog !== null) {
        const c = (fix.cog * Math.PI) / 180;
        v = [fix.speed * Math.sin(c), fix.speed * Math.cos(c)];
      }
      // Field logs show the course off by ~90 deg for 10 s on a straight road (gyro at zero):
      // a velocity the fixes themselves contradict is not used.
      if (v && moved && Math.hypot(v[0] - moved.vx, v[1] - moved.vy) > moved.tol) v = null;
      // In and just after a turn the course lags by tens of degrees and drags the track back
      // (it finished corners ~15 deg short, then caught up with 2 m jumps). There only the speed
      // is used, on the filter's own course; the gyro and the positions handle the direction.
      const fv = Math.hypot(pkf.x[2], pkf.x[3]);
      if (v && fix.speed >= 0.3 && turning > TURN_SPEED_ONLY && fv > 0.5) v = [(pkf.x[2] / fv) * fix.speed, (pkf.x[3] / fv) * fix.speed];
      if (v) {
        const before = this._snapOffset(t);
        const [bx, by] = [pkf.x[0] + before.dx, pkf.x[1] + before.dy];
        pkf.updateVelocity(t, v[0], v[1], fix.speed < 0.3 ? Math.max(velVar, 0.3 ** 2) : velVar, VEL_GATE);
        this._holdSnap(t, bx, by);
      }
    }

    // Steering needs a real GNSS fix (it reports a speed; Wi-Fi positions indoors do not) that
    // says we were driving just before the fixes stopped.
    if (acc <= STEER_FIX_ACC && fix.speed !== null) {
      this.goodFixT = t;
      this.steerOk = fix.speed > STEER_MIN_SPEED;
      this.turn = this.steered = 0;
    }
    this._learnDeviation(fix);

    // Course over ground as a heading fallback when there is no magnetometer.
    if (fix.t - this.compassT > COMPASS_STALE && fix.speed > COG_MIN_SPEED && fix.cog !== null) {
      this._propagate(fix.t);
      this.hkf.update(fix.cog, 15 * 15);
      this.headingSource = 'cog';
    }
  }

  /**
   * A fix moves the filter's position in one go, which draws a kink every second in corners.
   * The output keeps the position where it was and lets the difference decay over ~0.5 s;
   * the filter itself is unchanged. Large corrections (reacquiring after an outage) show at once.
   */
  _holdSnap(t, bx, by) {
    const dx = bx - this.pkf.x[0], dy = by - this.pkf.x[1];
    this.snap = Math.hypot(dx, dy) > SNAP_MAX ? null : { t, dx, dy };
  }

  /** Remaining output offset at t. */
  _snapOffset(t) {
    const s = this.snap;
    if (!s || t < s.t) return { dx: 0, dy: 0 };
    const k = Math.exp(-(t - s.t) / this._snapTau);
    return { dx: s.dx * k, dy: s.dy * k };
  }

  /** Gyro heading change (deg, clockwise) from time t0 until now, from the last few seconds. */
  _turnSince(t0) {
    const h = this.yawHist;
    if (!h.length || t0 >= h[h.length - 1][0]) return 0;
    let i = h.length - 1;
    while (i > 0 && h[i - 1][0] > t0) i--;
    return h[h.length - 1][1] - h[Math.max(0, i - 1)][1];
  }

  /** Velocity from the previous fix to this one, when both are recent and good enough to judge by. */
  _fixVelocity(fixT, x, y, acc) {
    const p = this.prevFix;
    this.prevFix = { t: fixT, x, y, acc };
    if (!p) return null;
    const dt = (fixT - p.t) / 1000;
    if (!(dt >= 0.5 && dt <= 2.5) || acc > 20 || p.acc > 20) return null;
    // Consecutive fixes share most of their error, so the movement between them is much
    // better than either accuracy figure suggests.
    return { vx: (x - p.x) / dt, vy: (y - p.y) / dt, tol: VEL_CHECK_TOL + (0.2 * (acc + p.acc)) / dt };
  }

  _learnDeviation(fix) {
    const m = this.magSum;
    this.magSum = { s: 0, c: 0, n: 0 };
    const cog = fix.cog;
    const prev = this.prevCog;
    this.prevCog = cog;
    if (!m.n || cog === null || !(fix.speed > DEV_MIN_SPEED) || !(fix.acc < 20)) return;
    if (fix.t - this.compassT > 1000) return;
    if (prev === null || Math.abs(wrap180(cog - prev)) > 5) return; // course changing
    if (this.rateLP !== null && Math.abs(this.rateLP) > DEV_MAX_TURN) return;
    const mag = wrap360((Math.atan2(m.s, m.c) * 180) / Math.PI);
    const offsets = this.settings.get('declination') + this.settings.get('headingOffset');
    this.devResidual = wrap180(cog - offsets - mag - this.dev.correction(mag));
    if (this.settings.get('autoDeviation')) this.dev.update(mag, wrap180(cog - offsets - mag));
  }

  resetDeviation() {
    this.dev.reset();
    this.devResidual = null;
    this.hkf.reset();
  }

  onOrientation(o) {
    if (!Number.isFinite(o.beta) || !Number.isFinite(o.gamma)) return;
    this.att = { alpha: o.alpha, beta: o.beta, gamma: o.gamma, t: o.t, up: upInDevice(o.beta, o.gamma) };

    let alphaAbs = null;
    if (o.compass !== null && Number.isFinite(o.alpha)) {
      // iOS: webkitCompassHeading is the magnetic heading of the top edge. Turn it into an
      // alpha offset so the full attitude (and any mounting) can be used. Refresh only when
      // the phone is near level, where that heading is well defined.
      const flat = Math.abs(o.beta) < 35 && Math.abs(o.gamma) < 35;
      const off = wrap360(360 - o.compass - o.alpha);
      if (this.iosAlphaOffset === null) this.iosAlphaOffset = off;
      else if (flat) this.iosAlphaOffset = wrap360(this.iosAlphaOffset + 0.1 * wrap180(off - this.iosAlphaOffset));
      alphaAbs = wrap360(o.alpha + this.iosAlphaOffset);
    } else if (o.absolute && Number.isFinite(o.alpha)) {
      alphaAbs = o.alpha;
    }
    if (alphaAbs === null) return;

    const mode = this._mountFor(this.att.up[2]);
    this._compass(o.t, headingFromOrientation(alphaAbs, o.beta, o.gamma, mode), o.compassAcc);
  }

  /**
   * Android app: attitude matrix + gyro from the native VesselSensors plugin (keeps working in
   * the background). R is device → East/North/Up, gyro is deg/s in device axes.
   */
  onNativeMotion(e) {
    if (e.R) {
      const R = [e.R.slice(0, 3), e.R.slice(3, 6), e.R.slice(6, 9)];
      const { beta, gamma } = betaGammaFromMatrix(R);
      this.att = { alpha: null, beta, gamma, t: e.t, up: R[2] };
      this.magAccuracy = e.magAccuracy ?? null;
      this._compass(e.t, headingFromMatrix(R, this._mountFor(R[2][2])), e.headingAcc);
    }
    // Native gyro is [x, y, z]; rotationRate convention is alpha = x, beta = y, gamma = z.
    if (e.gyro) this.onMotion({ t: e.t, rot: { alpha: e.gyro[0], beta: e.gyro[1], gamma: e.gyro[2] } });
  }

  /** Mount actually used for this attitude: the setting, or flat/upright chosen from tilt for 'auto'. */
  _mountFor(upZ) {
    const m = this.settings.get('mount');
    this.mountMode = m === 'flat' || m === 'upright' ? m : autoMountMode(upZ, this.mountMode);
    return this.mountMode;
  }

  /** One magnetometer heading (magnetic, deg) of the mount; accDeg = sensor's own accuracy estimate. */
  _compass(t, mag, accDeg) {
    if (mag === null) return;
    this.magHeadingRaw = mag;
    this.stillDet.addCompass(t, mag);
    this.magSum.s += Math.sin((mag * Math.PI) / 180);
    this.magSum.c += Math.cos((mag * Math.PI) / 180);
    this.magSum.n++;
    if (t - this.compassT < COMPASS_MIN_INTERVAL) return;
    this.compassT = t;

    const dev = this.settings.get('autoDeviation') ? this.dev.correction(mag) : 0;
    const trueHdg = wrap360(mag + dev + this.settings.get('declination') + this.settings.get('headingOffset'));
    const sd = accDeg > 0 ? Math.max(this.settings.get('compassSigma'), accDeg) : this.settings.get('compassSigma');
    this._propagate(t);
    this.hkf.update(trueHdg, sd * sd);
    this.headingSource = 'compass';
  }

  onMotion(m) {
    if (!this.att) return; // need beta/gamma to project the rates onto the vertical
    let rate = headingRateFromUp(m.rot, this.att.up);
    if (rate === null) return;
    if (this.settings.get('invertGyro')) rate = -rate;
    const dt = this.gyroT ? (m.t - this.gyroT) / 1000 : 0;
    this.gyroRate = rate;
    this.gyroT = m.t;
    // The filter integrates every raw sample (integration averages vibration out). The rate
    // of turn we report is low-passed: one raw sample at 60 Hz mostly shows engine/hull
    // vibration, not the vessel turning.
    this.hkf.propagate(m.t, rate);
    this._zeroRate(m.t, rate);
    const corrected = rate - (this.hkf.initialized ? this.hkf.bias : 0);
    this._steer(m.t, corrected);
    // |rate of turn| over the last ~2 s (decaying peak), for how far the chipset course may lag
    if (dt > 0 && dt <= 1) {
      this.yaw += corrected * dt;
      this.yawHist.push([m.t, this.yaw]);
      while (this.yawHist.length && m.t - this.yawHist[0][0] > 4000) this.yawHist.shift();
    }
    this.turnMem = dt > 0 && dt <= 1 ? Math.max(Math.abs(corrected), this.turnMem * Math.exp(-dt / TURN_MEM_S)) : Math.abs(corrected);
    const tau = Math.max(0.05, this.settings.get('rateSmoothing'));
    if (this.rateLP === null || !(dt > 0) || dt > 1) this.rateLP = corrected;
    else this.rateLP += (1 - Math.exp(-dt / tau)) * (corrected - this.rateLP);
  }

  /**
   * GNSS outage while driving (car park ramps, tunnels): the position filter would carry on in a
   * straight line at the last velocity. Turn that velocity with the gyro's rate of turn instead
   * (deg/s, clockwise positive), so the coasting track follows the turns.
   */
  _steer(t, rate) {
    const dt = this.steerT ? (t - this.steerT) / 1000 : 0;
    this.steerT = t;
    if (!(dt > 0) || dt > 0.5) return;
    this.turn += rate * dt; // deg turned since the last usable fix
    const pkf = this.pkf;
    if (!pkf.initialized || !this.goodFixT || !this.steerOk) return;
    const gap = t - this.goodFixT;
    if (gap < this._steerAfter || gap > STEER_MAX_MS) return;
    if (Math.hypot(pkf.x[2], pkf.x[3]) < STEER_MIN_SPEED) return;
    pkf.predict(t); // the distance so far was covered on the old course
    // Catch up on the whole turn since the fix (the first step includes the wait), then follow it.
    const d = this.turn - this.steered;
    this.steered = this.turn;
    // ~1 deg/s of rate error (bias, mounting) becomes speed x that much sideways velocity error.
    const v = Math.hypot(pkf.x[2], pkf.x[3]);
    pkf.rotateVelocity(d * (Math.PI / 180), (v * STEER_RATE_SIGMA * (Math.PI / 180)) ** 2 * dt);
  }

  /** Lying still: the mean gyro rate is the bias, so feed it to the heading filter directly. */
  _zeroRate(t, rate) {
    const z = this.stillDet.addRate(t, rate);
    if (!z) return;
    const g = this.gnss;
    if (g && t - g.t < 5000 && g.speed !== null && g.speed > STILL_MAX_SPEED) return;
    this.stillT = t;
    // Not turning and not shaking for 10 s, and GNSS does not say otherwise: not moving either.
    // Without this, sparse indoor fixes 50 m apart give the track a false velocity to coast on.
    if (this.pkf.initialized) this.pkf.updateVelocity(t, 0, 0, ZUPT_SIGMA ** 2);
    this.hkf.updateBias(z.mean, z.varMean + ZERO_RATE_SIGMA ** 2);
  }

  _propagate(t) {
    const gyroFresh = t - this.gyroT < GYRO_STALE;
    this.hkf.propagate(t, gyroFresh ? this.gyroRate : null);
  }

  /**
   * Re-anchor the local x/y frame (used when resuming a session after the app was reopened,
   * so x/y keep the session's original origin). Resets the position filter.
   */
  setOrigin(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (this.frame && this.frame.lat0 === lat && this.frame.lon0 === lon) return;
    this.frame = new LocalFrame(lat, lon);
    this.pkf.reset();
    this.snap = null;
    this.lastFixT = null;
    this.prevFix = null;
    this.goodFixT = 0;
    if (this.mark) Object.assign(this.mark, this.frame.toXY(this.mark.lat, this.mark.lon));
    this._emit('frame', { lat, lon });
  }

  // ---------------------------------------------------------------- marked location

  markLocation(t = Date.now()) {
    const s = this.state(t);
    if (!s.hasFix) return null;
    this.mark = { lat: s.lat, lon: s.lon, x: s.x, y: s.y, t, acc: s.acc };
    this._saveMark();
    this._emit('mark', this.mark);
    return this.mark;
  }

  clearMark() {
    this.mark = null;
    this._saveMark();
    this._emit('mark', null);
  }

  _saveMark() {
    try {
      if (this.mark) localStorage.setItem('gnsslog.mark', JSON.stringify(this.mark));
      else localStorage.removeItem('gnsslog.mark');
    } catch {}
  }

  _restoreMark() {
    try {
      const s = JSON.parse(localStorage.getItem('gnsslog.mark') || localStorage.getItem('gnsslog.skyhook') || 'null');
      if (s && Number.isFinite(s.lat)) this.mark = { ...s, x: NaN, y: NaN };
    } catch {}
  }

  // ---------------------------------------------------------------- outputs

  /**
   * Advance the filters to t and return the full state. Used by the 5 Hz logger.
   */
  state(t = Date.now()) {
    this.pkf.predict(t);
    this._propagate(t);
    return this._compose(t, this.pkf.peek(t), this.hkf.peek(t));
  }

  /** Non-mutating state for smooth rendering between ticks. */
  peek(t = Date.now()) {
    return this._compose(t, this.pkf.peek(t), this.hkf.peek(t));
  }

  _compose(t, p, hdg) {
    const g = this.gnss;
    const hasFix = !!(p && this.frame);
    const out = {
      t,
      hasFix,
      lat: null, lon: null, x: null, y: null, vx: null, vy: null,
      sog: null, cog: null,
      acc: g ? g.acc : null,
      posSigma: hasFix ? this.pkf.sigmaPos : null,
      hdg,
      hdgMag: hdg === null ? null : wrap360(hdg - this.settings.get('declination')),
      hdgSigma: this.hkf.initialized ? this.hkf.sigma : null,
      hdgRate: !this.hkf.initialized ? null : t - this.gyroT < GYRO_STALE && this.rateLP !== null ? this.rateLP : this.hkf.rate,
      hdgSrc: this.hkf.initialized ? (t - this.compassT < COMPASS_STALE ? 'compass' : this.headingSource) : 'none',
      gyroBias: this.hkf.initialized ? this.hkf.bias : null,
      still: t - this.stillT < 2000,
      gyroRate: t - this.gyroT < GYRO_STALE ? this.gyroRate : null,
      compass: this.magHeadingRaw,
      mount: this.mountMode,
      compassDev: this.settings.get('autoDeviation') && this.magHeadingRaw !== null ? this.dev.correction(this.magHeadingRaw) : 0,
      pitch: this.att ? this.att.beta : null,
      roll: this.att ? this.att.gamma : null,
      gnss: g,
      gnssAge: g ? t - g.t : null,
      sky: null,
      markSpot: this.mark ? { lat: this.mark.lat, lon: this.mark.lon } : null,
    };
    if (hasFix) {
      const o = this._snapOffset(t);
      out.x = p.x + o.dx;
      out.y = p.y + o.dy;
      out.vx = p.vx;
      out.vy = p.vy;
      const ll = this.frame.toLatLon(out.x, out.y);
      out.lat = ll.lat;
      out.lon = ll.lon;
      out.sog = Math.hypot(p.vx, p.vy);
      out.cog = out.sog > 0.2 ? bearingXY(p.vx, p.vy) : null;
    }
    if (hasFix && this.mark && Number.isFinite(this.mark.x)) {
      const dx = out.x - this.mark.x;
      const dy = out.y - this.mark.y;
      out.sky = {
        ...this.mark,
        dist: Math.hypot(dx, dy),
        distGeo: haversine(this.mark.lat, this.mark.lon, out.lat, out.lon),
        // Bearing from the vessel back to the spot.
        brg: bearingXY(-dx, -dy),
        dx,
        dy,
      };
    }
    return out;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
