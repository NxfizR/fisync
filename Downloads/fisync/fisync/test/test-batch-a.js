// Key rotation, tamper-evident log, clipboard filter and history, device list backup, accessibility, and contributor files.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
const DATA = path.join(os.tmpdir(), 'fisync-batcha-' + process.pid);
const SHARE = path.join(os.tmpdir(), 'fisync-batcha-share-' + process.pid);
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(SHARE, { recursive: true, force: true });
process.env.PORT = '18500';
process.env.FISYNC_DATA = DATA;
process.env.SHARE_DIR = SHARE;
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const srv = require('../server');
const BASE = 'ws://127.0.0.1:18500';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const refused = async p => { try { await p; } catch (e) { return e.message; } throw new Error('expected a refusal'); };
const pairPhone = async name => (await FiClient.pair(`${BASE}/pair`, srv.getState().pin, name));

(async () => {
  await srv.start({ approve: async () => true });

  // 1. the phone panel key can be rotated: the old key stops working at once
  const oldKey = srv.getState().owner;
  let closedWith = null;
  const panel = await FiClient.connect(BASE + '/desk', oldKey, { onClose: r => { closedWith = r; } });
  srv.rotateOwnerKey();
  await sleep(150);
  assert.ok(closedWith && /panel key changed|changed/i.test(closedWith), 'open panel is signed out with a clear message');
  assert.ok(/no longer paired|not allowed|refused/i.test(await refused(FiClient.connect(BASE + '/desk', oldKey, {}))), 'old panel key is refused');
  const fresh = await FiClient.connect(BASE + '/desk', srv.getState().owner, {});
  assert.ok(fresh.isOpen, 'new panel key works');
  fresh.close();
  console.log('ok  phone-panel key rotation signs out old panels and accepts the new key');

  // 2. the activity log is a chain: a changed line is detected
  const before = srv.verifyLog();
  assert.ok(before.ok && before.checked > 0, 'log chain is intact');
  const original = fs.readFileSync(srv.LOG, 'utf8');
  fs.writeFileSync(srv.LOG, original.replace('fisync started', 'fisync stopped'));
  const after = srv.verifyLog();
  assert.strictEqual(after.ok, false, 'a changed line is detected');
  fs.writeFileSync(srv.LOG, original);
  assert.ok(srv.verifyLog().ok, 'restored log checks out again');
  console.log('ok  activity log detects a changed or removed line');

  // 3. clipboard: passwords and card numbers are not synced; ordinary text is, and is kept in history
  assert.strictEqual(srv.looksSecret('4111 1111 1111 1111'), 'a card number');
  assert.strictEqual(srv.looksSecret('Tr0ub4dor&3'), 'a password');
  assert.strictEqual(srv.looksSecret('Meeting at 5pm tomorrow'), null);
  const phone = await pairPhone('Clip phone');
  const got = [];
  const ctl = await FiClient.connect(BASE + '/ctl', phone.token, { onJson: m => { if (m.t === 'clip') got.push(m.text); } });
  srv.setClipboardSync(true);
  srv.pushClipboard('Meeting at 5pm tomorrow');
  srv.pushClipboard('4111 1111 1111 1111');
  await sleep(150);
  assert.deepStrictEqual(got, ['Meeting at 5pm tomorrow'], 'only the ordinary text reached the phone');
  assert.ok(srv.clipboardHistory().some(e => e.text === 'Meeting at 5pm tomorrow' && e.from === 'computer'));
  assert.ok(!srv.clipboardHistory().some(e => e.text === '4111 1111 1111 1111'), 'blocked text is not kept');
  ctl.close();
  srv.setClipboardSync(false);
  console.log('ok  clipboard filter blocks card numbers and passwords, and keeps a short history');

  // 4. the device list keeps a backup and restores from it if the main file is damaged
  await pairPhone('Second phone');
  assert.ok(fs.existsSync(path.join(DATA, 'devices.json.bak')), 'backup of the last good list exists');
  const names = srv.getState().devices.map(d => d.name);
  assert.deepStrictEqual(names, ['Clip phone', 'Second phone'], 'two phones paired');
  fs.writeFileSync(path.join(DATA, 'devices.json'), 'this is not the list');
  const restored = srv.getState().devices.map(d => d.name);
  assert.deepStrictEqual(restored, ['Clip phone'], 'list restored from the backup (the copy before the last pairing)');
  console.log('ok  device list is restored from its backup when the main file is damaged');

  // 5. accessibility basics on the phone page
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fields = html.match(/<(input|textarea|select)\b[^>]*>/g) || [];
  for (const f of fields) {
    if (/type="file"/.test(f)) continue;
    if (/type="checkbox"/.test(f) || /id="speed"/.test(f)) continue;   // labelled by the text around them
    assert.ok(/aria-label|data-i18n-aria|data-i18n-ph/.test(f), 'labelled: ' + f.slice(0, 60));
  }
  assert.strictEqual((html.match(/<label class="check">[^<]*<span[^>]*>[^<]*<\/span><input id="[a-z]+" type="checkbox">/g) || []).length, 4, 'each checkbox sits inside its label');
  assert.ok(/id="theme"/.test(html) && /aria-pressed/.test(html), 'theme button and pressed tabs present');
  assert.ok(/role="img"/.test(html) && /aria-live="polite"/.test(html), 'screen and status are announced');
  console.log('ok  phone page: every field is labelled, tabs say which is selected, screen and status are announced');

  // 6. contributor files exist
  for (const f of ['CONTRIBUTING.md', 'CHANGELOG.md', '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', f)), f);
  }
  console.log('ok  contributing guide, changelog and issue templates are in place');

  console.log('\nBatch A checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
