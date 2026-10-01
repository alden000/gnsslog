// E2E for the service worker: other pages on the same domain must not replace the app shell
// (field bug: a shared domain showed its landing page at every path), and the app must still
// start offline.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const srv = spawn('node', ['server/dev-server.mjs', '8101'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 1.3, longitude: 103.8, accuracy: 3 } });
  const page = await ctx.newPage();
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const base = 'http://localhost:8101/';
  await page.goto(base);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });
  await page.reload(); // now controlled by the worker
  // Visit another (non-app) page on the same origin, then come back to the app.
  await page.goto(base + 'icons/icon.svg');
  await page.waitForTimeout(800);
  await page.goto(base);
  const title = await page.title();
  console.log('after visiting another page, / shows:', JSON.stringify(title));
  assert.equal(title, 'GNSS Log', 'app shell must not be replaced by other pages');

  // Offline start.
  await page.waitForTimeout(500);
  await ctx.setOffline(true);
  await page.reload();
  const offlineTitle = await page.title();
  console.log('offline / shows:', JSON.stringify(offlineTitle));
  assert.equal(offlineTitle, 'GNSS Log');
  console.log('OFFLINE E2E OK');
} catch (e) {
  console.error('OFFLINE E2E FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.kill();
}
