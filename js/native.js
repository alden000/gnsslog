// Android app (Capacitor) integration. In the browser/PWA all of this is inactive.
// Plugins are reached through the Capacitor runtime the native shell injects, so the web app
// needs no bundler: Capacitor.registerPlugin(name) returns a proxy to the native plugin.

const Cap = globalThis.Capacitor;

export const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());

const cache = {};
export function plugin(name) {
  if (!isNative) return null;
  return (cache[name] ||= Cap.registerPlugin(name));
}

/** Share a text file through Android's share sheet (WebView cannot download files). */
export async function shareTextFile(text, filename) {
  const Filesystem = plugin('Filesystem');
  const Share = plugin('Share');
  const { uri } = await Filesystem.writeFile({ path: filename, data: text, directory: 'CACHE', encoding: 'utf8' });
  await Share.share({ title: filename, files: [uri], dialogTitle: 'Export session' });
}
