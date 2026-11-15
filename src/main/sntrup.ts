// Streamlined NTRU Prime 4591^761 (sntrup4591761), the post-quantum key encapsulation Decred's mixing uses.
// A port of github.com/companyzero/sntrup4591761 (ISC), kept byte for byte: the random stream is read in the same
// order, so keys and ciphertexts made from a seeded stream match the Go code's (other mixing peers re-derive them
// from revealed seeds when assigning blame). Go's 32-bit integer arithmetic, which wraps, is reproduced with
// Math.imul and explicit truncation.

export const PUBLIC_KEY_SIZE = 1218;
export const PRIVATE_KEY_SIZE = 1600;
export const CIPHERTEXT_SIZE = 1047;
const P = 761;
const createHash = (alg: string) => require('node:crypto').createHash(alg);

/** A source of random bytes read in order (a seeded stream, or the system's). */
export type ByteReader = (n: number) => Uint8Array;

const i8 = (a: number) => (a << 24) >> 24;
const i16 = (a: number) => (a << 16) >> 16;
const u32 = (a: number) => a >>> 0;
const umul = (a: number, b: number) => Math.imul(a, b) >>> 0;

// ---- mod 3 ----
function freeze3(a: number): number {
  a = (a - Math.imul(3, Math.imul(10923, a) >> 15)) | 0;
  a = (a - Math.imul(3, (Math.imul(89478485, a) + 134217728) >> 28)) | 0;
  return i8(a);
}
const plusProduct3 = (a: number, b: number, c: number) => freeze3((a + Math.imul(b, c)) | 0);
const minusProduct3 = (a: number, b: number, c: number) => freeze3((a - Math.imul(b, c)) | 0);
const sum3 = (a: number, b: number) => freeze3((a + b) | 0);
const maskSet3 = (x: number) => -x * x;

// ---- mod q ----
function freezeQ(a: number): number {
  a = (a - Math.imul(4591, Math.imul(228, a) >> 20)) | 0;
  a = (a - Math.imul(4591, (Math.imul(58470, a) + 134217728) >> 28)) | 0;
  return i16(a);
}
const productQ = (a: number, b: number) => freezeQ(Math.imul(a, b));
const squareQ = (a: number) => freezeQ(Math.imul(a, a));
function reciprocalQ(a1: number): number {
  const a2 = squareQ(a1); const a3 = productQ(a2, a1); const a4 = squareQ(a2); const a8 = squareQ(a4);
  const a16 = squareQ(a8); const a32 = squareQ(a16); const a35 = productQ(a32, a3); const a70 = squareQ(a35);
  const a140 = squareQ(a70); const a143 = productQ(a140, a3); const a286 = squareQ(a143); const a572 = squareQ(a286);
  const a1144 = squareQ(a572); const a1147 = productQ(a1144, a3); const a2294 = squareQ(a1147); const a4588 = squareQ(a2294);
  return productQ(a4588, a1);
}
const plusProductQ = (a: number, b: number, c: number) => freezeQ((a + Math.imul(b, c)) | 0);
const minusProductQ = (a: number, b: number, c: number) => freezeQ((a - Math.imul(b, c)) | 0);
const sumQ = (a: number, b: number) => freezeQ((a + b) | 0);
function maskSetQ(x: number): number { let r = x & 0xffff; r = -r; return r >> 30; }

const smallerMask = (x: number, y: number) => (x - y) >> 31;

// ---- small polynomials ----
function random32(read: ByteReader): number { const b = read(4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) | 0; }

function randomSmall(read: ByteReader): Int8Array {
  const g = new Int8Array(P);
  for (let i = 0; i < P; i++) { const r = u32(random32(read)); g[i] = i8((umul(1073741823 & r, 3) >>> 30) - 1); }
  return g;
}

/**
 * The Go code's constant-time sorting network. Its comparison is subtle.ConstantTimeLessOrEq, which works on int32
 * and wraps (it is only "defined" for small values), so that exact comparison is kept: the order must match.
 */
