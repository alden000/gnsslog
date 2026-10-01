import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawTileLayer, MAP_SOURCES } from '../js/maptiles.js';
import { LocalFrame } from '../js/geo.js';

// Records drawImage destination rects (in the canvas frame after translate to centre).
function mockCtx() {
  return { draws: [], save() {}, restore() {}, translate() {}, rotate() {}, drawImage(img, ...a) { this.draws.push({ url: img.url, d: a.length === 4 ? a : a.slice(4) }); } };
}
const cache = { get: (url) => ({ url, naturalWidth: 256, naturalHeight: 256 }), peek: () => null };

for (const [lat, lon, mpp] of [[1.2952, 103.7923, 0.3], [1.4223, 103.7951, 5], [59.91, 10.75, 1.2]]) {
  test(`tiles line up with the local frame at ${lat},${lon} (${mpp} m/px)`, () => {
    const geo = new LocalFrame(lat - 0.001, lon + 0.002); // frame origin away from the view centre
    const center = geo.toXY(lat, lon);
    const ctx = mockCtx();
    drawTileLayer(ctx, cache, MAP_SOURCES.satellite, { geo, center, mpp, rot: 0, w: 400, h: 600, dpr: 1 });
    assert.ok(ctx.draws.length > 0);
    // A test point 60 px NE of centre: where it lands in its tile must match web-mercator maths.
    const p = geo.toLatLon(center.x + 60 * mpp, center.y + 60 * mpp);
    const u = ctx.draws[0].url.match(/tile\/(\d+)\/(\d+)\/(\d+)/).slice(1).map(Number);
    const z = u[0], n = 2 ** z;
    const X = ((p.lon + 180) / 360) * n;
    const Y = ((1 - Math.log(Math.tan((p.lat * Math.PI) / 180) + 1 / Math.cos((p.lat * Math.PI) / 180)) / Math.PI) / 2) * n;
    const tile = ctx.draws.find((d) => d.url.endsWith(`/${z}/${Math.floor(Y)}/${Math.floor(X)}`));
    assert.ok(tile, 'tile containing the point is drawn');
    const [dx, dy, dw, dh] = tile.d;
    const sx = dx + 0.25 + (X - Math.floor(X)) * (dw - 0.5);
    const sy = dy + 0.25 + (Y - Math.floor(Y)) * (dh - 0.5);
    assert.ok(Math.abs(sx - 60) < 0.6 && Math.abs(sy + 60) < 0.6, `point at (${sx.toFixed(2)}, ${sy.toFixed(2)}) expected (60, -60)`);
    // Zoom picks the sharpest sensible level: each 256 px tile is drawn 128-256 screen px wide,
    // i.e. at least one tile pixel per screen pixel.
    assert.ok(dw > 127 && dw <= 257, `tile drawn ${dw.toFixed(0)} px wide`);
  });
}
