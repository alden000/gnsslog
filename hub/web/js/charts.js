// Stacked time-series panels sharing one time axis (small multiples: one y-scale per panel).
// drawCharts() is shared by the screen and the image exports. Lines are decimated to min/max
// per pixel column, so hours of 5 Hz data draw quickly and exports stay a sensible size.

import { CanvasPainter, measureText } from './painter.js';

export const PANELS = [
  { id: 'speed', title: 'Speed', unit: 'speed', series: [{ col: 'sog', label: 'SOG' }, { col: 'gnssSpeed', label: 'GNSS raw' }], floor0: true },
  { id: 'heading', title: 'Heading', unit: '°', series: [{ col: 'hdg', label: 'Heading' }, { col: 'cog', label: 'COG' }], wrap: true },
  { id: 'rot', title: 'Rate of turn', unit: '°/s', series: [{ col: 'hdgRate', label: 'ROT' }], zero: true, digits: 2 },
  { id: 'mark', title: 'Distance to mark', unit: 'm', series: [{ col: 'markDist', label: 'Distance' }], floor0: true },
  { id: 'vel', title: 'Velocity east / north', unit: 'speed', series: [{ col: 'vx', label: 'East' }, { col: 'vy', label: 'North' }], zero: true },
  { id: 'acc', title: 'Position accuracy', unit: 'm', series: [{ col: 'gnssAcc', label: 'GNSS' }, { col: 'posSigma', label: 'Filter σ' }], floor0: true },
  { id: 'hsig', title: 'Heading uncertainty', unit: '°', series: [{ col: 'hdgSigma', label: 'σ' }], floor0: true },
  { id: 'att', title: 'Pitch / roll', unit: '°', series: [{ col: 'pitch', label: 'Pitch' }, { col: 'roll', label: 'Roll' }], zero: true },
  { id: 'gyro', title: 'Gyro bias', unit: '°/s', series: [{ col: 'gyroBias', label: 'Bias' }], zero: true, digits: 3 },
];
export const DEFAULT_PANELS = ['speed', 'heading', 'rot', 'mark', 'acc'];

const L = { left: 54, right: 16, header: 24, gap: 12, axis: 28 };
const GAP_MS = 2500;

export function chartsHeight(nPanels, plotH) {
  return nPanels * (L.header + plotH + L.gap) + L.axis;
}

