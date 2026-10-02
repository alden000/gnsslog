// End-to-end smoke test: simulated GNSS + compass/gyro on a phone-sized Chromium.
// Records a test case, marks a location, uploads to the hub (hub/server.mjs), opens playback.
// Usage: node tests/e2e/smoke.mjs [outDir]   (writes screenshots to outDir)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
  await page.fill('[data-setting="authValue"]', 'Bearer smoke-token');
  await page.press('[data-setting="authValue"]', 'Tab');
  await page.fill('[data-setting="endpoint"]', 'http://localhost:8792/ingest');
  await page.press('[data-setting="endpoint"]', 'Tab');
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
