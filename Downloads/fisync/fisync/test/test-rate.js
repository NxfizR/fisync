const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
process.env.PORT = '18492';
process.env.FISYNC_DATA = '/tmp/fs-data-rate';
process.env.SHARE_DIR = '/tmp/fs-share-rate';
require('fs').rmSync(process.env.FISYNC_DATA, { recursive: true, force: true });
require('fs').rmSync(process.env.SHARE_DIR, { recursive: true, force: true });
process.env.FISYNC_MAX_MBPS = '1';
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const srv = require('../server');
const BASE = 'ws://127.0.0.1:18492';

(async () => {
  await srv.start({ approve: async () => true });
  const m = await FiClient.pair(`${BASE}/pair`, srv.getState().pin, 'Rate phone');
  const buf = crypto.randomBytes(2 * 1024 * 1024);
  const file = { name: 'two.bin', size: buf.length, slice: (a, b) => ({ arrayBuffer: async () => Uint8Array.from(buf.subarray(a, b)).buffer }) };
  const t0 = Date.now();
  await FiClient.downloadFile(BASE, m.token, 'two.bin').catch(() => null);   // nothing yet: a missing file is refused
  await FiClient.uploadFile(BASE, m.token, file);
  const t1 = Date.now();
  const got = Buffer.from(await (await FiClient.downloadFile(BASE, m.token, 'two.bin')).arrayBuffer());
  const t2 = Date.now();
  assert.ok(got.equals(buf), 'file intact');
  assert.ok(t2 - t1 >= 1500, `download is paced to about 1 MB/s (took ${t2 - t1} ms)`);
  console.log(`ok  2 MB download paced at about 1 MB/s (${t2 - t1} ms)`);
  console.log('\nTransfer limit checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
