// The device list is encrypted on disk, and a wrong key cannot overwrite it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
const DATA = path.join(os.tmpdir(), 'fisync-store-test-' + process.pid);
const SHARE = path.join(os.tmpdir(), 'fisync-store-share-' + process.pid);
process.env.PORT = '18498';
process.env.FISYNC_DATA = DATA;
process.env.SHARE_DIR = SHARE;
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const srv = require('../server');
const BASE = 'ws://127.0.0.1:18498';

(async () => {
  const key = crypto.randomBytes(32);
  await srv.start({ approve: async () => true, storageKey: key });
  assert.strictEqual(srv.getState().encrypted, true);
  await FiClient.pair(`${BASE}/pair`, srv.getState().pin, 'Stored phone');
  const file = fs.readFileSync(path.join(DATA, 'devices.json'));
  assert.ok(file.subarray(0, 5).equals(Buffer.from('FISE1')), 'device list is encrypted on disk');
  assert.ok(!file.toString('latin1').includes('Stored phone'), 'the phone name is not readable on disk');
  assert.strictEqual(srv.getState().devices.length, 1);
  console.log('ok  paired phone list is encrypted on disk and still loads');

  // a copy opened with the wrong key sees no phones and refuses to overwrite the file
  const before = crypto.createHash('sha256').update(file).digest('hex');
  const child = `
    const srv = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    srv.setStorageKey(Buffer.alloc(32, 7));
    const count = srv.getState().devices.length;
    let refused = false;
    try { srv.forgetDevices(); } catch (e) { refused = /Refusing/.test(e.message); }
    console.log(JSON.stringify({ count, refused }));
    process.exit(0);`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', child], {
    env: { ...process.env, FISYNC_DATA: DATA, SHARE_DIR: SHARE }, encoding: 'utf8',
  }).trim().split('\n').pop());
  assert.strictEqual(out.count, 0, 'wrong key shows no phones');
  assert.strictEqual(out.refused, true, 'wrong key cannot overwrite the list');
  const after = crypto.createHash('sha256').update(fs.readFileSync(path.join(DATA, 'devices.json'))).digest('hex');
  assert.strictEqual(after, before, 'file unchanged');
  console.log('ok  a wrong key cannot read or overwrite the paired phones');

  console.log('\nStorage checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
