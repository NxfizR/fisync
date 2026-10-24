// A phone pairs on the local network, then reaches its computer through the relay with the same encrypted handshake.
process.env.FISYNC_RELAY = 'ws://127.0.0.1:18521';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
const { createRelay } = require('../relay/relay');
const { relayAddress } = require('../remote/relay-client');
const DATA = path.join(os.tmpdir(), 'fisync-relay-e2e-' + process.pid);
fs.rmSync(DATA, { recursive: true, force: true });
process.env.PORT = '18513';
process.env.FISYNC_TLS_PORT = '0';
process.env.FISYNC_DATA = DATA;
process.env.SHARE_DIR = DATA + '-share';
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = require('../server');

(async () => {
  const relay = createRelay();
  await new Promise(res => relay.server.listen(18521, '127.0.0.1', res));
  await srv.start({ approve: async () => true });
  const addr = relayAddress(srv.getState().computerId);
  for (let i = 0; i < 100 && !relay.computerOnline(addr); i++) await sleep(20);
  assert.ok(relay.computerOnline(addr), 'the computer is online at the relay');

  const phone = await FiClient.pair('ws://127.0.0.1:18513/pair', srv.getState().pin, 'Relay phone');
  const link = await FiClient.connect(`ws://127.0.0.1:18521/phone/${addr}?route=/bridge`, phone.token, { onJson: () => {} });
  assert.ok(link, 'the phone completes the encrypted handshake through the relay');
  await sleep(100);
  const seen = srv.getState().devices.find(d => d.name === 'Relay phone');
  assert.strictEqual(seen.via, 'relay', 'the computer knows the phone came through the relay');
  console.log('ok  a phone completes the encrypted handshake through the relay, and the computer records it');

  assert.ok(/relay=127\.0\.0\.1%3A18521/.test(srv.pairLink()), 'the pairing code carries the relay address');
  console.log('ok  the pairing code carries the relay address');

  link.close();
  relay.server.close();
  console.log('\nRelay end-to-end checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
