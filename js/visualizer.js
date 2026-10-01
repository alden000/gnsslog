// Top-down (x = East, y = North) canvas visualiser.
// Centre is the vessel, or the skyhook spot when one is marked. Breadcrumbs, range rings,
// the vessel glyph, the skyhook marker and the vessel<->spot line are drawn relative to it.

const NICE = [1, 2, 5];

function niceStep(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const n of NICE) if (n * p >= v) return n * p;
  return 10 * p;
}

export function fmtDist(m) {
  if (m === null || !Number.isFinite(m)) return '—';
  if (m >= 10000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (m >= 100) return `${m.toFixed(0)} m`;
  if (m >= 10) return `${m.toFixed(1)} m`;
  return `${m.toFixed(2)} m`;
}

export class Visualizer {
  constructor(canvas, { onModeChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mpp = 0.25; // metres per CSS pixel
    this.auto = true;
    this.getFrame = null;
    this.raf = 0;
    this.onModeChange = onModeChange;
    this.pointers = new Map();
    this.pinch = null;
    this._readColors();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this._readColors());
    this._bindGestures();
  }

  refreshTheme() {
    this._readColors();
  }

  start(getFrame) {
    this.getFrame = getFrame;
    if (!this.raf) this.raf = requestAnimationFrame(() => this._loop());
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  setAuto(on) {
    this.auto = on;
    this.onModeChange?.(on);
  }

  zoom(factor) {
    this.mpp = Math.min(500, Math.max(0.01, this.mpp * factor));
    this.setAuto(false);
  }

  _loop() {
    this.raf = requestAnimationFrame(() => this._loop());
    if (document.visibilityState !== 'visible' || !this.canvas.isConnected || this.canvas.offsetParent === null) return;
    const f = this.getFrame?.();
    this.draw(f);
  }

  _readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.c = {
      text: v('--text'),
      text2: v('--text-2'),
      text3: v('--text-3'),
      hair: v('--hairline'),
      grid: v('--grid'),
      brand1: v('--brand-1'),
      brand2: v('--brand-2'),
      brand3: v('--brand-3'),
      onBrand: v('--on-brand'),
      mark: v('--mark'),
      canvas: v('--canvas'),
      vessel: v('--vessel'),
      trail: v('--trail'),
    };
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.dpr = dpr;
  }

  _bindGestures() {
    const el = this.canvas;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mpp: this.mpp };
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 10) {
          this.mpp = Math.min(500, Math.max(0.01, (this.pinch.mpp * this.pinch.d) / d));
          if (this.auto) this.setAuto(false);
        }
      }
    });
    const end = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(Math.exp(e.deltaY * 0.0015));
      },
      { passive: false },
    );
    el.addEventListener('dblclick', () => this.setAuto(true));
  }

  /**
   * frame: {
   *   vessel: { x, y, hdg, acc, vx, vy } | null,
   *   trail: [{ x, y }],             // oldest first
   *   sky: { x, y, dist } | null,
   *   headingUp: boolean,
   * }
   */
  draw(frame) {
    const { ctx, w, h, c } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const vessel = frame?.vessel;
    const sky = frame?.sky && Number.isFinite(frame.sky.x) ? frame.sky : null;
    const R = Math.min(w, h) / 2; // usable radius in px

    if (!vessel) {
      this._drawRings(w / 2, h / 2, R, 0);
      ctx.fillStyle = c.text3;
      ctx.font = '600 13px "Plus Jakarta Sans", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for GNSS fix…', w / 2, h / 2 + 4);
      return;
    }

    const center = sky || vessel;
    const rot = frame.headingUp && Number.isFinite(vessel.hdg) ? vessel.hdg : 0; // deg, CCW world rotation

    // Auto range: keep the interesting things inside ~80% of the radius.
    if (this.auto) {
      let need;
      if (sky) need = Math.max(sky.dist * 1.25, 8);
      else {
        let ext = Math.max((vessel.acc || 5) * 1.5, 15);
        const tr = frame.trail;
        const tail = tr.length > 300 ? tr.length - 300 : 0; // last minute
        for (let i = tail; i < tr.length; i++) if (tr[i]) ext = Math.max(ext, Math.hypot(tr[i].x - vessel.x, tr[i].y - vessel.y));
        need = ext * 1.1;
      }
      const target = need / (R * 0.82);
      // Ease toward the target scale (log space) so zoom changes glide.
      this.mpp = Math.exp(Math.log(this.mpp) + (Math.log(target) - Math.log(this.mpp)) * 0.08);
    }

    const mpp = this.mpp;
    const th = (rot * Math.PI) / 180;
    const cos = Math.cos(th), sin = Math.sin(th);
    const cx = w / 2, cy = h / 2;
    const toScreen = (x, y) => {
      const dx = x - center.x, dy = y - center.y;
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      return [cx + rx / mpp, cy - ry / mpp];
    };

    this._drawRings(cx, cy, R, rot);

    // Breadcrumbs: oldest fade out, newest brightest.
    const tr = frame.trail;
    if (tr.length > 1) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = c.trail;
      const segs = 12;
      const per = Math.ceil(tr.length / segs);
      for (let s = 0; s < segs; s++) {
        const a = s * per, b = Math.min(tr.length - 1, (s + 1) * per);
        if (b <= a) continue;
        ctx.globalAlpha = 0.15 + 0.85 * ((s + 1) / segs) ** 1.6;
        ctx.lineWidth = 1.5 + 1.5 * ((s + 1) / segs);
        ctx.beginPath();
        let pen = false; // null entries mark gaps (app was in the background)
        for (let i = a; i <= b; i++) {
          if (!tr[i]) {
            pen = false;
            continue;
          }
          const [px, py] = toScreen(tr[i].x, tr[i].y);
          if (pen) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
          pen = true;
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    const [vx, vy] = toScreen(vessel.x, vessel.y);

    // GNSS accuracy disc.
    if (vessel.acc > 0) {
      const rr = vessel.acc / mpp;
      if (rr > 4 && rr < 4 * R) {
        ctx.beginPath();
        ctx.arc(vx, vy, rr, 0, Math.PI * 2);
        ctx.fillStyle = c.trail;
        ctx.globalAlpha = 0.08;
        ctx.fill();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = c.trail;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // Skyhook spot + tether line + distance label.
    if (sky) {
      const [sx, sy] = toScreen(sky.x, sky.y);
      const grad = ctx.createLinearGradient(sx, sy, vx, vy);
      grad.addColorStop(0, c.mark);
      grad.addColorStop(1, c.brand2);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(vx, vy);
      ctx.stroke();

      // Marker: ring + crosshair.
      ctx.strokeStyle = c.mark;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx - 15, sy); ctx.lineTo(sx - 5, sy);
      ctx.moveTo(sx + 5, sy); ctx.lineTo(sx + 15, sy);
      ctx.moveTo(sx, sy - 15); ctx.lineTo(sx, sy - 5);
      ctx.moveTo(sx, sy + 5); ctx.lineTo(sx, sy + 15);
      ctx.stroke();
      ctx.fillStyle = c.mark;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
      ctx.fill();

      const len = Math.hypot(vx - sx, vy - sy);
      if (len > 50) {
        const label = fmtDist(sky.dist);
        const mx = (sx + vx) / 2, my = (sy + vy) / 2;
        ctx.font = '700 13px "Plus Jakarta Sans", system-ui, sans-serif';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = c.canvas;
        ctx.globalAlpha = 0.85;
        roundRect(ctx, mx - tw / 2 - 8, my - 12, tw + 16, 24, 12);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, mx, my + 0.5);
        ctx.textBaseline = 'alphabetic';
      }
    }

    // Velocity vector (dashed): where the vessel will be in 30 s at the current speed and course.
    if (Number.isFinite(vessel.vx) && Math.hypot(vessel.vx, vessel.vy) > 0.2) {
      const [ex, ey] = toScreen(vessel.x + vessel.vx * 30, vessel.y + vessel.vy * 30);
      ctx.strokeStyle = c.text2;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      if (Math.hypot(ex - vx, ey - vy) > 40) {
        ctx.fillStyle = c.text2;
        ctx.font = '700 10px "Plus Jakarta Sans", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('30 s', ex, ey - 6);
      }
      ctx.globalAlpha = 1;
    }

    this._drawVessel(vx, vy, Number.isFinite(vessel.hdg) ? vessel.hdg - rot : null);
    this._drawNorth(rot);
    this._drawScale();
  }

  _drawRings(cx, cy, R, rot) {
    const { ctx, c, mpp } = this;
    const step = niceStep((R * mpp) / 3);
    const stepPx = step / mpp;
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    ctx.font = '600 10px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.fillStyle = c.text3;
    ctx.textAlign = 'left';
    const maxR = Math.hypot(this.w, this.h) / 2;
    for (let i = 1; i * stepPx < maxR; i++) {
      ctx.beginPath();
      ctx.arc(cx, cy, i * stepPx, 0, Math.PI * 2);
      ctx.stroke();
      // Label each ring where it crosses the left horizontal axis (clear of the HUD).
      if (i <= 4 && i * stepPx < cx - 8) ctx.fillText(fmtDist(i * step), cx - i * stepPx + 4, cy - 5);
    }
    // Cross hairs aligned with north.
    const th = (rot * Math.PI) / 180;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-th);
    ctx.beginPath();
    ctx.moveTo(-maxR, 0); ctx.lineTo(maxR, 0);
    ctx.moveTo(0, -maxR); ctx.lineTo(0, maxR);
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  _drawVessel(x, y, hdgScreen) {
    const { ctx, c } = this;
    ctx.save();
    ctx.translate(x, y);
    if (hdgScreen === null) {
      ctx.fillStyle = c.vessel;
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    ctx.rotate((hdgScreen * Math.PI) / 180);
    const grad = ctx.createLinearGradient(0, -16, 0, 14);
    grad.addColorStop(0, c.brand3);
    grad.addColorStop(0.5, c.brand2);
    grad.addColorStop(1, c.brand1);
    ctx.beginPath();
    ctx.moveTo(0, -17);
    ctx.bezierCurveTo(7, -9, 8, 2, 7, 13);
    ctx.lineTo(-7, 13);
    ctx.bezierCurveTo(-8, 2, -7, -9, 0, -17);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = c.vessel;
    ctx.stroke();
    ctx.fillStyle = c.onBrand;
    ctx.beginPath();
    ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawNorth(rot) {
    const { ctx, c } = this;
    const x = this.w - 26, y = this.h - 30; // bottom-right, clear of the controls
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((-rot * Math.PI) / 180);
    ctx.fillStyle = c.brand2;
    ctx.beginPath();
    ctx.moveTo(0, -12); ctx.lineTo(5, 2); ctx.lineTo(-5, 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = c.text3;
    ctx.beginPath();
    ctx.moveTo(0, 12); ctx.lineTo(5, 2); ctx.lineTo(-5, 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = c.text2;
    ctx.font = '700 10px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    const th = (-rot * Math.PI) / 180;
    ctx.fillText('N', x + Math.sin(th) * 20, y - Math.cos(th) * 20 + 4);
  }

  _drawScale() {
    const { ctx, c, mpp } = this;
    const m = niceStep(this.w * 0.22 * mpp);
    const px = m / mpp;
    const x = 16, y = 66; // top-left, under the mode tag (bottom is the skyhook readout)
    ctx.strokeStyle = c.text2;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5);
    ctx.stroke();
    ctx.fillStyle = c.text2;
    ctx.font = '700 11px "Plus Jakarta Sans", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(fmtDist(m), x, y - 9);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