function sortU32(x: Int32Array, n: number): void {
  if (n < 2) return;
  const minmax = (i: number, j: number) => {
    const a = x[i] | 0; const b = x[j] | 0;
    if (((((b - a) | 0) - 1) | 0) >> 31 & 1) { x[i] = b; x[j] = a; }
  };
  let top = 1;
  while (top < n - top) top += top;
  for (let p = top; p > 0; p >>= 1) {
    for (let i = 0; i < n - p; i++) if ((i & p) === 0) minmax(i, i + p);
    for (let q = top; q > p; q >>= 1) for (let i = 0; i < n - q; i++) if ((i & p) === 0) minmax(i + p, i + q);
  }
}

function randomTSmall(read: ByteReader): Int8Array {
  const r = new Int32Array(P);
  for (let i = 0; i < P; i++) r[i] = random32(read);
  for (let i = 0; i < 286; i++) r[i] &= -2;
  for (let i = 286; i < P; i++) r[i] = (r[i] & -3) | 1;
  sortU32(r, P);
  const f = new Int8Array(P);
  for (let i = 0; i < P; i++) f[i] = i8((r[i] & 3) - 1);
  return f;
}

function encodeSmall(f: Int8Array): Uint8Array {
  const c = new Uint8Array(191);
  for (let i = 0, j = 0; i < 190; i++, j += 4) c[i] = ((f[j] + 1) + ((f[j + 1] + 1) << 2) + ((f[j + 2] + 1) << 4) + ((f[j + 3] + 1) << 6)) & 0xff;
  c[190] = (f[760] + 1) & 0xff;
  return c;
}

function decodeSmall(c: Uint8Array): Int8Array {
  const f = new Int8Array(P);
  for (let i = 0, j = 0; i < 190; i++, j += 4) {
    let c0 = c[i];
    f[j] = (c0 & 3) - 1; c0 >>= 2; f[j + 1] = (c0 & 3) - 1; c0 >>= 2; f[j + 2] = (c0 & 3) - 1; c0 >>= 2; f[j + 3] = (c0 & 3) - 1;
  }
  f[760] = (c[190] & 3) - 1;
  return f;
}

// ---- R3 ----
/** The reciprocal in R3, and whether there is none (Go returns -1 then). */
function r3Reciprocal(s: Int8Array): { r: Int8Array; none: boolean } {
  const f = new Int8Array(P + 1); f[0] = -1; f[1] = -1; f[P] = 1;
  const g = new Int8Array(P + 1); for (let i = 0; i < P; i++) g[i] = s[i];
  let d = P; let e = P;
  const loops = 2 * P + 1;
  let u = new Int8Array(loops + 1); let v = new Int8Array(loops + 1); v[0] = 1;
  let F = f; let G = g;
  for (let i = 0; i < loops; i++) {
    const c = i8(G[P] * F[P]);
    for (let k = 0; k < P + 1; k++) G[k] = minusProduct3(G[k], F[k], c);
    for (let k = P; k > 0; k--) G[k] = G[k - 1]; G[0] = 0;
    for (let k = 0; k < loops + 1; k++) v[k] = minusProduct3(v[k], u[k], c);
    for (let k = loops; k > 0; k--) v[k] = v[k - 1]; v[0] = 0;
    e--;
    const m = smallerMask(e, d) & maskSet3(G[P]);
    if (m) { [e, d] = [d, e]; [F, G] = [G, F]; [u, v] = [v, u]; }
  }
  const r = new Int8Array(P);
  for (let i = 0; i < P; i++) r[i] = i8(u[P + i] * F[P]);
  return { r, none: smallerMask(0, d) !== 0 };
}

function r3Mult(f: Int8Array, g: Int8Array): Int8Array {
  const fg = new Int8Array(P * 2 - 1);
  for (let i = 0; i < P; i++) { let r = 0; for (let j = 0; j <= i; j++) r = plusProduct3(r, f[j], g[i - j]); fg[i] = r; }
  for (let i = P; i < P * 2 - 1; i++) { let r = 0; for (let j = i - P + 1; j < P; j++) r = plusProduct3(r, f[j], g[i - j]); fg[i] = r; }
  for (let i = P * 2 - 2; i >= P; i--) { fg[i - P] = sum3(fg[i - P], fg[i]); fg[i - P + 1] = sum3(fg[i - P + 1], fg[i]); }
  return fg.slice(0, P);
}

