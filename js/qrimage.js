// Read a QR code from a picture (a screenshot or photo of the analyser's pairing code), on the
// device. jsQR is loaded only when needed.

/** Text of the first QR code found in an image File/Blob, or throws. */
export async function decodeQrImage(file) {
  const { default: jsQR } = await import('./vendor/jsqr.js');
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error('Could not open that picture.');
  }
  // jsQR works best at moderate sizes: try a couple of scales of the whole picture.
  const longest = Math.max(bmp.width, bmp.height);
  for (const target of [1200, 800, 1800]) {
    const k = Math.min(1, target / longest);
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
    if (r?.data) {
      bmp.close?.();
      return r.data;
    }
  }
  bmp.close?.();
  throw new Error('No QR code found in that picture. Crop it closer to the code, or enter the code instead.');
}
