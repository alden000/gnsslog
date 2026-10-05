// Top-down track view: whole session (or a selection) north-up on an optional map, with pan /
// zoom, the vessel at the playback cursor, marked locations and the line to the active mark.
// drawTrackScene() is shared by the screen and the image exports.

import { MAP_SOURCES, SEAMARKS, TileCache, drawTileLayer } from '../../../js/maptiles.js';
import { CanvasPainter } from './painter.js';
import { isPoor } from '../../../js/quality.js';

const SPEED_BINS = 8;
export const tileCache = new TileCache();

function fmtDist(m) {
  if (!Number.isFinite(m)) return '—';
  if (m < 1000) return `${m < 10 ? m.toFixed(1) : Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

/** Bow-up vessel outline (same shape as the phone app), as polygon points around (0,0). */
const VESSEL = (() => {
  const pts = [];
  const bez = (p0, p1, p2, p3) => {
    for (let k = 1; k <= 8; k++) {
      const u = k / 8, v = 1 - u;
      pts.push(v ** 3 * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u ** 3 * p3[0], v ** 3 * p0[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u ** 3 * p3[1]);
    }
  };
  pts.push(0, -17);
  bez([0, -17], [7, -9], [8, 2], [7, 13]);
  pts.push(-7, 13);
  bez([-7, 13], [-8, 2], [-7, -9], [0, -17]);
  return pts;
})();

function rotated(pts, x, y, deg, scale = 1) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = x + (pts[i] * c - pts[i + 1] * s) * scale;
    out[i + 1] = y + (pts[i] * s + pts[i + 1] * c) * scale;
  }
  return out;
}

function niceScale(maxMeters) {
  const steps = [1, 2, 5];
  let best = 1;
  for (let e = 0; e < 8; e++) for (const s of steps) {
    const v = s * 10 ** e;
    if (v <= maxMeters) best = v;
  }
  return best;
}

export function speedRange(data, i0, i1) {
  const sog = data.cols.sog;
  let max = 0;
  if (sog) for (let i = i0; i <= i1; i++) if (sog[i] > max) max = sog[i];
  return [0, Math.max(max, 0.5)];
}

/**
 * Draw the track scene with painter p.
 * s: { w, h, data, center:{x,y}, mpp, pal, sel:[ta,tb]|null, colorBy, cursor (t)|null,
 *      map: { canvas|null, attribution }, speedUnit:{ k, label }, legend:boolean, title }
 */
export function drawTrackScene(p, s) {
  const { w, h, data, center, mpp, pal } = s;
  const sx = (x) => w / 2 + (x - center.x) / mpp;
  const sy = (y) => h / 2 - (y - center.y) / mpp;
  const onMap = !!s.map?.canvas;

  p.rect(0, 0, w, h, { fill: pal.bg });
  if (onMap) p.image(s.map.canvas, 0, 0, w, h);
  else drawGrid(p, s, sx, sy);

  if (!data || !data.n || !data.frame) {
    p.text('No position data', w / 2, h / 2, { fill: pal.text3, size: 14, align: 'center', baseline: 'middle' });
    return;
  }

  const n = data.n;
  const [selA, selB] = s.sel || [data.t0, data.t1];
  const [i0, i1] = data.range(selA, selB);
  const toPts = (a, b) => {
    const pts = [];
    for (let i = a; i <= b; i++) {
      if (data.isGap(i)) pts.push(NaN, NaN);
      pts.push(sx(data.px[i]), sy(data.py[i]));
    }
    return pts;
  };
  const halo = onMap ? { stroke: pal.halo, width: 6 } : null;

  // Context outside the selection: thin and quiet.
  if (s.sel) {
    for (const [a, b] of [[0, i0], [i1, n - 1]]) {
      if (b <= a) continue;
      const pts = toPts(a, b);
      if (halo) p.poly(pts, { ...halo, width: 4 });
      p.poly(pts, { stroke: onMap ? pal.text2 : pal.text3, width: 1.5, alpha: 0.8 });
    }
  }

  // The (selected) track. Stretches without proper GNSS (car parks, tunnels, indoors) are drawn
  // thin and dashed, so they do not read as real movement; a link is poor if either end is.
  const poor = (i) => isPoor(data.cols.gnssAcc?.[i], data.cols.posSigma?.[i]);
  const linkPoor = (i) => poor(i - 1) || poor(i);
  // Points of the links in [a, b] that are (not) poor, as polylines broken by NaN.
  const links = (a, b, wantPoor) => {
    const pts = [];
    let pen = false;
    for (let i = a + 1; i <= b; i++) {
      if (data.isGap(i) || linkPoor(i) !== wantPoor) {
        pen = false;
        continue;
      }
      if (!pen) {
        if (pts.length) pts.push(NaN, NaN);
        pts.push(sx(data.px[i - 1]), sy(data.py[i - 1]));
      }
      pts.push(sx(data.px[i]), sy(data.py[i]));
      pen = true;
    }
    return pts;
  };
  const main = links(i0, i1, false);
  if (halo) p.poly(main, halo);
  if (s.colorBy === 'speed' && data.cols.sog) {
    const [lo, hi] = speedRange(data, i0, i1);
    const bin = (i) => {
      const v = data.cols.sog[i];
      return Number.isFinite(v) ? Math.min(SPEED_BINS - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * SPEED_BINS))) : 0;
    };
    // Consecutive points of the same speed bin go into one path (keeps SVGs small).
    let start = i0, b = bin(i0);
    const flush = (end) => p.poly(links(start, end, false), { stroke: pal.ramp[b], width: 3 });
    for (let i = i0 + 1; i <= i1; i++) {
      const bi = bin(i);
      if (bi !== b) {
        flush(i);
        start = i;
        b = bi;
      }
    }
    flush(i1);
  } else {
    p.poly(main, { stroke: pal.trail, width: 2.5 });
  }
  const weak = links(i0, i1, true);
  if (weak.length) p.poly(weak, { stroke: onMap ? pal.text : pal.text2, width: 1.5, dash: [4, 4], alpha: 0.75 });

  // Start / end of the (selected) track.
  const firstPos = (a, b, dir) => {
    for (let i = a; dir > 0 ? i <= b : i >= b; i += dir) if (Number.isFinite(data.px[i])) return i;
    return -1;
  };
  const iStart = firstPos(i0, i1, 1), iEnd = firstPos(i1, i0, -1);
  const lbl = { fill: pal.text, size: 11, weight: 700, halo: pal.halo, haloWidth: 4 };
  if (iStart >= 0) {
    const x = sx(data.px[iStart]), y = sy(data.py[iStart]);
    p.circle(x, y, 5, { fill: pal.bg, stroke: pal.text, width: 2 });
    p.text('Start', x + 9, y - 8, lbl);
  }
  if (iEnd >= 0 && iEnd !== iStart) {
    const x = sx(data.px[iEnd]), y = sy(data.py[iEnd]);
    p.rect(x - 4.5, y - 4.5, 9, 9, { fill: pal.text, stroke: pal.bg, width: 1.5 });
    p.text('End', x + 9, y - 8, lbl);
  }

  // Marked locations.
  for (const m of data.marks) {
    const xy = data.xyOf(m.lat, m.lon);
    const x = sx(xy.x), y = sy(xy.y);
    p.poly([x, y - 8, x + 8, y, x, y + 8, x - 8, y], { fill: pal.mark, stroke: pal.bg, width: 2, close: true });
    p.text(m.label, x + 11, y + 4, lbl);
  }

  // Playback cursor: line to the active mark, then the vessel.
  if (s.cursor !== null && s.cursor !== undefined) {
    const i = data.index(s.cursor);
    if (Number.isFinite(data.px[i])) {
      const x = sx(data.px[i]), y = sy(data.py[i]);
      const m = data.markAt(data.t[i]);
      if (m) {
        const xy = data.xyOf(m.lat, m.lon);
        const mx = sx(xy.x), my = sy(xy.y);
        p.line(mx, my, x, y, { stroke: pal.mark, width: 2, dash: [6, 5] });
        const d = Number.isFinite(data.value('markDist', i)) ? data.value('markDist', i) : Math.hypot(xy.x - data.px[i], xy.y - data.py[i]);
        const label = fmtDist(d);
        p.text(label, (mx + x) / 2, (my + y) / 2 - 8, { ...lbl, size: 12, align: 'center' });
      }
      const hdg = data.value('hdg', i);
      if (Number.isFinite(hdg)) {
        p.poly(rotated(VESSEL, x, y, hdg), { fill: pal.brand2, stroke: pal.vessel, width: 1.5, close: true });
        p.circle(x, y, 2.2, { fill: pal.onBrand });
      } else p.circle(x, y, 7, { fill: pal.vessel, stroke: pal.bg, width: 2 });
    }
  }

  drawChrome(p, s, i0, i1);
}

function drawGrid(p, s, sx, sy) {
  const { w, h, mpp, center, pal } = s;
  const step = niceScale(Math.max(w, h) * mpp / 6);
  const x0 = Math.floor((center.x - (w / 2) * mpp) / step) * step;
  const y0 = Math.floor((center.y - (h / 2) * mpp) / step) * step;
  for (let x = x0; x <= center.x + (w / 2) * mpp; x += step) p.line(sx(x), 0, sx(x), h, { stroke: pal.grid, width: 1 });
  for (let y = y0; y <= center.y + (h / 2) * mpp; y += step) p.line(0, sy(y), w, sy(y), { stroke: pal.grid, width: 1 });
}

function drawChrome(p, s, i0, i1) {
  const { w, h, mpp, pal } = s;
  const onMap = !!s.map?.canvas;
  const ink = { fill: pal.text, size: 11, weight: 600, halo: pal.halo, haloWidth: 4 };

  // Scale bar (bottom left).
  const len = niceScale(120 * mpp);
  const px = len / mpp;
  const bx = 16, by = h - 22;
  p.line(bx, by, bx + px, by, { stroke: pal.halo, width: 6, cap: 'butt' });
  p.poly([bx, by - 5, bx, by, bx + px, by, bx + px, by - 5], { stroke: pal.text, width: 2, cap: 'butt' });
  p.text(fmtDist(len), bx + px / 2, by - 8, { ...ink, align: 'center' });

  // North arrow (top right).
  const nx = w - 24, ny = 30;
  p.poly([nx, ny - 13, nx + 6, ny + 3, nx - 6, ny + 3], { fill: pal.brand2, close: true, stroke: onMap ? pal.halo : null, width: 1 });
  p.poly([nx, ny + 13, nx + 6, ny + 3, nx - 6, ny + 3], { fill: pal.text3, close: true, stroke: onMap ? pal.halo : null, width: 1 });
  p.text('N', nx, ny - 17, { ...ink, align: 'center', size: 10 });

  // Speed legend (bottom right).
  if (s.colorBy === 'speed' && s.legend !== false && s.data.cols.sog) {
    const [lo, hi] = speedRange(s.data, i0, i1);
    const k = s.speedUnit.k;
    const lw = 128, lx = w - lw - 16, ly = h - 30;
    p.rect(lx - 8, ly - 22, lw + 16, 40, { fill: pal.halo, r: 8 });
    pal.ramp.forEach((c, i) => p.rect(lx + (i * lw) / SPEED_BINS, ly, lw / SPEED_BINS + 0.5, 6, { fill: c }));
    p.text(`Speed (${s.speedUnit.label})`, lx, ly - 8, { fill: pal.text2, size: 10, weight: 600 });
    p.text((lo * k).toFixed(1), lx, ly + 16, { fill: pal.text2, size: 10, weight: 600 });
    p.text((hi * k).toFixed(1), lx + lw, ly + 16, { fill: pal.text2, size: 10, weight: 600, align: 'right' });
  }

  if (onMap && s.map.attribution) {
    const y = s.colorBy === 'speed' && s.legend !== false ? h - 56 : h - 8;
    p.text(s.map.attribution, w - 8, y, { fill: pal.text2, size: 9, weight: 500, align: 'right', halo: pal.halo, haloWidth: 3 });
  }
  if (s.title) p.text(s.title, 16, 26, { fill: pal.text, size: 15, weight: 700, family: 'display', halo: pal.halo, haloWidth: 4 });
}

/**
 * Map background as one canvas (w x h CSS px at `scale`), waiting up to `waitMs` for tiles to
 * arrive (for exports; the screen passes 0 and redraws as tiles load).
 */
export async function renderMap({ w, h, scale = 1, center, mpp, frame, layer, seamarks, dark, waitMs = 0 }) {
  const src = MAP_SOURCES[layer];
  if (!src || !frame) return null;
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  if (layer === 'satellite') c.dataset.jpeg = '1';
  const ctx = c.getContext('2d');
  const view = { geo: frame, center, mpp: mpp / scale, rot: 0, w: c.width, h: c.height, dpr: 1 };
  const draw = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    drawTileLayer(ctx, tileCache, src, view, { dark });
    if (seamarks) drawTileLayer(ctx, tileCache, SEAMARKS, view, {});
  };
  draw();
  const until = Date.now() + waitMs;
  while (waitMs && tileCache.pending() && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
    draw();
  }
  return c;
}

export function mapAttribution(layer, seamarks) {
  const src = MAP_SOURCES[layer];
  if (!src) return '';
  return src.attribution + (seamarks ? ` · ${SEAMARKS.attribution}` : '');
}

/** Centre and scale that fit the track between ta and tb (default: all) into w x h. */
export function fitView(d, w, h, ta, tb, pad = 56) {
  if (!d || !d.n) return null;
  const [i0, i1] = ta === undefined ? [0, d.n - 1] : d.range(ta, tb);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (!Number.isFinite(x)) return;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  for (let i = i0; i <= i1; i++) add(d.px[i], d.py[i]);
  for (const m of d.marks) {
    if (m.until < (ta ?? -Infinity) || m.t > (tb ?? Infinity)) continue;
    const xy = d.xyOf(m.lat, m.lon);
    add(xy.x, xy.y);
  }
  if (!Number.isFinite(minX)) return null;
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    mpp: Math.max((maxX - minX) / Math.max(w - 2 * pad, 50), (maxY - minY) / Math.max(h - 2 * pad, 50), 0.05),
  };
}

/** Interactive track view on a canvas. */
export class TrackView {
  constructor(canvas, { onSeek, onViewChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.onViewChange = onViewChange;
    this.data = null;
    this.center = { x: 0, y: 0 };
    this.mpp = 1;
    this.opts = { map: 'off', seamarks: false, colorBy: 'speed', follow: false };
    this.sel = null;
    this.cursor = null;
    this.pal = null;
    this.speedUnit = { k: 1, label: 'm/s' };
    this.dirty = true;
    this.mapCanvas = null;
    this.mapKey = '';
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._bind();
    const loop = () => {
      if (this.dirty || (this.opts.map !== 'off' && tileCache.pending())) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.dirty = true;
  }

  setData(data) {
    const first = !this.data;
    this.data = data;
    if (first) this.fit();
    this.dirty = true;
  }

  set(patch) {
    Object.assign(this, patch);
    this.dirty = true;
  }

  setOptions(o) {
    Object.assign(this.opts, o);
    this.dirty = true;
  }

  /** Fit the view to the track between ta and tb (default: everything). */
  fit(ta, tb) {
    const v = fitView(this.data, this.w, this.h, ta, tb);
    if (!v) return;
    this.center = v.center;
    this.mpp = v.mpp;
    this.dirty = true;
  }

  _bind() {
    const c = this.canvas;
    const pts = new Map();
    let drag = null;
    let pinch = null;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pts.size === 1) drag = { x: e.offsetX, y: e.offsetY, cx: this.center.x, cy: this.center.y, moved: false };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mpp: this.mpp };
        drag = null;
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 10) this.mpp = Math.min(Math.max(pinch.mpp * (pinch.d / d), 0.02), 20000);
        this.opts.follow = false;
        this.dirty = true;
        this.onViewChange?.();
      } else if (drag) {
        const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
        if (Math.hypot(dx, dy) > 4) drag.moved = true;
        if (drag.moved) {
          this.center = { x: drag.cx - dx * this.mpp, y: drag.cy + dy * this.mpp };
          this.opts.follow = false;
          this.dirty = true;
          this.onViewChange?.();
        }
      }
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (drag && !drag.moved && pts.size === 0) this._click(e.offsetX, e.offsetY);
      if (pts.size === 0) drag = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(e.deltaY * 0.0015);
      // Zoom about the pointer.
      const wx = this.center.x + (e.offsetX - this.w / 2) * this.mpp;
      const wy = this.center.y - (e.offsetY - this.h / 2) * this.mpp;
      const mpp = Math.min(Math.max(this.mpp * f, 0.02), 20000);
      this.center = { x: wx - (e.offsetX - this.w / 2) * mpp, y: wy + (e.offsetY - this.h / 2) * mpp };
      this.mpp = mpp;
      this.dirty = true;
      this.onViewChange?.();
    }, { passive: false });
  }

  zoom(f) {
    this.mpp = Math.min(Math.max(this.mpp * f, 0.02), 20000);
    this.dirty = true;
  }

  /** Click near the track: seek to the nearest sample. */
  _click(x, y) {
    const d = this.data;
    if (!d || !d.n) return;
    let best = -1, bd = 14 * 14;
    for (let i = 0; i < d.n; i++) {
      const dx = this.w / 2 + (d.px[i] - this.center.x) / this.mpp - x;
      const dy = this.h / 2 - (d.py[i] - this.center.y) / this.mpp - y;
      const dd = dx * dx + dy * dy;
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    if (best >= 0) this.onSeek?.(d.t[best]);
  }

  _mapCanvas() {
    if (this.opts.map === 'off' || !this.data?.frame) return null;
    const key = [this.opts.map, this.opts.seamarks, this.pal.name, this.center.x, this.center.y, this.mpp, this.w, this.h, this.dpr].join('|');
    if (key !== this.mapKey || tileCache.pending() || this._mapStale) {
      this._mapStale = !!tileCache.pending();
      this.mapKey = key;
      const src = MAP_SOURCES[this.opts.map];
      if (!this.mapCanvas) this.mapCanvas = document.createElement('canvas');
      const c = this.mapCanvas;
      c.width = this.canvas.width;
      c.height = this.canvas.height;
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      // Drawn in device pixels already (mpp per device pixel), so dpr is 1 here.
      const view = { geo: this.data.frame, center: this.center, mpp: this.mpp / this.dpr, rot: 0, w: c.width, h: c.height, dpr: 1 };
      drawTileLayer(ctx, tileCache, src, view, { dark: this.pal.name === 'dark' });
      if (this.opts.seamarks) drawTileLayer(ctx, tileCache, SEAMARKS, view, {});
    }
    return this.mapCanvas;
  }

  /** The scene description for the current view (also used by exports). */
  scene(extra = {}) {
    return {
      w: this.w,
      h: this.h,
      data: this.data,
      center: this.center,
      mpp: this.mpp,
      pal: this.pal,
      sel: this.sel,
      colorBy: this.opts.colorBy,
      cursor: this.cursor,
      speedUnit: this.speedUnit,
      ...extra,
    };
  }

  draw() {
    this.dirty = false;
    if (!this.pal) return;
    const d = this.data;
    if (this.opts.follow && d && this.cursor !== null) {
      const i = d.index(this.cursor);
      if (Number.isFinite(d.px[i])) this.center = { x: d.px[i], y: d.py[i] };
    }
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const map = this._mapCanvas();
    const p = new CanvasPainter(ctx);
    drawTrackScene(p, this.scene({ map: map ? { canvas: map, attribution: mapAttribution(this.opts.map, this.opts.seamarks) } : null }));
  }
}
