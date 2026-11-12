'use strict';
// Helpers shared by make-params.js, prepare.js and the tests. Node's own crypto only, so it runs without npm install.
const crypto = require('crypto');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const FULL_BLOCK = 8;
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

function varint(n) {
  let v = BigInt(n);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
}

// Monero's base58: 8-byte blocks, each written as 11 characters (the last block shorter).
function cnBase58(buf) {
  let s = '';
  for (let i = 0; i < buf.length; i += FULL_BLOCK) {
    const block = buf.subarray(i, i + FULL_BLOCK);
    let v = 0n;
    for (const b of block) v = (v << 8n) | BigInt(b);
    let chunk = '';
    for (let k = 0; k < ENCODED_BLOCK_SIZES[block.length]; k++) {
      chunk = ALPHABET[Number(v % 58n)] + chunk;
      v /= 58n;
    }
    s += chunk;
  }
  return s;
}

function cnBase58Decode(str) {
  const parts = [];
  for (let i = 0; i < str.length; i += 11) {
    const chunk = str.slice(i, i + 11);
    const size = ENCODED_BLOCK_SIZES.indexOf(chunk.length);
    if (size < 0) throw new Error('bad base58 length');
    let v = 0n;
    for (const ch of chunk) {
      const d = ALPHABET.indexOf(ch);
      if (d < 0) throw new Error('bad base58 character');
      v = v * 58n + BigInt(d);
    }
    if (v >> BigInt(size * 8)) throw new Error('base58 block overflow');
    const block = Buffer.alloc(size);
    for (let k = size - 1; k >= 0; k--) { block[k] = Number(v & 0xffn); v >>= 8n; }
    parts.push(block);
  }
  return Buffer.concat(parts);
}

// Monero's cn_fast_hash: Keccak-256 with the original 0x01 padding (not SHA3's 0x06). Node has no such hash.
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);

function keccakF(a) {
  for (let r = 0; r < 24; r++) {
    const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) a[x + y] = b[x + y] ^ (~b[(x + 1) % 5 + y] & M64 & b[(x + 2) % 5 + y]);
    a[0] ^= RC[r];
  }
}

function keccak256(buf) {
  const rate = 136;
  const padded = Buffer.alloc((Math.floor(buf.length / rate) + 1) * rate);
  buf.copy(padded);
  padded[buf.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const a = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) a[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(a);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(a[i], i * 8);
  return out;
}

function decodeAddress(str) {
  const b = cnBase58Decode(str);
  let i = 0, prefix = 0n, shift = 0n;
  for (;;) {
    const x = b[i++];
    prefix |= BigInt(x & 0x7f) << shift;
    shift += 7n;
    if (!(x & 0x80)) break;
  }
  const body = b.subarray(0, b.length - 4);
  if (!keccak256(body).subarray(0, 4).equals(b.subarray(b.length - 4))) throw new Error('bad address checksum');
  return { prefix: Number(prefix), spendPub: b.subarray(i, i + 32), viewPub: b.subarray(i + 32, i + 64), extra: b.subarray(i + 64, b.length - 4) };
}

function encodeAddress(prefix, spendPub, viewPub) {
  const body = Buffer.concat([varint(prefix), spendPub, viewPub]);
  return cnBase58(Buffer.concat([body, keccak256(body).subarray(0, 4)]));
}

// The leading character a single-byte prefix always gives, or null if it can vary with the keys.
function leadingChar(prefix) {
  if (prefix < 0 || prefix > 127) return null;
  const d = 58n ** 10n;
  const lo = BigInt(prefix) << 56n;
  const hi = ((BigInt(prefix) + 1n) << 56n) - 1n;
  return lo / d === hi / d ? ALPHABET[Number(lo / d)] : null;
}

// A valid ed25519 point whose secret is thrown away, so nobody can spend what is sent to it.
function burnPoint() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
}

// The same layout as Monero's GENESIS_TX: version 1, unlock 60, one coinbase input at height 0,
// one output to a key, and a tx public key in extra.
function genesisTx(amount, outKey, txPub) {
  return Buffer.concat([
    Buffer.from([0x01, 0x3c, 0x01, 0xff, 0x00, 0x01]),
    varint(amount),
    Buffer.from([0x02]), outKey,
    Buffer.from([0x21, 0x01]), txPub,
  ]).toString('hex');
}

function parseGenesisTx(hex) {
  const b = Buffer.from(hex, 'hex');
  const head = b.subarray(0, 6).toString('hex');
  if (head !== '013c01ff0001') throw new Error('genesis tx header is not Monero\'s');
  let i = 6, amount = 0n, shift = 0n;
  for (;;) {
    const x = b[i++];
    amount |= BigInt(x & 0x7f) << shift;
    shift += 7n;
    if (!(x & 0x80)) break;
  }
  if (b[i++] !== 0x02) throw new Error('genesis output is not to a key');
  const outKey = b.subarray(i, i + 32); i += 32;
  if (b[i++] !== 0x21 || b[i++] !== 0x01) throw new Error('genesis extra is not a tx public key');
  const txPub = b.subarray(i, i + 32); i += 32;
  if (i !== b.length) throw new Error('genesis tx has trailing bytes');
  return { amount, outKey, txPub };
}

function networkIdBytes(hex) {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('network id must be 16 bytes of hex');
  return hex.match(/../g).map((x) => '0x' + x.toUpperCase());
}

module.exports = {
  ALPHABET, varint, cnBase58, cnBase58Decode, keccak256, encodeAddress, decodeAddress, leadingChar,
  burnPoint, genesisTx, parseGenesisTx, networkIdBytes,
};
