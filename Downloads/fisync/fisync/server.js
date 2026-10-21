// fisync server. `node server.js` runs it in a terminal; the desktop app (main.js) starts it too.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 8484;
const SHARE = process.env.SHARE_DIR || path.join(os.homedir(), 'fisync');
const DATA = process.env.FISYNC_DATA || path.join(os.homedir(), '.fisync');
const DEVICES = path.join(DATA, 'devices.json');
fs.mkdirSync(SHARE, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

// Events: 'pin' (pairing PIN changed), 'state' (paired phones or screen sharing changed),
// 'mirror' (a phone or the phone panel asked to start or stop screen sharing).
const events = new EventEmitter();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const newPin = () => String(crypto.randomInt(100000, 1000000));
const parse = d => { try { return JSON.parse(d); } catch { return null; } };
const lanIps = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);

const OWNER = crypto.randomBytes(24).toString('base64url'); // only this computer knows it; opens the phone panel
let PIN = newPin();             // changes after every pairing
let approve = askInTerminal;    // the desktop app replaces this with a dialog
let pairing = false;
let mirroring = false;
let bridge = null;              // the Android app's connection, while it is open
let lastFrame = null;
const fails = new Map();        // wrong-PIN counts per address
const live = new Map();         // every open socket -> { role }
const viewers = new Set();      // phones watching the screen
const desks = new Set();        // the phone panel on this computer
const DESK_COMMANDS = new Set(['dial', 'answer', 'hangup', 'calls', 'sms', 'sendsms', 'syncphotos']);

// Remote control needs a native input library; file sharing works without it.
let nut = null;
try {
  nut = require('@nut-tree-fork/nut-js');
  nut.mouse.config.autoDelayMs = 0;
  nut.keyboard.config.autoDelayMs = 0;
} catch { nut = null; }
const KEYS = new Set(['Enter', 'Backspace', 'Escape', 'Tab', 'Left', 'Right', 'Up', 'Down', 'Delete',
  'AudioMute', 'AudioVolDown', 'AudioVolUp', 'AudioPlay', 'AudioNext', 'AudioPrev']);
let pdx = 0, pdy = 0, moving = false;

// ---------- who is allowed in: the laptop owner, or a phone that was approved and paired
const loadDevices = () => { try { return JSON.parse(fs.readFileSync(DEVICES, 'utf8')); } catch { return []; } };
const saveDevices = list => fs.writeFileSync(DEVICES, JSON.stringify(list, null, 2), { mode: 0o600 });
function roleOf(token) {
  if (!token) return null;
  if (same(token, OWNER)) return 'owner';
  const h = sha(token);
  return loadDevices().some(d => d.hash === h) ? 'phone' : null;
}
function rotatePin() { PIN = newPin(); events.emit('pin'); }
function forgetDevices() {
  saveDevices([]);
  for (const [ws, info] of live) if (info.role === 'phone') ws.close();
  rotatePin();
  events.emit('state');
}

// ---------- pairing: right PIN AND a click on Allow on this computer
function askInTerminal(name) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(
    `\nAllow "${name}" to control this computer and use the fisync folder? [y/N] `,
    answer => { rl.close(); resolve(/^y/i.test(answer.trim())); }));
}

async function pairRequest(ip, pin, name) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (Date.now() < f.until) return { error: 'Too many wrong PINs. Wait a minute and try again.' };
  if (!same(pin, PIN)) {
    if (++f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; }
    fails.set(ip, f);
    return { error: 'Wrong PIN.' };
  }
  fails.delete(ip);
  if (pairing) return { error: 'Another phone is waiting for approval.' };
  pairing = true;
  try {
    const label = String(name || '').replace(/[^\w .()-]/g, '').trim().slice(0, 40) || 'Phone';
    const ok = await Promise.race([
      Promise.resolve().then(() => approve(label)).catch(() => false),
      new Promise(resolve => setTimeout(() => resolve(false), 60000)),
    ]);
    if (!ok) return { error: 'Not approved on your computer.' };
    const token = crypto.randomBytes(32).toString('base64url'); // shown to the phone once; only its hash is stored
    saveDevices([...loadDevices(), { name: label, hash: sha(token), added: Date.now() }]);
    rotatePin();
    events.emit('state');
    return { token, name: label };
  } finally {
    pairing = false;
  }
}

