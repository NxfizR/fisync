// Phase 2: how a phone connected, new-network alerts, and the desktop window settings.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
const remote = require('../remote');
const DATA = path.join(os.tmpdir(), 'fisync-p2-' + process.pid);
const SHARE = path.join(os.tmpdir(), 'fisync-p2-share-' + process.pid);
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(SHARE, { recursive: true, force: true });
process.env.PORT = '18511';
process.env.FISYNC_TLS_PORT = '0';
process.env.FISYNC_DATA = DATA;
process.env.SHARE_DIR = SHARE;
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const srv = require('../server');

(async () => {
  assert.strictEqual(remote.connectionPath('100.64.1.2'), 'tailscale');
  assert.strictEqual(remote.connectionPath('100.127.9.9'), 'tailscale');
  assert.strictEqual(remote.connectionPath('100.128.0.1'), 'other', 'outside the Tailscale range is not Tailscale');
  assert.strictEqual(remote.connectionPath('192.168.1.5'), 'local');
  assert.strictEqual(remote.connectionPath('::ffff:10.0.0.4'), 'local');
  assert.strictEqual(remote.connectionPath('127.0.0.1'), 'usb');
  assert.strictEqual(remote.connectionPath('8.8.8.8'), 'other');
  assert.strictEqual(remote.networkKey('192.168.1.77'), '192.168.1', 'a local network is its first three octets');
  assert.strictEqual(remote.networkKey('100.64.1.2'), 'tailscale');
  console.log('ok  connections are labelled as Tailscale, local, USB or other');

  await srv.start({ approve: async () => true });
  const phone = await FiClient.pair(`ws://127.0.0.1:18511/pair`, srv.getState().pin, 'Alert phone');
  const id = JSON.parse(fs.readFileSync(path.join(DATA, 'devices.json'), 'utf8')).find(d => d.name === 'Alert phone').id;

  const first = srv.noteNetwork(id, '192.168.1.20');
  assert.strictEqual(first.changed, false, 'the first network is recorded without an alert');
  assert.strictEqual(srv.noteNetwork(id, '192.168.1.99').changed, false, 'the same network is not an alert');
  assert.strictEqual(srv.noteNetwork(id, '192.168.2.7').changed, true, 'a different local network is an alert');
  assert.strictEqual(srv.noteNetwork(id, '192.168.2.8').changed, false, 'and only the first time it is seen');
  assert.strictEqual(srv.noteNetwork(id, '100.64.0.9').changed, true, 'moving onto Tailscale is an alert');
  console.log('ok  a phone on a network it has not used before raises an alert, once');

  assert.ok(srv.getState().devices.find(d => d.name === 'Alert phone').via, 'the phone shows how it connects');
  console.log('ok  the desk and tray can show how each phone connects');
  assert.ok(phone.token, 'pairing still works');

  srv.stopAll ? srv.stopAll() : null;
  console.log('\nPhase 2 checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
