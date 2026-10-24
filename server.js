// fisync server. `node server.js` runs it in a terminal; the desktop app (main.js) starts it too.
// Everything except the static pages travels through an encrypted channel (see README "Encryption").
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const remote = require('./remote');
const relayClient = require('./remote/relay-client');

const PORT = Number(process.env.PORT) || 8484;
const SHARE = process.env.SHARE_DIR || path.join(os.homedir(), 'fisync');
const DATA = process.env.FISYNC_DATA || path.join(os.homedir(), '.fisync');
const DEVICES = path.join(DATA, 'devices.json');
const LOG = path.join(DATA, 'activity.log');
const PIN_LIFETIME = 5 * 60 * 1000;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const MAX_CLIP = 100000;
const CHUNK = 256 * 1024;
const IDLE_MS = (Number(process.env.FISYNC_IDLE_SECONDS) || 3600) * 1000;   // phones lock after this much inactivity
const MAX_BPS = (Number(process.env.FISYNC_MAX_MBPS) || 0) * 1024 * 1024;   // 0 = no transfer limit
const PERMS = ['files', 'control', 'screen', 'phone', 'clipboard'];
const ROUTE_PERM = { '/ctl': 'control', '/view': 'screen', '/files': 'files', '/bridge': 'phone' };
const BLOCKED_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'lnk', 'sh', 'jar', 'reg', 'hta', 'dll', 'appimage']);
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' blob: data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'",
};
fs.mkdirSync(SHARE, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

const ID_FILE = path.join(DATA, 'computer-id');
let COMPUTER_ID = (() => {
  try { return fs.readFileSync(ID_FILE, 'utf8').trim(); } catch { /* first run */ }
  const id = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(ID_FILE, id);
  return id;
})();

const events = new EventEmitter();   // 'pin', 'state', 'mirror', 'clip', 'network'
const sleep = ms => new Promise(r => setTimeout(r, ms));
const parse = d => { try { return JSON.parse(d); } catch { return null; } };
const lanIps = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
let logPrev = '0'.repeat(64);
function initLog() {
  try {
    for (const l of fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean)) {
      const f = l.split('\t');
      if (f.length === 3) logPrev = f[2];
    }
  } catch { /* no log yet */ }
}
const LOG_MAX = Number(process.env.FISYNC_LOG_MAX) || 5 * 1024 * 1024;
// Adds one line to the log, chained to the line before it.
function appendLine(msg) {
  const body = `${new Date().toISOString()}\t${msg}`;
  const h = crypto.createHash('sha256').update(logPrev + '\n' + body).digest('hex');
  logPrev = h;
  try { fs.appendFileSync(LOG, `${body}\t${h}\n`); } catch { /* logging never stops the server */ }
}
const log = msg => {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > LOG_MAX) {
      const last = logPrev;
      fs.renameSync(LOG, LOG + '.1');
      logPrev = last;
      appendLine(`log continues from ${last}`);   // the new file records where the old one ended
    }
  } catch { /* rotation failing never stops the server */ }
  appendLine(msg);
};
initLog();
// Checks the chain: returns { ok: false, line } at the first line that was changed or removed.
function verifyLog(file = LOG) {
  let prev = '0'.repeat(64), chained = false, checked = 0, continuesFrom = null;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].split('\t');
    if (f.length !== 3) { if (chained) return { ok: false, line: i + 1 }; continue; }
    const anchor = i === 0 ? /^log continues from ([0-9a-f]{64})$/.exec(f[1]) : null;
    if (anchor) { prev = anchor[1]; continuesFrom = anchor[1]; }
    const h = crypto.createHash('sha256').update(prev + '\n' + f[0] + '\t' + f[1]).digest('hex');
    if (h !== f[2]) return { ok: false, line: i + 1 };
    prev = h;
    chained = true;
    checked++;
  }
  return { ok: true, checked, continuesFrom };
}

// ---------- crypto helpers (wire format shared with src/crypto-core.js and FiCrypto.java)
const hmacB = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const ctEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const idOfToken = t => crypto.createHash('sha256')
  .update(Buffer.concat([Buffer.from('fisync/1 id'), Buffer.from(t, 'utf8')])).digest('base64url');
const keyOfToken = t => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(t, 'utf8'), Buffer.alloc(0), 'fisync/1 auth', 32));
const nonceOf = n => { const b = Buffer.alloc(12); b.writeBigUInt64BE(BigInt(n), 4); return b; };
const seal = (key, n, plain) => {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonceOf(n));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
};
const open = (key, n, data) => {
  if (data.length < 16) throw new Error('short frame');
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonceOf(n));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
};

let OWNER = crypto.randomBytes(24).toString('base64url');
let OWNER_ID = idOfToken(OWNER);
let OWNER_KEY = keyOfToken(OWNER);
let PIN = '';
let pinTimer = null;
let approve = askInTerminal;
let pairing = false;
let mirroring = false;
let clipboardSync = false;     // off unless you turn it on
let screenTimer = null;
let bridge = null;             // Channel of the Android app, while it is connected
let lastFrame = null;
const fails = new Map();
const live = new Set();        // authenticated sockets (ws.who is set)
const viewers = new Set();     // Channels watching the screen
const desks = new Set();       // Channels of the phone panel on this computer
const phoneChans = new Set();  // Channels of every paired phone that is connected
const DESK_COMMANDS = new Set(['dial', 'answer', 'hangup', 'calls', 'sms', 'sendsms', 'syncphotos', 'phonestatus', 'contacts']);

// ---------- devices: { name, id, key, added, perms, locked }. Tokens are never stored.
// ---------- encrypted device store. With a storage key, devices.json is encrypted on disk.
const STORE_MAGIC = Buffer.from('FISE1');
let STORE_KEY = null;
let storeError = null;
function setStorageKey(k) { STORE_KEY = k || null; }
function readStore(file = DEVICES) {
  let raw;
  try { raw = fs.readFileSync(file); } catch { return null; }   // no file yet
  if (raw.subarray(0, 5).equals(STORE_MAGIC)) {
    if (!STORE_KEY) throw new Error('devices.json is encrypted but no storage key is available');
    const d = crypto.createDecipheriv('aes-256-gcm', STORE_KEY, raw.subarray(5, 17));
    d.setAuthTag(raw.subarray(17, 33));
    return Buffer.concat([d.update(raw.subarray(33)), d.final()]).toString('utf8');
  }
  return raw.toString('utf8');   // an older plain-text file; it is encrypted on the next save
}
let restoredFromBackup = false;
function loadDevices() {
  let lastError = null;
  for (const file of [DEVICES, DEVICES + '.bak']) {
    try {
      const text = readStore(file);
      if (text === null) {
        if (file === DEVICES) return [];   // no list yet: a new computer
        continue;                          // no backup yet: keep the earlier error
      }
      storeError = null;
      restoredFromBackup = file !== DEVICES;
      if (restoredFromBackup) log('device list restored from its backup');
      return text ? JSON.parse(text) : [];
    } catch (e) {
      lastError = e;
    }
  }
  storeError = lastError;
  log(`could not read devices: ${lastError.message}`);
  return [];
}
function saveDevices(list) {
  // Never overwrite the list if it could not be read: that would lose every paired phone.
  if (storeError) throw new Error(`Refusing to overwrite devices.json: ${storeError.message}`);
  let out = Buffer.from(JSON.stringify(list, null, 2), 'utf8');
  if (STORE_KEY) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', STORE_KEY, iv);
    const ct = Buffer.concat([c.update(out), c.final()]);
    out = Buffer.concat([STORE_MAGIC, iv, c.getAuthTag(), ct]);
  }
  // Keep the last good copy, then write a temporary file and swap it in, so a crash mid-write cannot leave half a file.
  if (!restoredFromBackup && fs.existsSync(DEVICES)) fs.copyFileSync(DEVICES, DEVICES + '.bak');
  fs.writeFileSync(DEVICES + '.tmp', out, { mode: 0o600 });
  fs.renameSync(DEVICES + '.tmp', DEVICES);
  restoredFromBackup = false;
}
const hasPerm = (d, p) => (d.perms || PERMS).includes(p);
// Permissions are read fresh, so a change applies to a phone that is already connected.
const hasLive = (ws, p) => {
  if (!ws.who || !ws.who.device) return false;
  const d = loadDevices().find(x => x.id === ws.who.device.id);
  return !!d && hasPerm(d, p);
};
function findRole(id) {
  if (id === OWNER_ID) return { role: 'owner', key: OWNER_KEY };
  const list = loadDevices();
  const d = list.find(x => x.id === id) || list.find(x => x.prevId === id);
  if (!d) return null;
  const viaPrev = d.id !== id;   // still using the token from before a key rotation
  return { role: 'phone', key: Buffer.from(viaPrev ? d.prevKey : d.key, 'base64url'), device: d, viaPrev };
}
function rotatePin(reason) {
  PIN = String(crypto.randomInt(100000, 1000000));
  clearTimeout(pinTimer);
  pinTimer = setTimeout(() => rotatePin('expired'), PIN_LIFETIME);
  pinTimer.unref();
  log(`pairing PIN changed (${reason})`);
  events.emit('pin');
}
rotatePin('startup');

