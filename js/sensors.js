// Raw sensor access: GNSS (Geolocation API), orientation (magnetometer-referenced attitude)
// and motion (gyroscope). Emits 'gnss', 'orientation', 'motion' and 'status' events.

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
    this._startGnss();
  }

  async startMotion() {
    if (this.motionStarted) return;
    this.motionStarted = true;
    this.running = true;
    await this._startMotion();
  }

  stop() {
    this.running = false;
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
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
