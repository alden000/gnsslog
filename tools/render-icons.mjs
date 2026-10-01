// Renders icons/*.svg to the PNG sizes the manifest and iOS need (uses Playwright's Chromium).
// Usage: node tools/render-icons.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../icons/', import.meta.url));
const jobs = [
  ['icon.svg', 'icon-512.png', 512, 'transparent'],
  ['icon.svg', 'icon-192.png', 192, 'transparent'],
  ['icon.svg', 'apple-touch-icon.png', 180, '#09090F'],
  ['maskable.svg', 'maskable-512.png', 512, 'transparent'],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [src, out, size, bg] of jobs) {
  const svg = readFileSync(dir + src, 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:${bg}"><img style="width:${size}px;height:${size}px;display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`,
  );
  await page.screenshot({ path: dir + out, omitBackground: bg === 'transparent' });
  console.log('wrote', out);
}
await browser.close();
