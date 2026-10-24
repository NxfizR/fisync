// Property tests: thousands of random inputs at the parsers that read data from the network or from disk.
// Each property must hold for every input, so a crash or a wrong answer shows up with a small example.
const assert = require('assert');
const fc = require('fast-check');
const remote = require('../remote');
const relayClient = require('../remote/relay-client');

(async () => {
  const core = await import('../src/crypto-core.js');
  const runs = { numRuns: 500 };

  fc.assert(fc.property(fc.uint8Array({ minLength: 0, maxLength: 64 }), bytes => {
    const r = remote.decodeBeacon(Buffer.from(bytes));
    if (r === null) return true;
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(r.ip) && r.port >= 0 && r.port <= 65535;
  }), runs);
  console.log('ok  500 random inputs: the beacon reader never crashes and only returns a valid address');

  fc.assert(fc.property(fc.string({ maxLength: 40 }), s => {
    const p = remote.connectionPath(s);
    return ['tailscale', 'local', 'usb', 'relay', 'other'].includes(p);
  }), runs);
  console.log('ok  500 random peer addresses are sorted into one of the known paths');

  fc.assert(fc.property(fc.string({ maxLength: 40 }), s => typeof remote.networkKey(s) === 'string'), runs);
  console.log('ok  500 random peer addresses always give a network key');

  fc.assert(fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.uint8Array({ minLength: 0, maxLength: 200 }), fc.integer({ min: 0, max: 2 ** 31 }), (key, data, n) => {
    if (data.length < 16) return true;
    try {
      core.open(key, n, data);
      return false;   // random bytes must never be accepted as authentic
    } catch (e) {
      return e instanceof Error;
    }
  }), runs);
  console.log('ok  500 random ciphertexts are rejected, and only with an ordinary error');

  fc.assert(fc.property(fc.hexaString({ minLength: 32, maxLength: 32 }), hex => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(remote.beaconUuid(hex))), runs);
  console.log('ok  500 random beacons turn into valid service IDs');

  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 60 }), id => {
    const a = relayClient.relayAddress(id);
    return /^[0-9a-f]{64}$/.test(a) && a === relayClient.relayAddress(id);
  }), runs);
  console.log('ok  500 random computer IDs give a fixed 64-character relay address');

  console.log('\nProperty checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
