// Notifications, texts from the computer, lock, Wake-on-LAN packet, scheduled photo sync, crash records, release file checks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
const DATA = path.join(os.tmpdir(), 'fisync-batchb-' + process.pid);
const SHARE = path.join(os.tmpdir(), 'fisync-batchb-share-' + process.pid);
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(SHARE, { recursive: true, force: true });
process.env.PORT = '18501';
process.env.FISYNC_DATA = DATA;
process.env.SHARE_DIR = SHARE;
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const srv = require('../server');
const { checkDesktop, checkApk } = require('../scripts/check-artifacts');
const BASE = 'ws://127.0.0.1:18501';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const refused = async p => { try { await p; } catch (e) { return e.message; } throw new Error('expected a refusal'); };

(async () => {
  await srv.start({ approve: async () => true });

  // texts from the computer need a connected phone
  assert.strictEqual(srv.sendTextFromComputer('+15550001', 'hi'), false, 'no phone connected: not sent');

  const phone = await FiClient.pair(`${BASE}/pair`, srv.getState().pin, 'Bridge phone');
  assert.strictEqual(phone.mac, srv.computerMac(), 'pairing returns the computer address for Wake-on-LAN');
  const bridgeGot = [];
  let bridge = null;
  bridge = await FiClient.connect(BASE + '/bridge', phone.token, { onJson: m => bridgeGot.push(m) });

  // 1. notifications from the phone reach the computer and the phone panel
  const incoming = [];
  srv.events.on('incoming', m => incoming.push(m));
  const deskGot = [];
  const desk = await FiClient.connect(BASE + '/desk', srv.getState().owner, { onJson: m => deskGot.push(m) });
  await sleep(50);
  srv.setNotifApps(['Chat']);   // notifications are forwarded only for apps you choose
  bridge.sendJson({ t: 'notif', app: 'Chat', title: 'Ana', text: 'See you at five' });
  await sleep(120);
  assert.ok(incoming.some(m => m.t === 'notif' && m.app === 'Chat'), 'computer is told about the notification');
  assert.ok(deskGot.some(m => m.t === 'notif' && m.title === 'Ana'), 'phone panel shows the notification');
  console.log('ok  phone notifications reach the computer and the phone panel');

  // 2. a reply typed on the computer is sent by the phone
  assert.strictEqual(srv.sendTextFromComputer('+15550001', 'On my way'), true);
  await sleep(120);
  const sent = bridgeGot.find(m => m.t === 'sendsms');
  assert.ok(sent && sent.to === '+15550001' && sent.body === 'On my way', 'phone receives the reply to send');
  console.log('ok  a reply typed on the computer is sent by the phone');

  // 3. lock: remote control, screen and files stop; calls and texts keep working
  const ctlReasons = [];
  const ctl = await FiClient.connect(BASE + '/ctl', phone.token, { onClose: r => ctlReasons.push(r) });
  srv.lockComputer('test');
  await sleep(150);
  assert.ok(ctlReasons.some(r => /locked/i.test(r)), 'open control connection is closed with a clear reason');
  assert.ok(/locked/i.test(await refused(FiClient.connect(BASE + '/files', phone.token, {}))), 'files refused while locked');
  assert.ok(/locked/i.test(await refused(FiClient.connect(BASE + '/view', phone.token, {}))), 'screen refused while locked');
  assert.ok(bridge.isOpen, 'calls and texts keep working');
  assert.ok(deskGot.some(m => m.t === 'locked' && m.on === true), 'phone panel shows the lock');
  srv.unlockComputer();
  const again = await FiClient.connect(BASE + '/files', phone.token, {});
  assert.ok(again.isOpen, 'files work again after unlock');
  again.close();
  console.log('ok  lock stops remote control, screen and files; calls and texts continue; unlock restores them');

  // 4. Wake-on-LAN packet
  const pkt = srv.magicPacket('00:11:22:33:44:55');
  assert.strictEqual(pkt.length, 102, 'six bytes of 0xFF plus sixteen copies of the address');
  assert.ok(pkt.subarray(0, 6).equals(Buffer.alloc(6, 0xff)));
  for (let i = 0; i < 16; i++) assert.ok(pkt.subarray(6 + i * 6, 12 + i * 6).equals(Buffer.from('001122334455', 'hex')));
  assert.throws(() => srv.magicPacket('nope'), /12 hex digits/);
  console.log('ok  Wake-on-LAN packet is built correctly');

  // 5. scheduled photo sync asks the phone (checked with a short test interval)
  bridgeGot.length = 0;
  srv.setPhotoSchedule(0.0003);
  await sleep(2600);
  srv.setPhotoSchedule(0);
  assert.ok(bridgeGot.some(m => m.t === 'syncphotos'), 'phone is asked to sync photos on schedule');
  console.log('ok  scheduled photo sync asks the phone');

  // 6. crash records stay on this computer
  srv.recordCrash(new Error('batch b test crash'));
  assert.ok(srv.crashText().includes('batch b test crash'));
  srv.clearCrash();
  assert.strictEqual(srv.crashText(), '');
  console.log('ok  crash records are kept on this computer and can be cleared');

  // 7. release file checks
  const dist = path.join(os.tmpdir(), 'fisync-dist-' + process.pid);
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'app.exe'), 'tiny');
  assert.ok(checkDesktop(dist, 1).some(p => /latest\.yml/.test(p)), 'missing latest.yml is reported');
  fs.writeFileSync(path.join(dist, 'latest.yml'), 'version: 1');
  assert.deepStrictEqual(checkDesktop(dist, 1), [], 'complete desktop release passes');
  assert.ok(checkDesktop(dist, 1000).some(p => /too small/.test(p)), 'a tiny installer is reported');
  const apk = path.join(os.tmpdir(), 'fisync-apk-' + process.pid);
  fs.rmSync(apk, { recursive: true, force: true });
  fs.mkdirSync(apk, { recursive: true });
  for (const f of ['classes.dex', 'AndroidManifest.xml', 'resources.arsc']) fs.writeFileSync(path.join(apk, f), 'x');
  execFileSync('zip', ['-q', 'app-release.apk', 'classes.dex', 'AndroidManifest.xml', 'resources.arsc'], { cwd: apk });
  assert.deepStrictEqual(checkApk(apk, 1), [], 'complete APK passes');
  fs.rmSync(path.join(apk, 'app-release.apk'));
  execFileSync('zip', ['-q', 'app-release.apk', 'classes.dex', 'AndroidManifest.xml'], { cwd: apk });
  assert.ok(checkApk(apk, 1).some(p => /resources\.arsc/.test(p)), 'an APK without resources is reported');
  console.log('ok  release checks catch missing or incomplete installers and APKs');

  desk.close();
  bridge.close();
  console.log('\nBatch B checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
