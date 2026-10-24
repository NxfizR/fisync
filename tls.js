// A local certificate authority for the secure page (https). It is made once, kept on this computer,
// and its public certificate is installed on each phone after the fingerprint has been checked.
// The server certificate is renewed when the computer's network address changes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');

// Key pairs come from Node's native crypto, which is much faster than generating them in JavaScript.
function newKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey: forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' })),
    privateKey: forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs8', format: 'pem' })),
  };
}

const SERVER_DAYS = 365;

function serial() {
  return '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
}

function fingerprint(certPem) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(certPem))).getBytes();
  return forge.md.sha256.create().update(der).digest().toHex().toUpperCase().match(/../g).join(':');
}

function makeCA() {
  const keys = newKeys();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 3600e3);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400e3);
  const subject = [{ name: 'commonName', value: 'fisync local CA' }];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keys, cert };
}

function makeServerCert(ca, ips) {
  const keys = newKeys();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 3600e3);
  cert.validity.notAfter = new Date(Date.now() + SERVER_DAYS * 86400e3);
  cert.setSubject([{ name: 'commonName', value: 'fisync' }]);
  cert.setIssuer(ca.cert.subject.attributes);
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map(ip => ({ type: 7, ip }))];
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);
  cert.sign(ca.keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

// Returns { caPem, fingerprint, key, cert }. Creates whatever is missing; renews the server certificate when the addresses change.
function loadOrCreate(dir, ips) {
  fs.mkdirSync(dir, { recursive: true });
  const caKeyFile = path.join(dir, 'ca.key');
  const caFile = path.join(dir, 'ca.pem');
  const serverFile = path.join(dir, 'server.json');
  let ca;
  if (fs.existsSync(caKeyFile) && fs.existsSync(caFile)) {
    ca = {
      keys: { privateKey: forge.pki.privateKeyFromPem(fs.readFileSync(caKeyFile, 'utf8')) },
      cert: forge.pki.certificateFromPem(fs.readFileSync(caFile, 'utf8')),
    };
  } else {
    ca = makeCA();
    fs.writeFileSync(caKeyFile, forge.pki.privateKeyToPem(ca.keys.privateKey), { mode: 0o600 });
    fs.writeFileSync(caFile, forge.pki.certificateToPem(ca.cert));
  }
  const caPem = forge.pki.certificateToPem(ca.cert);
  const wanted = [...ips].sort().join(',');
  let server = null;
  try {
    const saved = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
    const left = forge.pki.certificateFromPem(saved.cert).validity.notAfter - Date.now();
    if (saved.ips === wanted && left > 7 * 86400e3) server = saved;
  } catch { /* none yet */ }
  if (!server) {
    const made = makeServerCert(ca, ips);
    server = { ips: wanted, key: made.key, cert: made.cert };
    fs.writeFileSync(serverFile, JSON.stringify(server), { mode: 0o600 });
  }
  return { caPem, fingerprint: fingerprint(caPem), key: server.key, cert: server.cert };
}

module.exports = { loadOrCreate, fingerprint };