function alertPhones(text) {
  for (const c of phoneChans) c.json({ t: 'alert', text });
}
function removeId(id, why) {
  const gone = loadDevices().find(x => x.id === id);
  log(why);
  saveDevices(loadDevices().filter(x => x.id !== id));
  for (const ws of live) if (ws.who && ws.who.device && ws.who.device.id === id) ws.close(4401, 'not paired');
  if (gone) alertPhones(`${gone.name} was removed from this computer`);
  events.emit('state');
}
function removeDevice(added) {
  const d = loadDevices().find(x => x.added === added);
  if (d) removeId(d.id, `removed phone "${d.name}"`);
}
function forgetDevices() {
  log('all phones removed');
  saveDevices([]);
  for (const ws of live) if (ws.who && ws.who.role === 'phone') ws.close(4401, 'not paired');
  rotatePin('all phones removed');
  events.emit('state');
}
function setPerms(added, perms) {
  const list = loadDevices();
  const d = list.find(x => x.added === added);
  if (!d) return;
  d.perms = perms.filter(p => PERMS.includes(p));
  saveDevices(list);
  log(`permissions for "${d.name}": ${d.perms.join(', ') || 'none'}`);
  for (const ws of live) {
    if (ws.who && ws.who.device && ws.who.device.id === d.id && ROUTE_PERM[ws.route] && !d.perms.includes(ROUTE_PERM[ws.route])) {
      ws.close(4403, 'permission removed');
    }
  }
  events.emit('state');
}
function setLocked(id, flag) {
  const list = loadDevices();
  const d = list.find(x => x.id === id);
  if (!d) return;
  d.locked = flag;
  saveDevices(list);
}
function lockDevice(ws) {
  const id = ws.who.device.id;
  setLocked(id, true);
  log(`locked "${ws.who.device.name}" after inactivity`);
  for (const other of live) {
    if (other.who && other.who.device && other.who.device.id === id) other.close(4408, 'locked after inactivity');
  }
}
// Phones that sit idle lock. The Android service is exempt, because it must stay connected in the background.
const idleCheck = setInterval(() => {
  const now = Date.now();
  for (const ws of live) {
    if (!ws.who || ws.who.role !== 'phone' || ws.route === '/bridge') continue;
    if (now - (ws.lastSeen || 0) > IDLE_MS) lockDevice(ws);
  }
}, Math.min(IDLE_MS, 60000));
idleCheck.unref();

// Signs out the phone panel: a new key is made, and open panels must be reopened from the fisync window.
function rotateOwnerKey() {
  OWNER = crypto.randomBytes(24).toString('base64url');
  OWNER_ID = idOfToken(OWNER);
  OWNER_KEY = keyOfToken(OWNER);
  for (const ws of live) if (ws.who && ws.who.role === 'owner') ws.close(4410, 'panel key changed');
  log('phone-panel key rotated');
  events.emit('state');
}

// ---------- pairing: right PIN AND an Allow click on this computer
function askInTerminal(name) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(
    `\nAllow "${name}" to connect to this computer? [y/N] `,
    answer => { rl.close(); resolve(/^y/i.test(answer.trim())); }));
}

async function pairRequest(ip, pubC, nC, proof, name) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (Date.now() < f.until) return { error: 'Too many wrong PINs. Wait a minute and try again.' };
  const expect = hmacB(Buffer.from(PIN, 'utf8'), Buffer.concat([Buffer.from('pair'), pubC, nC]));
  if (!ctEq(expect, proof)) {
    if (++f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; }
    fails.set(ip, f);
    log(`wrong PIN from ${ip}`);
    return { error: 'Wrong PIN. The PIN is on your computer and changes every 5 minutes.' };
  }
  fails.delete(ip);
  if (pairing) return { error: 'Another phone is waiting for approval on your computer.' };
  pairing = true;
  try {
    const label = String(name || '').replace(/[^\w .()-]/g, '').trim().slice(0, 40) || 'Phone';
    const ok = await Promise.race([
      Promise.resolve().then(() => approve(label)).catch(() => false),
      new Promise(resolve => setTimeout(() => resolve(false), 60000)),
    ]);
    if (!ok) { log(`pairing from ${ip} ("${label}") was not approved`); return { error: 'Not approved on your computer.' }; }
    const token = crypto.randomBytes(32).toString('base64url');
    saveDevices([...loadDevices(), {
      name: label, id: idOfToken(token), key: keyOfToken(token).toString('base64url'),
      added: Date.now(), perms: PERMS.slice(), locked: false,
    }]);
    log(`paired "${label}" from ${ip}`);
    rotatePin('phone paired');
    events.emit('state');
    return { token, name: label };
  } finally {
    pairing = false;
  }
}

function pairSocket(ws, ip) {
  ws.on('message', async (data, isBinary) => {
    try {
      if (isBinary) return ws.close();
      const m = parse(data.toString());
      if (!m || m.t !== 'pair-hello' || m.v !== 1) return ws.close();
      const pubC = Buffer.from(String(m.eph), 'base64url');
      const nC = Buffer.from(String(m.n), 'base64url');
      const proof = Buffer.from(String(m.proof), 'base64url');
      if (pubC.length !== 65 || nC.length !== 16) return ws.close();
      const r = await pairRequest(ip, pubC, nC, proof, m.name);
      if (r.error) { ws.send(JSON.stringify({ t: 'error', msg: r.error })); return ws.close(); }
      const e = crypto.createECDH('prime256v1');
      e.generateKeys();
      const nS = crypto.randomBytes(16);
      const k = Buffer.from(crypto.hkdfSync('sha256', e.computeSecret(pubC), Buffer.concat([nC, nS]), 'fisync/1 pair', 32));
      const ct = seal(k, 0, Buffer.from(JSON.stringify({ token: r.token, name: r.name, cid: COMPUTER_ID, mac: computerMac() }), 'utf8'));
      ws.send(JSON.stringify({
        t: 'pair-ack', eph: e.getPublicKey(null, 'uncompressed').toString('base64url'),
        n: nS.toString('base64url'), ct: ct.toString('base64url'),
      }));
      ws.close();
    } catch {
      ws.close();
    }
  });
}

