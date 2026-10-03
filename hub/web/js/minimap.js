// Track thumbnails for the session list: the simplified track (stats.track) on the chosen map
// layer, fitted into a small canvas, with start and end dots.

import { LocalFrame } from '../../../js/geo.js';
import { MAP_SOURCES, drawTileLayer } from '../../../js/maptiles.js';
import { tileCache } from './trackview.js';

const PAD = 9; // px around the track
const MIN_SPAN = 80; // m: a stationary session still shows its surroundings

export function drawMiniMap(canvas, track, { pal, layer = 'off', dark = true } = {}) {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, r.width), h = Math.max(1, r.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = pal.surface2;
  ctx.fillRect(0, 0, w, h);

  const n = (track?.length ?? 0) / 2;
  if (n < 1) {
    ctx.fillStyle = pal.text3;
    ctx.font = `600 10px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No position', w / 2, h / 2);
    return;
  }
  const frame = new LocalFrame(track[0], track[1]);
  const xy = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < track.length; i += 2) {
    const p = frame.toXY(track[i], track[i + 1]);
    xy.push(p.x, p.y);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const spanX = Math.max(maxX - minX, MIN_SPAN), spanY = Math.max(maxY - minY, MIN_SPAN);
  const mpp = Math.max(spanX / (w - 2 * PAD), spanY / (h - 2 * PAD));

  const src = MAP_SOURCES[layer];
  if (src) {
    drawTileLayer(ctx, tileCache, src, { geo: frame, center, mpp, rot: 0, w, h, dpr }, { dark });
    ctx.fillStyle = pal.bg; // soften so the track stands out
    ctx.globalAlpha = layer === 'satellite' ? 0.18 : 0.12;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  } else {
    // a faint grid instead of a map
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1;
    for (let gx = 0.5; gx < w; gx += 16) (ctx.beginPath(), ctx.moveTo(gx, 0), ctx.lineTo(gx, h), ctx.stroke());
    for (let gy = 0.5; gy < h; gy += 16) (ctx.beginPath(), ctx.moveTo(0, gy), ctx.lineTo(w, gy), ctx.stroke());
  }

  const sx = (x) => w / 2 + (x - center.x) / mpp;
  const sy = (y) => h / 2 - (y - center.y) / mpp;
  const path = () => {
    ctx.beginPath();
    for (let i = 0; i < xy.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, sx(xy[i]), sy(xy[i + 1]));
  };
  ctx.lineJoin = ctx.lineCap = 'round';
  if (src) {
    path();
    ctx.strokeStyle = pal.halo;
    ctx.lineWidth = 4.5;
    ctx.stroke();
  }
  path();
  ctx.strokeStyle = pal.trail;
  ctx.lineWidth = 2;
  ctx.stroke();
  // start (ring) and end (filled) dots
  const dot = (i, fill) => {
    ctx.beginPath();
    ctx.arc(sx(xy[i]), sy(xy[i + 1]), 3.2, 0, Math.PI * 2);
    ctx.fillStyle = fill ? pal.brand2 : pal.bg;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = fill ? pal.bg : pal.text;
    ctx.stroke();
  };
  dot(0, false);
  if (xy.length > 2) dot(xy.length - 2, true);
}
