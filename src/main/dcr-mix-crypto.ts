// The cryptography of Decred's mixing protocol (StakeShuffle: CoinShuffle++ over a DC-net), ported from dcrd's
// mixing package (ISC): the seeded ChaCha20 stream, EC-Schnorr-DCRv0 signatures with their RFC 6979 nonces, the
// secp256k1 + sntrup4591761 key exchange, the slot reservation and XOR DC-nets over the field 2^127-1, and the
// session ID. Everything that another peer may re-derive from revealed secrets (keys, pads) is computed exactly as
// dcrd does; tests pin it to vectors from the Go code.
import { generateKey, encapsulate, decapsulate, PUBLIC_KEY_SIZE } from './sntrup';

const { blake256 } = require('@noble/hashes/blake1.js');
const { hmac } = require('@noble/hashes/hmac.js');
const { sha256 } = require('@noble/hashes/sha2.js');
const { chacha20 } = require('@noble/ciphers/chacha.js');
const { secp256k1 } = require('@noble/curves/secp256k1.js');

/** The field prime 2^127 - 1. */
export const F = (1n << 127n) - 1n;
/** Bytes in a mixed message (a P2PKH hash). */
export const MSIZE = 20;
const N = secp256k1.Point.CURVE().n as bigint;

// ---- numbers ----

export const bytesToBig = (b: Uint8Array): bigint => (b.length ? BigInt('0x' + Buffer.from(b).toString('hex')) : 0n);
/** Like Go's big.Int.Bytes: big-endian, no leading zeros (empty for zero). */
export function bigToBytes(x: bigint): Uint8Array {
  if (x === 0n) return new Uint8Array();
  let h = x.toString(16);
  if (h.length % 2) h = '0' + h;
  return Uint8Array.from(Buffer.from(h, 'hex'));
}
const be32 = (x: bigint): Uint8Array => { const h = x.toString(16).padStart(64, '0'); return Uint8Array.from(Buffer.from(h, 'hex')); };
const mod = (a: bigint, m: bigint) => { const r = a % m; return r < 0n ? r + m : r; };
function powmod(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n; b = mod(b, m);
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
const inv = (a: bigint, m: bigint) => powmod(a, m - 2n, m);

// ---- the seeded stream ----

/** ChaCha20 keyed with a seed, the nonce's first 4 bytes the run (little-endian), read as a stream of bytes. */
export class ChaChaPrng {
  private buf = new Uint8Array();
  private used = 0;
  private counter = 0;
  private readonly nonce = new Uint8Array(12);
  constructor(private readonly seed: Uint8Array, run = 0) {
    if (seed.length !== 32) throw new Error('chacha20prng: bad seed length');
    new DataView(this.nonce.buffer).setUint32(0, run >>> 0, true);
  }
  next(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      if (this.used === this.buf.length) {
        const blocks = 64;
        this.buf = chacha20(this.seed, this.nonce, new Uint8Array(64 * blocks), undefined, this.counter);
        this.counter += blocks;
        this.used = 0;
      }
      const take = Math.min(n - o, this.buf.length - this.used);
      out.set(this.buf.subarray(this.used, this.used + take), o);
      this.used += take; o += take;
    }
    return out;
  }
  reader = (n: number): Uint8Array => this.next(n);
}

/** secp256k1.GeneratePrivateKeyFromRand: 32 bytes at a time until a valid scalar. */
export function privateKeyFromStream(read: (n: number) => Uint8Array): Uint8Array {
  for (;;) { const b = read(32); const k = bytesToBig(b); if (k > 0n && k < N) return b; }
}

// ---- EC-Schnorr-DCRv0 ----

const EXTRA_V0 = Uint8Array.from([0x0b, 0x75, 0xf9, 0x7b, 0x60, 0xe8, 0xa5, 0x76, 0x28, 0x76, 0xc0, 0x04, 0x82, 0x9e, 0xe9, 0xb9, 0x26, 0xfa, 0x6f, 0x0d, 0x2e, 0xea, 0xec, 0x3a, 0x4f, 0xd1, 0x44, 0x6a, 0x76, 0x83, 0x31, 0xcb]);