// ---- Rq ----
function rqReciprocal3(s: Int8Array): Int16Array {
  const f = new Int16Array(P + 1); f[0] = -1; f[1] = -1; f[P] = 1;
  const g = new Int16Array(P + 1); for (let i = 0; i < P; i++) g[i] = i16(3 * s[i]);
  let d = P; let e = P;
  const loops = 2 * P + 1;
  let u = new Int16Array(loops + 1); let v = new Int16Array(loops + 1); v[0] = 1;
  let F = f; let G = g;
  for (let i = 0; i < loops; i++) {
    const c = productQ(G[P], reciprocalQ(F[P]));
    for (let k = 0; k < P + 1; k++) G[k] = minusProductQ(G[k], F[k], c);
    for (let k = P; k > 0; k--) G[k] = G[k - 1]; G[0] = 0;
    for (let k = 0; k < loops + 1; k++) v[k] = minusProductQ(v[k], u[k], c);
    for (let k = loops; k > 0; k--) v[k] = v[k - 1]; v[0] = 0;
    e--;
    const m = smallerMask(e, d) & maskSetQ(G[P]);
    if (m) { [e, d] = [d, e]; [F, G] = [G, F]; [u, v] = [v, u]; }
  }
  const r = new Int16Array(P);
  const rec = reciprocalQ(F[P]);
  for (let i = 0; i < P; i++) r[i] = productQ(u[P + i], rec);
  return r;
}

function rqMult(f: Int16Array, g: Int8Array): Int16Array {
  const fg = new Int16Array(P * 2 - 1);
  for (let i = 0; i < P; i++) { let r = 0; for (let j = 0; j <= i; j++) r = plusProductQ(r, f[j], g[i - j]); fg[i] = r; }
  for (let i = P; i < P * 2 - 1; i++) { let r = 0; for (let j = i - P + 1; j < P; j++) r = plusProductQ(r, f[j], g[i - j]); fg[i] = r; }
  for (let i = P * 2 - 2; i >= P; i--) { fg[i - P] = sumQ(fg[i - P], fg[i]); fg[i - P + 1] = sumQ(fg[i - P + 1], fg[i]); }
  return fg.slice(0, P);
}

function round3(f: Int16Array): Int16Array {
  const h = new Int16Array(P);
  for (let i = 0; i < P; i++) h[i] = i16(Math.imul((Math.imul(21846, f[i] + 2295) + 32768) >> 16, 3) - 2295);
  return h;
}

function rqEncode(f: Int16Array): Uint8Array {
  const c = new Uint8Array(PUBLIC_KEY_SIZE);
  for (let i = 0, j = 0, k = 0; i < 152; i++, j += 5, k += 8) {
    let f0 = f[j] + 2295;
    const f1 = Math.imul(f[j + 1] + 2295, 3); const f2 = Math.imul(f[j + 2] + 2295, 9);
    const f3 = Math.imul(f[j + 3] + 2295, 27); const f4 = Math.imul(f[j + 4] + 2295, 81);
    f0 = (f0 + (f1 << 11)) | 0;
    c[k] = f0 & 0xff; f0 >>= 8; c[k + 1] = f0 & 0xff; f0 >>= 8;
    f0 = (f0 + (f2 << 6)) | 0;
    c[k + 2] = f0 & 0xff; f0 >>= 8; c[k + 3] = f0 & 0xff; f0 >>= 8;
    f0 = (f0 + (f3 << 1)) | 0;
    c[k + 4] = f0 & 0xff; f0 >>= 8;
    f0 = (f0 + (f4 << 4)) | 0;
    c[k + 5] = f0 & 0xff; f0 >>= 8; c[k + 6] = f0 & 0xff; f0 >>= 8; c[k + 7] = f0 & 0xff;
  }
  const f0 = f[760] + 2295;
  c[1216] = f0 & 0xff; c[1217] = (f0 >> 8) & 0xff;
  return c;
}

