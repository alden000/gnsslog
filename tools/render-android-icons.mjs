// Renders the Android launcher icons and splash screens from icons/*.svg (Playwright Chromium).
// Usage: node tools/render-android-icons.mjs
import { chromium } from 'playwright';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const res = root + 'android/app/src/main/res/';
const BG = '#041113';
const icon = readFileSync(root + 'icons/icon.svg', 'utf8');
const maskable = readFileSync(root + 'icons/maskable.svg', 'utf8');
const foreground = maskable.replace(/<rect width="512" height="512"[^>]*\/>/, ''); // adaptive-icon foreground layer
const uri = (svg) => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
const size = (f) => execFileSync('identify', ['-format', '%w %h', f]).toString().split(' ').map(Number);

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(file, w, h, html, transparent) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${transparent ? 'transparent' : BG}">${html}</body></html>`);
  await page.screenshot({ path: file, omitBackground: transparent });
}
for (const d of readdirSync(res).filter((d) => d.startsWith('mipmap-') && !d.includes('anydpi'))) {
  const [s] = size(`${res}${d}/ic_launcher.png`);
  await render(`${res}${d}/ic_launcher.png`, s, s, `<img src="${uri(icon)}" width="${s}" height="${s}">`, true);
  await render(`${res}${d}/ic_launcher_round.png`, s, s, `<img src="${uri(maskable)}" width="${s}" height="${s}" style="border-radius:50%">`, true);
  const [fs] = size(`${res}${d}/ic_launcher_foreground.png`);
  await render(`${res}${d}/ic_launcher_foreground.png`, fs, fs, `<img src="${uri(foreground)}" width="${fs}" height="${fs}">`, true);
}
for (const d of readdirSync(res).filter((d) => d.startsWith('drawable'))) {
  let f;
  try { f = `${res}${d}/splash.png`; size(f); } catch { continue; }
  const [w, h] = size(f);
  const s = Math.round(Math.min(w, h) * 0.28);
  await render(f, w, h, `<img src="${uri(icon)}" width="${s}" height="${s}" style="position:absolute;left:${(w - s) / 2}px;top:${(h - s) / 2}px">`, false);
}
writeFileSync(res + 'values/ic_launcher_background.xml', `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#073034</color>\n</resources>\n`);
await browser.close();
console.log('Android icons and splash screens rendered');
