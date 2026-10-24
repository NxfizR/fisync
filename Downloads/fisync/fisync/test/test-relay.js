// The relay on its own: pairing a phone with its computer, passing bytes both ways, and the refusals.
const assert = require('assert');
const WebSocket = require('ws');
const { createRelay } = require('../relay/relay');
const { relayAddress, startRelayClient } = require('../remote/relay-client');

const PORT = 18520;
const url = `ws://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const open = ws => new Promise((res, rej) => { ws.once('open', () => res(ws)); ws.once('error', rej); });
const closed = ws => new Promise(res => ws.once('close', (code, reason) => res({ code, reason: String(reason) })));
const nextMessage = ws => new Promise(res => ws.once('message', (d, bin) => res({ d, bin })));

(async () => {
  const relay = createRelay({ sessionWaitMs: 800 });
  await new Promise(res => relay.server.listen(PORT, '127.0.0.1', res));

  const computerId = 'test-computer-' + Date.now();
  const addr = relayAddress(computerId);
  let routeSeen = null;
  const computer = startRelayClient({
    relayUrl: url,
    computerId,
    onSession: (s, route) => {
      routeSeen = route;
      s.on('message', (d, bin) => s.send(bin ? d : 'echo:' + d, { binary: bin }));
    },
  });
  for (let i = 0; i < 50 && !relay.computerOnline(addr); i++) await sleep(20);
  assert.ok(relay.computerOnline(addr), 'the computer is registered with the relay');
  console.log('ok  a computer registers with the relay under a hash of its ID');

  const phone = await open(new WebSocket(`${url}/phone/${addr}?route=/files`));
  const first = nextMessage(phone);
  phone.send('hello');
  assert.strictEqual(String((await first).d), 'echo:hello', 'text reaches the computer and comes back');
  const bin = nextMessage(phone);
  phone.send(Buffer.from([1, 2, 3, 250]), { binary: true });
  const back = await bin;
  assert.ok(back.bin && Buffer.from(back.d).equals(Buffer.from([1, 2, 3, 250])), 'binary data comes back unchanged');
  assert.strictEqual(routeSeen, '/files', 'the computer is told which route the phone asked for');
  console.log('ok  a phone reaches its computer through the relay, text and binary, with the route kept');

  const stranger = new WebSocket(`${url}/phone/${relayAddress('nobody-home')}`);
  assert.strictEqual((await closed(stranger)).code, 4404, 'an offline computer is reported');
  console.log('ok  a phone is told when its computer is offline');

  const duplicate = new WebSocket(`${url}/computer/${addr}`);
  assert.strictEqual((await closed(duplicate)).code, 4409, 'a second computer with the same address is refused');
  console.log('ok  an address can only be held by one computer at a time');

  const deaf = await open(new WebSocket(`${url}/computer/${relayAddress('deaf-computer')}`));
  deaf.on('message', () => {});   // registered, but never answers the sessions
  const waiting = await open(new WebSocket(`${url}/phone/${relayAddress('deaf-computer')}`));
  assert.strictEqual((await closed(waiting)).code, 4408, 'a phone stops waiting when its computer does not answer');
  deaf.close();
  console.log('ok  a phone stops waiting when its computer does not answer');

  for (const bad of ['/phone/not-a-real-address', '/nowhere/' + addr]) {
    const r = await new Promise(res => {
      const ws = new WebSocket(url + bad);
      ws.on('unexpected-response', (req, resp) => res(resp.statusCode));
      ws.on('error', () => {});
    });
    assert.strictEqual(r, 404, 'a malformed address is refused: ' + bad);
  }
  console.log('ok  malformed addresses are refused');

  phone.close();
  computer.stop();
  await sleep(100);
  relay.server.close();
  console.log('\nRelay checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
