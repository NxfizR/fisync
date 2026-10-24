// Remote access helpers: the Tailscale name of this computer, and the nearby Bluetooth beacon.
// Mostly pure functions, so they can be tested without a tailnet or a Bluetooth radio.
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');

const MAGIC = Buffer.from([0x46, 0x53, 1]);   // "FS" + version 1
const BEACON_LENGTH = 16;                     // sent as a 128-bit service ID: no manufacturer registration needed

// First 7 bytes of the hash of the computer ID: lets a phone recognise its own computer without the ID itself being sent.
function cidHash(computerId) {
  return crypto.createHash('sha256').update(String(computerId), 'utf8').digest().subarray(0, 7);
}

// Beacon: "FS" + version (3 bytes), id hash (7), IPv4 address (4), port (2, big-endian). No keys, no names.
function encodeBeacon(computerId, ip, port) {
  const buf = Buffer.alloc(BEACON_LENGTH);
  MAGIC.copy(buf, 0);
  cidHash(computerId).copy(buf, 3);
  String(ip).split('.').forEach((n, i) => { buf[10 + i] = Number(n); });
  buf.writeUInt16BE(Number(port), 14);
  return buf;
}

// Returns { ip, port } for a beacon, or null if it is not ours or is for another computer.
function decodeBeacon(buf, computerId) {
  if (!Buffer.isBuffer(buf) || buf.length < BEACON_LENGTH) return null;
  if (!buf.subarray(0, 3).equals(MAGIC)) return null;
  if (computerId !== undefined && !buf.subarray(3, 10).equals(cidHash(computerId))) return null;
  return { ip: [10, 11, 12, 13].map(i => buf[i]).join('.'), port: buf.readUInt16BE(14) };
}

// The beacon as a standard UUID string, which Windows, Linux and Android all read the same way.
function beaconUuid(hex) {
  return String(hex).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function tailscaleBinary() {
  if (process.env.TAILSCALE_BIN) return process.env.TAILSCALE_BIN;
  return process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
}

// Asks Tailscale for this computer's name on the tailnet. Never throws.
function tailscaleStatus(bin = tailscaleBinary()) {
  return new Promise(resolve => {
    execFile(bin, ['status', '--json'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err && err.code === 'ENOENT') return resolve({ installed: false, running: false, dnsName: null, ips: [] });
      let j = null;
      try { j = JSON.parse(String(stdout)); } catch { /* logged out, or Tailscale is stopped */ }
      if (!j) return resolve({ installed: true, running: false, dnsName: null, ips: [] });
      const self = j.Self || {};
      const dnsName = String(self.DNSName || '').replace(/\.$/, '') || null;
      resolve({
        installed: true,
        running: j.BackendState === 'Running',
        dnsName,
        ips: (self.TailscaleIPs || []).filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip)),
      });
    });
  });
}

// Which helper sends the beacon on each system, and how to start it. Returns { cmd, args } or { reason }.
function beaconCommand(platform, beaconFile, root) {
  const script = name => path.join(root, 'remote', name);
  if (platform === 'win32') {
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script('beacon-advertise.ps1'), '-BeaconFile', beaconFile] };
  }
  if (platform === 'darwin') {
    return { cmd: 'swift', args: [script('beacon-macos.swift'), beaconFile] };
  }
  if (platform === 'linux') {
    try { require.resolve('dbus-next', { paths: [root] }); }
    catch { return { reason: 'Nearby Bluetooth on Linux needs one extra package: open a terminal in the fisync folder and run npm install' }; }
    return { cmd: process.execPath, args: [script('beacon-linux.js'), beaconFile] };
  }
  return { reason: 'Nearby Bluetooth is not available on this system' };
}

// How a phone reached the computer, from the address it connected from.
function connectionPath(peer) {
  const a = String(peer || '').replace(/^::ffff:/, '');
  if (a === 'relay') return 'relay';
  const v4 = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (a === '::1' || (v4 && v4[1] === '127')) return 'usb';          // this computer, or USB port forwarding
  if (v4 && v4[1] === '100' && +v4[2] >= 64 && +v4[2] <= 127) return 'tailscale';
  if (v4 && (v4[1] === '10' || (v4[1] === '172' && +v4[2] >= 16 && +v4[2] <= 31) || (v4[1] === '192' && v4[2] === '168'))) return 'local';
  return 'other';
}

// The network a phone came from, for spotting a new one. Local networks are compared by their first three octets.
function networkKey(peer) {
  const path = connectionPath(peer);
  if (path !== 'local') return path;
  return String(peer).replace(/^::ffff:/, '').split('.').slice(0, 3).join('.');
}

module.exports = { connectionPath, networkKey, cidHash, encodeBeacon, decodeBeacon, beaconUuid, tailscaleBinary, tailscaleStatus, beaconCommand, BEACON_LENGTH };
