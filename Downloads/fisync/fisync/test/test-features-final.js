// Older messages: the phone panel asks for messages before a date, and the phone's answer comes back.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
const DATA = path.join(os.tmpdir(), 'fisync-final-' + process.pid);
const SHARE = path.join(os.tmpdir(), 'fisync-final-share-' + process.pid);
fs.rmSync(DATA, { recursive: true, force: true });
fs.rmSync(SHARE, { recursive: true, force: true });
process.env.PORT = '18506';
process.env.FISYNC_TLS_PORT = '0';
process.env.FISYNC_DATA = DATA;
process.env.SHARE_DIR = SHARE;
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const srv = require('../server');
const BASE = 'ws://127.0.0.1:18506';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await srv.start({ approve: async () => true });
  const phone = await FiClient.pair(`${BASE}/pair`, srv.getState().pin, 'Final phone');
  const asked = [];
  let bridge = null;
  bridge = await FiClient.connect(BASE + '/bridge', phone.token, {
    onJson: m => {
      if (m.t === 'sms') asked.push(m);
      if (m.t === 'sms' && m.before) bridge.sendJson({ t: 'sms', older: true, items: [{ address: '+15550009', body: 'an older text', date: m.before - 1000, type: 1 }] });
    },
  });
  const desk = [];
  const panel = await FiClient.connect(BASE + '/desk', srv.getState().owner, { onJson: m => desk.push(m) });
  panel.sendJson({ t: 'sms', before: 1700000000000 });
  await sleep(150);
  assert.ok(asked.some(m => m.before === 1700000000000), 'the phone is asked for messages before that date');
  const older = desk.find(m => m.t === 'sms' && m.older);
  assert.ok(older && older.items[0].body === 'an older text', 'the older messages come back to the phone panel');
  console.log('ok  older messages are requested from the phone and returned to the phone panel');
  panel.close();
  bridge.close();
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
