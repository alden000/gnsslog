// Persistent user settings (localStorage), with change notifications.

const KEY = 'gnsslog.settings';

export const DEFAULTS = {
  v: 2, // settings schema version
  theme: 'system', // system | light | dark
  haptics: true, // vibrate briefly on taps
  speedUnit: 'kn', // kn | ms | kmh
  mount: 'auto', // auto | flat | upright
  headingOffset: 0, // deg added to the phone heading to get the bow heading
  declination: 0, // deg, East positive: true = magnetic + declination
  compassSigma: 6, // deg, 1-sigma magnetometer noise used by the heading filter
  invertGyro: false,
  rateSmoothing: 0.5, // s, time constant of the rate-of-turn low-pass filter
  autoDeviation: true, // learn compass deviation (magnets, steel) from GNSS course
  orientUp: 'north', // north | heading (visualiser)
  mapLayer: 'off', // off | street | satellite (visualiser background)
  seamarks: false, // OpenSeaMap overlay on the map
  trailMinutes: 10,
  endpoint: '',
  authHeader: 'Authorization',
  authValue: '',
  autoSync: true,
  chunkSize: 1000,
  deviceName: '',
};

export class Settings extends EventTarget {
  constructor() {
    super();
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {}
    // v2: 'auto' mounting became the default. 'flat' was the old default, so a stored 'flat' is
    // almost always just that default (it made upright phones point wildly); move it to 'auto'.
    if ((stored.v || 1) < 2) {
      if (stored.mount === 'flat') stored.mount = 'auto';
      stored.v = 2;
      if (Object.keys(stored).length > 1) {
        try {
          localStorage.setItem(KEY, JSON.stringify(stored));
        } catch {}
      }
    }
    this.values = { ...DEFAULTS, ...stored };
  }

  get(k) {
    return this.values[k];
  }

  set(k, v) {
    if (this.values[k] === v) return;
    this.values[k] = v;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.values));
    } catch {}
    this.dispatchEvent(new CustomEvent('change', { detail: { key: k, value: v } }));
  }

  snapshot() {
    const { authValue, ...rest } = this.values;
    return rest;
  }
}
