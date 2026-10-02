// One small drawing API with two back ends, so the screen, JPG/PNG and SVG exports share the
// same drawing code:
//   CanvasPainter  -> a 2D canvas (screen, raster export)
//   SvgPainter     -> an SVG document string (vector export)
//
// Styles: { fill, stroke, width, dash: [..], alpha, cap, join, r (corner radius) }
// Text:   { fill, size, weight, family: 'body'|'display', align: left|center|right,
//           baseline: top|middle|bottom|alphabetic, halo (colour), haloWidth }
// Polylines take flat [x0, y0, x1, y1, ...] arrays; a NaN coordinate breaks the line.

import { FONT_BODY, FONT_DISPLAY } from './palette.js';

const fontOf = (st) => `${st.weight || 500} ${st.size || 12}px ${st.family === 'display' ? FONT_DISPLAY : FONT_BODY}`;

let measureCtx = null;
export function measureText(s, st = {}) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = fontOf(st);
  return measureCtx.measureText(String(s)).width;
}

export class CanvasPainter {
  constructor(ctx) {
    this.ctx = ctx;
  }

  _style(st) {
    const c = this.ctx;
    c.globalAlpha = st.alpha ?? 1;
    if (st.stroke) {
      c.strokeStyle = st.stroke;
      c.lineWidth = st.width ?? 1;
      c.setLineDash(st.dash || []);
      c.lineCap = st.cap || 'round';
      c.lineJoin = st.join || 'round';
    }
    if (st.fill) c.fillStyle = st.fill;
  }

  _finish(st) {
    const c = this.ctx;
    if (st.fill) c.fill();
    if (st.stroke) c.stroke();
    c.globalAlpha = 1;
    c.setLineDash([]);
  }

  rect(x, y, w, h, st = {}) {
    const c = this.ctx;
    this._style(st);
    c.beginPath();
    if (st.r) c.roundRect(x, y, w, h, st.r);
    else c.rect(x, y, w, h);
    this._finish(st);
  }

  line(x1, y1, x2, y2, st = {}) {
    this.poly([x1, y1, x2, y2], st);
  }

  poly(pts, st = {}) {
    const c = this.ctx;
    this._style(st);
    c.beginPath();
    let pen = false;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        pen = false;
        continue;
      }
      if (pen) c.lineTo(x, y);
      else c.moveTo(x, y);
      pen = true;
    }
    if (st.close) c.closePath();
    this._finish(st);
  }

  circle(x, y, r, st = {}) {
    const c = this.ctx;
    this._style(st);
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    this._finish(st);
  }

  text(s, x, y, st = {}) {
    const c = this.ctx;
    c.font = fontOf(st);
    c.textAlign = st.align || 'left';
    c.textBaseline = st.baseline || 'alphabetic';
    c.globalAlpha = st.alpha ?? 1;
    if (st.halo) {
      c.lineJoin = 'round';
      c.lineWidth = st.haloWidth ?? 3;
      c.strokeStyle = st.halo;
      c.setLineDash([]);
      c.strokeText(String(s), x, y);
    }
    c.fillStyle = st.fill || '#000';
    c.fillText(String(s), x, y);
    c.globalAlpha = 1;
  }

  image(src, x, y, w, h, alpha = 1) {
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(src, x, y, w, h);
    this.ctx.globalAlpha = 1;
  }

  clip(x, y, w, h) {
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(x, y, w, h);
    this.ctx.clip();
  }

  translate(x, y) {
    this.ctx.save();
    this.ctx.translate(x, y);
  }

  end() {
    this.ctx.restore();
  }
}

const n = (v) => (Math.round(v * 100) / 100).toString();
const escXml = (s) => String(s).replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]);

function svgColor(c) {
  // rgba(...) is valid in SVG 2 renderers but split it for the widest support.
  const m = /^rgba\(([^)]+)\)$/.exec(c || '');
  if (!m) return { c: c || 'none', a: 1 };
  const p = m[1].split(',').map((s) => s.trim());
  return { c: `rgb(${p[0]},${p[1]},${p[2]})`, a: Number(p[3]) };
}