// ---------- relay: reaches this computer through a relay when a direct connection is not possible
const RELAY_FILE = path.join(DATA, 'relay.json');
const RELAY_ROUTES = ['/ctl', '/bridge', '/view', '/desk', '/files'];
let relayRun = null;
function relayUrl() {
  if (process.env.FISYNC_RELAY) return process.env.FISYNC_RELAY;
  try { return JSON.parse(fs.readFileSync(RELAY_FILE, 'utf8')).url || null; } catch { return null; }
}
function startRelay() {
  if (relayRun) { relayRun.stop(); relayRun = null; }
  const url = relayUrl();
  if (!url || !/^wss?:\/\//.test(url) || !COMPUTER_ID) return null;
  relayRun = relayClient.startRelayClient({
    relayUrl: url,
    computerId: COMPUTER_ID,
    onStatus: st => log(`relay ${st}`),
    onSession: (s, route) => acceptRelayed(s, route),
  });
  return relayRun;
}
// A phone reached us through the relay: it gets the same encrypted handshake as a direct connection.
function acceptRelayed(s, route) {
  if (!RELAY_ROUTES.includes(route)) return s.close(4404, 'no such route');
  secureSession(s, route, (chan, who) => serve(route, chan, s, who));
}

// ---------- key rotation for Android phones, file checksums, setup check
const pendingRotation = new Map();   // device id -> { chan, ws, id, key }
// Gives the phone a new token. The old one keeps working until the phone connects with the new one.
function rotatePhoneKey(added) {
  const d = loadDevices().find(x => x.added === added);
  if (!d) return { ok: false, reason: 'That phone is not paired' };
  const ws = [...live].find(w => w.who && w.who.role === 'phone' && w.who.device && w.who.device.id === d.id && w.route === '/bridge');
  if (!ws) return { ok: false, reason: 'Open the fisync app on the phone, then rotate its key' };
  const token = crypto.randomBytes(32).toString('base64url');
  pendingRotation.set(d.id, { chan: ws.chan, ws, id: idOfToken(token), key: keyOfToken(token).toString('base64url') });
  ws.chan.json({ t: 'rekey', token });
  log(`key rotation sent to "${d.name}"`);
  return { ok: true };
}
// The phone confirmed the new token: switch to it, and keep the old one until the phone uses the new one.
function commitRotation(chan) {
  for (const [devId, p] of pendingRotation) {
    if (p.chan !== chan) continue;
    pendingRotation.delete(devId);
    const list = loadDevices();
    const d = list.find(x => x.id === devId);
    if (!d) return;
    d.prevId = d.id;
    d.prevKey = d.key;
    d.id = p.id;
    d.key = p.key;
    saveDevices(list);
    log(`key rotated for "${d.name}"`);
    p.ws.close(4409, 'key rotated');   // the phone reconnects with the new token
    return;
  }
}
// Once a phone connects with the new token, the old one stops working.
function forgetOldKey(devId) {
  const list = loadDevices();
  const d = list.find(x => x.id === devId);
  if (!d || !d.prevId) return;
  delete d.prevId;
  delete d.prevKey;
  saveDevices(list);
}
function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
function setupCheck() {
  const s = getState();
  const bt = remote.beaconCommand(process.platform, BEACON_FILE, __dirname);
  const phones = loadDevices().length;
  return [
    { name: 'fisync is running', ok: true, detail: `listening on port ${PORT}` },
    { name: 'Network connection', ok: lanIps().length > 0, detail: lanIps().length ? `address ${lanIps()[0]}` : 'no network address found' },
    { name: 'Tailscale', ok: !!tsInfo.running, detail: !tsInfo.installed ? 'not installed (optional)' : tsInfo.running ? `running as ${tsInfo.dnsName}` : 'installed but not running' },
    { name: 'Nearby Bluetooth', ok: !bt.reason, detail: bt.reason || 'available on this computer' },
    { name: 'Secure page', ok: s.securePort > 0, detail: s.securePort ? `ready on port ${s.securePort}` : 'not started' },
    { name: 'Phones paired', ok: phones > 0, detail: phones ? `${phones} paired` : 'none yet: show the pairing code' },
    { name: 'Stored data encrypted', ok: !!STORE_KEY, detail: STORE_KEY ? 'yes, with the system keychain' : 'no' },
  ];
}

// ---------- migration file: moves paired phones to a new computer, protected by a passphrase
function setComputerId(id) {
  COMPUTER_ID = String(id);
  fs.writeFileSync(ID_FILE, COMPUTER_ID);
  log('computer id set from a migration file');
}
function encryptBundle(obj, passphrase) {
  const salt = crypto.randomBytes(16);
  const N = 131072;
  const key = crypto.scryptSync(passphrase, salt, 32, { N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return Buffer.from(JSON.stringify({
    format: 'fisync-migration-file', v: 1, kdf: 'scrypt', N,
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64'),
  }), 'utf8');
}
function decryptBundle(buf, passphrase) {
  let env;
  try { env = JSON.parse(buf.toString('utf8')); } catch { throw new Error('This is not a fisync migration file'); }
  if (!env || env.format !== 'fisync-migration-file' || env.v !== 1) throw new Error('This is not a fisync migration file');
  let plain;
  try {
    const key = crypto.scryptSync(passphrase, Buffer.from(env.salt, 'base64'), 32, { N: env.N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    plain = Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]);
  } catch {
    throw new Error('Wrong passphrase, or the file is damaged');
  }
  return JSON.parse(plain.toString('utf8'));
}
function createMigrationFile(passphrase) {
  if (!passphrase || String(passphrase).length < 12) throw new Error('Use a passphrase of at least 12 characters');
  return encryptBundle({
    format: 'fisync-migration', version: 1, createdAt: new Date().toISOString(),
    computerId: COMPUTER_ID, settings: exportSettings(),
    devices: loadDevices().map(d => ({ name: d.name, id: d.id, key: d.key, added: d.added, perms: d.perms || PERMS })),
  }, String(passphrase));
}
// Adds the phones from the file; phones already here are kept.
function importMigrationFile(buf, passphrase) {
  const obj = decryptBundle(buf, String(passphrase || ''));
  if (obj.format !== 'fisync-migration' || obj.version !== 1) throw new Error('This is not a fisync migration file');
  const list = loadDevices();
  const known = new Set(list.map(d => d.id));
  let added = 0;
  for (const d of obj.devices || []) {
    if (!d.id || !d.key || known.has(d.id)) continue;
    list.push({ name: String(d.name || 'Phone').slice(0, 40), id: d.id, key: d.key, added: d.added || Date.now(),
      perms: (d.perms || PERMS).filter(p => PERMS.includes(p)), locked: false });
    added++;
  }
  saveDevices(list);
  const idChanged = !!obj.computerId && obj.computerId !== COMPUTER_ID;
  if (idChanged) setComputerId(obj.computerId);
  if (obj.settings) { try { importSettings(obj.settings); } catch { /* keep the settings already here */ } }
  log(`migration file imported: ${added} phone(s) added`);
  events.emit('state');
  return { added, restartNeeded: idChanged };
}

// ---------- remote access: Tailscale name, nearby Bluetooth beacon
let tsInfo = { installed: false, running: false, dnsName: null, ips: [] };
let bleProc = null;
let bleTimer = null;
const BLE_MINUTES = 10;   // the beacon is only on this long unless the desk panel turns it on again
const BEACON_FILE = path.join(DATA, 'beacon.json');
function refreshRemote() {
  return remote.tailscaleStatus().then(r => { tsInfo = r; return r; });
}
// Writes the current LAN address into the beacon file, which the Bluetooth helper reads.
function writeBeaconFile() {
  const ip = lanIps().find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (!ip || !COMPUTER_ID) return null;
  const hex = remote.encodeBeacon(COMPUTER_ID, ip, PORT).toString('hex');
  fs.writeFileSync(BEACON_FILE, JSON.stringify({ hex, ip, port: PORT, updated: new Date().toISOString() }));
  return ip;
}
// The link the pairing code carries: the LAN address and PIN, plus the Tailscale name when there is one.
function pairLink() {
  const ip = lanIps().find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || 'localhost';
  const ts = tsInfo.dnsName ? `&ts=${encodeURIComponent(tsInfo.dnsName)}` : '';
  const rl = relayUrl() ? `&relay=${encodeURIComponent(new URL(relayUrl()).host)}` : '';
  return `http://${ip}:${PORT}/#pin=${PIN}${ts}${rl}`;
}
function setBluetoothBeacon(on) {
  if (!on) {
    clearTimeout(bleTimer);
    if (bleProc) { bleProc.kill(); bleProc = null; }
    log('nearby Bluetooth off');
    return { ok: true, on: false };
  }
  if (bleProc) return { ok: true, on: true };
  if (!writeBeaconFile()) return { ok: false, reason: 'No network address to share yet' };
  const c = remote.beaconCommand(process.platform, BEACON_FILE, __dirname);
  if (c.reason) return { ok: false, reason: c.reason };
  bleProc = spawn(c.cmd, c.args, { windowsHide: true, stdio: 'ignore' });
  bleProc.on('error', e => { log('nearby Bluetooth could not start: ' + e.message); bleProc = null; });
  bleProc.on('exit', () => { bleProc = null; });
  clearTimeout(bleTimer);
  bleTimer = setTimeout(() => setBluetoothBeacon(false), BLE_MINUTES * 60 * 1000);
  bleTimer.unref();
  log('nearby Bluetooth on for ' + BLE_MINUTES + ' minutes');
  return { ok: true, on: true };
}

// ---------- trash, room on the disk, notification allowlist, photo backup, data report, diagnostics
const TRASH = path.join(SHARE, '.trash');
let notifApps = new Set();
let backupDir = null;
// Refuses a transfer that would leave less than 200 MB free.
function hasRoom(bytes) {
  try {
    const st = fs.statfsSync(SHARE);
    return st.bavail * st.bsize > bytes + 200 * 1024 * 1024;
  } catch { return true; }
}
const notifAllowed = app => notifApps.has(String(app));
function setNotifApps(list) {
  notifApps = new Set((Array.isArray(list) ? list : []).map(String).slice(0, 200));
  log(`notification apps allowed: ${notifApps.size}`);
  events.emit('state');
}
function setBackupFolder(dir) {
  backupDir = dir ? String(dir) : null;
  if (backupDir) fs.mkdirSync(backupDir, { recursive: true });
  log(backupDir ? 'photo backup folder set' : 'photo backup turned off');
}
function moveToTrash(file, name) {
  fs.mkdirSync(TRASH, { recursive: true });
  fs.renameSync(file, path.join(TRASH, `${Date.now()}-${name}`));
}
function dirBytes(dir) {
  try {
    return fs.readdirSync(dir).reduce((sum, f) => sum + (fs.statSync(path.join(dir, f)).isFile() ? fs.statSync(path.join(dir, f)).size : 0), 0);
  } catch { return 0; }
}
function emptyTrash() {
  fs.rmSync(TRASH, { recursive: true, force: true });
  log('trash emptied');
}
function clearLog() {
  fs.writeFileSync(LOG, '');
  logPrev = '0'.repeat(64);
  log('activity log cleared');
}
// Everything stored on this computer, with its size and purpose.
function storageReport() {
  const size = f => { try { return fs.statSync(f).size; } catch { return 0; } };
  return [
    { name: 'Paired phones', path: DEVICES, bytes: size(DEVICES), purpose: 'names, dates and encrypted keys of paired phones' },
    { name: 'Activity log', path: LOG, bytes: size(LOG) + size(LOG + '.1'), purpose: 'pairings, removals and sharing events, with times' },
    { name: 'Crash report', path: CRASH, bytes: size(CRASH), purpose: 'errors from this computer, kept here only' },
    { name: 'Secure page certificate', path: path.join(DATA, 'tls'), bytes: size(path.join(DATA, 'tls', 'ca.pem')), purpose: 'certificate authority for the secure page' },
    { name: 'Deleted files (trash)', path: TRASH, bytes: dirBytes(TRASH), purpose: 'files removed from phones, until you empty the trash' },
    { name: 'Clipboard history', path: 'memory only', bytes: 0, purpose: 'kept in memory and cleared when fisync closes' },
  ];
}
// Support file: no keys, tokens or addresses; names inside the log are hidden.
function diagnostics() {
  const redact = l => l.replace(/"[^"]*"/g, '"…"').replace(/\d+\.\d+\.\d+\.\d+/g, 'x.x.x.x');
  let lines = [];
  try { lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-200).map(redact); } catch { /* no log yet */ }
  return {
    app: 'fisync',
    version: require('./package.json').version,
    time: new Date().toISOString(),
    platform: os.platform(),
    release: os.release(),
    node: process.version,
    settings: exportSettings(),
    phones: loadDevices().length,
    locked,
    paused: isPaused(),
    notifApps: [...notifApps],
    log: lines,
  };
}

// ---------- pause, last seen, settings, clipboard origin
const seenAt = new Map();
const seenVia = new Map();
// Records where a phone connected from. A network it has not used before is reported to the desk.
function noteNetwork(deviceId, peer) {
  const via = remote.connectionPath(peer);
  seenVia.set(deviceId, via);
  if (via === 'relay') return { changed: false, path: via };   // a relay is not a network of its own
  const key = remote.networkKey(peer);
  const list = loadDevices();
  const d = list.find(x => x.id === deviceId);
  if (!d) return { changed: false, path: via };
  const changed = !!d.lastNet && d.lastNet !== key;
  if (d.lastNet !== key) { d.lastNet = key; saveDevices(list); }
  if (changed) {
    log(`"${d.name}" connected from a new network (${via})`);
    toDesks({ t: 'alert', msg: `${d.name} connected from a new network (${via}). If this was not you, remove it from the phone list.` });
  }
  return { changed, path: via };
}
let pausedUntil = 0;
const isPaused = () => Date.now() < pausedUntil;

// Stops phone access for a while (the Android service retries on its own when the pause ends).
function pauseFor(ms, why) {
  pausedUntil = Date.now() + Math.max(60000, Number(ms) || 3600000);
  for (const ws of live) if (ws.who && ws.who.role === 'phone') ws.close(4413, 'paused');
  log(`phone access paused: ${why || 'by you'}`);
  for (const d of desks) d.json({ t: 'paused', until: pausedUntil });
  events.emit('state');
}
function resumeLink() {
  if (!isPaused()) return;
  pausedUntil = 0;
  log('phone access resumed');
  for (const d of desks) d.json({ t: 'paused', until: 0 });
  events.emit('state');
}

// Settings that move to a new computer. Paired phones do not move: they must be paired again.
function exportSettings() {
  return { version: 1, photoHours };
}
function importSettings(obj) {
  const hours = Number(obj && obj.photoHours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 168) throw new Error('Those settings are not valid');
  setPhotoSchedule(hours);
  log('settings imported');
}

// ---------- lock, wake address, scheduled photo sync, texts from the computer, crash records
let locked = false;
const LOCKED_ROUTES = ['/ctl', '/view', '/files'];
let photoHours = 0;
let photoTimer = null;
const CRASH = path.join(DATA, 'crash.log');

function setLockedState(on) {
  for (const d of desks) d.json({ t: 'locked', on });
  events.emit('state');
}
// Stops remote control, the screen and file access until someone unlocks the computer. Calls and texts keep working.
function lockComputer(why) {
  if (locked) return;
  locked = true;
  setMirroring(false);
  for (const ws of live) if (ws.who && ws.who.role === 'phone' && LOCKED_ROUTES.includes(ws.route)) ws.close(4412, 'computer locked');
  log(`phones locked: ${why}`);
  setLockedState(true);
}
function unlockComputer() {
  if (!locked) return;
  locked = false;
  log('phones unlocked');
  setLockedState(false);
}
const isLocked = () => locked;

// The computer's network address for Wake-on-LAN, or null if none is found.
function computerMac() {
  const found = Object.values(os.networkInterfaces()).flat()
    .find(i => !i.internal && i.family === 'IPv4' && i.mac && i.mac !== '00:00:00:00:00:00');
  return found ? found.mac : null;
}
// The Wake-on-LAN "magic packet": six 0xFF bytes, then the address sixteen times.
function magicPacket(mac) {
  const hex = String(mac).replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error('A computer address needs 12 hex digits');
  const m = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => m)]);
}

