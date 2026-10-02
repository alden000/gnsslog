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