export class SvgPainter {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.out = [];
    this.defs = [];
    this.clipN = 0;
    this.stack = [];
  }

  _attrs(st) {
    const a = [];
    const al = st.alpha ?? 1;
    if (st.fill) {
      const f = svgColor(st.fill);
      a.push(`fill="${f.c}"`);
      if (f.a * al < 1) a.push(`fill-opacity="${n(f.a * al)}"`);
    } else a.push('fill="none"');
    if (st.stroke) {
      const s = svgColor(st.stroke);
      a.push(`stroke="${s.c}"`, `stroke-width="${n(st.width ?? 1)}"`, `stroke-linecap="${st.cap || 'round'}"`, `stroke-linejoin="${st.join || 'round'}"`);
      if (s.a * al < 1) a.push(`stroke-opacity="${n(s.a * al)}"`);
      if (st.dash && st.dash.length) a.push(`stroke-dasharray="${st.dash.join(' ')}"`);
    }
    return a.join(' ');
  }

  rect(x, y, w, h, st = {}) {
    const r = st.r ? ` rx="${n(st.r)}"` : '';
    this.out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${r} ${this._attrs(st)}/>`);
  }

  line(x1, y1, x2, y2, st = {}) {
    this.poly([x1, y1, x2, y2], st);
  }

  poly(pts, st = {}) {
    let d = '';
    let pen = false;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${n(x)} ${n(y)}`;
      pen = true;
    }
    if (!d) return;
    if (st.close) d += 'Z';
    this.out.push(`<path d="${d}" ${this._attrs(st)}/>`);
  }

  circle(x, y, r, st = {}) {
    this.out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" ${this._attrs(st)}/>`);
  }

  text(s, x, y, st = {}) {
    const anchor = { left: 'start', center: 'middle', right: 'end' }[st.align || 'left'];
    const base = { top: 'hanging', middle: 'central', bottom: 'text-after-edge', alphabetic: 'alphabetic' }[st.baseline || 'alphabetic'];
    const family = st.family === 'display' ? FONT_DISPLAY : FONT_BODY;
    const f = svgColor(st.fill || '#000');
    const common = `x="${n(x)}" y="${n(y)}" font-family="${escXml(family)}" font-size="${st.size || 12}" font-weight="${st.weight || 500}" text-anchor="${anchor}" dominant-baseline="${base}"`;
    const op = (st.alpha ?? 1) * f.a < 1 ? ` opacity="${n((st.alpha ?? 1) * f.a)}"` : '';
    if (st.halo) {
      const h = svgColor(st.halo);
      this.out.push(`<text ${common} fill="none" stroke="${h.c}" stroke-opacity="${n(h.a)}" stroke-width="${st.haloWidth ?? 3}" stroke-linejoin="round"${op}>${escXml(s)}</text>`);
    }
    this.out.push(`<text ${common} fill="${f.c}"${op}>${escXml(s)}</text>`);
  }

  /** Raster content (map tiles): embedded as a data URL. */
  image(src, x, y, w, h, alpha = 1) {
    let href = src.src;
    if (src instanceof HTMLCanvasElement) href = src.toDataURL(src.dataset.jpeg ? 'image/jpeg' : 'image/png', 0.85);
    this.out.push(`<image x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" href="${href}" preserveAspectRatio="none"${alpha < 1 ? ` opacity="${n(alpha)}"` : ''}/>`);
  }

  clip(x, y, w, h) {
    const id = `c${++this.clipN}`;
    this.defs.push(`<clipPath id="${id}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"/></clipPath>`);
    this.out.push(`<g clip-path="url(#${id})">`);
  }

  translate(x, y) {
    this.out.push(`<g transform="translate(${n(x)} ${n(y)})">`);
  }

  end() {
    this.out.push('</g>');
  }

  toString() {
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}">`,
      this.defs.length ? `<defs>${this.defs.join('')}</defs>` : '',
      ...this.out,
      '</svg>',
    ].join('\n');
  }
}
