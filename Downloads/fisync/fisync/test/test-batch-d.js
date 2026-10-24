// Pause, resumable transfers, delete and rename, last seen, settings, battery reports to the tray.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
const DATA = path.join(os.tmpdir(), 'fisync-batchd-' + process.pid);
const SHARE = path.join(os.tmpdir(), 'fisync-batchd-share-' + process.pid);
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(SHARE, { recursive: true, force: true });
process.env.PORT = '18505';
process.env.FISYNC_TLS_PORT = '0';
process.env.FISYNC_DATA = DATA;
process.env.SHARE_DIR = SHARE;
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const srv = require('../server');
const BASE = 'ws://127.0.0.1:18505';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const refused = async p => { try { await p; } catch (e) { return e.message; } throw new Error('expected a refusal'); };
const fake = (name, buf) => ({ name, size: buf.length, slice: (a, b) => ({ arrayBuffer: async () => Uint8Array.from(buf.subarray(a, b)).buffer }) });

(async () => {
  await srv.start({ approve: async () => true });
  const pinA = srv.getState().pin;
  const phone = await FiClient.pair(`${BASE}/pair`, pinA, 'Phone D');

  // 1. resumable upload: a connection that drops part way leaves the partial file; the next attempt starts from there
  const data = crypto.randomBytes(3 * 1024 * 1024 + 77);
  const half = data.subarray(0, 1024 * 1024);
  let offsetSeen = null;
  const first = await FiClient.connect(BASE + '/files', phone.token, {
    onJson: m => { if (m.t === 'put-ready') { offsetSeen = m.offset; } },
  });
  first.sendJson({ t: 'put', name: 'big.bin', size: data.length });
  await sleep(150);
  first.sendBlob(new Uint8Array(half));
  await sleep(250);
  first.close();
  await sleep(250);
  const probe = await FiClient.connect(BASE + '/files', phone.token, {});
  let resumeAt = null;
  const probeWatch = new Promise(res => { probe.sendJson({ t: 'put', name: 'big.bin', size: data.length }); setTimeout(() => res(), 300); });
  probe.close();
  await probeWatch;
  const partial = path.join(SHARE, '.upload-big.bin.part');
  assert.ok(fs.existsSync(partial) && fs.statSync(partial).size === half.length, 'partial file kept after the drop');
  await FiClient.uploadFile(BASE, phone.token, fake('big.bin', data));
  const final = fs.readFileSync(path.join(SHARE, 'big.bin'));
  assert.ok(final.equals(data), 'resumed upload matches the original byte for byte');
  assert.ok(!fs.existsSync(partial), 'partial file is gone after success');
  console.log('ok  an interrupted upload resumes from where it stopped');

  // 2. resumable download: asking from an offset returns only the rest
  const dl = await FiClient.connect(BASE + '/files', phone.token, {});
  const parts = [];
  let startInfo = null;
  await new Promise(resolve => {
    const d2 = FiClient.connect; // keep reference
    dl.close();
    FiClient.connect(BASE + '/files', phone.token, {
      onJson: m => { if (m.t === 'get-start') startInfo = m; if (m.t === 'get-end') resolve(); },
      onBlob: b => parts.push(Buffer.from(b)),
    }).then(api => api.sendJson({ t: 'get', name: 'big.bin', offset: 1000 }));
  });
  assert.strictEqual(startInfo.offset, 1000);
  assert.strictEqual(Buffer.concat(parts).length, data.length - 1000);
  assert.ok(Buffer.concat(parts).equals(data.subarray(1000)), 'the rest of the file arrives intact');
  console.log('ok  a download can resume from an offset');

  // 3. delete and rename, with the same safety checks as uploads
  await FiClient.renameFile(BASE, phone.token, 'big.bin', 'renamed.bin');
  assert.ok(fs.existsSync(path.join(SHARE, 'renamed.bin')) && !fs.existsSync(path.join(SHARE, 'big.bin')));
  assert.ok(/blocked/.test(await refused(FiClient.renameFile(BASE, phone.token, 'renamed.bin', 'bad.exe'))), 'rename cannot create a blocked file type');
  await FiClient.deleteFile(BASE, phone.token, 'renamed.bin');
  assert.ok(!fs.existsSync(path.join(SHARE, 'renamed.bin')));
  assert.ok(/No such file/.test(await refused(FiClient.deleteFile(BASE, phone.token, 'renamed.bin'))));
  console.log('ok  files can be renamed and deleted, with the same safety checks');

  // 4. last seen is recorded for a phone that has been in contact
  const seen = srv.getState().devices.find(d => d.name === 'Phone D');
  assert.ok(seen && typeof seen.lastSeen === 'number', 'last seen time is recorded');
  console.log('ok  each paired phone shows when it was last seen');

  // 5. settings can be exported and imported; invalid settings are refused
  srv.setPhotoSchedule(6);
  const saved = srv.exportSettings();
  assert.deepStrictEqual(saved, { version: 1, photoHours: 6 });
  srv.setPhotoSchedule(0);
  srv.importSettings(saved);
  assert.strictEqual(srv.getState().photoHours, 6, 'imported settings apply');
  assert.throws(() => srv.importSettings({ photoHours: 9999 }), /not valid/);
  srv.setPhotoSchedule(0);
  console.log('ok  settings export and import, and invalid settings are refused');

  // 6. pause: phone access stops for a while, then resumes on its own
  const ctlClosed = [];
  const ctl = await FiClient.connect(BASE + '/ctl', phone.token, { onClose: r => ctlClosed.push(r) });
  const deskState = [];
  const desk = await FiClient.connect(BASE + '/desk', srv.getState().owner, { onJson: m => { if (m.t === 'paused') deskState.push(m); } });
  srv.pauseFor(60000, 'test');
  await sleep(150);
  assert.ok(ctlClosed.some(r => /paused/i.test(r)), 'open phone connection is closed with a clear reason');
  assert.ok(/paused/i.test(await refused(FiClient.connect(BASE + '/files', phone.token, {}))), 'phones are refused while paused');
  assert.ok(deskState.some(m => m.until > Date.now()), 'phone panel shows the pause');
  srv.resumeLink();
  const back = await FiClient.connect(BASE + '/files', phone.token, {});
  assert.ok(back.isOpen, 'phones connect again after resume');
  back.close();
  ctl.close();
  desk.close();
  console.log('ok  pause stops phone access with a clear reason, and resume restores it');

  // 7. battery reports from the phone reach the tray
  const trayGot = [];
  srv.events.on('phonestatus', m => trayGot.push(m));
  const bridge = await FiClient.connect(BASE + '/bridge', phone.token, {});
  bridge.sendJson({ t: 'phonestatus', battery: 64, charging: false, network: '4G' });
  await sleep(120);
  assert.ok(trayGot.some(m => m.battery === 64), 'battery reaches the computer for the tray');
  bridge.close();
  console.log('ok  battery reports reach the computer for the tray tooltip');

  console.log('\nBatch D server checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
