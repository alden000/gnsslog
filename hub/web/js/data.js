// Session data in the analyser: column arrays (NaN for missing numbers), time lookup, the
// local x/y frame for drawing, marked-location intervals and statistics.

import { LocalFrame } from '../../../js/geo.js';
import { computeStats } from './stats.js';

/** Columns the analyser loads (the full set stays on the server for exports). */
export const LOAD_COLS = [
  't', 'segment', 'lat', 'lon', 'vx', 'vy', 'sog', 'cog',
  'hdg', 'hdgRate', 'hdgSigma', 'gyroRate', 'gyroBias', 'compass', 'compassDev', 'pitch', 'roll',
  'posSigma', 'gnssAcc', 'gnssSpeed', 'gnssCog', 'gnssNew',
  'markActive', 'markLat', 'markLon', 'markDist', 'markBrg',
];
const STRING_COLS = new Set(['hdgSrc', 'mount', 'markEvent', 'iso']);
const GAP_MS = 2500; // longer gaps (pause, app closed) break lines

export class SessionData {
  constructor(meta, payload) {
    this.meta = meta;
    this.cols = {};
    this.n = 0;
    this.maxSeq = -1;
    this.frame = null;
    this.px = [];
    this.py = [];
    this.append(payload);
    this.setEvents(meta.events || []);
  }

  get t() {
    return this.cols.t;
  }

  append({ columns, rows }) {
    if (!rows || !rows.length) return 0;
    for (const c of columns) if (!this.cols[c]) this.cols[c] = new Array(this.n).fill(STRING_COLS.has(c) ? '' : NaN);
    const idx = columns.map((c) => this.cols[c]);
    const missing = Object.keys(this.cols).filter((c) => !columns.includes(c)).map((c) => this.cols[c]);
    const seqI = columns.indexOf('seq');
    for (const r of rows) {
      if (r[seqI] <= this.maxSeq) continue; // already have it
      for (let k = 0; k < idx.length; k++) {
        const v = r[k];
        idx[k].push(STRING_COLS.has(columns[k]) ? (v ?? '') : v === null || v === undefined || v === '' ? NaN : Number(v));
      }
      for (const m of missing) m.push(NaN);
      this.maxSeq = r[seqI];
      this.n++;
    }
    this._project();
    return rows.length;
  }

  _project() {
    const { lat, lon } = this.cols;
    if (!lat) return;
    for (let i = this.px.length; i < this.n; i++) {
      if (!this.frame && Number.isFinite(lat[i]) && Number.isFinite(lon[i])) this.frame = new LocalFrame(lat[i], lon[i]);
      if (this.frame && Number.isFinite(lat[i]) && Number.isFinite(lon[i])) {
        const p = this.frame.toXY(lat[i], lon[i]);
        this.px.push(p.x);
        this.py.push(p.y);
      } else {
        this.px.push(NaN);
        this.py.push(NaN);
      }
    }
    // Rows projected before the frame existed.
    if (this.frame) for (let i = 0; i < this.n; i++) {
      if (Number.isFinite(this.px[i]) || !Number.isFinite(lat[i])) continue;
      const p = this.frame.toXY(lat[i], lon[i]);
      this.px[i] = p.x;
      this.py[i] = p.y;
    }
  }

  setEvents(events) {
    this.events = events || [];
    // Marked locations with the interval during which each one was active.
    this.marks = [];
    let cur = null;
    const close = (t) => cur && ((cur.until = t), (cur = null));
    for (const e of this.events) {
      if ((e.type === 'mark' || e.type === 'mark_active') && Number.isFinite(e.lat)) {
        close(e.t);
        cur = { t: e.t, lat: e.lat, lon: e.lon, until: Infinity, carried: e.type === 'mark_active' };
        this.marks.push(cur);
      } else if (e.type === 'mark_clear') close(e.t);
    }
    // The same spot carried over (mark_active after a resume) is one mark.
    this.marks = this.marks.filter((m, i, a) => !(m.carried && i > 0 && a[i - 1].lat === m.lat && a[i - 1].lon === m.lon && ((a[i - 1].until = m.until), true)));
    this.marks.forEach((m, i) => (m.label = `M${i + 1}`));
  }

  xyOf(lat, lon) {
    return this.frame ? this.frame.toXY(lat, lon) : { x: NaN, y: NaN };
  }

  markAt(t) {
    for (let i = this.marks.length - 1; i >= 0; i--) if (this.marks[i].t <= t && t < this.marks[i].until) return this.marks[i];
    return null;
  }

  get t0() {
    return this.n ? this.t[0] : 0;
  }

  get t1() {
    return this.n ? this.t[this.n - 1] : 0;
  }

  /** First index with t >= time. */
  lower(time) {
    const t = this.t;
    let lo = 0, hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Index of the sample nearest to time. */
  index(time) {
    if (!this.n) return -1;
    const i = this.lower(time);
    if (i <= 0) return 0;
    if (i >= this.n) return this.n - 1;
    return time - this.t[i - 1] <= this.t[i] - time ? i - 1 : i;
  }

  /** Inclusive index range covering [ta, tb]. */
  range(ta, tb) {
    const i0 = Math.min(this.lower(ta), this.n - 1);
    let i1 = this.lower(tb + 0.001) - 1;
    if (i1 < i0) i1 = i0;
    return [Math.max(0, i0), Math.max(0, i1)];
  }

  isGap(i) {
    return i > 0 && this.t[i] - this.t[i - 1] > GAP_MS;
  }

  value(col, i) {
    const a = this.cols[col];
    return a && i >= 0 && i < this.n ? a[i] : NaN;
  }

  stats(ta = this.t0, tb = this.t1) {
    const [i0, i1] = this.range(ta, tb);
    return computeStats(this.cols, i0, i1);
  }

  hasData(col) {
    const a = this.cols[col];
    if (!a) return false;
    for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) return true;
    return false;
  }
}
