// Copies the web app into www/ for Capacitor (the PWA itself is served from the repo root).
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = root + 'www/';
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const p of ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons']) cpSync(root + p, out + p, { recursive: true });

// The Android shell injects only a minimal Capacitor bridge; Capacitor.registerPlugin() (used to
// reach the native plugins) comes from @capacitor/core. Load its browser build before the app.
cpSync(root + 'node_modules/@capacitor/core/dist/capacitor.js', out + 'js/capacitor.js');
const html = readFileSync(out + 'index.html', 'utf8');
const tag = '<script type="module" src="js/app.js"></script>';
if (!html.includes(tag)) throw new Error('build-www: app script tag not found in index.html');
writeFileSync(out + 'index.html', html.replace(tag, '<script src="js/capacitor.js"></script>\n    ' + tag));

console.log('www/ ready');