function niceStep(range, target) {
  const raw = range / Math.max(target, 1);
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

const TIME_STEPS = [200, 500, 1e3, 2e3, 5e3, 10e3, 15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3];

const pad2 = (v) => String(v).padStart(2, '0');
export function fmtClock(t, withSeconds = true) {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${withSeconds ? `:${pad2(d.getSeconds())}` : ''}`;
}
export function fmtElapsed(ms) {
  const neg = ms < 0;
  let s = Math.abs(ms) / 1000;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const ss = s < 10 ? `0${s.toFixed(s % 1 ? 1 : 0)}` : s.toFixed(s % 1 ? 1 : 0);
  return `${neg ? '-' : ''}${h ? `${h}:${pad2(m)}` : m}:${ss}`;
}

function unitOf(panel, speedUnit) {
  return panel.unit === 'speed' ? speedUnit.label : panel.unit;
}
function scaleOf(panel, speedUnit) {
  return panel.unit === 'speed' ? speedUnit.k : 1;
}

/**
 * Decimated screen points for one series: for each pixel column the first, min, max and last
 * values, so spikes survive. Breaks at missing values, time gaps and (heading) wrap-around.
 */
function seriesPoints(data, col, i0, i1, tx, k, wrap) {
  const a = data.cols[col];
  const t = data.t;
  const out = []; // [x, value] pairs, NaN = break
  if (!a) return out;
  let curX = null, first, min, max, last, minI, maxI;
  const flush = () => {
    if (curX === null) return;
    const vals = minI < maxI ? [first, min, max, last] : [first, max, min, last];
    for (const v of vals) out.push(curX, v);
  };
  let prevT = -Infinity, prevV = NaN;
  for (let i = i0; i <= i1; i++) {
    const v = a[i] * k;
    const gap = t[i] - prevT > GAP_MS;
    const brk = !Number.isFinite(v) || gap || (wrap && Number.isFinite(prevV) && Math.abs(v - prevV) > 180);
    prevT = t[i];
    if (brk) {
      flush();
      curX = null;
      if (out.length && Number.isFinite(out[out.length - 1])) out.push(NaN, NaN);
      if (!Number.isFinite(v)) {
        prevV = NaN;
        continue;
      }
    }
    prevV = v;
    const x = Math.round(tx(t[i]));
    if (x !== curX) {
      flush();
      curX = x;
      first = min = max = last = v;
      minI = maxI = i;
    } else {
      if (v < min) (min = v), (minI = i);
      if (v > max) (max = v), (maxI = i);
      last = v;
    }
  }
  flush();
  return out;
}

/**
 * s: { w, data, panels, win: [ta, tb], sel, cursor, hover, pal, speedUnit, timeMode, plotH,
 *      cache (object reused between screen frames) }
 */
export function drawCharts(p, s) {
  const { w, data, panels, pal, plotH } = s;
  const [ta, tb] = s.win;
  const x0 = L.left, x1 = w - L.right;
  const tx = (t) => x0 + ((t - ta) / (tb - ta || 1)) * (x1 - x0);
  const h = chartsHeight(panels.length, plotH);
  p.rect(0, 0, w, h, { fill: s.background ?? pal.bg });
  if (!data || !data.n) return;

  const [i0r, i1r] = data.range(ta, tb);
  const i0 = Math.max(0, i0r - 1), i1 = Math.min(data.n - 1, i1r + 1);
  const readT = s.hover ?? s.cursor;
  const readI = readT === null || readT === undefined ? -1 : data.index(readT);

  // Decimated lines, cached while the window and size are unchanged.
  const key = `${ta}|${tb}|${w}|${data.n}|${s.speedUnit.k}|${panels.map((x) => x.id).join(',')}`;
  const cache = s.cache || {};
  if (cache.key !== key) {
    cache.key = key;
    cache.lines = panels.map((panel) =>
      panel.series.map((sr) => seriesPoints(data, sr.col, i0, i1, tx, scaleOf(panel, s.speedUnit), panel.wrap)),
    );
  }

  // Time ticks.
  const step = TIME_STEPS.find((st) => ((x1 - x0) / ((tb - ta) / st)) >= 86) || TIME_STEPS[TIME_STEPS.length - 1];
  const origin = s.timeMode === 'elapsed' ? data.t0 : new Date(ta).getTimezoneOffset() * -60000;
  const firstTick = Math.ceil((ta - origin) / step) * step + origin;
  const ticks = [];
  for (let t = firstTick; t <= tb; t += step) ticks.push(t);

  panels.forEach((panel, pi) => {
    const top = pi * (L.header + plotH + L.gap);
    const py0 = top + L.header, py1 = py0 + plotH;
    const lines = cache.lines[pi];
    const k = scaleOf(panel, s.speedUnit);

    // y range
    let lo = Infinity, hi = -Infinity;
    if (panel.wrap) (lo = 0), (hi = 360);
    else {
      for (const pts of lines) for (let j = 1; j < pts.length; j += 2) if (Number.isFinite(pts[j])) (lo = Math.min(lo, pts[j])), (hi = Math.max(hi, pts[j]));
      if (!Number.isFinite(lo)) (lo = 0), (hi = 1);
      if (panel.zero) (lo = Math.min(lo, 0)), (hi = Math.max(hi, 0));
      if (panel.floor0 && lo >= 0) lo = 0;
      if (hi - lo < 1e-6) (hi += 0.5), (lo -= panel.floor0 && lo === 0 ? 0 : 0.5);
      const padY = (hi - lo) * 0.08;
      hi += padY;
      if (!(panel.floor0 && lo === 0)) lo -= padY;
    }
    const ty = (v) => py1 - ((v - lo) / (hi - lo)) * plotH;

    // grid + y labels
    let ystep = panel.wrap ? 90 : niceStep(hi - lo, 3);
    // At least two labelled gridlines.
    while (!panel.wrap && Math.floor(hi / ystep) - Math.ceil(lo / ystep) + 1 < 2) ystep = niceStep(hi - lo, (hi - lo) / ystep * 2.2);
    for (let v = Math.ceil(lo / ystep) * ystep; v <= hi + 1e-9; v += ystep) {
      const y = ty(v);
      p.line(x0, y, x1, y, { stroke: Math.abs(v) < 1e-9 && panel.zero ? pal.axis : pal.grid, width: 1 });
      const dec = ystep < 0.01 ? 3 : ystep < 0.1 ? 2 : ystep < 1 ? 1 : 0;
      p.text(v.toFixed(dec), x0 - 8, y, { fill: pal.text3, size: 10, weight: 500, align: 'right', baseline: 'middle' });
    }
    for (const t of ticks) p.line(tx(t), py0, tx(t), py1, { stroke: pal.grid, width: 1 });

    // header: title + legend with values at the read-out time
    p.text(panel.title, x0, top + 15, { fill: pal.text2, size: 11, weight: 700 });
    let lx = x0 + measureText(panel.title, { size: 11, weight: 700 }) + 16;
    panel.series.forEach((sr, si) => {
      if (!data.cols[sr.col]) return;
      const color = pal.series[si];
      const v = readI >= 0 ? data.value(sr.col, readI) * k : NaN;
      const valTxt = Number.isFinite(v) ? `${v.toFixed(panel.digits ?? (Math.abs(v) < 10 ? 2 : 1))} ${unitOf(panel, s.speedUnit)}` : '—';
      if (panel.series.length > 1) {
        p.line(lx, top + 11, lx + 12, top + 11, { stroke: color, width: 2.5 });
        lx += 17;
        p.text(sr.label, lx, top + 15, { fill: pal.text2, size: 11, weight: 500 });
        lx += measureText(sr.label, { size: 11, weight: 500 }) + 5;
      }
      if (readI < 0) {
        lx += 10;
        return; // no read-out time (exports): legend only
      }
      p.text(valTxt, lx, top + 15, { fill: pal.text, size: 11, weight: 700 });
      lx += measureText(valTxt, { size: 11, weight: 700 }) + 16;
    });

    // selection band
    if (s.sel) {
      const sa = Math.max(x0, tx(s.sel[0])), sb = Math.min(x1, tx(s.sel[1]));
      if (sb > sa) p.rect(sa, py0, sb - sa, plotH, { fill: pal.selection });
    }

    // series (first series on top)
    p.clip(x0, py0 - 2, x1 - x0, plotH + 4);
    for (let si = lines.length - 1; si >= 0; si--) {
      const pts = lines[si];
      const xy = new Array(pts.length);
      for (let j = 0; j < pts.length; j += 2) {
        xy[j] = pts[j];
        xy[j + 1] = Number.isFinite(pts[j + 1]) ? ty(pts[j + 1]) : NaN;
      }
      p.poly(xy, { stroke: pal.series[si], width: si === 0 ? 2 : 1.5 });
    }
    p.end();

    // marks
    for (const m of data.marks) {
      if (m.t < ta || m.t > tb) continue;
      const x = tx(m.t);
      p.line(x, py0, x, py1, { stroke: pal.mark, width: 1.5, dash: [4, 4] });
      if (pi === 0) p.text(m.label, x + 4, py0 + 11, { fill: pal.text, size: 10, weight: 700, halo: s.background ?? pal.bg, haloWidth: 3 });
    }
    // selection edges, hover, cursor
    if (s.sel) for (const t of s.sel) if (t >= ta && t <= tb) p.line(tx(t), py0, tx(t), py1, { stroke: pal.selectionEdge, width: 1.5 });
    if (s.hover !== null && s.hover !== undefined) p.line(tx(s.hover), py0, tx(s.hover), py1, { stroke: pal.text3, width: 1 });
    if (s.cursor !== null && s.cursor !== undefined && s.cursor >= ta && s.cursor <= tb) {
      p.line(tx(s.cursor), py0, tx(s.cursor), py1, { stroke: pal.brand2, width: 2 });
    }
    p.line(x0, py1, x1, py1, { stroke: pal.axis, width: 1 });
  });

  // time axis labels
  const axisY = panels.length * (L.header + plotH + L.gap) + 6;
  for (const t of ticks) {
    if (tx(t) > x1 - 70) continue; // keep clear of the axis caption
    const label = s.timeMode === 'elapsed' ? fmtElapsed(t - data.t0) : fmtClock(t, step < 60000);
    p.text(label, tx(t), axisY + 8, { fill: pal.text3, size: 10, weight: 500, align: 'center', baseline: 'middle' });
  }
  p.text(s.timeMode === 'elapsed' ? 'elapsed' : 'local time', x1, axisY + 8, { fill: pal.text3, size: 9, weight: 600, align: 'right', baseline: 'middle', alpha: 0.8 });
}

/** Interactive charts on a canvas. */
export class Charts {
  constructor(canvas, { onSeek, onSelect, onWindow, onHover } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    Object.assign(this, { onSeek, onSelect, onWindow, onHover });
    this.data = null;
    this.panels = [];
    this.win = [0, 1];
    this.sel = null;
    this.cursor = null;
    this.hover = null;
    this.pal = null;
    this.plotH = 96;
    this.speedUnit = { k: 1, label: 'm/s' };
    this.timeMode = 'clock';
    this.cache = {};
    this.dirty = true;
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._bind();
    const loop = () => {
      if (this.dirty) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  set(patch) {
    Object.assign(this, patch);
    if ('panels' in patch || 'plotH' in patch) this._resize();
    if ('data' in patch || 'speedUnit' in patch) this.cache = {};
    this.dirty = true;
  }

  invalidate() {
    this.cache = {};
    this.dirty = true;
  }

  _resize() {
    const w = Math.max(200, this.canvas.parentElement.clientWidth);
    const h = chartsHeight(this.panels.length, this.plotH);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = w;
    this.h = h;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.cache = {};
    this.dirty = true;
  }

  timeAt(x) {
    const [ta, tb] = this.win;
    const x0 = L.left, x1 = this.w - L.right;
    return ta + ((Math.min(Math.max(x, x0), x1) - x0) / (x1 - x0)) * (tb - ta);
  }

  _bind() {
    const c = this.canvas;
    let down = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      down = { x: e.offsetX, t: this.timeAt(e.offsetX), selecting: false };
    });
    c.addEventListener('pointermove', (e) => {
      const t = this.timeAt(e.offsetX);
      if (down) {
        if (!down.selecting && Math.abs(e.offsetX - down.x) > 6) down.selecting = true;
        if (down.selecting) this.onSelect?.([Math.min(down.t, t), Math.max(down.t, t)]);
      }
      if (e.pointerType === 'mouse') this.onHover?.(t);
    });
    const up = (e) => {
      if (down && !down.selecting && e.type === 'pointerup') this.onSeek?.(this.timeAt(e.offsetX));
      down = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => this.onHover?.(null));
    c.addEventListener('dblclick', () => this.onWindow?.(null));
    c.addEventListener('wheel', (e) => {
      if (!this.data) return;
      e.preventDefault();
      const [ta, tb] = this.win;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        const shift = ((e.deltaX || e.deltaY) / (this.w - L.left - L.right)) * (tb - ta);
        this.onWindow?.([ta + shift, tb + shift]);
        return;
      }
      const t = this.timeAt(e.offsetX);
      const f = Math.exp(e.deltaY * 0.002);
      this.onWindow?.([t - (t - ta) * f, t + (tb - t) * f]);
    }, { passive: false });
  }

  scene(extra = {}) {
    return {
      w: this.w,
      data: this.data,
      panels: this.panels,
      win: this.win,
      sel: this.sel,
      cursor: this.cursor,
      hover: this.hover,
      pal: this.pal,
      speedUnit: this.speedUnit,
      timeMode: this.timeMode,
      plotH: this.plotH,
      ...extra,
    };
  }

  draw() {
    this.dirty = false;
    if (!this.pal) return;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawCharts(new CanvasPainter(this.ctx), this.scene({ cache: this.cache }));
  }
}
