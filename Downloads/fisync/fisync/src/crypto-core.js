// Crypto used by the browser and the Android launcher. Must match server.js and FiCrypto.java.
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hkdf } from '@noble/hashes/hkdf';
import { randomBytes } from '@noble/hashes/utils';
import { gcm } from '@noble/ciphers/aes';

const te = new TextEncoder(), td = new TextDecoder();
export const utf8 = s => te.encode(s);
export const text = b => td.decode(b);

export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export const b64u = bytes => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const unb64u = str => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

export const random = n => randomBytes(n);
export const sha = d => sha256(d);
export const mac = (key, data) => hmac(sha256, key, data);
export const kdf = (ikm, salt, info, len) => hkdf(sha256, ikm, salt, info, len);

export function ephemeral() {
  const priv = p256.utils.randomPrivateKey();
  return { priv, pub: p256.getPublicKey(priv, false) };   // 65-byte uncompressed point
}
export const ecdh = (priv, pub) => p256.getSharedSecret(priv, pub, false).slice(1, 33);

const nonce = n => {
  const b = new Uint8Array(12);
  new DataView(b.buffer).setBigUint64(4, BigInt(n));
  return b;
};
export const seal = (key, n, plain) => gcm(key, nonce(n)).encrypt(plain);
export const open = (key, n, data) => gcm(key, nonce(n)).decrypt(data);

export const same = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
};
