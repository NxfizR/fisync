const fs = require('fs');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');
globalThis.WebSocket = WebSocket;
process.env.PORT = '18491';
process.env.FISYNC_DATA = '/tmp/fs-data-idle';
process.env.SHARE_DIR = '/tmp/fs-share-idle';
require('fs').rmSync(process.env.FISYNC_DATA, { recursive: true, force: true });
require('fs').rmSync(process.env.SHARE_DIR, { recursive: true, force: true });
process.env.FISYNC_IDLE_SECONDS = '1';
const FiClient = new Function(fs.readFileSync(path.join(__dirname, '..', 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();
const srv = require('../server');
const BASE = 'ws://127.0.0.1:18491';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await srv.start({ approve: async () => true });
  const m = await FiClient.pair(`${BASE}/pair`, srv.getState().pin, 'Idle phone');

  let lockReason = null;
  await FiClient.connect(BASE + '/ctl', m.token, { onClose: r => { lockReason = r; } });
  await sleep(2600);
  assert.ok(lockReason && /locked/i.test(lockReason), 'idle phone is locked: ' + lockReason);
  console.log('ok  idle phone locks with a clear reason');

  let waiting = false;
  const back = await FiClient.connect(BASE + '/ctl', m.token, { onPending: () => { waiting = true; } });
  assert.ok(waiting, 'reconnect shows a waiting-for-approval state');
  assert.ok(back.isOpen, 'connects after approval');
  console.log('ok  reconnecting waits for approval on the computer, then connects');

  console.log('\nIdle lock checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
