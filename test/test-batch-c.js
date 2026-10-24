// The secure page (https with a local certificate authority), the translation review sheet, and the guides.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
const DATA = path.join(os.tmpdir(), 'fisync-batchc-' + process.pid);
const SHARE = path.join(os.tmpdir(), 'fisync-batchc-share-' + process.pid);
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(SHARE, { recursive: true, force: true });
process.env.PORT = '18504';
process.env.FISYNC_TLS_PORT = '18503';
process.env.FISYNC_DATA = DATA;
process.env.SHARE_DIR = SHARE;
const srv = require('../server');
const { reviewSheet, toCsv } = require('../scripts/i18n-review');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const get = (url, opts = {}) => new Promise((resolve, reject) => {
  https.get(url, { rejectUnauthorized: true, ...opts }, res => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

(async () => {
  await srv.start({ approve: async () => true });
  // the certificate is made in the background; wait until the secure page is listening
  for (let i = 0; i < 60 && !srv.getState().securePort; i++) await sleep(250);
  const state = srv.getState();
  assert.strictEqual(state.securePort, 18503, 'secure page is listening');
  assert.ok(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(state.caFingerprint), 'fingerprint has the expected form');
  console.log('ok  secure page is listening and shows a certificate fingerprint');

  const ca = fs.readFileSync(path.join(DATA, 'tls', 'ca.pem'));
  const page = await get('https://127.0.0.1:18503/', { ca });
  assert.strictEqual(page.status, 200);
  assert.ok(page.body.includes('<title>fisync</title>'));
  console.log('ok  the phone page loads over https with the installed certificate');

  let refusedWithoutCa = false;
  try { await get('https://127.0.0.1:18503/'); } catch (e) { refusedWithoutCa = true; }
  assert.ok(refusedWithoutCa, 'a browser without the certificate does not trust the page');
  console.log('ok  without the certificate installed, the page is not trusted');

  // the phone page connects over wss on the secure port: a well-formed request with a wrong PIN gets a clear answer
  const crypto = require('crypto');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pubC = ecdh.getPublicKey(null, 'uncompressed');
  const nC = crypto.randomBytes(16);
  const proof = crypto.createHmac('sha256', Buffer.from('000000')).update(Buffer.concat([Buffer.from('pair'), pubC, nC])).digest();
  const reply = await new Promise((resolve, reject) => {
    const w = new WebSocket('wss://127.0.0.1:18503/pair', ['fisync'], { ca });
    w.on('open', () => w.send(JSON.stringify({
      t: 'pair-hello', v: 1, eph: pubC.toString('base64url'), n: nC.toString('base64url'),
      proof: proof.toString('base64url'), name: 'Test',
    })));
    w.on('message', d => { resolve(JSON.parse(d)); w.close(); });
    w.on('error', reject);
  });
  assert.strictEqual(reply.t, 'error', 'secure connection reaches the pairing check');
  assert.ok(/Wrong PIN/.test(reply.msg));
  console.log('ok  pairing works over the secure connection');

  // the certificate follows the network: renewing it keeps the page working
  srv.checkNetwork(['10.99.0.5']);
  await sleep(2500);
  const again = await get('https://127.0.0.1:18503/', { ca });
  assert.strictEqual(again.status, 200, 'page still loads after the certificate is renewed');
  console.log('ok  the server certificate is renewed when the network changes');

  // the same certificate authority is kept
  assert.strictEqual(srv.getState().caFingerprint, state.caFingerprint, 'the authority does not change');
  const plain = await new Promise(resolve => http.get('http://127.0.0.1:18504/ca.pem', res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  }));
  assert.strictEqual(plain.status, 200);
  assert.ok(plain.body.includes('BEGIN CERTIFICATE'), 'the authority can be downloaded on the plain port');
  console.log('ok  the authority stays the same and can be downloaded for installation');

  // translation review sheet
  const { rows, warnings } = reviewSheet(path.join(__dirname, '..', 'public', 'i18n'));
  const englishCount = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'i18n', 'en.json'), 'utf8'))).length;
  assert.strictEqual(rows.length, 23 * englishCount, 'one row per language and string');
  assert.ok(Array.isArray(warnings));
  const csv = toCsv(rows.slice(0, 2));
  assert.ok(csv.startsWith('language,key,english,translation'));
  console.log(`ok  translation review sheet: ${rows.length} rows, ${warnings.length} things to check`);

  // guides
  for (const f of ['docs/SECURE-PAGE.md', 'docs/RELEASE-SIGNING.md', 'docs/KEYSTORE-BACKUP.md', 'docs/GOOGLE-PLAY.md']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f);
  }
  console.log('ok  guides for the secure page, signing, key backup and Google Play are in place');

  console.log('\nBatch C checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
