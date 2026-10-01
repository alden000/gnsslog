// E2E: background pause/resume inside one page, then app reload mid-recording and resume.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const srv = spawn('node', ['server/dev-server.mjs', '8097'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['geolocation'], geolocation: { latitude: 1.3, longitude: 103.8, accuracy: 3 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const sensorsSim = () =>
    page.evaluate(() => setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 300, beta: 1, gamma: 0, absolute: true })), 50));
  let k = 0;
  const mover = setInterval(() => ctx.setGeolocation({ latitude: 1.3 + ++k * 0.00001, longitude: 103.8, accuracy: 3 }).catch(() => {}), 1000);

  await page.goto('http://localhost:8097/');
  await sensorsSim();
  await page.waitForFunction(() => document.querySelector('#r-pos').textContent.includes('°N'));
  await page.click('#btn-rec');
  await page.fill('#new-name', 'Resume test');
  await page.click('#new-start');
  await sleep(1500);

  // 1) Background for ~2 s: no rows while hidden, pause/resume events, segment 1.
  const setVis = (v) => page.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, v);
  await setVis('hidden');
  await sleep(2000);
  await setVis('visible');
  await sleep(1500);

  // 2) App killed and reopened mid-recording.
  await page.evaluate(() => window.gnsslog.recorder.flush());
  const before = await page.evaluate(() => window.gnsslog.recorder.seq);
  await page.reload();
  await sensorsSim();
  await page.waitForSelector('#sheet:not([hidden]) [data-act="resume"]');
  await page.click('[data-act="resume"]');
  await sleep(2500);
  await page.click('#btn-rec');
  await page.click('[data-act="stop"]');
  await sleep(500);
  clearInterval(mover);

  const info = await page.evaluate(async () => {
    const { db } = window.gnsslog;
    const all = await db.listSessions();
    const s = all[0];
    const rows = await db.getSamples(s.id);
    const gaps = rows.slice(1).map((r, i) => [rows[i].seq, r.t - rows[i].t]).filter(([, d]) => d > 400);
    return {
      sessions: all.length, status: s.status, interrupted: !!s.interrupted,
      events: s.events.map((e) => e.type + (e.reason ? ':' + e.reason : '')),
      seqOk: rows.every((r, i) => r.seq === i), count: rows.length, sampleCount: s.sampleCount,
      segments: [...new Set(rows.map((r) => r.segment))], gaps,
      originSame: s.origin && rows.at(-1).x !== null && Math.abs(Math.hypot(rows.at(-1).x, rows.at(-1).y)) < 50,
    };
  });
  console.log(info, 'rows before reload', before);
  assert.equal(info.sessions, 1, 'one session, continued');
  assert.equal(info.status, 'done');
  assert.equal(info.interrupted, false);
  assert.deepEqual(info.events, ['start', 'pause:background', 'resume:foreground', 'resume:reopened', 'stop']);
  assert.ok(info.seqOk && info.count === info.sampleCount);
  assert.deepEqual(info.segments, [0, 1, 2]);
  assert.equal(info.gaps.length, 2, 'two gaps: background and reload');
  assert.ok(info.gaps[0][1] >= 1800, 'no rows written while hidden');
  assert.ok(info.originSame, 'x/y still relative to the session origin');
  assert.deepEqual(errors, []);
  console.log('RESUME E2E OK');
} catch (e) {
  console.error('RESUME E2E FAILED:', e.message, errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.kill();
}