function setPhotoSchedule(hours) {
  photoHours = Math.max(0, Number(hours) || 0);
  clearInterval(photoTimer);
  photoTimer = null;
  if (photoHours > 0) {
    photoTimer = setInterval(() => {
      if (bridge && bridge.ws.readyState === 1) {
        bridge.json({ t: 'syncphotos' });
        log('scheduled photo sync started');
      }
    }, photoHours * 3600 * 1000);
    photoTimer.unref();
  }
  for (const d of desks) d.json({ t: 'photoschedule', hours: photoHours });
  events.emit('state');
}

// A reply typed on the computer (for example from a notification) goes to the phone, which sends it as a text.
function sendTextFromComputer(to, body) {
  if (!bridge || bridge.ws.readyState !== 1 || !to || !body) return false;
  bridge.json({ t: 'sendsms', to: String(to), body: String(body).slice(0, 1000) });
  log('text sent from the computer');
  return true;
}

function recordCrash(err) {
  try { fs.appendFileSync(CRASH, `${new Date().toISOString()}\t${String((err && err.stack) || err)}\n\n`); } catch { /* nothing else to do */ }
}
function crashText() { try { return fs.readFileSync(CRASH, 'utf8'); } catch { return ''; } }
function clearCrash() { try { fs.unlinkSync(CRASH); } catch { /* none */ } }

