// Phase 2 remainder: phone key rotation, upload checksums, and the setup check.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
const DATA = path.join(os.tmpdir(), 'fisync-p2b-' + process.pid);
const SHARE = path.join(os.tmpdir(), 'fisync-p2b-share-' + process.pid);
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(SHARE, { recursive: true, force: true });
process.env.PORT = '18512';
process.env.FISYNC_TLS_PORT = '0';
process.env.FISYNC_DATA = DATA;
process.env.SHARE_DIR = SHARE;
const BASE = 'ws://127.0.0.1:18512';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const srv = require('../server');

(async () => {
  await srv.start({ approve: async () => true });
  const phone = await FiClient.pair(`${BASE}/pair`, srv.getState().pin, 'Rotating phone');
  const stored = () => JSON.parse(fs.readFileSync(path.join(DATA, 'devices.json'), 'utf8')).find(d => d.name === 'Rotating phone');
  const before = stored();
  const added = before.added;

  // 1. the phone must be connected to rotate its key
  assert.strictEqual(srv.rotatePhoneKey(added).ok, false, 'a phone that is not connected cannot be rotated');
  console.log('ok  a phone must be connected before its key can be rotated');

  // 2. the phone receives a new token, confirms it, and then uses it
  let link;
  let newToken = null;
  link = await FiClient.connect(`${BASE}/bridge`, phone.token, {
    onJson: m => {
      if (m.t === 'rekey') { newToken = m.token; link.sendJson({ t: 'rekey-ack' }); }
    },
  });
  assert.strictEqual(srv.rotatePhoneKey(added).ok, true, 'rotation starts');
  await sleep(300);
  assert.ok(newToken && newToken !== phone.token, 'the phone received a new token');
  const during = stored();
  assert.ok(during.prevId === before.id && during.id !== before.id, 'the old identity is kept until the phone uses the new one');
  const again = await FiClient.connect(`${BASE}/bridge`, newToken, { onJson: () => {} });
  assert.ok(again, 'the phone connects with the new token');
  await sleep(200);
  assert.strictEqual(stored().prevId, undefined, 'the old token stops working once the new one is in use');
  console.log('ok  a phone is given a new token, confirms it, and reconnects with it');

  // 3. an upload with a wrong checksum is refused and the file is not kept
  const uploadWith = (sha, name) => new Promise(async resolve => {
    const api = await FiClient.connect(`${BASE}/files`, newToken, {
      onJson: m => {
        if (m.t === 'put-ready') { api.sendBlob(new Uint8Array(Buffer.from('hello'))); api.sendJson({ t: 'put-end' }); }
        else if (m.t === 'saved' || m.t === 'error') resolve(m);
      },
    });
    api.sendJson({ t: 'put', name, size: 5, sha256: sha });
  });
  const bad = await uploadWith('0'.repeat(64), 'bad.txt');
  assert.strictEqual(bad.t, 'error', 'a wrong checksum is refused');
  assert.ok(!fs.existsSync(path.join(SHARE, 'bad.txt')), 'the damaged file is not kept');
  const good = await uploadWith(crypto.createHash('sha256').update('hello').digest('hex'), 'good.txt');
  assert.strictEqual(good.t, 'saved', 'a correct checksum is accepted');
  assert.strictEqual(fs.readFileSync(path.join(SHARE, 'good.txt'), 'utf8'), 'hello');
  console.log('ok  uploads are checked against their checksum, and a damaged file is refused');

  // 4. the setup check lists what matters
  const items = srv.setupCheck();
  const names = items.map(i => i.name);
  for (const n of ['fisync is running', 'Network connection', 'Tailscale', 'Nearby Bluetooth', 'Secure page', 'Phones paired', 'Stored data encrypted']) {
    assert.ok(names.includes(n), 'setup check lists ' + n);
  }
  assert.strictEqual(items.find(i => i.name === 'Phones paired').ok, true, 'the paired phone is counted');
  console.log('ok  the setup check reports each part of the setup');

  link.close();
  console.log('\nPhase 2 remainder checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
