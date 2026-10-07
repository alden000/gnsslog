// Hub + analyser end to end: seeded sessions, playback, selection, trim, rename, image and data
// exports, live updates while a session is uploading.
// Usage: node tests/e2e/hub.mjs [outDir]
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createHub } from '../../hub/server.mjs';
import { makeRun, upload, post } from './hub-seed.mjs';

const out = process.argv[2] || join(tmpdir(), 'gnsslog-hub-shots');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'gnsslog-hub-'));
const TOKEN = 'e2e-token';
const hub = createHub({ dataDir: dir, ingestToken: TOKEN, quiet: true, noBackup: true });
const { port } = await hub.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;

const A = makeRun({ id: '0a1b2c3d-0000-4000-8000-00000000000a', name: 'Harbour run' });
await upload(base, TOKEN, A);
const LIVE = makeRun({ id: '0a1b2c3d-0000-4000-8000-00000000000b', name: 'Live test', seed: 9, t0: Date.now() - 300000, seconds: 300 });
await upload(base, TOKEN, LIVE, { upTo: 1000, live: true });

const tile = readFileSync(new URL('../../icons/icon-192.png', import.meta.url));
const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true, colorScheme: 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  // Map tiles: a local PNG with CORS, so exports with a map must not taint the canvas.
  await page.route(/arcgisonline\.com|openseamap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: tile }));

  await page.goto(base + '/');
  await page.waitForSelector('.row');
  assert.equal(await page.locator('.row').count(), 2);
  assert.ok(await page.locator('.row', { hasText: 'Live test' }).locator('.badge.live').count(), 'live badge');

  // ---- open the finished session
  await page.click('.row:has-text("Harbour run")');
  await page.waitForFunction(() => document.querySelector('#t-clock').textContent !== '--:--:--');
  assert.match(await page.textContent('#s-sub'), /4,375 samples/);
  assert.match(await page.textContent('#stats'), /15:00/);

  // ---- playback moves the cursor
  await page.selectOption('#speed', '64');
  const before = await page.textContent('#t-elapsed');
  await page.click('#btn-play');
  await page.waitForTimeout(700);
  await page.click('#btn-play');
  assert.notEqual(await page.textContent('#t-elapsed'), before);

  // ---- drag on the charts selects a range; stats switch to the selection
  const box = await page.locator('#charts').boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + 80);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + 90, { steps: 6 });
  await page.mouse.up();
  assert.match(await page.textContent('#sel-label'), /Selection \d\d:\d\d:\d\d – \d\d:\d\d:\d\d/);
  assert.match(await page.textContent('#stats-label'), /Selection/);
  assert.equal(await page.isDisabled('#btn-trim'), false);

  // ---- map + speed colouring, then a screenshot
  await page.click('#map-seg button[data-v=satellite]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, 'hub-session.png') });

  // ---- image exports
  async function exportImage(kind, format, range = 'all') {
    await page.click('#btn-export');
    await page.click('#exp-tab button[data-v=image]');
    await page.click(`.seg[data-name=kind] button[data-v=${kind}]`);
    await page.click(`.seg[data-name=format] button[data-v=${format}]`);
    await page.click(`.seg[data-name=range] button[data-v=${range}]`);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exp-go')]);
    const file = join(out, dl.suggestedFilename());
    await dl.saveAs(file);
    return { name: dl.suggestedFilename(), buf: readFileSync(file) };
  }
  const svg = await exportImage('track', 'svg');
  assert.match(svg.name, /Harbour_run_track\.svg/);
  const svgText = svg.buf.toString();
  assert.ok(svgText.startsWith('<svg'), 'svg root');
  assert.match(svgText, /<path d="M/);
  assert.match(svgText, /<image [^>]*href="data:image\/jpeg/, 'satellite map embedded');
  const jpg = await exportImage('report', 'jpg');
  assert.deepEqual([...jpg.buf.subarray(0, 3)], [0xff, 0xd8, 0xff], 'jpeg magic');
  const chartsSvg = await exportImage('charts', 'svg', 'selection');
  assert.match(chartsSvg.buf.toString(), /Speed/);
  const png = await exportImage('report', 'png');
  assert.deepEqual([...png.buf.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  const reportSvg = await exportImage('report', 'svg');
  assert.ok(reportSvg.buf.length > 20000);

  // ---- data export (selection, GPX)
  await page.click('#btn-export');
  await page.click('#exp-tab button[data-v=data]');
  await page.click('.seg[data-name=dformat] button[data-v=gpx]');
  await page.click('.seg[data-name=drange] button[data-v=selection]');
  await page.click('.seg[data-name=every] button[data-v="1000"]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exp-go')]);
  const gpxPath = join(out, dl.suggestedFilename());
  await dl.saveAs(gpxPath);
  const gpx = readFileSync(gpxPath, 'utf8');
  const nPts = (gpx.match(/<trkpt /g) || []).length;
  assert.ok(nPts > 50 && nPts < 200, `gpx points ${nPts}`);
  assert.match(dl.suggestedFilename(), /_extract\.gpx$/);

  // ---- trim the selection into a new session
  await page.click('#btn-trim');
  await page.fill('#trim-name', 'Approach only');
  await page.click('#trim-go');
  await page.waitForFunction(() => document.querySelector('#s-name').textContent === 'Approach only');
  assert.match(await page.textContent('#s-sub'), /trimmed copy/);

  // ---- rename
  await page.click('#btn-rename');
  await page.fill('#ren-name', 'Approach (renamed)');
  await page.click('#ren-go');
  await page.waitForFunction(() => document.querySelector('#s-name').textContent === 'Approach (renamed)');

  // ---- live session: new uploads appear without reloading
  await page.goto(base + '/#/s/' + LIVE.session.id);
  await page.waitForFunction(() => document.querySelector('#s-sub').textContent.includes('1,000 samples'));
  assert.equal(await page.isVisible('#s-live'), true);
  await upload(base, TOKEN, { session: LIVE.session, samples: LIVE.samples }, { upTo: 1200, live: true });
  await page.waitForFunction(() => document.querySelector('#s-sub').textContent.includes('1,200 samples'), null, { timeout: 10000 });
  // the cursor followed the live end
  const elapsed = await page.textContent('#t-elapsed');
  const [a, b] = elapsed.split(' / ');
  assert.equal(a, b, `cursor at the end: ${elapsed}`);

  // ---- phone layout
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, 'hub-phone.png') });

  // ---- delete from the list
  await page.goto(base + '/#/');
  await page.waitForSelector('.row');
  await page.click('.row:has-text("Approach (renamed)")');
  await page.waitForFunction(() => document.querySelector('#s-name').textContent === 'Approach (renamed)');
  await page.click('#btn-delete');
  await page.click('#cf-go');
  await page.waitForFunction(() => !document.querySelector('#view-list').hidden && document.querySelectorAll('.row').length === 2);

  // ---- phones: pair a new one (QR + code), the phone redeems it, then remove it
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click('#btn-phones');
  await page.waitForSelector('#ph-list li');
  await page.click('#ph-pair');
  await page.waitForSelector('#ph-qr svg');
  const shown = await page.textContent('#ph-code');
  assert.match(shown, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  await page.screenshot({ path: join(out, 'hub-pair.png') });
  const [qrDl] = await Promise.all([page.waitForEvent('download'), page.click('#ph-save')]);
  assert.equal(qrDl.suggestedFilename(), `gnsslog-pair-${shown}.png`);
  await qrDl.saveAs(join(out, qrDl.suggestedFilename()));
  const pr = await fetch(`${base}/ingest/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: shown, device: 'Test phone' }) });
  assert.equal(pr.status, 200);
  await page.waitForSelector('#ph-list li:has-text("Test phone")', { timeout: 6000 });
  await page.screenshot({ path: join(out, 'hub-phones.png') });
  await page.click('#ph-list li:has-text("Test phone") [data-act="remove"]');
  await page.click('#cf-go');
  await page.waitForSelector('#ph-list li.empty', { timeout: 5000 });
  await page.keyboard.press('Escape');

  assert.deepEqual(errors, []);
  console.log('HUB E2E OK, files in', out);
} catch (err) {
  console.error(err);
  console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
}
