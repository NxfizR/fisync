import { utf8, text, concat, b64u, unb64u, random, sha, mac, kdf, ephemeral, ecdh, seal, open, same } from './crypto-core.js';

const idOf = token => sha(concat(utf8('fisync/1 id'), utf8(token)));
const keyOf = token => kdf(utf8(token), new Uint8Array(0), utf8('fisync/1 auth'), 32);
const CHUNK = 256 * 1024;

const REASONS = {
  1006: 'Cannot reach the computer. Check that it is on, on the same Wi-Fi, or use USB.',
  4401: 'This phone is no longer paired. Pair it again.',
  4403: 'This phone is not allowed to use that feature. Ask for access on the computer.',
  4408: 'This phone was locked after inactivity. Approve it on your computer.',
  4410: 'The phone panel key changed. Open the phone panel again from the fisync window.',
  4412: 'This computer is locked. Unlock it on the computer to continue.',
  4413: 'The computer has paused phone access for a while. It reconnects automatically.',
};
const reasonFor = code => REASONS[code] || 'The computer refused this connection.';

// Opens an encrypted channel. Resolves once the computer has proven who it is.
export function connect(url, token, handlers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const id = idOf(token), key = keyOf(token);
    const e = ephemeral(), nC = random(16);
    let T = null, ch = null, state = 'hello';
    const timer = setTimeout(() => fail('No answer from the computer. Check that it is on and on the same Wi-Fi.'), 70000);

    const send = (type, body) => {
      if (!ch || ws.readyState !== 1) return;
      ws.send(seal(ch.sk, ch.sn++, concat(Uint8Array.of(type), body)));
    };
    const api = {
      get isOpen() { return ws.readyState === 1; },
      get bufferedAmount() { return ws.bufferedAmount; },
      sendJson(o) { send(1, utf8(JSON.stringify(o))); },
      sendBlob(u8) { send(2, u8); },
      close() { ws.close(); },
    };
    const fail = why => {
      clearTimeout(timer);
      if (state !== 'ready') reject(new Error(why));
      try { ws.close(); } catch { /* already closed */ }
    };

    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: 1, id: b64u(id), eph: b64u(e.pub), n: b64u(nC) }));
    ws.onmessage = ev => {
      try {
        if (state === 'hello') {
          const m = JSON.parse(ev.data);
          if (m.t === 'pending') { if (handlers.onPending) handlers.onPending(m.text); return; }
          if (m.t !== 'hello-ack') return fail('The computer refused this connection.');
          const pubS = unb64u(m.eph), nS = unb64u(m.n);
          T = concat(utf8('fisync/1'), id, e.pub, nC, pubS, nS);
          if (!same(mac(key, concat(utf8('server'), T)), unb64u(m.mac))) return fail('The computer could not prove who it is.');
          const okm = kdf(ecdh(e.priv, pubS), concat(nC, nS), utf8('fisync/1 keys'), 64);
          ch = { sk: okm.slice(0, 32), rk: okm.slice(32), sn: 0, rn: 0 };
          ws.send(JSON.stringify({ t: 'auth', mac: b64u(mac(key, concat(utf8('client'), T))) }));
          state = 'auth';
          return;
        }
        const pt = open(ch.rk, ch.rn++, new Uint8Array(ev.data));
        if (pt[0] === 1) {
          const m = JSON.parse(text(pt.subarray(1)));
          if (state === 'auth' && m.t === 'ready') {   // the computer has finished setting up this connection
            state = 'ready';
            clearTimeout(timer);
            resolve(api);
            return;
          }
          if (handlers.onJson) handlers.onJson(m);
        } else if (pt[0] === 2 && handlers.onBlob) handlers.onBlob(pt.subarray(1));
      } catch (err) {
        fail(err.message || 'Connection error');
      }
    };
    ws.onclose = ev => {
      clearTimeout(timer);
      if (state !== 'ready') reject(new Error(reasonFor(ev && ev.code)));
      else if (handlers.onClose) handlers.onClose(REASONS[ev && ev.code] || '');
    };
    ws.onerror = () => { /* onclose follows with the reason */ };
  });
}