function pairSocket(ws, ip) {
  ws.on('message', async d => {
    const m = parse(d);
    if (!m || m.t !== 'pair') return;
    const r = await pairRequest(ip, m.pin, m.name);
    ws.send(JSON.stringify(r.token ? { t: 'paired', token: r.token, name: r.name } : { t: 'error', msg: r.error }));
    if (r.token) ws.close();
  });
}

// ---------- screen sharing (frames come from the desktop app)
function pushFrame(buf) {
  if (!mirroring) return;
  lastFrame = buf;
  for (const v of viewers) if (v.readyState === 1 && v.bufferedAmount < 2e6) v.send(buf);
}
function setMirroring(on) {
  mirroring = !!on;
  if (!mirroring) lastFrame = null;
  const status = JSON.stringify({ t: 'status', on: mirroring });
  for (const v of viewers) if (v.readyState === 1) v.send(status);
  const deskMsg = JSON.stringify({ t: 'mirror', on: mirroring });
  for (const d of desks) if (d.readyState === 1) d.send(deskMsg);
  events.emit('state');
}

// ---------- remote control
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
  else if (m.t === 'tapAt') {   // a tap on the mirrored picture, as a fraction of the screen
    const x = Math.min(Math.max(+m.x || 0, 0), 1), y = Math.min(Math.max(+m.y || 0, 0), 1);
    const w = await screen.width(), h = await screen.height();
    await mouse.setPosition(new Point(Math.round(x * (w - 1)), Math.round(y * (h - 1))));
    await mouse.click(Button.LEFT);
  }
}

