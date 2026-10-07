// End-to-end smoke test: simulated GNSS + compass/gyro on a phone-sized Chromium.
// Records a test case, marks a location, uploads to the hub (hub/server.mjs), opens playback.
// Usage: node tests/e2e/smoke.mjs [outDir]   (writes screenshots to outDir)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import qrcode from '../../hub/web/js/vendor/qrcode.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const out = process.argv[2] || join(tmpdir(), 'gnsslog-shots');
mkdirSync(out, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'gnsslog-recv-'));
const procs = [
  spawn('node', ['server/dev-server.mjs', '8091'], { stdio: 'ignore' }),
  spawn('node', ['--disable-warning=ExperimentalWarning', 'hub/server.mjs'], { stdio: 'ignore', env: { ...process.env, HUB_DATA: data, HUB_PORT: '8792', HUB_INGEST_TOKEN: 'smoke-token' } }),
];
const cleanup = () => {
  procs.forEach((p) => p.kill());
  rmSync(data, { recursive: true, force: true });
};
await new Promise((r) => setTimeout(r, 700));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const errors = [];
let mover = null; // moves the simulated position; always cleared in finally
try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: process.env.THEME || 'dark',
    permissions: ['geolocation'],
    geolocation: { latitude: 1.264, longitude: 103.84, accuracy: 3 },
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // Web fonts are optional (system fallbacks); keep the test hermetic.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.addInitScript(() => {
    window.__vibes = [];
    navigator.vibrate = (p) => (window.__vibes.push(p), true);
  });
  await page.goto('http://localhost:8091/');

  // Simulated compass (heading 045°, flat phone) + small gyro yaw at 20 Hz.
  await page.evaluate(() => {
    setInterval(() => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 315, beta: 2, gamma: -1, absolute: true }));
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: 0.05, beta: 0, gamma: 0 }, interval: 50 }));
    }, 50);
  });

  // Vessel moves north-east ~1 m/s, 1 Hz fixes.
  let k = 0;
  mover = setInterval(() => {
    k++;
    ctx.setGeolocation({ latitude: 1.264 + k * 0.0000064, longitude: 103.84 + k * 0.0000064, accuracy: 3 }).catch(() => {});
  }, 1000);

  await page.waitForFunction(() => document.querySelector('#r-pos').textContent.includes('°N'), null, { timeout: 10000 });
  assert.equal(await page.isDisabled('#viz-mode'), true, 'no mark yet: centring is fixed on the vessel');
  assert.match(await page.textContent('#title-version'), /^v\d+\.\d+\.\d+$/, 'version shown next to the title');
  // Tapping the north marker toggles north-up / heading-up (and back).
  await page.click('#btn-north');
  assert.equal(await page.evaluate(() => window.gnsslog.settings.get('orientUp')), 'heading');
  assert.equal(await page.textContent('#btn-orient'), 'H↑');
  await page.click('#btn-north');
  assert.equal(await page.evaluate(() => window.gnsslog.settings.get('orientUp')), 'north');
  await sleep(1500);
  await page.screenshot({ path: join(out, '1-live.png') });

  // Start a recording.
  await page.click('#btn-rec');
  await page.fill('#new-name', 'E2E run');
  await page.click('#new-start');
  await sleep(2000);
  await page.click('#btn-sky');
  await sleep(4000);
  await page.screenshot({ path: join(out, '2-mark.png') });
  const skyText = await page.textContent('#sky-dist');
  assert.match(skyText, /m$/, 'mark distance shown');
  // Centring toggle: enabled once a location is marked, switches between mark and vessel.
  assert.equal(await page.textContent('#viz-mode'), 'Mark centred');
  await page.click('#viz-mode');
  await sleep(1200);
  assert.equal(await page.textContent('#viz-mode'), 'Vessel centred');
  await page.screenshot({ path: join(out, '2b-vessel-centred.png') });
  await page.click('#viz-mode');
  assert.equal(await page.textContent('#viz-mode'), 'Mark centred');

  // Clear trail is display-only: recording continues and no samples are lost.
  const seqBefore = await page.evaluate(() => window.gnsslog.recorder.seq);
  await page.click('#btn-trail-clear');
  await page.waitForSelector('#sheet:not([hidden]) [data-act="ok"]');
  await page.screenshot({ path: join(out, '2d-clear-confirm.png') });
  await page.click('[data-act="ok"]');
  await sleep(1000);
  const seqAfter = await page.evaluate(() => window.gnsslog.recorder.seq);
  assert.ok(seqAfter >= seqBefore + 4, `still recording after clearing the trail (${seqBefore} -> ${seqAfter})`);
  await page.screenshot({ path: join(out, '2c-trail-cleared.png') });
  await page.click('#btn-sky-clear');
  await sleep(1200);
  await page.click('#btn-rec');
  await page.click('[data-act="stop"]');
  await sleep(500);
  clearInterval(mover);

  const info = await page.evaluate(async () => {
    const { db } = window.gnsslog;
    const [s] = await db.listSessions();
    const rows = await db.getSamples(s.id);
    const dts = rows.slice(1).map((r, i) => r.t - rows[i].t);
    return {
      name: s.name,
      count: rows.length,
      durS: (s.endedAt - s.startedAt) / 1000,
      meanDt: dts.reduce((a, b) => a + b, 0) / dts.length,
      events: s.events.map((e) => e.type),
      hdg: rows.at(-1).hdg,
      hasXY: rows.at(-1).x !== null,
      sky: rows.find((r) => r.markDist !== null)?.markDist,
      markEvents: rows.filter((r) => r.markEvent).map((r) => `${r.seq}:${r.markEvent}`),
      markActive: rows.map((r) => r.markActive).join(''),
      markRow: (() => {
        const m = rows.find((r) => r.markEvent === 'mark');
        return m && { active: m.markActive, lat: m.markLat, prevActive: rows[m.seq - 1].markActive, eventSeq: s.events.find((e) => e.type === 'mark').seq, seq: m.seq };
      })(),
    };
  });
  console.log('session', info);
  assert.equal(info.name, 'E2E run');
  assert.ok(Math.abs(info.meanDt - 200) < 15, `mean sample interval ${info.meanDt} ms`);
  assert.ok(info.count >= info.durS * 5 * 0.9, 'about 5 samples per second');
  assert.deepEqual(info.events, ['start', 'mark', 'mark_clear', 'stop']);
  assert.equal(info.markEvents.length, 2, `sky events ${info.markEvents}`);
  assert.match(info.markEvents.join(' '), /^\d+:mark \d+:clear$/);
  assert.match(info.markActive, /^0+1+0+$/, 'active only between mark and clear');
  assert.equal(info.markRow.seq, info.markRow.eventSeq, 'mark flagged on the event row');
  assert.equal(info.markRow.active, 1);
  assert.equal(info.markRow.prevActive, 0);
  assert.ok(info.markRow.lat > 1.26);
  assert.ok(Math.abs(info.hdg - 45) < 3, `heading ${info.hdg}`);
  assert.ok(info.sky > 0);

  // Cloud upload to the hub.
  await page.click('.dock-tab[data-tab="settings"]');
  await sleep(400);
  await page.screenshot({ path: join(out, '4-settings.png'), fullPage: false });
  // Pair: the analyser makes a one-time code (local request, no Access), the phone types it.
  assert.equal(await page.isVisible('#btn-pair-scan'), false, 'no QR scanner in the web app');
  const pc = await (await fetch('http://localhost:8792/api/devices/pair', { method: 'POST' })).json();
  await page.click('#btn-pair-code');
  await sleep(400);
  await page.fill('#pair-host', 'http://localhost:8792');
  await page.fill('#pair-code', pc.display.toLowerCase());
  await page.fill('#pair-name', 'Smoke phone');
  await page.screenshot({ path: join(out, '4b-pair.png') });
  await page.click('#sheet [data-act="ok"]');
  await page.waitForFunction(() => /Paired with localhost:8792 as "Smoke phone"/.test(document.querySelector('#pair-status').textContent), null, { timeout: 5000 });
  assert.equal(await page.isVisible('#btn-unpair'), true);
  const devs = await (await fetch('http://localhost:8792/api/devices')).json();
  assert.deepEqual(devs.devices.map((d) => d.name), ['Smoke phone']);

  // Unpair, then pair again from a picture: a phone-sized dark screenshot with the QR code in it.
  await page.click('#btn-unpair');
  await page.click('#sheet [data-act="ok"]');
  await page.waitForFunction(() => /Not paired/.test(document.querySelector('#pair-status').textContent));
  const pc2 = await (await fetch('http://localhost:8792/api/devices/pair', { method: 'POST' })).json();
  const shot = join(out, 'pair-screenshot.png');
  writeFileSync(shot, qrScreenshotPng(`http://localhost:8792/pair#${pc2.code}`));
  await page.setInputFiles('#pair-image', shot);
  await page.waitForFunction(() => /Paired with localhost:8792/.test(document.querySelector('#pair-status').textContent), null, { timeout: 8000 });
  assert.equal((await (await fetch('http://localhost:8792/api/devices')).json()).devices.length, 2);
  await page.click('.dock-tab[data-tab="sessions"]');
  await page.waitForFunction(() => document.querySelector('.badge')?.textContent === 'Uploaded', null, { timeout: 10000 });
  await sleep(900);
  await page.screenshot({ path: join(out, '3-sessions.png') });
  const remote = await (await fetch('http://localhost:8792/api/sessions')).json();
  assert.equal(remote.length, 1);
  assert.equal(remote[0].sampleCount, info.count);
  assert.equal(remote[0].final, true);
  assert.equal(remote[0].marks, 1);
  const csv = await (await fetch(`http://localhost:8792/api/sessions/${remote[0].id}/export.csv`)).text();
  assert.equal(csv.trim().split('\n').length - 1, info.count, 'all samples uploaded');
  assert.match(csv.split('\n')[0], /markDist/);

  // Playback.
  await page.click('.session');
  await sleep(600);
  await page.screenshot({ path: join(out, '3b-session-sheet.png') });
  await page.click('[data-act="play"]');
  await sleep(600);
  await page.click('#pb-play');
  await sleep(2500);
  await page.screenshot({ path: join(out, '5-playback.png') });

  const vibes = await page.evaluate(() => window.__vibes);
  assert.ok(vibes.length >= 5 && vibes.includes(14) && vibes.includes(28), `haptics on taps: ${JSON.stringify(vibes)}`);
  assert.deepEqual(errors, [], 'no console errors');
  console.log('E2E OK, screenshots in', out);
} catch (err) {
  console.error('E2E FAILED:', err.message, err.actual !== undefined ? `(actual ${JSON.stringify(err.actual)}, expected ${JSON.stringify(err.expected)})` : '', '\nerrors:', errors);
  process.exitCode = 1;
} finally {
  clearInterval(mover);
  await browser.close();
  cleanup();
}

// PNG of a 1080x2400 dark "screenshot" with a QR code (white card) in the middle.
function qrScreenshotPng(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const W = 1080, H = 2400, n = q.getModuleCount(), cell = 14, card = n * cell + 8 * cell;
  const x0 = (W - card) / 2, y0 = 700;
  const px = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    px[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      let v = 18; // dark UI
      if (x >= x0 && x < x0 + card && y >= y0 && y < y0 + card) {
        const mx = Math.floor((x - x0) / cell) - 4, my = Math.floor((y - y0) / cell) - 4;
        v = mx >= 0 && my >= 0 && mx < n && my < n && q.isDark(my, mx) ? 0 : 255;
      }
      const o = y * (W * 3 + 1) + 1 + x * 3;
      px[o] = px[o + 1] = px[o + 2] = v;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, k) => {
    let c = k;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}
