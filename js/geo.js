// Geodesy helpers: WGS84 local tangent-plane projection (x = East, y = North, metres),
// great-circle distance and angle wrapping. Accurate to centimetres over a few km,
// which is all a vessel-scale visualiser and skyhook distance need.

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

/** Meridional (M) and prime-vertical (N) radii of curvature at a latitude. */
export function radii(latDeg) {
  const s = Math.sin(latDeg * D2R);
  const w = 1 - E2 * s * s;
  const N = A / Math.sqrt(w);
  const M = (A * (1 - E2)) / (w * Math.sqrt(w));
  return { M, N };
}

/** Local East/North frame anchored at (lat0, lon0). */
export class LocalFrame {
  constructor(lat0, lon0) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    const { M, N } = radii(lat0);
    this.mPerDegLat = M * D2R;
    this.mPerDegLon = N * Math.cos(lat0 * D2R) * D2R;
  }

  toXY(lat, lon) {
    return {
      x: wrap180(lon - this.lon0) * this.mPerDegLon,
      y: (lat - this.lat0) * this.mPerDegLat,
    };
  }

  toLatLon(x, y) {
    return {
      lat: this.lat0 + y / this.mPerDegLat,
      lon: wrap180(this.lon0 + x / this.mPerDegLon),
    };
  }
}

/** Haversine great-circle distance in metres (mean earth radius). */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Bearing (degrees clockwise from north) of a planar vector. */
export function bearingXY(dx, dy) {
  return wrap360(Math.atan2(dx, dy) * R2D);
}

export function wrap360(deg) {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

export function wrap180(deg) {
  const d = wrap360(deg + 180) - 180;
  return d === -180 ? 180 : d;
}
