// Computer side of the relay: keeps a connection to the relay open, and accepts phone sessions relayed through it.
const crypto = require('crypto');
const WebSocket = require('ws');

// The address the relay knows this computer by: SHA-256 of its ID. The ID itself is never sent.
function relayAddress(computerId) {
  return crypto.createHash('sha256').update(String(computerId), 'utf8').digest('hex');
}

function startRelayClient({ relayUrl, computerId, onSession, onStatus, WebSocketClass = WebSocket }) {
  const address = relayAddress(computerId);
  let stopped = false, socket = null, delay = 2000;
  const connect = () => {
    if (stopped) return;
    socket = new WebSocketClass(`${relayUrl}/computer/${address}`);
    socket.on('open', () => { delay = 2000; onStatus && onStatus('online'); });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.t !== 'session' || !/^[0-9a-f]{32}$/.test(String(m.sid))) return;
      const s = new WebSocketClass(`${relayUrl}/session/${m.sid}`);
      s.on('error', () => {});
      s.on('open', () => { s.relayed = true; onSession(s, String(m.route || '/bridge')); });
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      onStatus && onStatus('offline');
      if (!stopped) {
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, 60000);
      }
    });
  };
  connect();
  return { address, stop() { stopped = true; if (socket) socket.close(); } };
}

module.exports = { relayAddress, startRelayClient };
