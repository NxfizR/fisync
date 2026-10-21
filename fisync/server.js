// fisync agent. Run it on your Windows or Linux computer, then open the
// printed address (or scan the QR code) from your phone on the same Wi-Fi.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 8484;
const SHARE = process.env.SHARE_DIR || path.join(os.homedir(), 'fisync');
const PIN = String(crypto.randomInt(100000, 1000000));
const KEYS = new Set(['Enter', 'Backspace', 'Escape', 'Tab', 'Left', 'Right', 'Up', 'Down',
  'Delete', 'AudioMute', 'AudioVolDown', 'AudioVolUp', 'AudioPlay', 'AudioNext', 'AudioPrev']);
fs.mkdirSync(SHARE, { recursive: true });

// Mouse/keyboard control needs a native library; file transfer works without it.
let nut = null;
try {
  nut = require('@nut-tree-fork/nut-js');
  nut.mouse.config.autoDelayMs = 0;
  nut.keyboard.config.autoDelayMs = 0;
} catch (e) {
  console.log('Mouse and keyboard control is unavailable here; file transfer still works.');
}

// ---- auth: every API call and the socket need the PIN; 5 misses = 1 minute lockout
const fails = new Map();
function authed(req, url) {
  const ip = req.socket.remoteAddress;
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (Date.now() < f.until) return false;
  const given = String(url.searchParams.get('pin') || req.headers['x-pin'] || '');
  const ok = given.length === PIN.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(PIN));
  if (ok) { fails.delete(ip); return true; }
  if (++f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; }
  fails.set(ip, f);
  return false;
}

// ---- files
const safeName = n => path.basename(n).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'file';
function uniquePath(name) {
  const { name: base, ext } = path.parse(name);
  let p = path.join(SHARE, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(SHARE, `${base} (${i})${ext}`);
  return p;
}
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const esc = s => String(s).replace(/[&<>"]/g, c => '&#' + c.charCodeAt(0) + ';');
const lanIps = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
const pairUrl = () => `http://${lanIps()[0] || 'localhost'}:${PORT}/#pin=${PIN}`;

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (url.pathname === '/desk') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'desk.html')));
    }
    if (url.pathname === '/pair') {   // pairing screen: only reachable from the computer itself
      const from = req.socket.remoteAddress;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(from)) {
        return json(res, 403, { error: 'Open this page on the computer that runs fisync' });
      }
      return QRCode.toString(pairUrl(), { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } })
        .then(svg => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>fisync</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:0 auto;padding:20px;text-align:center}svg{width:240px;height:240px;border-radius:12px}code{font-size:30px;letter-spacing:4px}</style>
<h1>fisync</h1><p>On your phone, scan this code, or open an address below and enter the PIN.</p>${svg}
<p>PIN<br><code>${PIN}</code></p><p>${lanIps().map(ip => `http://${ip}:${PORT}`).join('<br>')}</p>
<p><a href="/desk#pin=${PIN}" target="_blank">Phone calls, messages and photos</a></p>
<p>Shared folder<br>${esc(SHARE)}</p>`);
        })
        .catch(e => json(res, 500, { error: e.message }));
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (!authed(req, url)) return json(res, 401, { error: 'Wrong PIN' });

    if (url.pathname === '/api/info') {
      return json(res, 200, { host: os.hostname(), platform: process.platform, control: !!nut });
    }
    if (url.pathname === '/api/files' && req.method === 'GET') {
      const files = fs.readdirSync(SHARE, { withFileTypes: true })
        .filter(d => d.isFile() && !d.name.endsWith('.part'))
        .map(d => {
          const s = fs.statSync(path.join(SHARE, d.name));
          return { name: d.name, size: s.size, mtime: s.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, files);
    }

    const m = url.pathname.match(/^\/api\/files\/(.+)$/);
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
});

// ---- remote control over WebSocket
let pdx = 0, pdy = 0, moving = false;
async function flushMove() {
  if (moving) return;
  moving = true;
  try {
    while (pdx || pdy) {
      const x = pdx, y = pdy;
      pdx = pdy = 0;
      const p = await nut.mouse.getPosition();
      await nut.mouse.setPosition(new nut.Point(Math.round(p.x + x), Math.round(p.y + y)));
    }
  } finally { moving = false; }
}

async function handle(m) {
  const { mouse, keyboard, Key, Button } = nut;
  if (m.t === 'move') { pdx += +m.dx || 0; pdy += +m.dy || 0; flushMove().catch(() => {}); }
  else if (m.t === 'click') await mouse.click(m.b === 'right' ? Button.RIGHT : Button.LEFT);
  else if (m.t === 'scroll') {
    const n = Math.min(Math.abs(+m.dy) || 0, 20);
    if (n) await (m.dy > 0 ? mouse.scrollDown(n) : mouse.scrollUp(n));
  }
  else if (m.t === 'text') await keyboard.type(String(m.s).slice(0, 500));
  else if (m.t === 'key' && KEYS.has(m.k)) await keyboard.type(Key[m.k]);
}

// ---- phone bridge: the Android app connects to /phone, computer pages to /desk
const bridge = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
const DESK_COMMANDS = new Set(['dial', 'answer', 'hangup', 'calls', 'sms', 'sendsms', 'syncphotos']);
const desks = new Set();
let phone = null;
const toDesks = o => desks.forEach(d => d.readyState === 1 && d.send(JSON.stringify(o)));

function phoneConnected(ws) {
  phone = ws;
  toDesks({ t: 'phone', on: true });
  ws.on('message', d => {
    let m;
    try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'photo') {   // photos are saved to the shared folder; calls and messages are only relayed
      try { fs.writeFileSync(uniquePath(safeName(String(m.name))), Buffer.from(String(m.data), 'base64')); } catch { return; }
      m = { t: 'photo' };
    }
    toDesks(m);
  });
  ws.on('close', () => { if (phone === ws) { phone = null; toDesks({ t: 'phone', on: false }); } });
}

function deskConnected(ws) {
  desks.add(ws);
  ws.send(JSON.stringify({ t: 'phone', on: !!phone }));
  ws.on('message', d => {
    let m;
    try { m = JSON.parse(d); } catch { return; }
    if (!DESK_COMMANDS.has(m.t)) return;
    if (phone && phone.readyState === 1) phone.send(JSON.stringify(m));
    else ws.send(JSON.stringify({ t: 'phone', on: false }));
  });
  ws.on('close', () => desks.delete(ws));
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (!['/ws', '/phone', '/desk'].includes(p) || (p === '/ws' && !nut) || !authed(req, url)) return socket.destroy();
  if (p === '/phone') return bridge.handleUpgrade(req, socket, head, ws => phoneConnected(ws));
  if (p === '/desk') return bridge.handleUpgrade(req, socket, head, ws => deskConnected(ws));
  wss.handleUpgrade(req, socket, head, ws => {
    ws.on('message', d => {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      handle(m).catch(() => {});
    });
  });
});

function start() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => resolve({ pin: PIN, port: PORT, share: SHARE }));
  });
}
module.exports = { start };

// `node server.js` runs in the terminal; the desktop app (main.js) calls start() itself.
if (require.main === module) {
  start().then(async () => {
    console.log(`\nfisync is running.\nShared folder: ${SHARE}\nPIN: ${PIN}\n`);
    lanIps().forEach(ip => console.log(`  http://${ip}:${PORT}`));
    console.log('\nScan to open on your phone (PIN is filled in for you):');
    console.log(await QRCode.toString(pairUrl(), { type: 'terminal', small: true }));
    console.log(`Phone calls, messages and photos: http://localhost:${PORT}/desk#pin=${PIN}`);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
