// Raw sensor access: GNSS (Geolocation API), orientation (magnetometer-referenced attitude)
// and motion (gyroscope). Emits 'gnss', 'orientation', 'motion' and 'status' events.
// In the Android app, GNSS comes from a background-capable location service and attitude/gyro
// from the native VesselSensors plugin ('nativeMotion' events), so logging survives the app
// being in the background.

import { isNative, plugin } from './native.js';

const isIOS =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class Sensors extends EventTarget {
  constructor() {
    super();
    this.watchId = null;
    this.running = false;
    this.status = {
      gnss: 'off', // off | waiting | ok | denied | error | unsupported
      gnssError: '',
      orientation: 'off', // off | waiting | ok | relative | denied | unsupported
      motion: 'off', // off | waiting | ok | denied | unsupported
    };
    this._onOrientation = this._onOrientation.bind(this);
    this._onMotion = this._onMotion.bind(this);
    this.lastOrientationT = 0;
    this.lastMotionT = 0;
  }

  /** iOS 13+ only grants motion/orientation from inside a user gesture. */
  get needsMotionPermission() {
    if (isNative) return false;
    return (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    );
  }

  /** Must be called from a click/tap handler (iOS motion permission). */
  async start() {
    this.running = true;
    const motion = this.startMotion(); // first, while the tap's user activation is fresh
    this.startGnss();
    await motion;
  }

  startGnss() {
    if (this.watchId !== null) return;
    this.running = true;
    if (isNative) {
      this.watchId = 'pending';
      this._startNativeGnss();
    } else this._startGnss();
  }

  async startMotion() {
    if (this.motionStarted) return;
    this.motionStarted = true;
    this.running = true;
    if (isNative) await this._startNativeMotion();
    else await this._startMotion();
  }

  /**
   * Android app: keep GNSS + sensors running with the screen off / app in the background
   * (foreground service with a notification, partial wake lock). Used while recording.
   */
  async setBackground(enabled) {
    if (!isNative || !!this.background === enabled) return;
    this.background = enabled;
    await plugin('VesselSensors').setBackground({ enabled }).catch(() => {});
    if (this.watchId !== null && this.watchId !== 'pending') this._restartNativeGnss();
    // A pending watcher re-checks the mode once it is registered.
  }

  async _restartNativeGnss() {
    const id = this.watchId;
    this.watchId = 'pending';
    await plugin('BackgroundGeolocation').removeWatcher({ id }).catch(() => {});
    this._startNativeGnss();
  }

  async _startNativeMotion() {
    const vs = plugin('VesselSensors');
    this._setStatus({ orientation: 'waiting', motion: 'waiting' });
    await vs.addListener('motion', (e) => {
      if (e.R && this.status.orientation !== 'ok') this._setStatus({ orientation: 'ok' });
      if (e.gyro && this.status.motion !== 'ok') this._setStatus({ motion: 'ok' });
      if (e.R) this.lastOrientationT = e.t;
      if (e.gyro) this.lastMotionT = e.t;
      this._emit('nativeMotion', e);
    });
    const has = await vs.start();
    // Tell the plugin JavaScript is alive; it holds live events back while we are frozen.
    clearInterval(this._ackTimer);
    this._ackTimer = setInterval(() => vs.ack().catch(() => {}), 1000);
    if (!has.rotation) this._setStatus({ orientation: 'unsupported' });
    if (!has.gyro) this._setStatus({ motion: 'unsupported' });
  }

  _startNativeGnss(attempt = 0) {
    const bg = plugin('BackgroundGeolocation');
    const background = !!this.background;
    this._setStatus({ gnss: 'waiting' });
    const opts = { requestPermissions: true, stale: false, distanceFilter: 0 };
    if (background) {
      opts.backgroundTitle = 'GNSS Log is recording';
      opts.backgroundMessage = 'Logging position and heading. Open the app to stop.';
    }
    bg.addWatcher(opts, (loc, err) => {
      if (err) {
        if (err.code === 'NOT_AUTHORIZED') this._setStatus({ gnss: 'denied', gnssError: err.message });
        else this._setStatus({ gnss: 'error', gnssError: err.message });
        return;
      }
      if (this.status.gnss !== 'ok') this._setStatus({ gnss: 'ok', gnssError: '' });
      this._emit('gnss', {
        t: Date.now(),
        fixT: loc.time,
        lat: loc.latitude,
        lon: loc.longitude,
        acc: loc.accuracy,
        alt: loc.altitude,
        altAcc: loc.altitudeAccuracy,
        speed: Number.isFinite(loc.speed) ? loc.speed : null,
        cog: Number.isFinite(loc.bearing) && loc.speed > 0 ? loc.bearing : null,
      });
    }).then(
      (id) => {
        this.watchId = id;
        if (!!this.background !== background) this._restartNativeGnss(); // mode changed meanwhile
      },
      (err) => {
        // The location service binds asynchronously at app start; retry briefly.
        if (attempt < 10) setTimeout(() => this._startNativeGnss(attempt + 1), 500);
        else {
          this.watchId = null;
          this._setStatus({ gnss: 'error', gnssError: String(err?.message || err) });
        }
      },
    );
  }

  /**
   * Android app: what the native log recorded with sinceT < t <= untilT (all pages), as
   * { frames: [nativeMotion events], fixes: [gnss events] }, oldest first.
   */
  async drain(sinceT, untilT) {
    const vs = plugin('VesselSensors');
    const frames = [];
    const fixes = [];
    let from = sinceT;
    for (let page = 0; page < 500; page++) {
      const r = await vs.drain({ sinceT: Math.floor(from), untilT: Math.ceil(untilT), max: 3000 });
      for (const f of r.frames || []) {
        frames.push({ t: f[0], R: f[1] === null ? null : f.slice(1, 10), gyro: f[10] === null ? null : f.slice(10, 13), headingAcc: f[13], magAccuracy: f[14], replay: true });
      }
      for (const x of r.fixes || []) {
        fixes.push({ t: x[0], fixT: x[1], lat: x[2], lon: x[3], acc: x[4], alt: x[5], altAcc: x[6], speed: x[7], cog: x[8] !== null && x[7] > 0 ? x[8] : null, replay: true });
      }
      if (!r.more || !r.frames?.length) break;
      from = r.frames[r.frames.length - 1][0];
    }
    return { frames, fixes };
  }

  /** Android app: open the app's system settings (e.g. after location was denied). */
  openSettings() {
    if (isNative) plugin('BackgroundGeolocation').openSettings();
  }

  stop() {
    this.running = false;
    clearInterval(this._ackTimer);
    if (isNative) {
      if (this.watchId && this.watchId !== 'pending') plugin('BackgroundGeolocation').removeWatcher({ id: this.watchId }).catch(() => {});
      plugin('VesselSensors').stop().catch(() => {});
    } else if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    window.removeEventListener('deviceorientationabsolute', this._onOrientation);
    window.removeEventListener('deviceorientation', this._onOrientation);
    window.removeEventListener('devicemotion', this._onMotion);
    this.motionStarted = false;
    this._setStatus({ gnss: 'off', orientation: 'off', motion: 'off' });
  }

  async _startMotion() {
    if (typeof DeviceOrientationEvent === 'undefined') {
      this._setStatus({ orientation: 'unsupported', motion: 'unsupported' });
      return;
    }
    if (this.needsMotionPermission) {
      try {
        // Both requests are issued synchronously inside the tap; awaiting one before
        // calling the other can lose the user-activation on iOS.
        const [o, m] = await Promise.all([
          DeviceOrientationEvent.requestPermission(),
          typeof DeviceMotionEvent?.requestPermission === 'function'
            ? DeviceMotionEvent.requestPermission()
            : Promise.resolve('granted'),
        ]);
        if (o !== 'granted') this._setStatus({ orientation: 'denied' });
        if (m !== 'granted') this._setStatus({ motion: 'denied' });
        if (o !== 'granted' && m !== 'granted') {
          this.motionStarted = false; // allow another attempt
          return;
        }
      } catch (err) {
        console.warn('Motion permission request failed', err);
        this._setStatus({ orientation: 'denied', motion: 'denied' });
        this.motionStarted = false;
        return;
      }
    }
    if (this.status.orientation !== 'denied') {
      this._setStatus({ orientation: 'waiting' });
      // Chrome/Android: 'deviceorientationabsolute' is earth (magnetic north) referenced.
      // Safari/iOS: 'deviceorientation' carries webkitCompassHeading.
      if ('ondeviceorientationabsolute' in window && !isIOS) {
        window.addEventListener('deviceorientationabsolute', this._onOrientation);
      } else {
        window.addEventListener('deviceorientation', this._onOrientation);
      }
    }
    if (this.status.motion !== 'denied') {
      this._setStatus({ motion: 'waiting' });
      window.addEventListener('devicemotion', this._onMotion);
    }
    // If nothing arrives the device simply has no such sensor (e.g. desktop).
    setTimeout(() => {
      if (this.status.orientation === 'waiting') this._setStatus({ orientation: 'unsupported' });
      if (this.status.motion === 'waiting') this._setStatus({ motion: 'unsupported' });
    }, 4000);
  }

  _startGnss() {
    if (!('geolocation' in navigator)) {
      this._setStatus({ gnss: 'unsupported' });
      return;
    }
    this._setStatus({ gnss: 'waiting' });
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        this._setStatus({ gnss: 'ok', gnssError: '' });
        this._emit('gnss', {
          t: Date.now(),
          fixT: pos.timestamp,
          lat: c.latitude,
          lon: c.longitude,
          acc: c.accuracy,
          alt: c.altitude,
          altAcc: c.altitudeAccuracy,
          speed: Number.isFinite(c.speed) ? c.speed : null,
          cog: Number.isFinite(c.heading) ? c.heading : null,
        });
      },
      (err) => {
        const denied = err.code === err.PERMISSION_DENIED;
        // Timeouts are transient (e.g. under a bridge); keep watching.
        this._setStatus({
          gnss: denied ? 'denied' : err.code === err.TIMEOUT ? 'waiting' : 'error',
          gnssError: err.message,
        });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  }

  _onOrientation(e) {
    if (e.alpha === null && e.beta === null) return;
    const now = Date.now();
    this.lastOrientationT = now;
    const compass = Number.isFinite(e.webkitCompassHeading) ? e.webkitCompassHeading : null;
    const absolute = e.type === 'deviceorientationabsolute' || e.absolute === true;
    const state = absolute || compass !== null ? 'ok' : 'relative';
    if (this.status.orientation !== state) this._setStatus({ orientation: state });
    this._emit('orientation', {
      t: now,
      alpha: e.alpha,
      beta: e.beta,
      gamma: e.gamma,
      absolute,
      compass,
      compassAcc: Number.isFinite(e.webkitCompassAccuracy) ? e.webkitCompassAccuracy : null,
    });
  }

  _onMotion(e) {
    const rr = e.rotationRate;
    if (!rr || (rr.alpha === null && rr.beta === null && rr.gamma === null)) return;
    const now = Date.now();
    this.lastMotionT = now;
    if (this.status.motion !== 'ok') this._setStatus({ motion: 'ok' });
    const a = e.acceleration;
    this._emit('motion', {
      t: now,
      rot: { alpha: rr.alpha, beta: rr.beta, gamma: rr.gamma },
      acc: a ? { x: a.x, y: a.y, z: a.z } : null,
      interval: e.interval,
    });
  }

  _setStatus(patch) {
    Object.assign(this.status, patch);
    this._emit('status', { ...this.status });
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