/** dcrd's NonceRFC6979 (HMAC-SHA256), with the key, hash and extra data as dcrd lays them out. */
export function nonceRFC6979(priv: Uint8Array, hash: Uint8Array, extra: Uint8Array, iterations: number): bigint {
  const key = Uint8Array.from([...priv, ...hash, ...extra]);
  const H = (k: Uint8Array, ...parts: Uint8Array[]) => hmac(sha256, k, Uint8Array.from(parts.flatMap((p) => [...p])));
  let v: Uint8Array = new Uint8Array(32).fill(1);
  let k: Uint8Array = new Uint8Array(32);
  k = H(k, v, Uint8Array.of(0), key); v = H(k, v);
  k = H(k, v, Uint8Array.of(1), key); v = H(k, v);
  let generated = 0;
  for (;;) {
    v = H(k, v);
    const s = bytesToBig(v);
    if (s > 0n && s < N) { generated++; if (generated > iterations) return s; }
    k = H(k, v, Uint8Array.of(0)); v = H(k, v);
  }
}

export function schnorrSign(priv: Uint8Array, hash: Uint8Array): Uint8Array {
  const d = bytesToBig(priv);
  for (let it = 0; ; it++) {
    let k = nonceRFC6979(priv, hash, EXTRA_V0, it);
    const R = secp256k1.Point.BASE.multiply(k).toAffine();
    if (R.y & 1n) k = N - k;
    const r = be32(R.x);
    const e = bytesToBig(blake256(Uint8Array.from([...r, ...hash])));
    if (e >= N) continue;
    const s = mod(k - e * d, N);
    return Uint8Array.from([...r, ...be32(s)]);
  }
}

export function schnorrVerify(pub: Uint8Array, hash: Uint8Array, sig: Uint8Array): boolean {
  try {
    if (sig.length !== 64 || pub.length !== 33 || hash.length !== 32) return false;
    const r = bytesToBig(sig.subarray(0, 32)); const s = bytesToBig(sig.subarray(32));
    const P = (1n << 256n) - 0x1000003d1n;
    if (r >= P || s >= N) return false;
    const Q = secp256k1.Point.fromBytes(pub);
    const e = bytesToBig(blake256(Uint8Array.from([...sig.subarray(0, 32), ...hash])));
    if (e >= N) return false;
    const sG = s === 0n ? secp256k1.Point.ZERO : secp256k1.Point.BASE.multiply(s);
    const eQ = e === 0n ? secp256k1.Point.ZERO : Q.multiply(e);
    const R = sG.add(eQ);
    if (R.equals(secp256k1.Point.ZERO)) return false;
    const a = R.toAffine();
    return (a.y & 1n) === 0n && a.x === r;
  } catch { return false; }
}

export const publicKeyOf = (priv: Uint8Array): Uint8Array => secp256k1.getPublicKey(priv, true);

/** The hash a mix message's signature commits to: tag, command, session, run, and the hash of the signed data. */
export function mixSigHash(command: string, sid: Uint8Array | null, run: number, sigHash: Uint8Array): Uint8Array {
  const s = sid && sid.length === 32 ? sid : new Uint8Array(32);
  const rn = sid && sid.length === 32 ? run : 0;
  return blake256(Buffer.from(`decred-mix-signature,${command},${Buffer.from(s).toString('hex')},${rn},${Buffer.from(sigHash).toString('hex')}`));
}

/** The proof that a pair request's coin is the signer's: over the expiry and the key (utxoproof). */
export function utxoProofHash(expiry: number, pub: Uint8Array): Uint8Array {
  const e = Buffer.alloc(4); e.writeUInt32BE(expiry >>> 0);
  return blake256(Buffer.concat([Buffer.from('mixpr-utxoproof,P2PKH(EC-Schnorr-DCRv0),'), e, Buffer.from(pub)]));
}

