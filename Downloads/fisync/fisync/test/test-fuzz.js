// Malformed and random input must never crash the server or stop it answering.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
const DATA = path.join(os.tmpdir(), 'fisync-fuzz-' + process.pid);
const SHARE = path.join(os.tmpdir(), 'fisync-fuzz-share-' + process.pid);
for (const d of [DATA, SHARE]) fs.rmSync(d, { recursive: true, force: true });
process.env.PORT = '18508';
process.env.FISYNC_TLS_PORT = '0';
process.env.FISYNC_DATA = DATA;
process.env.SHARE_DIR = SHARE;
const srv = require('../server');
const BASE = 'ws://127.0.0.1:18508';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let crashes = 0;
process.on('uncaughtException', () => { crashes++; });
process.on('unhandledRejection', () => { crashes++; });

const paths = ['/pair', '/ctl', '/bridge', '/view', '/desk', '/files', '/nope'];
const junk = i => [
  crypto.randomBytes(i % 60),
  JSON.stringify({ t: crypto.randomBytes(2).toString('hex'), v: i }),
  '{not json',
  JSON.stringify({ t: 'hello', v: 1, id: 'x', eph: '!!', n: '??' }),
  JSON.stringify({ t: 'pair-hello', v: 1, eph: '', n: '', proof: '', name: 'x' }),
  JSON.stringify({ t: 'auth', mac: 42 }),
  JSON.stringify({ t: 'put', name: null, size: 'many' }),
  JSON.stringify({ t: 'get', name: '../../etc/passwd', offset: -5 }),
  JSON.stringify({ t: 'rename', name: 'a', to: '' }),
  JSON.stringify({ t: 'notif', app: { x: 1 } }),
];

(async () => {
  await srv.start({ approve: async () => true });
  for (let i = 0; i < 200; i++) {
    const p = paths[i % paths.length];
    await new Promise(resolve => {
      let w;
      try { w = new WebSocket(BASE + p, ['fisync', 'junk-' + i]); } catch (e) { return resolve(); }
      w.on('error', () => {});
      w.on('close', () => resolve());
      w.on('open', () => {
        for (const payload of junk(i)) { try { w.send(payload); } catch (e) { /* closed already */ } }
        setTimeout(() => { try { w.terminate(); } catch (e) { /* already gone */ } resolve(); }, 15);
      });
      w.on('unexpected-response', () => resolve());
      setTimeout(resolve, 500);
    });
  }
  await sleep(300);
  assert.strictEqual(crashes, 0, 'no crashes while receiving junk');
  const status = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:18508/', r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.strictEqual(status, 200, 'the server still answers after the junk');
  console.log('ok  200 malformed connections: no crashes, and the server still answers');
  console.log('\nFuzz checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
