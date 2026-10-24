// fisync relay: carries encrypted traffic between a computer and its phones when they cannot reach each other.
// It never sees keys or file contents. A computer's address is the SHA-256 hash of its random ID, so the relay
// learns only that hash. Run it behind TLS (Caddy or nginx), as described in docs/RELAY.md.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const SESSION_WAIT_MS = 10_000;          // how long a phone waits for its computer to answer
const MAX_SESSIONS_PER_COMPUTER = 8;
const MAX_CONNECTIONS_PER_MINUTE = 60;   // per address, to slow down guessing and floods
const MAX_FRAME = 4 * 1024 * 1024;       // file chunks are 256 KB; anything much bigger is refused

function createRelay(opts = {}) {
  const waitMs = opts.sessionWaitMs || SESSION_WAIT_MS;
  const computers = new Map();      // address -> computer socket
  const pending = new Map();        // session id -> entry waiting for its computer
  const openSessions = new Map();   // address -> number of sessions in use
  const rate = new Map();           // ip -> { count, resetAt }
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('fisync relay\n');
  });

  function allowed(ip) {
    const now = Date.now();
    if (rate.size > 10000) rate.clear();
    const r = rate.get(ip) || { count: 0, resetAt: now + 60_000 };
    if (now > r.resetAt) { r.count = 0; r.resetAt = now + 60_000; }
    r.count++;
    rate.set(ip, r);
    return r.count <= MAX_CONNECTIONS_PER_MINUTE;
  }

  // Ends one relayed session exactly once, whichever side closes first.
  function finish(entry) {
    if (entry.done) return;
    entry.done = true;
    const n = (openSessions.get(entry.address) || 1) - 1;
    if (n <= 0) openSessions.delete(entry.address);
    else openSessions.set(entry.address, n);
  }

  function registerComputer(ws, address) {
    ws.on('error', () => {});
    const old = computers.get(address);
    if (old && old.readyState === 1) return ws.close(4409, 'this computer is already connected');
    computers.set(address, ws);
    ws.on('close', () => { if (computers.get(address) === ws) computers.delete(address); });
  }

  function phoneWants(ws, address, route) {
    ws.on('error', () => {});
    const c = computers.get(address);
    if (!c || c.readyState !== 1) return ws.close(4404, 'computer offline');
    const open = openSessions.get(address) || 0;
    if (open >= MAX_SESSIONS_PER_COMPUTER) return ws.close(4429, 'too many sessions');
    const sid = crypto.randomBytes(16).toString('hex');
    const entry = { phone: ws, address, queued: [], done: false, timer: null };
    entry.onEarly = (data, isBinary) => entry.queued.push([data, isBinary]);   // keep what the phone says before the computer answers
    ws.on('message', entry.onEarly);
    entry.timer = setTimeout(() => {
      pending.delete(sid);
      finish(entry);
      ws.close(4408, 'computer did not answer');
    }, waitMs);
    pending.set(sid, entry);
    openSessions.set(address, open + 1);
    ws.on('close', () => {
      if (pending.get(sid) === entry) { clearTimeout(entry.timer); pending.delete(sid); }
      finish(entry);
    });
    c.send(JSON.stringify({ t: 'session', sid, route }));
  }

  function attachSession(ws, sid) {
    ws.on('error', () => {});
    const e = pending.get(sid);
    if (!e) return ws.close(4404, 'no such session');
    pending.delete(sid);
    clearTimeout(e.timer);
    const phone = e.phone;
    phone.removeListener('message', e.onEarly);
    for (const [data, isBinary] of e.queued) ws.send(data, { binary: isBinary });
    phone.on('message', (data, isBinary) => { if (ws.readyState === 1) ws.send(data, { binary: isBinary }); });
    ws.on('message', (data, isBinary) => { if (phone.readyState === 1) phone.send(data, { binary: isBinary }); });
    phone.on('close', () => { if (ws.readyState === 1) ws.close(); finish(e); });
    ws.on('close', () => { if (phone.readyState === 1) phone.close(); finish(e); });
  }

  server.on('upgrade', (req, socket, head) => {
    if (!allowed(socket.remoteAddress)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const url = new URL(req.url, 'http://relay');
    const [kind, id] = url.pathname.split('/').filter(Boolean);
    const valid = ((kind === 'computer' || kind === 'phone') && /^[0-9a-f]{64}$/.test(id || ''))
      || (kind === 'session' && /^[0-9a-f]{32}$/.test(id || ''));
    if (!valid) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => {
      if (kind === 'computer') return registerComputer(ws, id);
      if (kind === 'phone') return phoneWants(ws, id, url.searchParams.get('route') || '/bridge');
      return attachSession(ws, id);
    });
  });

  return { server, computerOnline: address => { const c = computers.get(address); return !!c && c.readyState === 1; } };
}

module.exports = { createRelay };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  createRelay().server.listen(port, '0.0.0.0', () => console.log(`fisync relay listening on ${port}`));
}
