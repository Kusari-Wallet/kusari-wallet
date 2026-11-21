// Hybrid public key encryption (RFC 9180) with DHKEM(secp256k1, HKDF-SHA256), HKDF-SHA256 and ChaCha20-Poly1305:
// the suite Payjoin (BIP77) uses, both end to end and for Oblivious HTTP. Base and Auth modes, plus Export.
import { randomBytes } from 'node:crypto';

const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { hkdf, extract, expand } = require('@noble/hashes/hkdf.js');
const { sha256 } = require('@noble/hashes/sha2.js');
const { chacha20poly1305 } = require('@noble/ciphers/chacha.js');
void hkdf;

export const KEM_ID = 0x0016;
export const KDF_ID = 0x0001;
export const AEAD_ID = 0x0003;
const NK = 32; const NN = 12; const NH = 32;

const te = (s: string): Uint8Array => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const i2osp = (n: number, len: number): Uint8Array => { const b = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { b[i] = n & 0xff; n = Math.floor(n / 256); } return b; };

const KEM_SUITE = cat(te('KEM'), i2osp(KEM_ID, 2));
const HPKE_SUITE = cat(te('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));
const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array =>
  extract(sha256, cat(te('HPKE-v1'), suite, te(label), ikm), salt);
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, len: number): Uint8Array =>
  expand(sha256, prk, cat(i2osp(len, 2), te('HPKE-v1'), suite, te(label), info), len);

/** The 65-byte uncompressed public key of a private key. */
export const publicKeyOf = (sk: Uint8Array): Uint8Array => secp256k1.getPublicKey(sk, false);
/** Any encoding of a public key as the 65-byte uncompressed form; throws when it is not a point. */
export const uncompressed = (pk: Uint8Array): Uint8Array => secp256k1.Point.fromBytes(pk).toBytes(false);
export const compressed = (pk: Uint8Array): Uint8Array => secp256k1.Point.fromBytes(pk).toBytes(true);
export function newPrivateKey(): Uint8Array {
  for (;;) { const k = randomBytes(32); try { secp256k1.getPublicKey(k); return new Uint8Array(k); } catch { /* out of range: again */ } }
}

function dh(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  const shared: Uint8Array = secp256k1.getSharedSecret(sk, pk, true).slice(1); // the x coordinate
  if (shared.every((b) => b === 0)) throw new Error('A key exchange gave zero.');
  return shared;
}
function sharedSecret(dhValue: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const prk = labeledExtract(KEM_SUITE, new Uint8Array(0), 'eae_prk', dhValue);
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', kemContext, 32);
}

export interface HpkeContext { seal(pt: Uint8Array, aad?: Uint8Array): Uint8Array; open(ct: Uint8Array, aad?: Uint8Array): Uint8Array; export(ctx: Uint8Array, len: number): Uint8Array }

function keySchedule(mode: number, shared: Uint8Array, info: Uint8Array): HpkeContext {
  const empty = new Uint8Array(0);
  const pskIdHash = labeledExtract(HPKE_SUITE, empty, 'psk_id_hash', empty);
  const infoHash = labeledExtract(HPKE_SUITE, empty, 'info_hash', info);
  const ctx = cat(Uint8Array.of(mode), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, shared, 'secret', empty);
  const key = labeledExpand(HPKE_SUITE, secret, 'key', ctx, NK);
  const baseNonce = labeledExpand(HPKE_SUITE, secret, 'base_nonce', ctx, NN);
  const exporter = labeledExpand(HPKE_SUITE, secret, 'exp', ctx, NH);
  let seq = 0;
  const nonce = (): Uint8Array => { const n = Uint8Array.from(baseNonce); const s = i2osp(seq, NN); for (let i = 0; i < NN; i++) n[i] ^= s[i]; seq++; return n; };
  return {
    seal: (pt, aad = empty) => chacha20poly1305(key, nonce(), aad).encrypt(pt),
    open: (ct, aad = empty) => chacha20poly1305(key, nonce(), aad).decrypt(ct),
    export: (c, len) => labeledExpand(HPKE_SUITE, exporter, 'sec', c, len),
  };
}

/** Sender side. `sender` (a private key) makes it Auth mode. `ephemeral` is for tests only. */
export function setupSender(pkR: Uint8Array, info: Uint8Array, sender?: Uint8Array, ephemeral?: Uint8Array): { enc: Uint8Array; ctx: HpkeContext } {
  const skE = ephemeral ?? newPrivateKey();
  const enc = publicKeyOf(skE);
  const pkRm = uncompressed(pkR);
  if (!sender) return { enc, ctx: keySchedule(0, sharedSecret(dh(skE, pkRm), cat(enc, pkRm)), info) };
  const pkSm = publicKeyOf(sender);
  return { enc, ctx: keySchedule(2, sharedSecret(cat(dh(skE, pkRm), dh(sender, pkRm)), cat(enc, pkRm, pkSm)), info) };
}

/** Receiver side. `senderPub` makes it Auth mode. */
export function setupReceiver(enc: Uint8Array, skR: Uint8Array, info: Uint8Array, senderPub?: Uint8Array): HpkeContext {
  const pkE = uncompressed(enc);
  const pkRm = publicKeyOf(skR);
  if (!senderPub) return keySchedule(0, sharedSecret(dh(skR, pkE), cat(pkE, pkRm)), info);
  const pkSm = uncompressed(senderPub);
  return keySchedule(2, sharedSecret(cat(dh(skR, pkE), dh(skR, pkSm)), cat(pkE, pkRm, pkSm)), info);
}
