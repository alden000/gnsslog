// Sensor fusion: turns raw sensor events into a single vessel state.
//
// Heading: HeadingKF integrates the gyro yaw rate and is corrected by the magnetometer
//          heading (converted to true with the configured declination). With no compass
//          the GNSS course over ground is used while making way.
// Position/velocity: PositionKF in a local East/North frame anchored at the first fix.

import { LocalFrame, haversine, bearingXY, wrap360, wrap180 } from './geo.js';
import { HeadingKF, PositionKF } from './filters.js';
import { headingFromOrientation, headingRateFromGyro } from './attitude.js';

const COMPASS_MIN_INTERVAL = 100; // ms: ~10 Hz compass corrections (samples are correlated)
const GYRO_STALE = 500; // ms
const COMPASS_STALE = 3000; // ms
const COG_MIN_SPEED = 1.0; // m/s: below this GNSS course is noise

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
    this.headingSource = 'none'; // compass | cog | gyro | none
    this.iosAlphaOffset = null; // iOS: alpha is not north-referenced; offset from compass
    this.skyhook = null; // { lat, lon, x, y, t, acc }
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
    this.pkf.updatePosition(fix.t, x, y, acc * acc);

    if (fix.speed !== null) {
      const velVar = Math.max(0.15, 0.03 * acc) ** 2;
      if (fix.speed < 0.3) {
        this.pkf.updateVelocity(fix.t, 0, 0, Math.max(velVar, 0.3 ** 2));
      } else if (fix.cog !== null) {
        const c = (fix.cog * Math.PI) / 180;
        this.pkf.updateVelocity(fix.t, fix.speed * Math.sin(c), fix.speed * Math.cos(c), velVar);
      }
    }

    // Course over ground as a heading fallback when there is no magnetometer.
    if (fix.t - this.compassT > COMPASS_STALE && fix.speed > COG_MIN_SPEED && fix.cog !== null) {
      this._propagate(fix.t);
      this.hkf.update(fix.cog, 15 * 15);
      this.headingSource = 'cog';
    }
  }

  onOrientation(o) {
    if (!Number.isFinite(o.beta) || !Number.isFinite(o.gamma)) return;
    this.att = { alpha: o.alpha, beta: o.beta, gamma: o.gamma, t: o.t };

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

    const mag = headingFromOrientation(alphaAbs, o.beta, o.gamma, this.settings.get('mount'));
    if (mag === null) return;
    this.magHeadingRaw = mag;
    if (o.t - this.compassT < COMPASS_MIN_INTERVAL) return;
    this.compassT = o.t;

    const trueHdg = wrap360(mag + this.settings.get('declination') + this.settings.get('headingOffset'));
    const sd = o.compassAcc > 0 ? Math.max(this.settings.get('compassSigma'), o.compassAcc) : this.settings.get('compassSigma');
    this._propagate(o.t);
    this.hkf.update(trueHdg, sd * sd);
    this.headingSource = 'compass';
  }

  onMotion(m) {
    if (!this.att) return; // need beta/gamma to project the rates onto the vertical
    let rate = headingRateFromGyro(m.rot, this.att.beta, this.att.gamma);
    if (rate === null) return;
    if (this.settings.get('invertGyro')) rate = -rate;
    this.gyroRate = rate;
    this.gyroT = m.t;
    this.hkf.propagate(m.t, rate);
  }

  _propagate(t) {
    const gyroFresh = t - this.gyroT < GYRO_STALE;
    this.hkf.propagate(t, gyroFresh ? this.gyroRate : null);
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
      hdgRate: this.hkf.initialized ? this.hkf.rate : null,
      hdgSrc: this.hkf.initialized ? (t - this.compassT < COMPASS_STALE ? 'compass' : this.headingSource) : 'none',
      gyroBias: this.hkf.initialized ? this.hkf.bias : null,
      gyroRate: t - this.gyroT < GYRO_STALE ? this.gyroRate : null,
      compass: this.magHeadingRaw,
      pitch: this.att ? this.att.beta : null,
      roll: this.att ? this.att.gamma : null,
      gnss: g,
      gnssAge: g ? t - g.t : null,
      sky: null,
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
