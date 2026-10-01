// Copies the web app into www/ for Capacitor (the PWA itself is served from the repo root).
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = root + 'www/';
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const p of ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons']) cpSync(root + p, out + p, { recursive: true });
console.log('www/ ready');