// Pairs with the PIN. The PIN proves this phone knows it; the token comes back encrypted.
export function pair(url, pin, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const e = ephemeral(), nC = random(16);
    let done = false;
    const finish = (fn, v) => {
      if (!done) { done = true; fn(v); }
      try { ws.close(); } catch { /* already closed */ }
    };
    ws.onopen = () => ws.send(JSON.stringify({
      t: 'pair-hello', v: 1, eph: b64u(e.pub), n: b64u(nC),
      proof: b64u(mac(utf8(pin), concat(utf8('pair'), e.pub, nC))), name,
    }));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.t === 'error') return finish(reject, new Error(m.msg));
      if (m.t !== 'pair-ack') return;
      try {
        const k = kdf(ecdh(e.priv, unb64u(m.eph)), concat(nC, unb64u(m.n)), utf8('fisync/1 pair'), 32);
        finish(resolve, JSON.parse(text(open(k, 0, unb64u(m.ct)))));
      } catch {
        finish(reject, new Error('Could not verify the computer.'));
      }
    };
    ws.onclose = ev => finish(reject, new Error(reasonFor(ev && ev.code)));
  });
}

export function listFiles(base, token) {
  return new Promise((resolve, reject) => {
    let c;
    connect(base + '/files', token, {
      onJson: m => {
        if (m.t === 'list') { c.close(); resolve(m.items); }
        else if (m.t === 'error') { c.close(); reject(new Error(m.msg)); }
      },
      onClose: r => reject(new Error(r || 'Connection closed')),
    }).then(api => { c = api; api.sendJson({ t: 'list' }); }, reject);
  });
}

// progress keeps the parts received so far, so a second call resumes instead of starting again.
export function downloadFile(base, token, name, progress = { parts: [], bytes: 0 }) {
  return new Promise((resolve, reject) => {
    let c;
    connect(base + '/files', token, {
      onJson: m => {
        if (m.t === 'get-start') progress.size = m.size;
        else if (m.t === 'get-end') { c.close(); resolve(new Blob(progress.parts)); }
        else if (m.t === 'error') { c.close(); reject(new Error(m.msg)); }
      },
      onBlob: b => {
        progress.parts.push(b);
        progress.bytes += b.length;
        if (progress.onProgress) progress.onProgress(progress.bytes, progress.size);
      },
      onClose: r => reject(new Error(r || 'Connection closed')),
    }).then(api => { c = api; api.sendJson({ t: 'get', name, offset: progress.bytes }); }, reject);
  });
}

export function uploadFile(base, token, file, onProgress, conflict = 'keep') {
  return new Promise((resolve, reject) => {
    let c, offset = 0;
    const pump = async () => {
      while (offset < file.size) {
        while (c.bufferedAmount > 4e6) await new Promise(r => setTimeout(r, 20));
        const part = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
        c.sendBlob(part);
        offset += part.length;
        if (onProgress) onProgress(offset / file.size);
      }
      c.sendJson({ t: 'put-end' });
    };
    connect(base + '/files', token, {
      onJson: m => {
        if (m.t === 'put-ready') { offset = m.offset || 0; pump().catch(err => { c.close(); reject(err); }); }
        else if (m.t === 'saved') { c.close(); resolve(m.name); }
        else if (m.t === 'error') { c.close(); reject(new Error(m.msg)); }
      },
      onClose: r => reject(new Error(r || 'Connection closed')),
    }).then(api => { c = api; api.sendJson({ t: 'put', name: file.name, size: file.size, conflict }); }, reject);
  });
}

// One request that gets one reply, such as delete or rename.
function oneShot(base, token, msg, doneType) {
  return new Promise((resolve, reject) => {
    let c;
    connect(base + '/files', token, {
      onJson: m => {
        if (m.t === doneType) { c.close(); resolve(m); }
        else if (m.t === 'error') { c.close(); reject(new Error(m.msg)); }
      },
      onClose: r => reject(new Error(r || 'Connection closed')),
    }).then(api => { c = api; api.sendJson(msg); }, reject);
  });
}
export const deleteFile = (base, token, name) => oneShot(base, token, { t: 'delete', name }, 'deleted');
export const renameFile = (base, token, name, to) => oneShot(base, token, { t: 'rename', name, to }, 'renamed');
