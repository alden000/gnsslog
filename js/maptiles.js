// Map backgrounds for the visualiser: standard web-mercator XYZ tiles drawn into the same canvas
// as the track. Each tile's corners are converted into the visualiser's local East/North frame,
// so the map lines up with the breadcrumbs exactly (and rotates with heading-up mode).

import { D2R, R2D } from './geo.js';

export const MAP_SOURCES = {
  street: {
    // Esri World Street Map (no key needed). In dark theme it is drawn colour-inverted.
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    darkFilter: 'invert(1) hue-rotate(180deg) brightness(0.95) contrast(0.85)',
    attribution: 'Map © Esri, HERE, Garmin, OpenStreetMap contributors',
    link: 'https://www.esri.com/en-us/legal/terms/full-master-agreement',
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    link: 'https://www.esri.com/en-us/legal/terms/full-master-agreement',
  },
};

export const SEAMARKS = {
  url: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
  maxZoom: 18,
  attribution: '© OpenSeaMap',
  link: 'https://openseamap.org',
};

const EARTH_CIRC = 2 * Math.PI * 6378137;
const MAX_TILES = 400; // in-memory images kept
const RETRY_MS = 30000;

/** Small LRU of tile images; requests a tile the first time it is asked for. */
export class TileCache {
  constructor() {
    this.map = new Map(); // url -> { img, ok, failedAt }
  }

  get(url) {
    let e = this.map.get(url);
    if (e) {
      this.map.delete(url); // refresh LRU position
      this.map.set(url, e);
      if (e.failedAt && Date.now() - e.failedAt > RETRY_MS) e = null;
      else return e.ok ? e.img : null;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous'; // CORS requests so the service worker can cache them
    img.decoding = 'async';
    const entry = { img, ok: false, failedAt: 0 };
    img.onload = () => (entry.ok = true);
    img.onerror = () => (entry.failedAt = Date.now());
    img.src = url;
    this.map.set(url, entry);
    if (this.map.size > MAX_TILES) this.map.delete(this.map.keys().next().value);
    return null;
  }

  /** Already-loaded image for url, without requesting it. */
  peek(url) {
    const e = this.map.get(url);
    return e && e.ok ? e.img : null;
  }
}

function tileUrl(src, z, x, y, dark, dpr) {
  const tpl = src.url || (dark ? src.dark : src.light);
  const s = src.subdomains ? src.subdomains[(x + y) % src.subdomains.length] : '';
  return tpl
    .replace('{s}', s)
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y)
    .replace('{r}', src.retina && dpr >= 1.5 ? '@2x' : '');
}

const lonToX = (lon, n) => ((lon + 180) / 360) * n;
const latToY = (lat, n) => ((1 - Math.log(Math.tan(lat * D2R) + 1 / Math.cos(lat * D2R)) / Math.PI) / 2) * n;
const xToLon = (x, n) => (x / n) * 360 - 180;
const yToLat = (y, n) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * R2D;

/**
 * Draw one tile layer.
 * view: { geo: LocalFrame, center: {x, y} (local metres), mpp, rot (deg), w, h, dpr }
 */
export function drawTileLayer(ctx, cache, src, view, { dark = false, alpha = 1 } = {}) {
  const { geo, center, mpp, rot, w, h, dpr } = view;
  const c = geo.toLatLon(center.x, center.y);
  if (!Number.isFinite(c.lat) || Math.abs(c.lat) > 85) return;
  const cosLat = Math.cos(c.lat * D2R);

  // Zoom whose tiles are at least as sharp as the screen, capped by the source.
  let z = Math.ceil(Math.log2((EARTH_CIRC * cosLat) / (256 * mpp)));
  z = Math.max(0, Math.min(src.maxZoom, z));

  const radius = (Math.hypot(w, h) / 2) * mpp; // metres covered (any rotation)
  const dLat = (radius / 111320) * 1.05;
  const dLon = (radius / (111320 * Math.max(cosLat, 0.01))) * 1.05;
  let n, x0, x1, y0, y1;
  for (;;) {
    n = 2 ** z;
    x0 = Math.floor(lonToX(c.lon - dLon, n));
    x1 = Math.floor(lonToX(c.lon + dLon, n));
    y0 = Math.floor(latToY(Math.min(85, c.lat + dLat), n));
    y1 = Math.floor(latToY(Math.max(-85, c.lat - dLat), n));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 80 || z === 0) break;
    z--; // very large view: fewer, coarser tiles
  }

  const cx = w / 2, cy = h / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (dark && src.darkFilter) ctx.filter = src.darkFilter; // no-op where canvas filters are unsupported
  ctx.translate(cx, cy);
  ctx.rotate((-rot * Math.PI) / 180);
  ctx.imageSmoothingEnabled = true;
  for (let ty = Math.max(0, y0); ty <= Math.min(n - 1, y1); ty++) {
    for (let txRaw = x0; txRaw <= x1; txRaw++) {
      const tx = ((txRaw % n) + n) % n;
      // Tile corners -> local metres -> unrotated screen offsets from the centre.
      const nw = geo.toXY(yToLat(ty, n), xToLon(txRaw, n));
      const se = geo.toXY(yToLat(ty + 1, n), xToLon(txRaw + 1, n));
      const sx = (nw.x - center.x) / mpp, sy = -(nw.y - center.y) / mpp;
      const ex = (se.x - center.x) / mpp, ey = -(se.y - center.y) / mpp;
      const dw = ex - sx, dh = ey - sy;
      const img = cache.get(tileUrl(src, z, tx, ty, dark, dpr));
      if (img) {
        ctx.drawImage(img, sx - 0.25, sy - 0.25, dw + 0.5, dh + 0.5);
        continue;
      }
      // Not loaded yet: stretch an already-loaded parent tile so the map never flashes empty.
      for (let k = 1; k <= 4 && z - k >= 0; k++) {
        const p = cache.peek(tileUrl(src, z - k, tx >> k, ty >> k, dark, dpr));
        if (!p) continue;
        const f = 2 ** k;
        const sw = p.naturalWidth / f, sh = p.naturalHeight / f;
        ctx.drawImage(p, (tx % f) * sw, (ty % f) * sh, sw, sh, sx - 0.25, sy - 0.25, dw + 0.5, dh + 0.5);
        break;
      }
    }
  }
  ctx.restore();
}