// ---------- the encrypted channel
class Channel {
  constructor(ws, sendKey, recvKey) {
    this.ws = ws;
    this.sk = sendKey;
    this.rk = recvKey;
    this.sn = 0;
    this.rn = 0;
    this.onJson = () => {};
    this.onBlob = () => {};
  }
  raw(type, body) {
    if (this.ws.readyState !== 1) return;
    this.ws.lastSeen = Date.now();
    this.ws.send(seal(this.sk, this.sn++, Buffer.concat([Buffer.from([type]), body])));
  }
  json(o) { this.raw(1, Buffer.from(JSON.stringify(o), 'utf8')); }
  blob(b) { this.raw(2, b); }
  receive(data) {
    const pt = open(this.rk, this.rn++, data);   // throws if the frame was forged or out of order
    if (pt[0] === 1) this.onJson(JSON.parse(pt.subarray(1).toString('utf8')));
    else if (pt[0] === 2) this.onBlob(pt.subarray(1));
  }
}

// Handshake: hello -> hello-ack (proof) -> auth (proof). A locked phone waits for approval first.
function secureSession(ws, p, onReady) {
  let st = 'hello', key, T, shared, nC, nS;

  const answer = (m, who) => {
    const pubC = Buffer.from(String(m.eph), 'base64url');
    nC = Buffer.from(String(m.n), 'base64url');
    if (pubC.length !== 65 || nC.length !== 16) return ws.close(4403, 'bad hello');
    const e = crypto.createECDH('prime256v1');
    e.generateKeys();
    const pubS = e.getPublicKey(null, 'uncompressed');
    nS = crypto.randomBytes(16);
    T = Buffer.concat([Buffer.from('fisync/1'), Buffer.from(String(m.id), 'base64url'), pubC, nC, pubS, nS]);
    key = who.key;
    shared = e.computeSecret(pubC);
    ws.who = who;
    ws.route = p;
    st = 'auth';
    ws.send(JSON.stringify({
      t: 'hello-ack',
      eph: pubS.toString('base64url'),
      n: nS.toString('base64url'),
      mac: hmacB(key, Buffer.concat([Buffer.from('server'), T])).toString('base64url'),
    }));
  };

  ws.on('message', (data, isBinary) => {
    try {
      if (st === 'ready') {
        ws.lastSeen = Date.now();
        if (ws.who && ws.who.device) seenAt.set(ws.who.device.id, Date.now());
        if (isBinary) return ws.chan.receive(data);
        return ws.close(4403, 'unexpected message');
      }
      if (isBinary || st === 'pending') return ws.close(4403, 'unexpected message');
      const m = parse(data.toString());
      if (st === 'hello') {
        if (!m || m.t !== 'hello' || m.v !== 1) return ws.close(4403, 'bad hello');
        const who = findRole(String(m.id));
        if (!who) { log(`unknown device tried ${p}`); return ws.close(4401, 'not paired'); }
        if (p === '/desk' && who.role !== 'owner') { log('phone tried the desktop panel'); return ws.close(4403, 'not allowed'); }
        if (who.role === 'phone' && ROUTE_PERM[p] && !hasPerm(who.device, ROUTE_PERM[p])) {
          log(`"${who.device.name}" tried ${p} without permission`);
          return ws.close(4403, 'not allowed');
        }
        if (isPaused() && who.role === 'phone') {
          log(`"${who.device.name}" tried ${p} while phone access is paused`);
          return ws.close(4413, 'paused');
        }
        if (locked && who.role === 'phone' && LOCKED_ROUTES.includes(p)) {
          log(`"${who.device.name}" tried ${p} while phones are locked`);
          return ws.close(4412, 'computer locked');
        }
        if (who.role === 'phone' && who.device.locked) {
          st = 'pending';
          ws.send(JSON.stringify({ t: 'pending', text: 'Waiting for approval on your computer…' }));
          Promise.resolve().then(() => approve(`${who.device.name} (reconnecting after inactivity)`)).catch(() => false)
            .then(ok => {
              if (ws.readyState !== 1) return;
              if (!ok) { log(`reconnect of "${who.device.name}" was not approved`); return ws.close(4403, 'not approved'); }
              setLocked(who.device.id, false);
              who.device.locked = false;
              answer(m, who);
            });
          return;
        }
        return answer(m, who);
      }
      if (st === 'auth') {
        if (!m || m.t !== 'auth') return ws.close(4403, 'bad auth');
        if (!ctEq(hmacB(key, Buffer.concat([Buffer.from('client'), T])), Buffer.from(String(m.mac), 'base64url'))) {
          log('sign-in failed');
          return ws.close(4403, 'bad proof');
        }
        const okm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([nC, nS]), 'fisync/1 keys', 64));
        const chan = new Channel(ws, okm.subarray(32), okm.subarray(0, 32));
        ws.chan = chan;
        ws.lastSeen = Date.now();
        if (ws.who.role === 'phone') {
          seenAt.set(ws.who.device.id, Date.now());
          noteNetwork(ws.who.device.id, ws.relayed ? 'relay' : (ws._socket ? ws._socket.remoteAddress : ''));
          if (!ws.who.viaPrev) forgetOldKey(ws.who.device.id);
        }
        live.add(ws);
        ws.on('close', () => live.delete(ws));
        st = 'ready';
        onReady(chan, ws.who);
        chan.json({ t: 'ready' });   // the phone waits for this before it treats the connection as open
      }
    } catch {
      ws.close();
    }
  });
}

// ---------- clipboard (off by default; text only; both directions go through the same switch)
function setClipboardSync(on) {
  clipboardSync = !!on;
  log(clipboardSync ? 'clipboard sync turned on' : 'clipboard sync turned off');
  for (const d of desks) d.json({ t: 'clipboard', on: clipboardSync });
  events.emit('state');
}
const CLIP_HISTORY_MAX = 20;
let clipHistory = [];
const luhn = d => {
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};
// Returns a short description if the text looks like a card number or a password, otherwise null.
function looksSecret(text) {
  const t = String(text).trim();
  const digits = t.replace(/[ -]/g, '');
  if (/^\d{13,19}$/.test(digits) && luhn(digits)) return 'a card number';
  if (t.length >= 8 && t.length <= 64 && !/\s/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) && /[^A-Za-z0-9]/.test(t)) {
    return 'a password';
  }
  return null;
}
function clipAllowed(text, direction) {
  const kind = looksSecret(text);
  if (kind) { log(`clipboard text not synced (${direction}): it looks like ${kind}`); return false; }
  return true;
}
function recordClip(text, from) {
  clipHistory = [{ text, from, at: Date.now() }, ...clipHistory.filter(e => e.text !== text)].slice(0, CLIP_HISTORY_MAX);
  events.emit('state');
}
function clipboardHistory() { return clipHistory.slice(); }
function acceptClipFromPhone(text) {
  if (!clipAllowed(text, 'from phone')) return;
  recordClip(text, 'phone');
  events.emit('clip', text);
}
function pushClipboard(text) {
  if (!clipboardSync) return;
  const s = String(text).slice(0, MAX_CLIP);
  if (!clipAllowed(s, 'to phones')) return;
  recordClip(s, 'computer');
  for (const c of phoneChans) {
    if (c.ws.route === '/ctl' && hasLive(c.ws, 'clipboard')) c.json({ t: 'clip', text: s });
  }
}