function rqDecode(c: Uint8Array): Int16Array {
  const f = new Int16Array(P);
  const q = 4591; const qs = 2295;
  for (let i = 0, j = 0, k = 0; i < 152; i++, j += 8, k += 5) {
    let c0 = c[j], c1 = c[j + 1], c2 = c[j + 2], c3 = c[j + 3], c4 = c[j + 4], c5 = c[j + 5], c6 = c[j + 6];
    const c7 = c[j + 7];
    c6 = u32(c6 + (c7 << 8));
    const f4 = u32(umul(103564, c6) + umul(405, c5 + 1)) >>> 19;
    c5 = u32(c5 + umul(c6, 256));
    c5 = u32(c5 - (umul(f4, 81) << 4 >>> 0));
    c4 = u32(c4 + umul(c5, 256));
    const f3 = umul(9709, u32(c4 + 2)) >>> 19;
    c4 = u32(c4 - (umul(f3, 27) << 1 >>> 0));
    c3 = u32(c3 + umul(c4, 256));
    const f2 = u32(umul(233017, c3) + umul(910, c2 + 2)) >>> 19;
    c2 = u32(c2 + umul(c3, 256));
    c2 = u32(c2 - (umul(f2, 9) << 6 >>> 0));
    c1 = u32(c1 + umul(c2, 256));
    const f1 = u32(umul(21845, u32(c1 + 2)) + umul(85, c0)) >>> 19;
    c1 = u32(c1 - (umul(f1, 3) << 3 >>> 0));
    c0 = u32(c0 + umul(c1, 256));
    const f0 = c0;
    f[k] = freezeQ(u32(f0 + q - qs) | 0); f[k + 1] = freezeQ(u32(f1 + q - qs) | 0); f[k + 2] = freezeQ(u32(f2 + q - qs) | 0);
    f[k + 3] = freezeQ(u32(f3 + q - qs) | 0); f[k + 4] = freezeQ(u32(f4 + q - qs) | 0);
  }
  const c0 = u32(c[1216] + (c[1217] << 8));
  f[760] = freezeQ(u32(c0 + q - qs) | 0);
  return f;
}

function rqEncodeRounded(f: Int16Array): Uint8Array {
  const c = new Uint8Array(1015);
  for (let i = 0, j = 0, k = 0; i < 253; i++, j += 3, k += 4) {
    let f0 = Math.imul(21846, f[j] + 2295) >> 16;
    let f1 = Math.imul(21846, f[j + 1] + 2295) >> 16;
    let f2 = Math.imul(21846, f[j + 2] + 2295) >> 16;
    f2 = Math.imul(f2, 3);
    f1 = (f1 + (f2 << 9)) | 0;
    f1 = Math.imul(f1, 3);
    f0 = (f0 + (f1 << 9)) | 0;
    c[k] = f0 & 0xff; f0 >>= 8; c[k + 1] = f0 & 0xff; f0 >>= 8; c[k + 2] = f0 & 0xff; f0 >>= 8; c[k + 3] = f0 & 0xff;
  }
  let f0 = Math.imul(21846, f[759] + 2295) >> 16;
  let f1 = Math.imul(21846, f[760] + 2295) >> 16;
  f1 = Math.imul(f1, 3);
  f0 = (f0 + (f1 << 9)) | 0;
  c[1012] = f0 & 0xff; f0 >>= 8; c[1013] = f0 & 0xff; f0 >>= 8; c[1014] = f0 & 0xff;
  return c;
}

