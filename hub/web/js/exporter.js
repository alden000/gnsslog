// Image exports (track, charts or a one-page report) as SVG, JPG or PNG, and data downloads.

import { CanvasPainter, SvgPainter } from './painter.js';
import { PALETTES } from './palette.js';
import { drawTrackScene, renderMap, mapAttribution, fitView } from './trackview.js';
import { drawCharts, chartsHeight, fmtClock, fmtElapsed } from './charts.js';

const pad2 = (v) => String(v).padStart(2, '0');
export function fmtDateTime(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtClock(t)}`;
}
export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  return fmtElapsed(Math.round(sec) * 1000);
}
export function fmtDistance(m) {
  if (!Number.isFinite(m)) return '—';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

export function safeName(s) {
  return (s || 'session').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'session';
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Time range for an export: 'view' (charts window), 'all' or 'selection'. */
function timeRange(ctx, range) {
  const { data } = ctx;
  if (range === 'selection' && ctx.sel) return ctx.sel;
  if (range === 'view') return ctx.charts.win;
  return [data.t0, data.t1];
}

/** Build the drawing for an export on painter p at logical size; returns nothing. */
async function compose(p, kind, ctx, o, size) {
  const pal = PALETTES[o.theme];
  const { data } = ctx;
  const [ta, tb] = timeRange(ctx, o.range);
  const sel = o.range === 'selection' ? ctx.sel : ctx.sel && o.range !== 'all' ? ctx.sel : null;
  const map = async (w, h, view) => {
    if (!o.map || ctx.mapLayer === 'off') return null;
    const canvas = await renderMap({ w, h, scale: o.raster ? o.scale : 2, center: view.center, mpp: view.mpp, frame: data.frame, layer: ctx.mapLayer, seamarks: ctx.seamarks, dark: o.theme === 'dark', waitMs: 8000 });
    return canvas ? { canvas, attribution: mapAttribution(ctx.mapLayer, ctx.seamarks) } : null;
  };
  const trackScene = (w, h, view, extra) => ({
    w, h, data, center: view.center, mpp: view.mpp, pal, sel, colorBy: ctx.colorBy, cursor: o.cursor ? ctx.cursor : null, speedUnit: ctx.speedUnit, ...extra,
  });
  const trackView = (w, h) => (o.range === 'view' ? { center: ctx.track.center, mpp: ctx.track.mpp * (ctx.track.w / w) } : fitView(data, w, h, ta, tb, 48)) || { center: { x: 0, y: 0 }, mpp: 1 };

  if (kind === 'track') {
    const view = trackView(size.w, size.h);
    drawTrackScene(p, trackScene(size.w, size.h, view, { map: await map(size.w, size.h, view), title: o.title ? ctx.name : null }));
    return;
  }

  if (kind === 'charts') {
    drawCharts(p, { w: size.w, data, panels: ctx.charts.panels, win: [ta, tb], sel: o.range === 'view' ? ctx.sel : null, cursor: o.cursor ? ctx.cursor : null, hover: null, pal, speedUnit: ctx.speedUnit, timeMode: ctx.timeMode, plotH: size.plotH });
    return;
  }

  // Report: title, stats, track, charts.
  const W = size.w;
  p.rect(0, 0, W, size.h, { fill: pal.bg });
  p.text(ctx.name, 32, 46, { fill: pal.text, size: 26, weight: 700, family: 'display' });
  const st = data.stats(ta, tb);
  const sub = [fmtDateTime(ta), `to ${fmtClock(tb)}`, ctx.device ? `Device ${ctx.device}` : null, o.range === 'selection' ? 'Selection' : null].filter(Boolean).join('  ·  ');
  p.text(sub, 32, 72, { fill: pal.text2, size: 13, weight: 500 });
  const k = ctx.speedUnit.k, u = ctx.speedUnit.label;
  const tiles = [
    ['Duration', fmtDuration(st.duration)],
    ['Distance', fmtDistance(st.distance)],
    ['Avg speed', st.avgSog === null ? '—' : `${(st.avgSog * k).toFixed(2)} ${u}`],
    ['Max speed', st.maxSog === null ? '—' : `${(st.maxSog * k).toFixed(2)} ${u}`],
    ['Moving time', fmtDuration(st.movingTime)],
    ['Closest to mark', st.minMarkDist === null ? '—' : fmtDistance(st.minMarkDist)],
  ];
  const tw = (W - 64 - (tiles.length - 1) * 12) / tiles.length;
  tiles.forEach(([label, value], i) => {
    const x = 32 + i * (tw + 12);
    p.rect(x, 96, tw, 64, { fill: pal.surface, stroke: pal.grid, width: 1, r: 12 });
    p.text(label, x + 14, 120, { fill: pal.text2, size: 11, weight: 600 });
    p.text(value, x + 14, 146, { fill: pal.text, size: 18, weight: 700, family: 'display' });
  });
  const trackH = size.trackH;
  const tvw = W - 64;
  const view = fitView(data, tvw, trackH, ta, tb, 48) || { center: { x: 0, y: 0 }, mpp: 1 };
  p.translate(32, 184);
  p.clip(0, 0, tvw, trackH);
  drawTrackScene(p, trackScene(tvw, trackH, view, { map: await map(tvw, trackH, view) }));
  p.end();
  p.end();
  p.rect(32, 184, tvw, trackH, { stroke: pal.grid, width: 1, r: 2 });
  p.translate(16, 184 + trackH + 24);
  drawCharts(p, { w: W - 32, data, panels: ctx.charts.panels, win: [ta, tb], sel: null, cursor: null, hover: null, pal, speedUnit: ctx.speedUnit, timeMode: ctx.timeMode, plotH: size.plotH, background: pal.bg });
  p.end();
  p.text(`GNSS Log Analyzer · exported ${fmtDateTime(Date.now())}`, W - 32, size.h - 18, { fill: pal.text3, size: 10, weight: 500, align: 'right' });
}

function sizeFor(kind, ctx) {
  if (kind === 'track') {
    const w = Math.max(ctx.track.w, 900), h = Math.max(ctx.track.h, 600);
    return { w: Math.round(w), h: Math.round(ctx.track.w >= 900 ? ctx.track.h : (w * 3) / 4) || h };
  }
  if (kind === 'charts') {
    const plotH = 120;
    return { w: Math.max(Math.round(ctx.charts.w), 1000), h: chartsHeight(ctx.charts.panels.length, plotH), plotH };
  }
  const plotH = 110, trackH = 720, w = 1400;
  return { w, h: 184 + trackH + 24 + chartsHeight(ctx.charts.panels.length, plotH) + 40, plotH, trackH };
}

/**
 * o: { kind: track|charts|report, format: svg|jpg|png, scale, theme: dark|light, range, map, cursor }
 * Returns { blob, filename }.
 */
export async function exportImage(ctx, o) {
  const size = sizeFor(o.kind, ctx);
  const base = `${safeName(ctx.name)}_${o.kind}`;
  if (o.format === 'svg') {
    const p = new SvgPainter(size.w, size.h);
    await compose(p, o.kind, ctx, { ...o, raster: false }, size);
    return { blob: new Blob([p.toString()], { type: 'image/svg+xml' }), filename: `${base}.svg` };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size.w * o.scale);
  canvas.height = Math.round(size.h * o.scale);
  const c2 = canvas.getContext('2d');
  c2.scale(o.scale, o.scale);
  await compose(new CanvasPainter(c2), o.kind, ctx, { ...o, raster: true }, size);
  const type = o.format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((r) => canvas.toBlob(r, type, 0.92));
  if (!blob) throw new Error('The browser could not encode the image (map tiles without CORS?)');
  return { blob, filename: `${base}.${o.format === 'png' ? 'png' : 'jpg'}` };
}

/** Download URL for a data extract. */
export function dataUrl(id, { format, t0, t1, every, cols }) {
  const q = new URLSearchParams();
  if (Number.isFinite(t0)) q.set('t0', Math.floor(t0));
  if (Number.isFinite(t1)) q.set('t1', Math.ceil(t1));
  if (every) q.set('every', every);
  if (cols && cols.length) q.set('cols', cols.join(','));
  const qs = q.toString();
  return `/api/sessions/${encodeURIComponent(id)}/export.${format}${qs ? `?${qs}` : ''}`;
}