// ---------- screen sharing (frames come from the desktop app)
function armScreenIdle(ms) {
  clearTimeout(screenTimer);
  screenTimer = setTimeout(() => {
    if (mirroring && viewers.size === 0) {
      log('screen sharing stopped: no phone is watching');
      events.emit('mirror', false);
    }
  }, ms);
}
function pushFrame(buf) {
  if (!mirroring) return;
  lastFrame = buf;
  for (const v of viewers) if (v.ws.readyState === 1 && v.ws.bufferedAmount < 2e6) v.blob(buf);
}
function setMirroring(on) {
  const was = mirroring;
  mirroring = !!on;
  if (!mirroring) lastFrame = null;
  if (mirroring) armScreenIdle(120000);
  else clearTimeout(screenTimer);
  log(mirroring ? 'screen sharing started' : 'screen sharing stopped');
  for (const v of viewers) v.json({ t: 'status', on: mirroring });
  for (const d of desks) d.json({ t: 'mirror', on: mirroring });
  if (mirroring && !was) alertPhones('Your computer started sharing its screen');
  events.emit('state');
}

// ---------- remote control
let pdx = 0, pdy = 0, moving = false;
let nut = null;
try {
  nut = require('@nut-tree-fork/nut-js');
  nut.mouse.config.autoDelayMs = 0;
  nut.keyboard.config.autoDelayMs = 0;
} catch { nut = null; }
const KEYS = new Set(['Enter', 'Backspace', 'Escape', 'Tab', 'Left', 'Right', 'Up', 'Down', 'Delete',
  'AudioMute', 'AudioVolDown', 'AudioVolUp', 'AudioPlay', 'AudioNext', 'AudioPrev']);

async function flushMove() {
  if (moving) return;
  moving = true;
  try {
    while (pdx || pdy) {
      const dx = pdx, dy = pdy;
      pdx = pdy = 0;
      const p = await nut.mouse.getPosition();
      await nut.mouse.setPosition(new nut.Point(Math.round(p.x + dx), Math.round(p.y + dy)));
    }
  } finally { moving = false; }
}

async function control(m) {
  if (!nut) return;
  const { mouse, keyboard, screen, Point, Key, Button } = nut;
  if (m.t === 'move') { pdx += +m.dx || 0; pdy += +m.dy || 0; flushMove().catch(() => {}); }
  else if (m.t === 'click') await mouse.click(m.b === 'right' ? Button.RIGHT : Button.LEFT);
  else if (m.t === 'scroll') {
    const n = Math.min(Math.abs(+m.dy) || 0, 20);
    if (n) await (m.dy > 0 ? mouse.scrollDown(n) : mouse.scrollUp(n));
  }
  else if (m.t === 'text') await keyboard.type(String(m.s).slice(0, 500));
  else if (m.t === 'key' && KEYS.has(m.k)) await keyboard.type(Key[m.k]);
  else if (m.t === 'tapAt') {
    const x = Math.min(Math.max(+m.x || 0, 0), 1), y = Math.min(Math.max(+m.y || 0, 0), 1);
    const w = await screen.width(), h = await screen.height();
    await mouse.setPosition(new Point(Math.round(x * (w - 1)), Math.round(y * (h - 1))));
    await mouse.click(Button.LEFT);
  }
}

// ---------- phone bridge and phone panel
function toDesks(o) { for (const d of desks) d.json(o); }

