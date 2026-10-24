// Beacon format, the Tailscale status reader, and which Bluetooth helper runs on each system.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const remote = require('../remote');

(async () => {
  const id = 'b7c1e2aa-computer-id';
  const beacon = remote.encodeBeacon(id, '192.168.1.50', 8484);
  assert.strictEqual(beacon.length, 16, 'beacon is 16 bytes');
  assert.strictEqual(beacon.toString('hex').length, 32, 'beacon fits a 128-bit service ID');
  assert.deepStrictEqual(remote.decodeBeacon(beacon, id), { ip: '192.168.1.50', port: 8484 }, 'beacon reads back');
  assert.strictEqual(remote.decodeBeacon(beacon, 'another-computer'), null, 'a beacon for another computer is ignored');
  assert.strictEqual(remote.decodeBeacon(Buffer.from('not a beacon at all, really'), id), null, 'other data is ignored');
  assert.ok(!beacon.toString('hex').includes(Buffer.from(id).toString('hex')), 'the beacon does not contain the computer id');
  const uuid = remote.beaconUuid(beacon.toString('hex'));
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid), 'the beacon is a standard UUID');
  assert.ok(uuid.startsWith('465301'), 'the UUID starts with the "FS" marker');
  console.log('ok  the beacon is sent as a standard service ID, so no manufacturer registration is needed');

  assert.strictEqual(remote.beaconCommand('win32', 'b.json', '/fisync').cmd, 'powershell.exe');
  assert.strictEqual(remote.beaconCommand('darwin', 'b.json', '/fisync').cmd, 'swift');
  assert.deepStrictEqual(remote.beaconCommand('freebsd', 'b.json', '/fisync'), { reason: 'Nearby Bluetooth is not available on this system' });
  const linux = remote.beaconCommand('linux', 'b.json', '/fisync');
  assert.ok(linux.cmd || linux.reason, 'Linux either has a helper or says what to install');
  if (linux.reason) assert.ok(/npm install/.test(linux.reason), 'the Linux message says what to install');
  console.log('ok  Windows, macOS and Linux each get their own helper, and other systems are told so');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fisync-ts-'));
  const fake = path.join(dir, 'tailscale');
  fs.writeFileSync(fake, '#!/bin/sh\necho \'{"BackendState":"Running","Self":{"DNSName":"my-pc.tail1234.ts.net.","TailscaleIPs":["100.64.1.2","fd7a:115c::1"],"Online":true}}\'\n');
  fs.chmodSync(fake, 0o755);
  const running = await remote.tailscaleStatus(fake);
  assert.strictEqual(running.installed, true);
  assert.strictEqual(running.running, true);
  assert.strictEqual(running.dnsName, 'my-pc.tail1234.ts.net', 'the trailing dot is removed');
  assert.deepStrictEqual(running.ips, ['100.64.1.2'], 'only IPv4 addresses are kept');
  console.log('ok  the Tailscale name is read from a running Tailscale');

  const loggedOut = path.join(dir, 'tailscale-out');
  fs.writeFileSync(loggedOut, '#!/bin/sh\necho "Logged out."\nexit 1\n');
  fs.chmodSync(loggedOut, 0o755);
  const out = await remote.tailscaleStatus(loggedOut);
  assert.deepStrictEqual([out.installed, out.running, out.dnsName], [true, false, null], 'logged out is reported, not thrown');
  console.log('ok  a logged-out Tailscale is reported without an error');

  const missing = await remote.tailscaleStatus(path.join(dir, 'no-such-program'));
  assert.strictEqual(missing.installed, false, 'a missing Tailscale is reported as not installed');
  console.log('ok  a computer without Tailscale is reported as not installed');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nRemote access checks passed.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
