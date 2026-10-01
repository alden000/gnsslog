// Persistent user settings (localStorage), with change notifications.

const KEY = 'gnsslog.settings';

export const DEFAULTS = {
  theme: 'system', // system | light | dark
  speedUnit: 'kn', // kn | ms | kmh
  mount: 'flat', // flat | upright
  headingOffset: 0, // deg added to the phone heading to get the bow heading
  declination: 0, // deg, East positive: true = magnetic + declination
  compassSigma: 6, // deg, 1-sigma magnetometer noise used by the heading filter
  invertGyro: false,
  rateSmoothing: 0.5, // s, time constant of the rate-of-turn low-pass filter
  autoDeviation: true, // learn compass deviation (magnets, steel) from GNSS course
  orientUp: 'north', // north | heading (visualiser)
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