function savePhoto(m) {
  try {
    const base = path.basename(String(m.name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '') || 'photo.jpg';
    const { name: stem, ext } = path.parse(base);
    let dest = path.join(SHARE, base);
    for (let i = 1; fs.existsSync(dest); i++) dest = path.join(SHARE, `${stem} (${i})${ext}`);
    fs.writeFileSync(dest, Buffer.from(String(m.data), 'base64'));
    if (backupDir) { try { fs.copyFileSync(dest, path.join(backupDir, path.basename(dest))); } catch { /* backup folder unavailable */ } }
    toDesks({ t: 'photo' });
  } catch { /* skip a photo that cannot be saved */ }
}

function deskMessage(chan, m) {
  if (m.t === 'mirror') {
    if (events.listenerCount('mirror') === 0) return chan.json({ t: 'error', msg: 'Screen sharing needs the fisync desktop app.' });
    return events.emit('mirror', !!m.on);
  }
  if (m.t === 'clipboard') return setClipboardSync(!!m.on);
  if (m.t === 'lock') return m.on ? lockComputer('locked from the phone panel') : unlockComputer();
  if (m.t === 'pause') return m.on ? pauseFor((Number(m.minutes) || 60) * 60000, 'from the phone panel') : resumeLink();
  if (m.t === 'photoschedule') return setPhotoSchedule(m.hours);
  if (m.t === 'storage') return chan.json({ t: 'storage', items: storageReport() });
  if (m.t === 'diagnostics') return chan.json({ t: 'diagnostics', data: diagnostics() });
  if (m.t === 'clearlog') { clearLog(); return chan.json({ t: 'storage', items: storageReport() }); }
  if (m.t === 'clearcrash') { clearCrash(); return chan.json({ t: 'storage', items: storageReport() }); }
  if (m.t === 'emptytrash') { emptyTrash(); return chan.json({ t: 'storage', items: storageReport() }); }
  if (m.t === 'notifapps') return setNotifApps(m.apps);
  if (m.t === 'pair-qr') return QRCode.toDataURL(pairLink()).then(data => chan.json({ t: 'pair-qr', data }));
  if (m.t === 'relay-set') {
    const url = String(m.url || '').trim();
    if (url && !/^wss?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(url)) return chan.json({ t: 'error', msg: 'Use an address like wss://relay.example.com' });
    fs.writeFileSync(RELAY_FILE, JSON.stringify({ url: url || null }));
    startRelay();
    log(url ? 'relay address set' : 'relay turned off');
    return chan.json({ t: 'remote', remote: getState().remote });
  }
  if (m.t === 'setup-check') return chan.json({ t: 'setup-check', items: setupCheck() });
  if (m.t === 'remote-refresh') return refreshRemote().then(() => chan.json({ t: 'remote', remote: getState().remote }));
  if (m.t === 'ble-on' || m.t === 'ble-off') {
    const r = setBluetoothBeacon(m.t === 'ble-on');
    return r.ok ? chan.json({ t: 'remote', remote: getState().remote }) : chan.json({ t: 'error', msg: r.reason });
  }
  if (m.t === 'migrate-export') {
    try { return chan.json({ t: 'migrate-bundle', data: createMigrationFile(m.passphrase).toString('base64') }); }
    catch (e) { return chan.json({ t: 'error', msg: e.message }); }
  }
  if (m.t === 'migrate-import') {
    try { return chan.json({ t: 'migrated', ...importMigrationFile(Buffer.from(String(m.data), 'base64'), m.passphrase) }); }
    catch (e) { return chan.json({ t: 'error', msg: e.message }); }
  }
  if (!DESK_COMMANDS.has(m.t)) return;
  if (bridge && bridge.ws.readyState === 1) bridge.json(m);
  else chan.json({ t: 'phone', on: false });
}

// ---------- files, carried over the encrypted channel
const safeName = n => path.basename(String(n)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '') || 'file';
function uniquePath(name) {
  const { name: stem, ext } = path.parse(name);
  let p = path.join(SHARE, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(SHARE, `${stem} (${i})${ext}`);
  return p;
}
function listFiles() {
  return fs.readdirSync(SHARE, { withFileTypes: true })
    .filter(d => d.isFile() && !d.name.endsWith('.part'))
    .map(d => { const s = fs.statSync(path.join(SHARE, d.name)); return { name: d.name, size: s.size, mtime: s.mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime);
}

function serveFiles(chan, ws) {
  const up = { stream: null, tmp: null, dest: null, size: 0, got: 0, start: 0, t0: 0 };
  // A dropped connection keeps the partial file, so the next attempt can resume where it stopped.
  ws.on('close', () => { if (up.stream) { up.stream.destroy(); up.stream = null; } });
  const discard = () => {
    if (up.stream) { up.stream.destroy(); up.stream = null; }
    if (up.tmp) fs.unlink(up.tmp, () => {});
  };

  chan.onBlob = b => {
    if (!up.stream) return;
    up.got += b.length;
    if (up.got > up.size) {
      discard();
      return chan.json({ t: 'error', msg: 'Upload was longer than its declared size' });
    }
    up.stream.write(b);
    if (MAX_BPS && ws._socket) {
      const wait = up.t0 + ((up.got - up.start) / MAX_BPS) * 1000 - Date.now();
      if (wait > 0) {
        ws._socket.pause();
        setTimeout(() => { if (ws._socket) ws._socket.resume(); }, wait);
      }
    }
  };

  async function handle(m) {
    if (m.t === 'list') return chan.json({ t: 'list', items: listFiles() });

    if (m.t === 'delete') {
      const name = safeName(m.name);
      const file = path.join(SHARE, name);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return chan.json({ t: 'error', msg: 'No such file' });
      moveToTrash(file, name);
      log(`file moved to the trash by a phone: ${name}`);
      return chan.json({ t: 'deleted', name });
    }

    if (m.t === 'rename') {
      const from = path.join(SHARE, safeName(m.name));
      const to = safeName(m.to);
      const ext = path.extname(to).slice(1).toLowerCase();
      if (BLOCKED_EXT.has(ext)) return chan.json({ t: 'error', msg: `Files ending in .${ext} are blocked for safety` });
      if (!fs.existsSync(from) || !fs.statSync(from).isFile()) return chan.json({ t: 'error', msg: 'No such file' });
      if (fs.existsSync(path.join(SHARE, to))) return chan.json({ t: 'error', msg: 'A file with that name already exists' });
      fs.renameSync(from, path.join(SHARE, to));
      log(`file renamed from a phone: ${safeName(m.name)} to ${to}`);
      return chan.json({ t: 'renamed', name: safeName(m.name), to });
    }

    if (m.t === 'get') {
      const file = path.join(SHARE, safeName(m.name));
      let st = null;
      try { st = fs.statSync(file); } catch { st = null; }
      if (!st || !st.isFile()) return chan.json({ t: 'error', msg: 'No such file' });
      const offset = Math.min(Math.max(0, Number(m.offset) || 0), st.size);
      chan.json({ t: 'get-start', name: path.basename(file), size: st.size, offset });
      const t0 = Date.now();
      let sent = 0;
      for await (const part of fs.createReadStream(file, { start: offset, highWaterMark: CHUNK })) {
        while (ws.readyState === 1 && ws.bufferedAmount > 4e6) await sleep(20);
        if (ws.readyState !== 1) return;
        chan.blob(part);
        sent += part.length;
        if (MAX_BPS) {
          const wait = t0 + (sent / MAX_BPS) * 1000 - Date.now();
          if (wait > 0) await sleep(wait);
        }
      }
      return chan.json({ t: 'get-end' });
    }

    if (m.t === 'put') {
      if (up.stream) return chan.json({ t: 'error', msg: 'Another upload is already in progress' });
      const name = safeName(m.name);
      const ext = path.extname(name).slice(1).toLowerCase();
      if (BLOCKED_EXT.has(ext)) return chan.json({ t: 'error', msg: `Files ending in .${ext} are blocked for safety` });
      const size = Number(m.size);
      if (!Number.isFinite(size) || size < 0 || size > MAX_UPLOAD) return chan.json({ t: 'error', msg: 'File is larger than 2 GB' });
      if (!hasRoom(size)) return chan.json({ t: 'error', msg: 'Not enough free space on the computer' });
      if (m.conflict === 'skip' && fs.existsSync(path.join(SHARE, name))) return chan.json({ t: 'error', msg: 'A file with that name already exists' });
      up.sha256 = m.sha256 ? String(m.sha256) : null;   // checked once the file is complete
      up.dest = m.conflict === 'replace' ? path.join(SHARE, name) : uniquePath(name);
      up.tmp = path.join(SHARE, '.upload-' + name + '.part');
      up.size = size;
      if (fs.existsSync(up.tmp) && fs.statSync(up.tmp).size > size) fs.unlinkSync(up.tmp);
      up.start = fs.existsSync(up.tmp) ? fs.statSync(up.tmp).size : 0;
      up.got = up.start;
      up.t0 = Date.now();
      up.stream = fs.createWriteStream(up.tmp, { flags: up.start ? 'a' : 'w' });
      up.stream.on('error', () => discard());
      return chan.json({ t: 'put-ready', offset: up.start });
    }

    if (m.t === 'put-end') {
      const s = up.stream;
      if (!s) return;
      up.stream = null;
      if (up.got !== up.size) {
        s.destroy();
        return chan.json({ t: 'error', msg: 'Upload was interrupted. Send it again and it will resume.' });
      }
      await new Promise(res => s.end(res));
      if (up.sha256 && (await sha256OfFile(up.tmp)) !== up.sha256) {
        fs.unlink(up.tmp, () => {});
        return chan.json({ t: 'error', msg: 'The file arrived damaged. Please send it again.' });
      }
      fs.renameSync(up.tmp, up.dest);
      return chan.json({ t: 'saved', name: path.basename(up.dest) });
    }
  }

  chan.onJson = m => { handle(m).catch(err => chan.json({ t: 'error', msg: err.message })); };
}

// ---------- routing after the handshake
function serve(p, chan, ws, who) {
  if (who.role === 'phone') phoneChans.add(chan);
  ws.on('close', () => {
    phoneChans.delete(chan);
    viewers.delete(chan);
    desks.delete(chan);
    if (bridge === chan) { bridge = null; toDesks({ t: 'phone', on: false }); }
    if (p === '/view' && mirroring && viewers.size === 0) armScreenIdle(30000);
  });

  if (p === '/ctl') {
    chan.onJson = m => {
      if (m.t === 'unpair') { if (who.role === 'phone') removeId(who.device.id, 'a phone removed itself'); return; }
      if (m.t === 'clip') {
        if (clipboardSync && (who.role === 'owner' || hasLive(ws, 'clipboard'))) {
          acceptClipFromPhone(String(m.text || '').slice(0, MAX_CLIP));
        }
        return;
      }
      control(m).catch(() => {});
    };
  }
  if (p === '/view') {
    viewers.add(chan);
    clearTimeout(screenTimer);
    chan.json({ t: 'status', on: mirroring });
    if (mirroring && lastFrame) chan.blob(lastFrame);
  }
  if (p === '/desk') {
    desks.add(chan);
    chan.json({ t: 'phone', on: !!bridge });
    chan.json({ t: 'mirror', on: mirroring });
    chan.json({ t: 'clipboard', on: clipboardSync });
    chan.json({ t: 'locked', on: locked });
    chan.json({ t: 'photoschedule', hours: photoHours });
    chan.json({ t: 'paused', until: pausedUntil });
    chan.onJson = m => deskMessage(chan, m);
  }
  if (p === '/bridge') {
    if (who.role !== 'phone') return ws.close(4403, 'not allowed');
    if (bridge && bridge !== chan) bridge.ws.close();
    bridge = chan;
    log('Android app connected');
    toDesks({ t: 'phone', on: true });
    chan.onJson = m => {
      if (m.t === 'notif' && !notifAllowed(m.app)) return;   // blocked apps raise no alert and are not forwarded
      if (m.t === 'smsin' || (m.t === 'call' && m.state === 'RINGING') || m.t === 'notif') events.emit('incoming', m);
      if (m.t === 'lock' && m.on) { lockComputer('locked from the phone'); return; }
      if (m.t === 'rekey-ack') { commitRotation(chan); return; }
      if (m.t === 'phonestatus') events.emit('phonestatus', m);
      if (m.t === 'photo') return savePhoto(m);
      if (m.t === 'unpair') return removeId(who.device.id, 'the Android app removed itself');
      toDesks(m);
    };
  }
  if (p === '/files') serveFiles(chan, ws);
}

// ---------- HTTP: only the static pages. All data goes through the channel above.
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
};
function handleHttp(req, res) {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    const send = (file, type) => {
      res.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS });
      res.end(fs.readFileSync(file));
    };
    const pub = name => path.join(__dirname, 'public', name);
    if (p === '/') return send(pub('index.html'), 'text/html; charset=utf-8');
    if (p === '/desk') return send(pub('desk.html'), 'text/html; charset=utf-8');
    if (p === '/ui.css') return send(pub('ui.css'), 'text/css; charset=utf-8');
    if (p === '/ca.pem') {
      res.writeHead(200, { 'Content-Type': 'application/x-pem-file', ...SECURITY_HEADERS });
      return res.end(tlsCaPem());
    }
    if (p.startsWith('/vendor/')) return send(pub('vendor/' + path.basename(p)), 'application/javascript; charset=utf-8');
    if (p.startsWith('/i18n/') && p.endsWith('.json')) return send(pub('i18n/' + path.basename(p)), 'application/json; charset=utf-8');
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

const server = http.createServer(handleHttp);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (!['/pair', '/ctl', '/bridge', '/view', '/desk', '/files'].includes(p)) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => {
    if (p === '/pair') return pairSocket(ws, req.socket.remoteAddress);
    secureSession(ws, p, (chan, who) => serve(p, chan, ws, who));
  });
});

