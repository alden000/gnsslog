// Session statistics, shared by the hub server (session list) and the analyser (selections).
// Pure functions over column arrays; no DOM.

import { haversine } from '../../../js/geo.js';

const MIN_STEP = 3; // m: distance counts only once the position has moved this far (GNSS jitter)
const GAP_MS = 5000; // a longer gap (pause, lost fix) is not travelled distance

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * cols: { t, lat, lon, sog, markDist? } arrays of equal length (null/NaN allowed).
 * i0..i1 inclusive index range (defaults to everything).
 */
export function computeStats(cols, i0 = 0, i1 = (cols.t?.length ?? 0) - 1) {
  const out = {
    samples: 0, start: null, end: null, duration: 0,
    distance: 0, maxSog: null, avgSog: null, movingTime: 0,
    bbox: null, minMarkDist: null, maxMarkDist: null,
  };
  if (!cols.t || i1 < i0) return out;
  const { t, lat, lon, sog, markDist } = cols;
  let anchor = null;
  let sogSum = 0, sogN = 0;
  let prevT = null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const ti = num(t[i]);
    if (!Number.isFinite(ti)) continue;
    out.samples++;
    if (out.start === null) out.start = ti;
    out.end = ti;
    const s = sog ? num(sog[i]) : NaN;
    if (Number.isFinite(s)) {
      sogSum += s;
      sogN++;
      if (out.maxSog === null || s > out.maxSog) out.maxSog = s;
      if (s > 0.5 && prevT !== null && ti - prevT < GAP_MS) out.movingTime += (ti - prevT) / 1000;
    }
    const la = lat ? num(lat[i]) : NaN, lo = lon ? num(lon[i]) : NaN;
    if (Number.isFinite(la) && Number.isFinite(lo)) {
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
      if (lo < minLon) minLon = lo;
      if (lo > maxLon) maxLon = lo;
      if (!anchor || ti - anchor.t > GAP_MS * 6) anchor = { lat: la, lon: lo, t: ti };
      else {
        const d = haversine(anchor.lat, anchor.lon, la, lo);
        if (d >= MIN_STEP) {
          out.distance += d;
          anchor = { lat: la, lon: lo, t: ti };
        } else anchor.t = ti;
      }
    }
    const md = markDist ? num(markDist[i]) : NaN;
    if (Number.isFinite(md)) {
      if (out.minMarkDist === null || md < out.minMarkDist) out.minMarkDist = md;
      if (out.maxMarkDist === null || md > out.maxMarkDist) out.maxMarkDist = md;
    }
    prevT = ti;
  }
  out.duration = out.start === null ? 0 : (out.end - out.start) / 1000;
  out.avgSog = sogN ? sogSum / sogN : null;
  if (minLat <= maxLat) out.bbox = [minLat, minLon, maxLat, maxLon];
  return out;
}

/**
 * A small version of the track for thumbnails: at most `maxPts` points as a flat
 * [lat, lon, lat, lon, ...] array (6 decimals, ~0.1 m), simplified with Ramer-Douglas-Peucker
 * so corners survive and straight runs collapse.
 */
export function simplifyTrack(lat, lon, maxPts = 150) {
  const pts = [];
  for (let i = 0; i < (lat?.length ?? 0); i++) {
    const a = num(lat[i]), o = num(lon[i]);
    if (Number.isFinite(a) && Number.isFinite(o)) pts.push([a, o]);
  }
  if (pts.length < 2) return pts.length ? [round6(pts[0][0]), round6(pts[0][1])] : [];
  // Equirectangular metres around the first point (plenty for a thumbnail).
  const k = Math.cos((pts[0][0] * Math.PI) / 180) * 111320;
  let xy = pts.map(([a, o]) => [(o - pts[0][1]) * k, (a - pts[0][0]) * 111320]);
  let src = pts;
  if (xy.length > 6000) {
    const n = xy.length; // fixed before filtering: both arrays must keep the same indices
    const step = Math.ceil(n / 6000);
    const keep = (_, i) => i % step === 0 || i === n - 1;
    xy = xy.filter(keep);
    src = src.filter(keep);
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of xy) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  let eps = Math.max(0.5, Math.hypot(maxX - minX, maxY - minY) / 300);
  let idx;
  for (let tries = 0; tries < 12; tries++) {
    idx = rdp(xy, eps);
    if (idx.length <= maxPts) break;
    eps *= 1.6;
  }
  const out = [];
  for (const i of idx) out.push(round6(src[i][0]), round6(src[i][1]));
  return out;
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

function rdp(xy, eps) {
  const keep = new Uint8Array(xy.length);
  keep[0] = keep[xy.length - 1] = 1;
  const stack = [[0, xy.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    let best = -1, bestD = eps;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      const d = len > 1e-9 ? Math.abs(dy * px - dx * py + bx * ay - by * ax) / len : Math.hypot(px - ax, py - ay);
      if (d > bestD) (bestD = d), (best = i);
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const idx = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) idx.push(i);
  return idx;
}
