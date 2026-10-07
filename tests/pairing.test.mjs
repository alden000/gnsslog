import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePairing, pairWithHub } from '../js/pairing.js';
import { createHub } from '../hub/server.mjs';

test('pairing text: scanned link, one-line text, separate address + code', () => {
  assert.deepEqual(parsePairing('https://logs.example.com/pair#ABCD2345'), { origin: 'https://logs.example.com', code: 'ABCD2345' });
  assert.deepEqual(parsePairing('logs.example.com abcd-2345'), { origin: 'https://logs.example.com', code: 'ABCD2345' });
  assert.deepEqual(parsePairing(' abcd 2345 ', 'logs.example.com'), { origin: 'https://logs.example.com', code: 'ABCD2345' });
  assert.deepEqual(parsePairing('ABCD-2345', 'https://logs.example.com/ingest'), { origin: 'https://logs.example.com', code: 'ABCD2345' });
  assert.throws(() => parsePairing('ABCD-2345'), /hub address/);
  assert.throws(() => parsePairing('ABCD-01', 'logs.example.com'), /8 letters/);
  assert.throws(() => parsePairing('ABCD-0000', 'logs.example.com'), /8 letters/); // 0 is not in the alphabet
});

test('the app pairs with a real hub and uploads with its own key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-'));
  const hub = createHub({ dataDir: dir, ingestToken: 'shared', quiet: true, noBackup: true });
  const origin = `http://127.0.0.1:${(await hub.listen(0, '127.0.0.1')).port}`;
  try {
    const code = await (await fetch(`${origin}/api/devices/pair`, { method: 'POST' })).json();
    // parsePairing wants a dotted host; the hub here is local, so build the target directly
    const r = await pairWithHub({ origin, code: code.code }, 'A56');
    assert.equal(r.endpoint, `${origin}/ingest`);
    assert.equal(r.pairedName, 'A56');
    assert.match(r.authValue, /^Bearer \S{40,}$/);
    const up = await fetch(r.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', [r.authHeader]: r.authValue }, body: JSON.stringify({ schema: 'gnsslog/1', session: { id: 'cccccccc-1111-2222-3333-444444444444', startedAt: 1, metaVersion: 1, events: [] }, samples: [] }) });
    assert.equal(up.status, 200);
    await assert.rejects(pairWithHub({ origin, code: code.code }, 'again'), /already used/);
    await assert.rejects(pairWithHub({ origin: 'http://127.0.0.1:9', code: 'ABCD2345' }, 'x'), /Could not reach/);
  } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
