// Moves paired phones to a new computer: the file needs its passphrase, and the phone reconnects afterwards without pairing again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const OLD = path.join(os.tmpdir(), 'fisync-mig-old-' + process.pid);
const NEW = path.join(os.tmpdir(), 'fisync-mig-new-' + process.pid);
const FILE = path.join(os.tmpdir(), 'fisync-mig-' + process.pid + '.fisync');
const PASS = 'correct horse battery';
for (const d of [OLD, NEW]) fs.rmSync(d, { recursive: true, force: true });
const env = dir => ({ ...process.env, PORT: '18509', FISYNC_TLS_PORT: '0', FISYNC_DATA: dir, SHARE_DIR: dir + '-share' });
const SERVER = path.join(ROOT, 'server.js');
const run = (dir, code) => execFileSync(process.execPath, ['-e', code], { env: env(dir), encoding: 'utf8', cwd: ROOT }).trim().split('\n').pop();

(async () => {
  const FiClient = new Function(fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'fisync-client.js'), 'utf8') + '\nreturn FiClient;')();

  // 1. old computer: pair a phone, then make the migration file
  const oldServer = spawn(process.execPath, ['-e', `
    const srv = require(${JSON.stringify(SERVER)});
    srv.start({ approve: async () => true }).then(() => console.log('READY ' + srv.getState().pin));`], { env: env(OLD), cwd: ROOT });
  const pin = await new Promise(resolve => oldServer.stdout.on('data', d => { const m = String(d).match(/READY (\d{6})/); if (m) resolve(m[1]); }));
  const oldId = fs.readFileSync(path.join(OLD, 'computer-id'), 'utf8').trim();
  const phone = await FiClient.pair('ws://127.0.0.1:18509/pair', pin, 'Moving phone');
  oldServer.kill();
  await new Promise(r => setTimeout(r, 400));
  run(OLD, `
    const srv = require(${JSON.stringify(SERVER)});
    fs.writeFileSync(${JSON.stringify(FILE)}, srv.createMigrationFile(${JSON.stringify(PASS)}));
    console.log('exported');`.replace('fs.writeFileSync', 'require("fs").writeFileSync'));
  const file = fs.readFileSync(FILE, 'utf8');
  assert.ok(!file.includes('Moving phone') && !file.includes(oldId), 'the file does not show the phone name or the computer id');
  console.log('ok  the migration file is written, and it shows no phone name or computer id');

  // 2. a short passphrase is refused, and a wrong one cannot open the file
  assert.throws(() => run(OLD, `require(${JSON.stringify(SERVER)}).createMigrationFile('short')`), /at least 12/);
  let refused = false;
  try {
    run(NEW, `require(${JSON.stringify(SERVER)}).importMigrationFile(require('fs').readFileSync(${JSON.stringify(FILE)}), 'wrong passphrase here')`);
  } catch (e) { refused = /Wrong passphrase/.test(String(e.stderr || '') + String(e.message)); }
  assert.ok(refused, 'a wrong passphrase is refused');
  console.log('ok  a short passphrase is refused, and a wrong one cannot open the file');

  // 3. new computer: import, then the moved phone connects with its existing token
  const imported = JSON.parse(run(NEW, `
    const srv = require(${JSON.stringify(SERVER)});
    console.log(JSON.stringify(srv.importMigrationFile(require('fs').readFileSync(${JSON.stringify(FILE)}), ${JSON.stringify(PASS)})));`));
  assert.strictEqual(imported.added, 1, 'one phone imported');
  assert.strictEqual(imported.restartNeeded, true, 'the computer id changes, so the new computer needs one restart');
  assert.strictEqual(fs.readFileSync(path.join(NEW, 'computer-id'), 'utf8').trim(), oldId, 'the new computer takes the old id');
  console.log('ok  the phone is imported, and the new computer takes the old computer id');

  const newServer = spawn(process.execPath, ['-e', `
    const srv = require(${JSON.stringify(SERVER)});
    srv.start({ approve: async () => true }).then(() => console.log('LISTENING'));`], { env: env(NEW), cwd: ROOT });
  await new Promise(resolve => newServer.stdout.on('data', d => { if (String(d).includes('LISTENING')) resolve(); }));
  const link = await FiClient.connect('ws://127.0.0.1:18509/bridge', phone.token, { onJson: () => {} });
  assert.ok(link && typeof link.close === 'function', 'the moved phone connects without pairing again');
  link.close();
  newServer.kill();
  console.log('ok  the moved phone connects to the new computer without pairing again');

  fs.rmSync(FILE, { force: true });
  console.log('\nMigration checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
