// E2E of the Android-app code path in Chromium, with the Capacitor runtime and plugins mocked
// to behave like the native ones (location watcher, 25 Hz VesselSensors heartbeat, Share).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// Serve the Android build of the web app (www/, which adds Capacitor core) like the APK does.
import { execFileSync } from 'node:child_process';
execFileSync('node', ['tools/build-www.mjs']);
const srv = spawn('node', ['server/dev-server.mjs', '8099', 'www'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.addInitScript(() => {
    // Imitates the REAL Android bridge: it provides PluginHeaders, nativePromise and nativeCallback
    // but NOT registerPlugin (that comes from @capacitor/core, loaded by the app as js/capacitor.js).
    const log = (window.__native = { calls: [], watchers: {}, listeners: [], shared: [] });
    let nextId = 1;
    const impl = {
      BackgroundGeolocation: {
        addWatcher(opts, cb) {
          log.calls.push(['addWatcher', !!opts.backgroundMessage]);
          let k = 0;
          const id = String(nextId);
          log.watchers[id] = setInterval(() => cb({ latitude: 1.3 + ++k * 0.00001, longitude: 103.8, accuracy: 3, altitude: 5, altitudeAccuracy: 3, speed: 1.1, bearing: 0, time: Date.now(), simulated: false }), 1000);
        },
        removeWatcher({ id }) { log.calls.push(['removeWatcher', id]); clearInterval(log.watchers[id]); delete log.watchers[id]; return Promise.resolve(); },
        openSettings() { log.calls.push(['openSettings']); return Promise.resolve(); },
      },
      VesselSensors: {
        addListener(opts, cb) { if (opts.eventName === 'motion') log.listeners.push(cb); },
        start() {
          log.calls.push(['sensors.start']);
          // Flat phone heading 045 (alpha 315): R = Rz(315); gyro quiet. 25 Hz, like the plugin.
          const a = (315 * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
          const R = [c, -s, 0, s, c, 0, 0, 0, 1];
          setInterval(() => log.listeners.forEach((cb) => cb({ t: Date.now(), R, gyro: [0, 0, 0.01], headingAcc: 3, magAccuracy: 3 })), 40);
          return Promise.resolve({ rotation: true, gyro: true });
        },
        stop() { return Promise.resolve(); },
        setBackground({ enabled }) { log.calls.push(['setBackground', enabled]); return Promise.resolve(); },
        batteryStatus() { return Promise.resolve({ unrestricted: false }); },
        requestUnrestrictedBattery() { log.calls.push(['battery']); return Promise.resolve(); },
      },
      Filesystem: { writeFile({ path, data }) { log.shared.push({ path, size: data.length, head: data.slice(0, 40) }); return Promise.resolve({ uri: 'file:///cache/' + path }); } },
      Share: { share(o) { log.calls.push(['share', o.files[0]]); return Promise.resolve(); } },
    };
    const callbackMethods = { BackgroundGeolocation: ['addWatcher'], VesselSensors: ['addListener'] };
    window.androidBridge = { postMessage() {} };
    window.Capacitor = {
      PluginHeaders: Object.keys(impl).map((name) => ({
        name,
        methods: Object.keys(impl[name]).map((m) => ({ name: m, rtype: (callbackMethods[name] || []).includes(m) ? 'callback' : 'promise' })),
      })),
      nativePromise: (plugin, method, options) => impl[plugin][method](options || {}),
      nativeCallback: (plugin, method, options, cb) => {
        const id = String(nextId++);
        impl[plugin][method](options || {}, cb);
        return id;
      },
    };
  });
  await page.goto('http://localhost:8099/');
  await page.waitForFunction(() => document.querySelector('#r-pos').textContent.includes('°N'), null, { timeout: 10000 });
  await sleep(1500);
  const chips = await page.evaluate(() => [...document.querySelectorAll('.chip span')].map((e) => e.textContent));
  console.log('chips', chips, 'perm card hidden', await page.isHidden('#perm-card'), 'onboarding sheet', await page.isVisible('#sheet'));
  assert.ok(chips.includes('Compass+Gyro'));
  assert.equal(await page.isVisible('#sheet'), false, 'no web permission prompt in the app');

  await page.click('#btn-rec');
  await page.waitForSelector('#btn-batt');
  await page.click('#btn-batt');
  await page.click('#new-start');
  await sleep(1500);
  // App goes to background: keep logging (no pause) even though setTimeout is throttled.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.__origSetTimeout = window.setTimeout;
    window.setTimeout = (fn, ms, ...a) => window.__origSetTimeout(fn, Math.max(ms, 1000), ...a); // background throttling
  });
  await sleep(3000);
  await page.evaluate(() => {
    window.setTimeout = window.__origSetTimeout;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(1000);
  await page.click('#btn-rec');
  await page.click('[data-act="stop"]');
  await sleep(600);

  const info = await page.evaluate(async () => {
    const { db } = window.gnsslog;
    const [s] = await db.listSessions();
    const rows = await db.getSamples(s.id);
    const dts = rows.slice(1).map((r, i) => r.t - rows[i].t);
    return { events: s.events.map((e) => e.type), n: rows.length, maxDt: Math.max(...dts), meanDt: dts.reduce((a, b) => a + b, 0) / dts.length, hdg: rows.at(-1).hdg, segs: [...new Set(rows.map((r) => r.segment))], calls: window.__native.calls };
  });
  console.log(info);
  assert.deepEqual(info.events, ['start', 'stop'], 'no pause while backgrounded in the app');
  assert.ok(info.maxDt < 300, `5 Hz kept while hidden (max gap ${info.maxDt} ms)`);
  assert.ok(Math.abs(info.hdg - 45) < 2, `heading ${info.hdg}`);
  assert.deepEqual(info.segs, [0]);
  const c = info.calls.map((x) => x.join(':'));
  assert.ok(c.includes('setBackground:true') && c.includes('setBackground:false'), 'background mode on while recording');
  assert.ok(c.includes('addWatcher:true'), 'location watcher switched to background mode');
  assert.ok(c.includes('battery'));

  // Export goes through Filesystem + Share.
  await page.click('.dock-tab[data-tab="sessions"]');
  await sleep(500);
  await page.click('.session');
  await page.click('[data-act="csv"]');
  await sleep(500);
  const shared = await page.evaluate(() => window.__native.shared);
  console.log('shared', shared);
  assert.ok(shared[0].path.endsWith('.csv') && shared[0].head.startsWith('seq,t,iso,segment'));
  assert.deepEqual(errors, []);
  console.log('NATIVE-MOCK E2E OK');
} catch (e) {
  console.error('NATIVE-MOCK E2E FAILED:', e.message, errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.kill();
}