// ---------- network: tell the user when the address changes (a new network)
let netKey = lanIps().join(',');
function checkNetwork(current = lanIps()) {
  const key = current.join(',');
  if (key === netKey) return false;
  netKey = key;
  log(`network changed: ${key || 'offline'}`);
  refreshTls(current);
  events.emit('network', current);
  return true;
}
const netTimer = setInterval(() => checkNetwork(), 30000);
netTimer.unref();

// ---------- secure page (https) for browsers. The Android app keeps using the plain port on your Wi-Fi.
const TLS_PORT = process.env.FISYNC_TLS_PORT === undefined ? 8443 : Number(process.env.FISYNC_TLS_PORT);
let httpsServer = null;
let tlsInfo = null;
const tlsCaPem = () => (tlsInfo ? tlsInfo.caPem : '');

function refreshTls(ips) {
  if (!httpsServer) return;
  try {
    tlsInfo = require('./tls').loadOrCreate(path.join(DATA, 'tls'), ips);
    if (typeof httpsServer.setSecureContext === 'function') httpsServer.setSecureContext({ key: tlsInfo.key, cert: tlsInfo.cert });
    log('secure page certificate updated for the current network');
  } catch (e) {
    log(`could not update the secure page certificate: ${e.message}`);
  }
}

function startTls() {
  if (!TLS_PORT) return Promise.resolve(false);
  try {
    tlsInfo = require('./tls').loadOrCreate(path.join(DATA, 'tls'), lanIps());
    httpsServer = https.createServer({ key: tlsInfo.key, cert: tlsInfo.cert }, handleHttp);
    httpsServer.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head));
  } catch (e) {
    log(`secure page not available: ${e.message}`);
    httpsServer = null;
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    httpsServer.once('error', e => { log(`secure page not available: ${e.message}`); resolve(false); });
    httpsServer.listen(TLS_PORT, '0.0.0.0', () => { log('secure page is ready'); resolve(true); });
  });
}

// ---------- public API for the desktop app and the terminal runner
// Lets phones find this computer on the local network, even after its address changes.
// The advert carries only the public id, never a key.
function advertise(port) {
  try {
    const { Bonjour } = require('bonjour-service');
    const bonjour = new Bonjour();
    bonjour.publish({ name: `fisync on ${os.hostname()}`, type: 'fisync', port, txt: { cid: COMPUTER_ID } });
  } catch (e) {
    log(`network discovery not available: ${e.message}`);
  }
}

function getState() {
  return {
    port: PORT, pin: PIN, owner: OWNER, share: SHARE, addresses: lanIps(), log: LOG, computerId: COMPUTER_ID,
    encrypted: !!STORE_KEY,
    mac: computerMac(), locked, photoHours,
    caFingerprint: tlsInfo ? tlsInfo.fingerprint : null,
    settings: exportSettings(),
    securePort: httpsServer && httpsServer.listening ? TLS_PORT : 0,
    clipboardSync,
    devices: loadDevices().map(d => ({ name: d.name, added: d.added, perms: d.perms || PERMS, locked: !!d.locked, lastSeen: seenAt.get(d.id) || null, via: seenVia.get(d.id) || null })),
    pausedUntil,
    notifApps: [...notifApps],
    backupDir,
    remote: { tailscale: tsInfo, bluetooth: !!bleProc, relay: relayUrl() },
  };
}
function start(opts = {}) {
  if (opts.approve) approve = opts.approve;
  return new Promise((resolve, reject) => {
    if (opts.storageKey) setStorageKey(opts.storageKey);
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', async () => {
      log('fisync started'); advertise(PORT); await startTls();
      writeBeaconFile();
      refreshRemote().catch(() => {});
      startRelay();
      setInterval(writeBeaconFile, 60_000).unref();   // the address can change when the network changes
      resolve(getState());
    });
  });
}
module.exports = {
  start, getState, pushFrame, setMirroring, forgetDevices, removeDevice, setPerms, setStorageKey,
  setClipboardSync, pushClipboard, checkNetwork, events, LOG, PERMS,
  rotateOwnerKey, verifyLog, clipboardHistory, looksSecret, acceptClipFromPhone,
  lockComputer, unlockComputer, isLocked, computerMac, magicPacket, setPhotoSchedule,
  pauseFor, resumeLink, isPaused, exportSettings, importSettings,
  hasRoom, setNotifApps, setBackupFolder, diagnostics, storageReport, emptyTrash, clearLog, verifyLog,
  createMigrationFile, importMigrationFile, refreshRemote, setBluetoothBeacon, pairLink, noteNetwork, rotatePhoneKey, setupCheck, relayUrl, startRelay,
  sendTextFromComputer, recordCrash, crashText, clearCrash, tlsCaPem,
  isMirroring: () => mirroring,
  isClipboardSync: () => clipboardSync,
};

// Terminal mode: node server.js   (node server.js --forget removes every paired phone)
if (require.main === module) {
  if (process.argv.includes('--forget')) {
    forgetDevices();
    console.log('All paired phones were removed.');
    process.exit(0);
  }
  start().then(async s => {
    console.log(`\nfisync is running.\nShared folder: ${s.share}`);
    console.log(`Pairing PIN: ${s.pin}`);
    s.addresses.forEach(ip => console.log(`  http://${ip}:${s.port}`));
    events.on('pin', () => console.log(`Pairing PIN changed. New PIN: ${getState().pin}`));
    console.log(await QRCode.toString(`http://${s.addresses[0] || 'localhost'}:${s.port}/#pin=${s.pin}`, { type: 'terminal', small: true }));
    console.log(`Phone panel (this computer only): http://localhost:${s.port}/desk#key=${s.owner}\n`);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
