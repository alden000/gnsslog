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

const COMPASS_MIN_INTERVAL = 100; // ms: ~10 Hz compass corrections (samples are correlated)
const GYRO_STALE = 500; // ms
const COMPASS_STALE = 3000; // ms
const COG_MIN_SPEED = 1.0; // m/s: below this GNSS course is noise
const DEV_MIN_SPEED = 2.0; // m/s (~4 kn): learn compass deviation only when making way
const DEV_MAX_TURN = 3; // deg/s: ...and running straight

export class Fusion extends EventTarget {
  constructor(settings) {
    super();
    this.settings = settings;
    this.hkf = new HeadingKF();
    this.pkf = new PositionKF();
    this.frame = null;
    this.gnss = null; // last raw fix
    this.att = null; // last { alpha, beta, gamma, t }
    this.magHeadingRaw = null; // last magnetometer heading of the mount (magnetic, deg)
    this.compassT = 0;
    this.gyroT = 0;
    this.gyroRate = null; // last raw heading rate from the gyro, deg/s
    this.rateLP = null; // low-pass filtered, bias-corrected rate of turn, deg/s
    this.headingSource = 'none'; // compass | cog | gyro | none
    this.iosAlphaOffset = null; // iOS: alpha is not north-referenced; offset from compass
    this.skyhook = null; // { lat, lon, x, y, t, acc }
    this.magAccuracy = null;
    this.mountMode = null; // flat | upright actually in use (resolves the 'auto' setting) // Android: magnetometer calibration 0 (unreliable) .. 3 (high)
    this.dev = new DeviationEstimator();
    this.magSum = { s: 0, c: 0, n: 0 }; // circular mean of raw compass since the last fix
    this.prevCog = null;
    this.devResidual = null; // last (COG - corrected compass), for diagnostics
    this._restoreSkyhook();
  }

  // ---------------------------------------------------------------- inputs

  onGnss(fix) {
    if (!this.frame) {
      this.frame = new LocalFrame(fix.lat, fix.lon);
      if (this.skyhook) Object.assign(this.skyhook, this.frame.toXY(this.skyhook.lat, this.skyhook.lon));
      this._emit('frame', { lat: fix.lat, lon: fix.lon });
    }
    this.gnss = fix;
    const { x, y } = this.frame.toXY(fix.lat, fix.lon);
    const acc = Math.max(fix.acc || 10, 1);
    // Reported accuracy is a ~68% horizontal radius; per-axis 1-sigma is about 0.7 of it.
    this.pkf.updatePosition(fix.t, x, y, (0.7 * acc) ** 2);

    if (fix.speed !== null) {
      // Phone GNSS velocity is smoothed by the chipset; trusting it too much makes the
      // track integrate velocity and drift metres away from the fixes (seen in field logs).
      const velVar = Math.max(0.5, 0.1 * acc) ** 2;
      if (fix.speed < 0.3) {
        this.pkf.updateVelocity(fix.t, 0, 0, Math.max(velVar, 0.3 ** 2));
      } else if (fix.cog !== null) {
        const c = (fix.cog * Math.PI) / 180;
        this.pkf.updateVelocity(fix.t, fix.speed * Math.sin(c), fix.speed * Math.cos(c), velVar);
      }
    }

    this._learnDeviation(fix);

    // Course over ground as a heading fallback when there is no magnetometer.
    if (fix.t - this.compassT > COMPASS_STALE && fix.speed > COG_MIN_SPEED && fix.cog !== null) {
      this._propagate(fix.t);
      this.hkf.update(fix.cog, 15 * 15);
      this.headingSource = 'cog';
    }
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
    const corrected = rate - (this.hkf.initialized ? this.hkf.bias : 0);
    const tau = Math.max(0.05, this.settings.get('rateSmoothing'));
    if (this.rateLP === null || !(dt > 0) || dt > 1) this.rateLP = corrected;
    else this.rateLP += (1 - Math.exp(-dt / tau)) * (corrected - this.rateLP);
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
    if (this.skyhook) Object.assign(this.skyhook, this.frame.toXY(this.skyhook.lat, this.skyhook.lon));
    this._emit('frame', { lat, lon });
  }

  // ---------------------------------------------------------------- skyhook

  markSkyhook(t = Date.now()) {
    const s = this.state(t);
    if (!s.hasFix) return null;
    this.skyhook = { lat: s.lat, lon: s.lon, x: s.x, y: s.y, t, acc: s.acc };
    this._saveSkyhook();
    this._emit('skyhook', this.skyhook);
    return this.skyhook;
  }

  clearSkyhook() {
    this.skyhook = null;
    this._saveSkyhook();
    this._emit('skyhook', null);
  }

  _saveSkyhook() {
    try {
      if (this.skyhook) localStorage.setItem('gnsslog.skyhook', JSON.stringify(this.skyhook));
      else localStorage.removeItem('gnsslog.skyhook');
    } catch {}
  }

  _restoreSkyhook() {
    try {
      const s = JSON.parse(localStorage.getItem('gnsslog.skyhook') || 'null');
      if (s && Number.isFinite(s.lat)) this.skyhook = { ...s, x: NaN, y: NaN };
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
      gyroRate: t - this.gyroT < GYRO_STALE ? this.gyroRate : null,
      compass: this.magHeadingRaw,
      mount: this.mountMode,
      compassDev: this.settings.get('autoDeviation') && this.magHeadingRaw !== null ? this.dev.correction(this.magHeadingRaw) : 0,
      pitch: this.att ? this.att.beta : null,
      roll: this.att ? this.att.gamma : null,
      gnss: g,
      gnssAge: g ? t - g.t : null,
      sky: null,
      skySpot: this.skyhook ? { lat: this.skyhook.lat, lon: this.skyhook.lon } : null,
    };
    if (hasFix) {
      out.x = p.x;
      out.y = p.y;
      out.vx = p.vx;
      out.vy = p.vy;
      const ll = this.frame.toLatLon(p.x, p.y);
      out.lat = ll.lat;
      out.lon = ll.lon;
      out.sog = Math.hypot(p.vx, p.vy);
      out.cog = out.sog > 0.2 ? bearingXY(p.vx, p.vy) : null;
    }
    if (hasFix && this.skyhook && Number.isFinite(this.skyhook.x)) {
      const dx = out.x - this.skyhook.x;
      const dy = out.y - this.skyhook.y;
      out.sky = {
        ...this.skyhook,
        dist: Math.hypot(dx, dy),
        distGeo: haversine(this.skyhook.lat, this.skyhook.lon, out.lat, out.lon),
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