function rqDecodeRounded(c: Uint8Array): Int16Array {
  const f = new Int16Array(P);
  const q = 4591; const qs = 2295;
  for (let i = 0, j = 0, k = 0; i < 253; i++, j += 4, k += 3) {
    let c0 = c[j], c1 = c[j + 1], c2 = c[j + 2];
    const c3 = c[j + 3];
    const f2 = u32(umul(14913081, c3) + umul(58254, c2) + umul(228, c1 + 2)) >>> 21;
    c2 = u32(c2 + umul(c3, 256));
    c2 = u32(c2 - (umul(f2, 9) << 2 >>> 0));
    const f1 = u32(umul(89478485, c2) + umul(349525, c1) + umul(1365, c0 + 1)) >>> 21;
    c1 = u32(c1 + umul(c2, 256));
    c1 = u32(c1 - (umul(f1, 3) << 1 >>> 0));
    c0 = u32(c0 + umul(c1, 256));
    const f0 = c0;
    f[k] = freezeQ(u32(umul(f0, 3) + q - qs) | 0); f[k + 1] = freezeQ(u32(umul(f1, 3) + q - qs) | 0); f[k + 2] = freezeQ(u32(umul(f2, 3) + q - qs) | 0);
  }
  let c0 = c[1012], c1 = c[1013];
  const c2 = c[1014];
  const f1 = u32(umul(89478485, c2) + umul(349525, c1) + umul(1365, c0 + 1)) >>> 21;
  c1 = u32(c1 + umul(c2, 256));
  c1 = u32(c1 - (umul(f1, 3) << 1 >>> 0));
  c0 = u32(c0 + umul(c1, 256));
  f[759] = freezeQ(u32(umul(c0, 3) + q - qs) | 0);
  f[760] = freezeQ(u32(umul(f1, 3) + q - qs) | 0);
  return f;
}

// ---- the KEM ----

export function generateKey(read: ByteReader): { publicKey: Uint8Array; privateKey: Uint8Array } {
  let g: Int8Array; let gr: Int8Array;
  for (;;) {
    g = randomSmall(read);
    const rec = r3Reciprocal(g);
    if (!rec.none) { gr = rec.r; break; }
  }
  const f = randomTSmall(read);
  const f3r = rqReciprocal3(f);
  const h = rqMult(f3r, g);
  const pk = rqEncode(h);
  const sk = new Uint8Array(PRIVATE_KEY_SIZE);
  sk.set(encodeSmall(f), 0); sk.set(encodeSmall(gr), 191); sk.set(pk, 382);
  return { publicKey: pk, privateKey: sk };
}

function createCipher(r: Int8Array, pk: Uint8Array): { ciphertext: Uint8Array; sharedKey: Uint8Array } {
  const h = rqDecode(pk);
  const c = round3(rqMult(h, r));
  const s: Buffer = createHash('sha512').update(encodeSmall(r)).digest();
  const ct = new Uint8Array(CIPHERTEXT_SIZE);
  ct.set(s.subarray(0, 32), 0); ct.set(rqEncodeRounded(c), 32);
  return { ciphertext: ct, sharedKey: Uint8Array.from(s.subarray(32)) };
}

export function encapsulate(read: ByteReader, pk: Uint8Array): { ciphertext: Uint8Array; sharedKey: Uint8Array } {
  if (pk.length !== PUBLIC_KEY_SIZE) throw new Error('bad sntrup public key');
  return createCipher(randomTSmall(read), pk);
}

/** The shared key, and whether the ciphertext was valid for this key (the key is returned either way, as in Go). */
export function decapsulate(ct: Uint8Array, sk: Uint8Array): { sharedKey: Uint8Array; ok: boolean } {
  const f = decodeSmall(sk.subarray(0, 191));
  const c = rqDecodeRounded(ct.subarray(32));
  const t = rqMult(c, f);
  const t3 = new Int8Array(P);
  for (let i = 0; i < P; i++) t3[i] = freeze3(freezeQ(Math.imul(3, t[i])));
  const gr = decodeSmall(sk.subarray(191, 382));
  const r = r3Mult(t3, gr);
  let w = 0;
  for (let i = 0; i < P; i++) if (r[i] !== 0) w++;
  let ok = w === 286;
  const h = rqDecode(sk.subarray(382));
  const hr = round3(rqMult(h, r));
  for (let i = 0; i < P; i++) if (hr[i] !== c[i]) ok = false;
  const s: Buffer = createHash('sha512').update(encodeSmall(r)).digest();
  if (Buffer.compare(s.subarray(0, 32), Buffer.from(ct.subarray(0, 32))) !== 0) ok = false;
  return { sharedKey: Uint8Array.from(s.subarray(32)), ok };
}

/** The building blocks, for tests against the Go code's intermediate values. */
export const sntrupInternals = { randomSmall, randomTSmall, r3Reciprocal, r3Mult, rqReciprocal3, rqMult, rqEncode, rqDecode, rqEncodeRounded, rqDecodeRounded, round3, encodeSmall, decodeSmall };
