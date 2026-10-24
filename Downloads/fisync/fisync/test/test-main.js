const fs = require('fs');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
process.env.PORT = '18490';
process.env.FISYNC_DATA = '/tmp/fs-data-main';
process.env.SHARE_DIR = '/tmp/fs-share-main';
require('fs').rmSync(process.env.FISYNC_DATA, { recursive: true, force: true });
require('fs').rmSync(process.env.SHARE_DIR, { recursive: true, force: true });
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const srv = require('../server');
const BASE = 'ws://127.0.0.1:18490';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fake = (name, buf) => ({ name, size: buf.length, slice: (a, b) => ({ arrayBuffer: async () => Uint8Array.from(buf.subarray(a, b)).buffer }) });
const refusal = async (p) => { try { await p; } catch (e) { return e.message; } throw new Error('expected refusal'); };
const pairPhone = async name => {
  const m = await FiClient.pair(`${BASE}/pair`, srv.getState().pin, name);
  return { token: m.token, added: srv.getState().devices.find(d => d.name === name).added };
};

(async () => {
  await srv.start({ approve: async () => true });
  const A = await pairPhone('Full phone');
  const B = await pairPhone('Files phone');
  srv.setPerms(B.added, ['files']);

  // permissions
  assert.ok(/not allowed/.test(await refusal(FiClient.connect(BASE + '/ctl', B.token, {}))), 'files-only phone blocked from control');
  const bFiles = await FiClient.connect(BASE + '/files', B.token, {});
  bFiles.close();
  console.log('ok  files-only phone: files allowed, mouse and keyboard refused');

  // A keeps a control connection; removing its control permission disconnects it
  let closeReason = null;
  const aCtl = await FiClient.connect(BASE + '/ctl', A.token, { onClose: r => { closeReason = r; } });
  srv.setPerms(A.added, ['files', 'control', 'screen', 'phone']);   // no clipboard
  assert.strictEqual(closeReason, null, 'still connected after dropping clipboard only');

  // clipboard: off by default, only with permission, both ways
  const aGot = [];
  const aCtl2 = await FiClient.connect(BASE + '/ctl', A.token, { onJson: m => aGot.push(m) });
  srv.setClipboardSync(true);
  srv.pushClipboard('secret-1');
  await sleep(150);
  assert.ok(!aGot.some(m => m.t === 'clip'), 'no clipboard without the clipboard permission');
  srv.setPerms(A.added, ['files', 'control', 'screen', 'phone', 'clipboard']);
  srv.pushClipboard('hello-phone');
  await sleep(150);
  assert.ok(aGot.some(m => m.t === 'clip' && m.text === 'hello-phone'), 'computer text reaches the phone');

  let fromPhone = null;
  srv.events.once('clip', t => { fromPhone = t; });
  aCtl2.sendJson({ t: 'clip', text: 'phone-text' });
  await sleep(150);
  assert.strictEqual(fromPhone, 'phone-text', 'phone text reaches the computer');

  srv.setClipboardSync(false);
  let leaked = false;
  srv.events.once('clip', () => { leaked = true; });
  aCtl2.sendJson({ t: 'clip', text: 'should-not-pass' });
  await sleep(150);
  assert.ok(!leaked, 'phone text ignored while sync is off');
  console.log('ok  clipboard: off by default, needs permission, works both ways when on');

  // removing the control permission while connected closes the control connection
  srv.setPerms(A.added, ['files']);
  await sleep(150);
  assert.ok(closeReason && /permission|not allowed/i.test(closeReason), 'connection closed with a clear reason: ' + closeReason);
  console.log('ok  removing a permission disconnects that feature at once, with a reason');

  // alerts
  const bAlerts = [];
  const bWatch = await FiClient.connect(BASE + '/files', B.token, { onJson: m => { if (m.t === 'alert') bAlerts.push(m.text); } });
  srv.setMirroring(true);
  await sleep(150);
  srv.setMirroring(false);
  assert.ok(bAlerts.some(t => /started sharing/.test(t)), 'phone told screen sharing started');
  srv.removeDevice(A.added);
  await sleep(150);
  assert.ok(bAlerts.some(t => /Full phone was removed/.test(t)), 'phone told another phone was removed');
  bWatch.close();
  console.log('ok  alerts: screen sharing started and a phone removed');

  // network change notice
  let netEvents = 0;
  srv.events.on('network', () => netEvents++);
  assert.strictEqual(srv.checkNetwork(['10.9.9.9']), true, 'new address is detected');
  assert.strictEqual(srv.checkNetwork(['10.9.9.9']), false, 'same address does not repeat');
  assert.strictEqual(netEvents, 1);
  console.log('ok  network change is detected once');

  // clearer errors
  assert.ok(/no longer paired/.test(await refusal(FiClient.connect(BASE + '/files', 'bogus-token-value', {}))), 'unknown phone gets a clear message');
  assert.ok(/Wrong PIN/.test(await refusal(FiClient.pair(`${BASE}/pair`, '000000', 'x'))), 'wrong PIN gets a clear message');
  console.log('ok  error messages say what went wrong');

  // phone panel connects with the owner key and receives the clipboard switch state
  let deskClip = null;
  const desk = await FiClient.connect(BASE + '/desk', srv.getState().owner, { onJson: m => { if (m.t === 'clipboard') deskClip = m.on; } });
  await sleep(100);
  assert.strictEqual(deskClip, false, 'panel shows clipboard sync is off');
  desk.close();
  console.log('ok  phone panel connects with the owner key and shows the clipboard switch');

  console.log('\nAll access, clipboard, alert and error checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