// ---------- phone bridge (calls, messages, photos from the Android app)
function toDesks(o) {
  const s = JSON.stringify(o);
  for (const d of desks) if (d.readyState === 1) d.send(s);
}
function savePhoto(m) {
  try {
    const base = path.basename(String(m.name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'photo.jpg';
    const { name: stem, ext } = path.parse(base);
    let dest = path.join(SHARE, base);
    for (let i = 1; fs.existsSync(dest); i++) dest = path.join(SHARE, `${stem} (${i})${ext}`);
    fs.writeFileSync(dest, Buffer.from(String(m.data), 'base64'));
    toDesks({ t: 'photo' });
  } catch { /* skip a photo that cannot be saved */ }
}
function deskMessage(ws, d) {
  const m = parse(d);
  if (!m) return;
  if (m.t === 'mirror') {
    if (events.listenerCount('mirror') === 0) return ws.send(JSON.stringify({ t: 'error', msg: 'Screen sharing needs the fisync desktop app.' }));
    return events.emit('mirror', !!m.on);
  }
  if (!DESK_COMMANDS.has(m.t)) return;
  if (bridge && bridge.readyState === 1) bridge.send(JSON.stringify(m));
  else ws.send(JSON.stringify({ t: 'phone', on: false }));
}

// ---------- sockets
function route(ws, p, role) {
  live.set(ws, { role });
  ws.on('close', () => {
    live.delete(ws); viewers.delete(ws); desks.delete(ws);
    if (bridge === ws) { bridge = null; toDesks({ t: 'phone', on: false }); }
  });
  if (p === '/ctl') ws.on('message', d => { const m = parse(d); if (m) control(m).catch(() => {}); });
  if (p === '/view') {
    viewers.add(ws);
    ws.send(JSON.stringify({ t: 'status', on: mirroring }));
    if (mirroring && lastFrame) ws.send(lastFrame);
  }
  if (p === '/bridge') {
    if (bridge && bridge !== ws) bridge.close();
    bridge = ws;
    toDesks({ t: 'phone', on: true });
    ws.on('message', d => {
      const m = parse(d);
      if (!m) return;
      if (m.t === 'photo') return savePhoto(m);
      toDesks(m);
    });
  }
  if (p === '/desk') {
    desks.add(ws);
    ws.send(JSON.stringify({ t: 'phone', on: !!bridge }));
    ws.send(JSON.stringify({ t: 'mirror', on: mirroring }));
    ws.on('message', d => deskMessage(ws, d));
  }
}

// ---------- files and pages over HTTP
const safeName = n => path.basename(String(n)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
function uniquePath(name) {
  const { name: stem, ext } = path.parse(name);
  let p = path.join(SHARE, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(SHARE, `${stem} (${i})${ext}`);
  return p;
}
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

function handleHttp(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const page = (file, type) => {
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
    };
    if (p === '/') return page('index.html', 'text/html; charset=utf-8');
    if (p === '/desk') return page('desk.html', 'text/html; charset=utf-8');
    if (p === '/ui.css') return page('ui.css', 'text/css; charset=utf-8');
    if (!p.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (!roleOf(req.headers['x-token'] || url.searchParams.get('token') || '')) return json(res, 401, { error: 'Not paired' });
    if (p === '/api/me') return json(res, 200, { ok: true });

    if (p === '/api/files' && req.method === 'GET') {
      const files = fs.readdirSync(SHARE, { withFileTypes: true })
        .filter(d => d.isFile() && !d.name.endsWith('.part'))
        .map(d => { const s = fs.statSync(path.join(SHARE, d.name)); return { name: d.name, size: s.size, mtime: s.mtimeMs }; })
        .sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, files);
    }
    const m = p.match(/^\/api\/files\/(.+)$/);
    if (m && req.method === 'GET') {
      const file = path.join(SHARE, safeName(decodeURIComponent(m[1])));
      return fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return json(res, 404, { error: 'No such file' });
        res.writeHead(200, {
          'Content-Length': st.size,
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
        });
        fs.createReadStream(file).pipe(res);
      });
    }
    if (m && req.method === 'PUT') {
      const dest = uniquePath(safeName(decodeURIComponent(m[1])));
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      req.pipe(out);
      out.on('finish', () => { fs.renameSync(tmp, dest); json(res, 200, { name: path.basename(dest) }); });
      out.on('error', () => json(res, 500, { error: 'Could not save file' }));
      req.on('aborted', () => { out.destroy(); fs.unlink(tmp, () => {}); });
      return;
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

// ---------- WebSocket routing: only /pair is open; everything else needs a valid token
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
const server = http.createServer(handleHttp);

function refuse(socket, code) {
  const text = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' }[code];
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (!['/pair', '/ctl', '/bridge', '/view', '/desk'].includes(p)) return refuse(socket, 404);
  if (p === '/pair') return wss.handleUpgrade(req, socket, head, ws => pairSocket(ws, req.socket.remoteAddress));
  const role = roleOf(url.searchParams.get('token') || '');
  if (!role) return refuse(socket, 401);
  if (p === '/desk' && role !== 'owner') return refuse(socket, 403);
  wss.handleUpgrade(req, socket, head, ws => route(ws, p, role));
});

// ---------- public API for the desktop app and the terminal runner
function getState() {
  return {
    port: PORT, pin: PIN, owner: OWNER, share: SHARE, addresses: lanIps(),
    devices: loadDevices().map(({ name, added }) => ({ name, added })),
  };
}
function start(opts = {}) {
  if (opts.approve) approve = opts.approve;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => resolve(getState()));
  });
}
module.exports = {
  start, getState, pushFrame, setMirroring, forgetDevices, events,
  isMirroring: () => mirroring,
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