// ---- key exchange ----

export interface KX { ecdhPriv: Uint8Array; ecdhPub: Uint8Array; pqPub: Uint8Array; pqPriv: Uint8Array; pqCleartexts: Uint8Array[] }

/** mixing.NewKX: the ECDH key, then the sntrup key, both from the stream. */
export function newKX(prng: ChaChaPrng): KX {
  const ecdhPriv = privateKeyFromStream(prng.reader);
  const { publicKey, privateKey } = generateKey(prng.reader);
  return { ecdhPriv, ecdhPub: publicKeyOf(ecdhPriv), pqPub: publicKey, pqPriv: privateKey, pqCleartexts: [] };
}

/** One ciphertext to every peer's sntrup key (own included), from the stream; the cleartexts are kept. */
export function encapsulateAll(kx: KX, prng: ChaChaPrng, pubkeys: Uint8Array[]): Uint8Array[] {
  kx.pqCleartexts = [];
  return pubkeys.map((pk) => {
    if (pk.length !== PUBLIC_KEY_SIZE) throw new Error('bad sntrup public key');
    const { ciphertext, sharedKey } = encapsulate(prng.reader, pk);
    kx.pqCleartexts.push(sharedKey);
    return ciphertext;
  });
}

export class DecapsulateError extends Error { constructor(readonly submittingIndex: number) { super('sntrup4591761: decapsulate failure'); } }

/** The slot reservation and DC-net secrets shared with every other message (mixing.KX.SharedSecrets). */
export function sharedSecrets(kx: KX, ecdhPubs: Uint8Array[], ciphertexts: Uint8Array[], myIndex: number, sid: Uint8Array, mcounts: number[]): { sr: Uint8Array[][]; dc: Uint8Array[][][] } {
  if (ecdhPubs.length !== mcounts.length || ciphertexts.length !== mcounts.length) throw new Error('peer count mismatch');
  const mcount = mcounts[myIndex];
  const mtot = mcounts.reduce((a, b) => a + b, 0);
  const sr: Uint8Array[][] = [];
  const dc: Uint8Array[][][] = [];
  for (let i = 0; i < mcount; i++) {
    sr.push(new Array(mtot)); dc.push(new Array(mtot));
    let m = 0;
    for (let peer = 0; peer < mcounts.length; peer++) {
      if (peer === myIndex && mcount === 1) { m++; continue; }
      const shared = Uint8Array.from(blake256(secp256k1.getSharedSecret(kx.ecdhPriv, ecdhPubs[peer], true).subarray(1)));
      const d = decapsulate(ciphertexts[peer], kx.pqPriv);
      if (!d.ok) throw new DecapsulateError(peer);
      for (let b = 0; b < 32; b++) shared[b] ^= d.sharedKey[b];
      if (peer !== myIndex) for (let b = 0; b < 32; b++) shared[b] ^= kx.pqCleartexts[peer][b];
      for (let j = 0; j < mcounts[peer]; j++) {
        if (myIndex === peer && j === i) { m++; continue; }
        let seedCounter = i; let nonce = j;
        if (myIndex > peer || (myIndex === peer && j > i)) { seedCounter = j; nonce = i; }
        const pre = Buffer.alloc(sid.length + 32 + 4);
        pre.set(sid, 0); pre.set(shared, sid.length); pre.writeUInt32LE(seedCounter, sid.length + 32);
        const prng = new ChaChaPrng(blake256(pre), nonce);
        sr[i][m] = prng.next(32);
        dc[i][m] = Array.from({ length: mtot }, () => prng.next(MSIZE));
        m++;
      }
    }
  }
  return { sr, dc };
}

// ---- slot reservation and DC-net ----

