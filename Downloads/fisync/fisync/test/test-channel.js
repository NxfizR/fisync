const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
process.env.PORT = '18484';
process.env.FISYNC_DATA = '' + require('os').tmpdir().replace(/\\/g, '/') + '/fs-data2';
process.env.SHARE_DIR = '/tmp/fs-share2';
require('fs').rmSync(process.env.FISYNC_DATA, { recursive: true, force: true });
require('fs').rmSync(process.env.SHARE_DIR, { recursive: true, force: true });
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const srv = require('../server');
const BASE = 'ws://127.0.0.1:18484';

const fakeFile = (name, buf) => ({
  name, size: buf.length,
  slice: (a, b) => ({ arrayBuffer: async () => Uint8Array.from(buf.subarray(a, b)).buffer }),
});
const rejects = async (p, label) => {
  try { await p; } catch (e) { return e.message; }
  throw new Error('expected a refusal: ' + label);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = async b => Buffer.from(await crypto.subtle.digest('SHA-256', b)).toString('hex');

(async () => {
  const st = await srv.start({ approve: async () => true });

  await rejects(FiClient.pair(`${BASE}/pair`, '000000', 'x'), 'wrong PIN');
  console.log('ok  wrong PIN refused');

  const pin = srv.getState().pin;
  const paired = await FiClient.pair(`${BASE}/pair`, pin, 'Test phone');
  assert.ok(paired.token, 'token returned');
  assert.strictEqual(paired.name, 'Test phone');
  assert.notStrictEqual(srv.getState().pin, pin, 'PIN changes after pairing');
  const token = paired.token;
  console.log('ok  pairing: PIN, approval, token delivered encrypted');

  assert.deepStrictEqual(await FiClient.listFiles(BASE, token), []);
  await FiClient.uploadFile(BASE, token, fakeFile('note.txt', Buffer.from('hello from the phone')));
  const names = (await FiClient.listFiles(BASE, token)).map(f => f.name);
  assert.ok(names.includes('note.txt'));
  const note = await (await FiClient.downloadFile(BASE, token, 'note.txt')).text();
  assert.strictEqual(note, 'hello from the phone');
  console.log('ok  small file: upload, list, download round trip');

  const big = crypto.randomBytes(3 * 1024 * 1024 + 123);
  await FiClient.uploadFile(BASE, token, fakeFile('big.bin', big));
  const back = Buffer.from(await (await FiClient.downloadFile(BASE, token, 'big.bin')).arrayBuffer());
  assert.strictEqual(await sha(back), await sha(big));
  console.log('ok  3 MB file: chunked upload and download match byte for byte');

  const msg = await rejects(FiClient.uploadFile(BASE, token, fakeFile('virus.exe', Buffer.from('MZ'))), 'exe upload');
  assert.ok(/blocked/.test(msg), msg);
  console.log('ok  executable upload refused');

  await rejects(FiClient.connect(BASE + '/files', 'not-the-token', {}), 'unknown token');
  console.log('ok  unknown token cannot connect');

  await rejects(FiClient.connect(BASE + '/desk', token, {}), 'phone on desktop panel');
  const desk = await FiClient.connect(BASE + '/desk', st.owner, {});
  desk.close();
  console.log('ok  phone cannot open the desktop panel; the owner key can');

  const frames = [];
  const view = await FiClient.connect(BASE + '/view', token, { onBlob: b => frames.push(Buffer.from(b)) });
  srv.setMirroring(true);
  srv.pushFrame(Buffer.from('FRAME-JPEG-BYTES'));
  await sleep(300);
  assert.ok(frames.some(f => f.toString() === 'FRAME-JPEG-BYTES'), 'frame arrives decrypted');
  view.close();
  srv.setMirroring(false);
  console.log('ok  screen frames reach the phone through the encrypted channel');

  const ctl = await FiClient.connect(BASE + '/ctl', token, {});
  ctl.sendJson({ t: 'unpair' });
  await sleep(400);
  await rejects(FiClient.connect(BASE + '/files', token, {}), 'unpaired token');
  console.log('ok  phone can remove itself, and its key stops working');

  console.log('\nAll encrypted-channel checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
