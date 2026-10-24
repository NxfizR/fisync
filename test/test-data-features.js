// Trash, duplicate names, room on the disk, photo backup, notification allowlist, data report, diagnostics, log rotation.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
const DATA = path.join(os.tmpdir(), 'fisync-data-' + process.pid);
const SHARE = path.join(os.tmpdir(), 'fisync-data-share-' + process.pid);
const BACKUP = path.join(os.tmpdir(), 'fisync-data-backup-' + process.pid);
for (const d of [DATA, SHARE, BACKUP]) fs.rmSync(d, { recursive: true, force: true });
process.env.PORT = '18507';
process.env.FISYNC_TLS_PORT = '0';
process.env.FISYNC_DATA = DATA;
process.env.SHARE_DIR = SHARE;
process.env.FISYNC_LOG_MAX = '2500';   // small, so the test can see the log rotate
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const srv = require('../server');
const BASE = 'ws://127.0.0.1:18507';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fake = (name, buf) => ({ name, size: buf.length, slice: (a, b) => ({ arrayBuffer: async () => Uint8Array.from(buf.subarray(a, b)).buffer }) });
const refused = async p => { try { await p; } catch (e) { return e.message; } throw new Error('expected a refusal'); };

(async () => {
  await srv.start({ approve: async () => true });
  const phone = await FiClient.pair(`${BASE}/pair`, srv.getState().pin, 'Diag phone');

  // 1. delete moves the file to the trash, and it can be emptied
  await FiClient.uploadFile(BASE, phone.token, fake('gone.txt', Buffer.from('bye')));
  await FiClient.deleteFile(BASE, phone.token, 'gone.txt');
  assert.ok(!fs.existsSync(path.join(SHARE, 'gone.txt')), 'file left the share');
  const trashed = fs.readdirSync(path.join(SHARE, '.trash'));
  assert.ok(trashed.some(f => f.endsWith('-gone.txt')), 'file is in the trash');
  assert.ok(srv.storageReport().find(i => i.name === 'Deleted files (trash)').bytes > 0);
  srv.emptyTrash();
  assert.ok(!fs.existsSync(path.join(SHARE, '.trash')), 'trash emptied');
  console.log('ok  deleting a file from a phone moves it to the trash; the trash can be emptied');

  // 2. a name that is already taken: keep both, replace, or skip
  await FiClient.uploadFile(BASE, phone.token, fake('dup.txt', Buffer.from('first')));
  await FiClient.uploadFile(BASE, phone.token, fake('dup.txt', Buffer.from('second')), undefined, 'keep');
  assert.ok(fs.existsSync(path.join(SHARE, 'dup (1).txt')), 'keep both saves a second copy');
  await FiClient.uploadFile(BASE, phone.token, fake('dup.txt', Buffer.from('third')), undefined, 'replace');
  assert.strictEqual(fs.readFileSync(path.join(SHARE, 'dup.txt'), 'utf8'), 'third', 'replace overwrites the old file');
  assert.ok(/already exists/.test(await refused(FiClient.uploadFile(BASE, phone.token, fake('dup.txt', Buffer.from('fourth')), undefined, 'skip'))), 'skip refuses');
  assert.strictEqual(fs.readFileSync(path.join(SHARE, 'dup.txt'), 'utf8'), 'third', 'skip leaves the file alone');
  console.log('ok  a taken name can be kept beside the old file, replaced, or skipped');

  // 3. room on the disk
  assert.strictEqual(srv.hasRoom(1), true, 'a small file fits');
  assert.strictEqual(srv.hasRoom(Number.MAX_SAFE_INTEGER), false, 'a file larger than the disk is refused');
  console.log('ok  transfers that would fill the disk are refused');

  // 4. photos are also copied to a backup folder when one is set
  srv.setBackupFolder(BACKUP);
  let bridge = null;
  bridge = await FiClient.connect(BASE + '/bridge', phone.token, { onJson: () => {} });
  const png = Buffer.from('fake-photo-bytes');
  bridge.sendJson({ t: 'photo', name: 'holiday.jpg', data: png.toString('base64') });
  await sleep(200);
  assert.ok(fs.existsSync(path.join(BACKUP, 'holiday.jpg')), 'photo copied to the backup folder');
  srv.setBackupFolder(null);
  console.log('ok  synced photos are copied to a backup folder');

  // 5. only the notification apps the user allowed are forwarded
  srv.setNotifApps(['com.chat']);
  const seen = [];
  srv.events.on('incoming', m => seen.push(m.app));
  bridge.sendJson({ t: 'notif', app: 'com.chat', title: 'Ana', text: 'hi' });
  bridge.sendJson({ t: 'notif', app: 'com.other', title: 'Spam', text: 'buy' });
  await sleep(150);
  assert.deepStrictEqual(seen, ['com.chat'], 'other apps are not forwarded');
  srv.setNotifApps([]);
  bridge.close();
  console.log('ok  notifications are forwarded only for the apps you allow');

  // 6. the data report and the diagnostics file keep secrets out
  const report = srv.storageReport();
  assert.ok(report.find(i => i.name === 'Paired phones').bytes > 0, 'report lists the paired phones file');
  const diag = srv.diagnostics();
  const text = JSON.stringify(diag);
  const deviceKey = JSON.parse(fs.readFileSync(path.join(DATA, 'devices.json'), 'utf8'))[0].key;
  assert.ok(!text.includes(deviceKey), 'diagnostics contain no phone key');
  assert.ok(!text.includes('Diag phone'), 'phone names are hidden in the log');
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(text), 'addresses are hidden');
  assert.ok(diag.log.length > 0 && diag.version, 'diagnostics include the log and version');
  console.log('ok  the data report and diagnostics leave out keys, names and addresses');

  // 7. the activity log rotates at its size limit, and each file still checks out
  for (let i = 0; i < 60; i++) srv.setMirroring(i % 2 === 0);
  srv.setMirroring(false);
  assert.ok(fs.existsSync(LOG_OLD()), 'old log kept after rotation');
  assert.ok(srv.verifyLog(srv.LOG).ok, 'new log checks out');
  assert.ok(srv.verifyLog(LOG_OLD()).ok, 'rotated log checks out');
  console.log('ok  the activity log rotates and both files keep their checks');
  const rotatedLines = fs.readFileSync(LOG_OLD(), 'utf8').split('\n').filter(Boolean);
  const rotatedEnd = rotatedLines[rotatedLines.length - 1].split('\t')[2];
  assert.strictEqual(srv.verifyLog(srv.LOG).continuesFrom, rotatedEnd, 'the new log records where the old one ended');
  console.log('ok  the new log records the last line of the old one, so a deleted old log is noticed');

  const link = srv.pairLink();
  assert.ok(/^http:\/\/[^/]+:18507\/#pin=\d{6}/.test(link), 'the pairing code has the address and PIN');
  console.log('ok  the pairing code carries the address and PIN');

  const lockLink = await FiClient.connect(BASE + '/bridge', phone.token, { onJson: () => {} });
  lockLink.sendJson({ t: 'lock', on: true });
  await sleep(150);
  assert.strictEqual(srv.diagnostics().locked, true, 'a phone can lock the computer');
  lockLink.close();
  console.log('ok  a phone can ask the computer to lock its remote access');

  console.log('\nData feature checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

function LOG_OLD() { return require('../server').LOG + '.1'; }