export function srMixPads(kp: Uint8Array[], my: number): bigint[] {
  const pads: bigint[] = [];
  for (let j = 0; j < kp.length; j++) {
    let pad = 0n;
    const ctr = Buffer.alloc(8); ctr.writeBigUInt64LE(BigInt(j + 1));
    for (let i = 0; i < kp.length; i++) {
      if (i === my) continue;
      const part = bytesToBig(blake256(Buffer.concat([Buffer.from(kp[i]), ctr])));
      pad = my > i ? pad + part : pad - part;
    }
    pads.push(mod(pad, F));
  }
  return pads;
}

export const srMix = (m: bigint, pads: bigint[]): bigint[] => pads.map((p, i) => mod(m ** BigInt(i + 1) + p, F));

export function addVectors(vs: bigint[][]): bigint[] {
  return vs[0].map((_, i) => mod(vs.reduce((s, v) => s + v[i], 0n), F));
}

/** The polynomial whose roots are the reserved slots, from the power sums (Newton's identities). */
export function coefficients(S: bigint[]): bigint[] {
  const n = S.length + 1;
  const a: bigint[] = new Array(n);
  a[n - 1] = F - 1n;
  for (let i = 0; i < n - 1; i++) {
    let acc = 0n;
    for (let j = 0; j <= i; j++) acc += a[n - 1 - i + j] * S[j];
    a[n - 2 - i] = mod(acc * mod(-inv(BigInt(i + 1), F), F), F);
  }
  return a;
}

export function isRoot(m: bigint, a: bigint[]): boolean {
  let sum = 0n;
  for (let i = 0; i < a.length; i++) sum += powmod(m, BigInt(i), F) * a[i];
  return mod(sum, F) === 0n;
}

export function dcMixPads(kp: Uint8Array[][], my: number): Uint8Array[] {
  const mtot = kp.find((v) => v)?.length ?? 0;
  const pads = Array.from({ length: mtot }, () => new Uint8Array(MSIZE));
  kp.forEach((vec, i) => { if (i === my) return; vec.forEach((x, s) => { for (let b = 0; b < MSIZE; b++) pads[s][b] ^= x[b]; }); });
  return pads;
}

export function dcMix(pads: Uint8Array[], m: Uint8Array, slot: number): Uint8Array[] {
  if (m.length !== MSIZE) throw new Error('m is not len Msize');
  const out = pads.map((p) => Uint8Array.from(p));
  for (let b = 0; b < MSIZE; b++) out[slot][b] ^= m[b];
  return out;
}

export function xorVectors(vs: Uint8Array[][]): Uint8Array[] {
  const out = vs[0].map(() => new Uint8Array(MSIZE));
  for (const v of vs) v.forEach((x, s) => { for (let b = 0; b < MSIZE; b++) out[s][b] ^= x[b]; });
  return out;
}

// ---- roots of the slot polynomial ----

type Poly = bigint[]; // coefficients, lowest first, over F
const trim = (p: Poly): Poly => { let n = p.length; while (n > 0 && p[n - 1] === 0n) n--; return p.slice(0, n); };
function polyMod(a: Poly, m: Poly): Poly {
  const r = a.slice(); const dm = m.length - 1; const lead = inv(m[dm], F);
  for (let i = r.length - 1; i >= dm; i--) {
    const c = (r[i] * lead) % F;
    if (c === 0n) continue;
    for (let j = 0; j <= dm; j++) r[i - dm + j] = mod(r[i - dm + j] - c * m[j], F);
  }
  return trim(r.slice(0, dm));
}
function polyMulMod(a: Poly, b: Poly, m: Poly): Poly {
  if (!a.length || !b.length) return [];
  const r: bigint[] = new Array(a.length + b.length - 1).fill(0n);
  for (let i = 0; i < a.length; i++) { if (a[i] === 0n) continue; for (let j = 0; j < b.length; j++) r[i + j] += a[i] * b[j]; }
  return polyMod(r.map((x) => x % F), m);
}
function polyPowMod(base: Poly, e: bigint, m: Poly): Poly {
  let r: Poly = [1n]; let b = polyMod(base, m);
  while (e > 0n) { if (e & 1n) r = polyMulMod(r, b, m); b = polyMulMod(b, b, m); e >>= 1n; }
  return r;
}
function polyGcd(a: Poly, b: Poly): Poly {
  a = trim(a); b = trim(b);
  while (b.length) { const r = polyMod(a, b); a = b; b = r; }
  const lead = inv(a[a.length - 1], F);
  return a.map((x) => (x * lead) % F);
}
const polySub = (a: Poly, b: Poly): Poly => trim(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => mod((a[i] ?? 0n) - (b[i] ?? 0n), F)));
function polyDiv(a: Poly, m: Poly): Poly {
  const r = a.slice(); const dm = m.length - 1; const q: bigint[] = new Array(Math.max(0, r.length - dm)).fill(0n); const lead = inv(m[dm], F);
  for (let i = r.length - 1; i >= dm; i--) {
    const c = (r[i] * lead) % F; q[i - dm] = c;
    for (let j = 0; j <= dm; j++) r[i - dm + j] = mod(r[i - dm + j] - c * m[j], F);
  }
  return trim(q);
}

