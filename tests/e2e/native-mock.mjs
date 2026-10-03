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
    const log = (window.__native = { calls: [], watchers: {}, listeners: [], shared: [], frames: [], fixes: [], acks: 0, freeze: null, queued: [] });
    let nextId = 1;
    let background = false;
    // freeze: null | 'drop' (WebView frozen, events lost) | 'burst' (WebView frozen, events
    // delivered late) | 'dead' (whole app frozen: native log stops too)
    const deliver = (fn) => {
      if (log.freeze === 'drop' || log.freeze === 'dead') return;
      if (log.freeze === 'burst') log.queued.push(fn);
      else fn();
    };
    log.unfreeze = ({ fixFirst = false } = {}) => {
      // fixFirst: a fresh GNSS fix reaches JavaScript before the first heartbeat after the freeze
      if (fixFirst && log.emitFix) log.emitFix();
      log.freeze = null;
      log.queued.splice(0).forEach((fn) => fn());
    };
    const impl = {
      BackgroundGeolocation: {
        addWatcher(opts, cb) {
          log.calls.push(['addWatcher', !!opts.backgroundMessage]);
          // The app runs one watcher at a time (the callback id it gets back is not this id).
          for (const w of Object.keys(log.watchers)) {
            clearInterval(log.watchers[w]);
            delete log.watchers[w];
          }
          let k = 0;
          const id = String(nextId);
          const t0 = (log.fixT0 ??= Date.now());
          const fix = () => ({ latitude: 1.3 + ((Date.now() - t0) / 1000) * 0.00001, longitude: 103.8, accuracy: 3, altitude: 5, altitudeAccuracy: 3, speed: 1.1, bearing: 0, time: Date.now(), simulated: false });
          log.emitFix = () => cb(fix());
          log.watchers[id] = setInterval(() => {
            const loc = fix();
            if (background && log.freeze !== 'dead') log.fixes.push([Date.now(), loc.time, loc.latitude, loc.longitude, 3, 5, 3, 1.1, 0]);
            deliver(() => cb(loc));
          }, 1000);
        },
        removeWatcher({ id }) { log.calls.push(['removeWatcher', id]); clearInterval(log.watchers[id]); delete log.watchers[id]; return Promise.resolve(); },
        openSettings() { log.calls.push(['openSettings']); return Promise.resolve(); },
      },
      VesselSensors: {
        addListener(opts, cb) {
          if (opts.eventName === 'motion') log.listeners.push(cb);
          if (opts.eventName === 'service') (log.serviceListeners ||= []).push(cb);
        },
        start() {
          log.calls.push(['sensors.start']);
          // Flat phone heading 045 (alpha 315): R = Rz(315); gyro quiet. 25 Hz, like the plugin.
          const a = (315 * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
          const R = [c, -s, 0, s, c, 0, 0, 0, 1];
          let n = 0;
          setInterval(() => {
            const e = { t: Date.now(), R, gyro: [0, 0, 0.01], headingAcc: 3, magAccuracy: 3 };
            if (background && log.freeze !== 'dead' && n++ % 2 === 0) log.frames.push([e.t, ...R, 0, 0, 0.01, 3, 3]); // ~10 Hz native log
            deliver(() => log.listeners.forEach((cb) => cb(e)));
          }, 40);
          return Promise.resolve({ rotation: true, gyro: true });
        },
        stop() { return Promise.resolve(); },
        setBackground({ enabled }) {
          log.calls.push(['setBackground', enabled]);
          background = enabled;
          if (enabled) log.frames.length = log.fixes.length = 0;
          // The app's RecordingService starts; set window.__native.noService to test the fallback.
          return Promise.resolve({ service: enabled && !log.noService });
        },
        ack() { log.acks++; return Promise.resolve(); },
        drain({ sinceT, untilT, max }) {
          log.calls.push(['drain']);
          const frames = log.frames.filter((f) => f[0] > sinceT && f[0] <= untilT);
          const more = frames.length > max;
          const sent = frames.slice(0, max);
          const fixUntil = more ? sent.at(-1)[0] : untilT;
          const fixes = log.fixes.filter((f) => f[0] > sinceT && f[0] <= fixUntil);
          return Promise.resolve({ frames: sent, fixes, more, oldestT: log.frames[0]?.[0] ?? -1, gnss: { on: true, provider: 'fused', logged: log.fixes.length, lastFixAgoMs: 500 } });
        },
        batteryStatus() { return Promise.resolve({ unrestricted: false }); },
        locationStatus() { return Promise.resolve({ fine: true, background: false }); },
        openAppSettings() { log.calls.push(['appSettings']); return Promise.resolve(); },
        haptic({ kind }) { log.calls.push(['haptic', kind]); return Promise.resolve(); },
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
  await page.waitForSelector('#btn-loc');
  await page.click('#btn-loc');
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
  // Screen off: Android freezes the WebView while the native services keep logging.
  const freeze = async (mode, ms) => {
    const t0 = await page.evaluate((m) => ((window.__native.freeze = m), Date.now()), mode);
    await sleep(ms);
    const t1 = await page.evaluate((fixFirst) => (window.__native.unfreeze({ fixFirst }), Date.now()), mode === 'drop');
    await sleep(1500);
    return [t0, t1];
  };
  const dropWin = await freeze('drop', 3000); // events lost: caught up from the native log
  const burstWin = await freeze('burst', 3000); // events delivered late, in one go
  const deadWin = await freeze('dead', 4000); // whole app frozen: nothing to recover
  await freeze('dead', 1500); // a short hiccup is bridged by the filters, not marked as a gap
  // RecordingService did not reach the foreground: the plugin watcher takes over in background mode.
  await page.evaluate(() => window.__native.serviceListeners.forEach((cb) => cb({ running: false, error: 'test' })));
  await sleep(800);
  await page.click('#btn-rec');
  await page.click('[data-act="stop"]');
  await sleep(600);

  const win = { drop: dropWin, burst: burstWin, dead: deadWin };
  const info = await page.evaluate(async (win) => {
    const { db } = window.gnsslog;
    const [s] = await db.listSessions();
    const rows = await db.getSamples(s.id);
    const dts = rows.slice(1).map((r, i) => r.t - rows[i].t);
    const big = rows.slice(1).map((r, i) => [rows[i].t, r.t - rows[i].t]).filter(([, dt]) => dt > 300);
    const inWin = ([a, b]) => rows.filter((r) => r.t > a + 300 && r.t < b - 300);
    return {
      events: s.events.map((e) => e.type),
      gap: s.events.find((e) => e.type === 'gap'),
      catchup: s.events.find((e) => e.type === 'catchup'),
      late: s.events.find((e) => e.type === 'late'),
      n: rows.length,
      big,
      meanDt: dts.reduce((a, b) => a + b, 0) / dts.length,
      hdg: rows.at(-1).hdg,
      segs: [...new Set(rows.map((r) => r.segment))],
      calls: window.__native.calls,
      acks: window.__native.acks,
      drop: inWin(win.drop).map((r) => [r.gnssNew, r.lat, r.gnssAge]),
      burst: inWin(win.burst).length,
      dead: inWin(win.dead).length,
    };
  }, win);
  console.log({ ...info, drop: info.drop.length, calls: info.calls.length });
  assert.deepEqual(info.events.slice(0, 4), ['start', 'catchup', 'late', 'gap'], 'no pause; catch-up, late burst and gap are logged');
  assert.equal(info.events.filter((x) => x === 'gap').length, 1, 'short hiccup bridged');
  assert.equal(info.events.at(-1), 'stop');
  assert.ok(info.catchup.frozenMs > 2500 && info.catchup.holes === 0 && info.catchup.fixes >= 2 && info.catchup.samples >= 12, `catchup event ${JSON.stringify(info.catchup)}`);
  assert.ok(info.late.spanMs > 1000 && info.late.maxLagMs > 1500, `late event ${JSON.stringify(info.late)}`);
  assert.equal(info.big.length, 1, `only the whole-app freeze leaves a hole: ${JSON.stringify(info.big)}`);
  assert.ok(Math.abs(info.big[0][1] - 4000) < 700, `hole matches the freeze: ${info.big[0][1]} ms`);
  assert.ok(Math.abs(info.gap.gapMs - 4000) < 700, `gap event ${info.gap.gapMs} ms`);
  assert.ok(info.drop.length >= 10, `samples recovered for the dropped freeze: ${info.drop.length}`);
  assert.ok(info.drop.filter(([n]) => n === 1).length >= 1, 'GNSS fixes recovered for the dropped freeze');
  assert.ok(info.drop.at(-1)[1] > info.drop[0][1], 'position advances through the recovered stretch');
  // The fresh fix that arrived first after the freeze must not be applied before the replay.
  const lats = info.drop.map((d) => d[1]);
  assert.ok(lats.every((v, i) => i === 0 || v >= lats[i - 1] - 1e-7), 'no jump back: fixes applied in time order');
  assert.ok(lats.at(-1) - lats[0] < 0.00004, `no teleport to the post-freeze position (${(lats.at(-1) - lats[0]).toFixed(6)})`);
  assert.ok(info.drop.every((d) => d[2] === null || d[2] > -1100), `no fix from the future: ${Math.min(...info.drop.map((d) => d[2]))} ms`);
  assert.ok(info.burst >= 5, `samples placed at their own time for the late burst: ${info.burst}`);
  assert.equal(info.dead, 0, 'no coasting samples invented for the whole-app freeze');
  assert.ok(Math.abs(info.hdg - 45) < 2, `heading ${info.hdg}`);
  assert.deepEqual(info.segs, [0, 1]);
  assert.ok(info.acks > 3, 'JavaScript keeps acking the plugin');
  assert.ok(info.calls.some((x) => x[0] === 'drain'), 'catch-up used the native log');
  const c = info.calls.map((x) => x.join(':'));
  assert.ok(c.includes('setBackground:true') && c.includes('setBackground:false'), 'background mode on while recording');
  const fb = c.indexOf('addWatcher:true');
  assert.ok(fb > 0 && c.slice(0, fb).filter((x) => x.startsWith('addWatcher')).every((x) => x === 'addWatcher:false'), 'plugin watcher in plain mode while RecordingService runs, background mode after the fallback');
  assert.ok(c.includes('battery'));
  assert.ok(c.includes('appSettings'), 'prompted for "Allow all the time"');
  for (const k of ['tap', 'confirm', 'heavy']) assert.ok(c.includes(`haptic:${k}`), `haptic ${k} on taps`);

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
