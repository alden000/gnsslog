// The drawn track: a smooth curve through the phone's own GNSS fixes (centripetal Catmull-Rom,
// which passes through every fix without loops or overshoot). The position filter is for the
// live "now" estimate; afterwards the fixes themselves are the best record of where we were.
// Shared by the app (live trail, playback) and the Analyzer.

import { isPoor } from './quality.js';

const DUP_MS = 50; // fixes this close in time are copies (background service + in-app watcher)
const BREAK_MS = 15000; // no fix for longer than this: the line is broken, not bridged
const BREAK_SPEED = 80; // m/s: a step faster than this is a glitch, not travel
const STEP_M = 1.5; // curve points about this far apart
const MAX_SUB = 16; // ...but at most this many per fix-to-fix span

/**
 * One monotonic stream of fixes, like the position filter uses: in arrival (recorded) order, a
 * fix at or before the last one kept (+50 ms) is a copy from the second location stream, or a
 * straggler, and is dropped rather than slotted back in.
 * fixes: [{ t, x, y, acc, speed }] in arrival order.
 */
export function cleanFixes(fixes) {
  const out = [];
  for (const f of fixes) {
    if (!Number.isFinite(f.t) || !Number.isFinite(f.x) || !Number.isFinite(f.y)) continue;
    if (!out.length || f.t > out[out.length - 1].t + DUP_MS) out.push(f);
  }
  return out;
}

/**
 * Curve through cleaned fixes. Returns parallel arrays { t, x, y, speed, poor, brk, n }:
 * brk[i] = true where a new piece starts (after a long gap), poor[i] = the span ending at i is
 * between fixes without proper GNSS. t is interpolated, so the curve can be looked up by time.
 */
export function smoothTrack(fixes) {
  const L = { t: [], x: [], y: [], speed: [], poor: [], brk: [], n: 0 };
  const push = (t, x, y, speed, poor, brk) => {
    L.t.push(t);
    L.x.push(x);
    L.y.push(y);
    L.speed.push(speed);
    L.poor.push(poor);
    L.brk.push(brk);
    L.n++;
  };
  const n = fixes.length;
  const bad = fixes.map((f) => isPoor(f.acc, 0));
  // A span joins fixes i and i+1 unless there is a gap or a glitch between them.
  const joined = (i) => {
    const a = fixes[i], b = fixes[i + 1];
    const dt = (b.t - a.t) / 1000;
    return dt * 1000 <= BREAK_MS && Math.hypot(b.x - a.x, b.y - a.y) <= BREAK_SPEED * Math.max(dt, 1);
  };
  for (let i = 0; i < n; i++) {
    const f = fixes[i];
    const startsPiece = i === 0 || !joined(i - 1);
    push(f.t, f.x, f.y, f.speed, !startsPiece && (bad[i] || bad[i - 1]), startsPiece);
    if (i === n - 1 || !joined(i)) continue;
    const p1 = f, p2 = fixes[i + 1];
    const poor = bad[i] || bad[i + 1];
    // Neighbours shape the tangents only within the same piece and the same quality, so a
    // stretch of Wi-Fi positions cannot bend the good track next to it.
    const p0 = i > 0 && joined(i - 1) && bad[i - 1] === bad[i] ? fixes[i - 1] : null;
    const p3 = i + 2 < n && joined(i + 1) && bad[i + 2] === bad[i + 1] ? fixes[i + 2] : null;
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const sub = Math.min(MAX_SUB, Math.max(1, Math.ceil(len / STEP_M)));
    for (let k = 1; k < sub; k++) {
      const u = k / sub;
      const [x, y] = poor ? [p1.x + (p2.x - p1.x) * u, p1.y + (p2.y - p1.y) * u] : catmullRom(p0, p1, p2, p3, u);
      const sp = Number.isFinite(p1.speed) && Number.isFinite(p2.speed) ? p1.speed + (p2.speed - p1.speed) * u : NaN;
      push(p1.t + (p2.t - p1.t) * u, x, y, sp, poor, false);
    }
  }
  return L;
}

/** Centripetal Catmull-Rom between p1 and p2 at u in [0, 1]; missing ends are mirrored. */
function catmullRom(p0, p1, p2, p3, u) {
  const P0 = p0 || { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
  const P3 = p3 || { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
  const knot = (a, b) => Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-6); // alpha = 0.5
  const t1 = knot(P0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, P3);
  const t = t1 + (t2 - t1) * u;
  const lerp = (a, b, ta, tb) => {
    const w = (t - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  const A1 = lerp(P0, p1, 0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, P3, t2, t3);
  const B1 = lerp(A1, A2, 0, t2), B2 = lerp(A2, A3, t1, t3);
  const C = lerp(B1, B2, t1, t2);
  return [C.x, C.y];
}

/** Index of the last curve point with t <= time (-1 before the start). */
export function lineIndex(L, time) {
  let lo = 0, hi = L.n - 1;
  if (!L.n || time < L.t[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (L.t[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Position on the curve at time t, or null outside it / inside a gap. */
export function lineAt(L, time) {
  const i = lineIndex(L, time);
  if (i < 0) return null;
  if (i === L.n - 1) return time - L.t[i] <= 1500 ? { x: L.x[i], y: L.y[i] } : null;
  if (L.brk[i + 1]) return time - L.t[i] <= 1500 ? { x: L.x[i], y: L.y[i] } : null;
  const w = (time - L.t[i]) / Math.max(L.t[i + 1] - L.t[i], 1);
  return { x: L.x[i] + (L.x[i + 1] - L.x[i]) * w, y: L.y[i] + (L.y[i + 1] - L.y[i]) * w };
}
