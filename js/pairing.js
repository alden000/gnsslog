// Pairing with a GNSS Log hub: the analyser shows a one-time code as a QR code
// (https://<hub>/pair#<CODE>) and as text (hub address + code). The phone sends the code to
// <hub>/ingest/pair and receives its own upload key. No address or key is built into the app.

const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/; // the hub's alphabet: no 0/O, 1/I/L

export function normaliseCode(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** https origin from what was scanned or typed ("logs.example.com", a full URL, ...). */
export function normaliseOrigin(s) {
  let t = String(s || '').trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) t = `https://${t}`;
  try {
    const u = new URL(t);
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Hub origin and code from a scanned QR code / pasted link, or from a typed address + code.
 * Returns { origin, code } or throws with a message for the person.
 */
export function parsePairing(text, typedHost = '') {
  const t = String(text || '').trim();
  let origin = null, code = '';
  const link = /^https?:\/\/[^\s]+$/i.test(t) ? new URL(t) : null;
  if (link) {
    origin = link.origin;
    code = normaliseCode(link.hash.slice(1) || link.searchParams.get('code') || link.pathname.split('/').pop());
  } else {
    // "logs.example.com ABCD-EFGH" in one line, or just the code with the address typed separately
    const parts = t.split(/\s+/);
    if (parts.length > 1 && parts[0].includes('.')) {
      origin = normaliseOrigin(parts[0]);
      code = normaliseCode(parts.slice(1).join(''));
    } else code = normaliseCode(t);
    if (!origin) origin = normaliseOrigin(typedHost);
  }
  if (!origin) throw new Error('Enter the hub address shown in the analyser.');
  if (!CODE_RE.test(code)) throw new Error('The code is 8 letters and digits, as shown in the analyser.');
  return { origin, code };
}

/** Redeem the code at the hub; returns the settings to store. */
export async function pairWithHub({ origin, code }, deviceName, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${origin}/ingest/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, device: deviceName }) });
  } catch {
    throw new Error(`Could not reach ${new URL(origin).host}. Check the address and the data connection.`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok || !body?.token) {
    if (res.status === 404 || res.status === 405) throw new Error(`${new URL(origin).host} is not a GNSS Log hub (or it needs updating).`);
    throw new Error(body?.error || `Pairing failed (${res.status}).`);
  }
  return {
    endpoint: `${origin}/ingest`,
    authHeader: 'Authorization',
    authValue: `Bearer ${body.token}`,
    pairedName: body.name || deviceName,
    pairedAt: Date.now(),
  };
}