/**
 * Every root in F of a polynomial (lowest coefficient first), sorted, or null unless it has exactly as many
 * distinct roots as its degree: Cantor–Zassenhaus splitting of gcd(x^F - x, a).
 */
export function solveRoots(a: bigint[], random: () => bigint): bigint[] | null {
  const f = trim(a.map((x) => mod(x, F)));
  const deg = f.length - 1;
  if (deg < 1) return null;
  const xp = polyPowMod([0n, 1n], F, f);
  const g = polyGcd(f, polySub(xp, [0n, 1n]));
  if (g.length - 1 !== deg) return null;
  const roots: bigint[] = [];
  const split = (h: Poly): void => {
    const d = h.length - 1;
    if (d === 1) { roots.push(mod(-h[0] * inv(h[1], F), F)); return; }
    for (;;) {
      const delta = random() % F;
      const t = polySub(polyPowMod([delta, 1n], (F - 1n) / 2n, h), [1n]);
      if (!t.length) continue;
      const u = polyGcd(h, t);
      const du = u.length - 1;
      if (du > 0 && du < d) { split(u); split(polyDiv(h, u)); return; }
    }
  };
  split(g);
  if (new Set(roots.map(String)).size !== deg) return null;
  return roots.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

// ---- session ID ----

export function deriveSessionID(prHashes: Uint8Array[], epoch: bigint): Uint8Array {
  const e = Buffer.alloc(8); e.writeBigUInt64BE(epoch);
  return blake256(Buffer.concat([Buffer.from('decred-mix-session'), e, ...prHashes.map((h) => Buffer.from(h))]));
}

const cmp = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const xor32 = (a: Uint8Array, b: Uint8Array) => Uint8Array.from(a, (x, i) => x ^ b[i]);

/** mixing.SortPRsForSession: the session ID from the PRs sorted by hash, then the PRs ordered by hash XOR ID. */
export function sortForSession<T extends { hash: Uint8Array }>(prs: T[], epoch: bigint): { sid: Uint8Array; prs: T[] } {
  const byHash = [...prs].sort((a, b) => cmp(a.hash, b.hash));
  const sid = deriveSessionID(byHash.map((p) => p.hash), epoch);
  const ordered = byHash.map((p) => ({ p, k: xor32(p.hash, sid) })).sort((a, b) => cmp(a.k, b.k)).map((x) => x.p);
  return { sid, prs: ordered };
}

/** mixing.ValidateSession for a KE: its PRs in session order; for run 0, the ID derived from them. */
export function validSession(seenPRs: Uint8Array[], sid: Uint8Array, epoch: bigint, run: number): boolean {
  const keyed = seenPRs.map((h) => xor32(h, sid));
  for (let i = 1; i < keyed.length; i++) if (cmp(keyed[i - 1], keyed[i]) > 0) return false;
  if (run === 0) {
    const sorted = [...seenPRs].sort(cmp);
    if (cmp(deriveSessionID(sorted, epoch), sid) !== 0) return false;
  }
  return true;
}
