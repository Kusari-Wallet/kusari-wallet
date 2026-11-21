// ElligatorSwift (BIP324): a secp256k1 public key as 64 bytes that look random. Payjoin (BIP77) puts its message
// keys in this form, so the directory can't tell keys from ciphertext. Written from the BIP324 specification; the
// y coordinate follows its parity convention (an odd t means an odd y).
import { randomBytes } from 'node:crypto';

const P = 2n ** 256n - 2n ** 32n - 977n;
const C = 0xa2d2ba93507f1df233770c2a797962cc61f6d15da14ecd47d8d27ae1cd5f852n; // a square root of -3

const mod = (a: bigint): bigint => { const r = a % P; return r < 0n ? r + P : r; };
function pow(b: bigint, e: bigint): bigint {
  let r = 1n; b = mod(b);
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
}
const inv = (a: bigint): bigint => pow(a, P - 2n);
/** "The" square root of BIP324: a^((p+1)/4), when it is one. */
function sqrt(a: bigint): bigint | null { const r = pow(a, (P + 1n) / 4n); return (r * r) % P === mod(a) ? r : null; }
const onCurve = (x: bigint): boolean => sqrt(mod(x * x * x + 7n)) !== null;

const toInt = (b: Uint8Array): bigint => BigInt('0x' + (Buffer.from(b).toString('hex') || '0'));
const toBytes = (n: bigint): Uint8Array => Uint8Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));

/** XSwiftEC: any (u, t) to an x coordinate on the curve. */
export function xswiftec(u: bigint, t: bigint): bigint {
  u = mod(u); t = mod(t);
  if (u === 0n) u = 1n;
  if (t === 0n) t = 1n;
  if (mod(u * u * u + t * t + 7n) === 0n) t = mod(2n * t);
  const X = mod((u * u * u + 7n - t * t) * inv(2n * t));
  const Y = mod((X + t) * inv(C * u));
  for (const x of [mod(u + 4n * Y * Y), mod((mod(-X * inv(Y)) - u) * inv(2n)), mod((mod(X * inv(Y)) - u) * inv(2n))]) {
    if (onCurve(x)) return x;
  }
  throw new Error('XSwiftEC found no point.'); // never: one of the three always is
}

/** XSwiftECInv: a t with XSwiftEC(u, t) = x for this case (0..7), or null. */
export function xswiftecInv(x: bigint, u: bigint, c: number): bigint | null {
  x = mod(x); u = mod(u);
  let v: bigint; let s: bigint;
  if ((c & 2) === 0) {
    if (onCurve(mod(-x - u))) return null;
    v = x;
    s = mod(-(u * u * u + 7n) * inv(mod(u * u + u * v + v * v)));
  } else {
    s = mod(x - u);
    if (s === 0n) return null;
    const r = sqrt(mod(-s * (4n * (u * u * u + 7n) + 3n * u * u * s)));
    if (r === null) return null;
    if ((c & 1) === 1 && r === 0n) return null;
    v = mod((mod(r * inv(s)) - u) * inv(2n));
  }
  const w = sqrt(s);
  if (w === null) return null;
  switch (c & 5) {
    case 0: return mod(-w * (mod(u * (1n - C) * inv(2n)) + v));
    case 1: return mod(w * (mod(u * (1n + C) * inv(2n)) + v));
    case 4: return mod(w * (mod(u * (1n - C) * inv(2n)) + v));
    default: return mod(-w * (mod(u * (1n + C) * inv(2n)) + v));
  }
}

/** The point an encoding stands for, as a 65-byte uncompressed key. */
export function ellswiftDecode(enc: Uint8Array): Uint8Array {
  if (enc.length !== 64) throw new Error('An ElligatorSwift key is 64 bytes.');
  const u = toInt(enc.subarray(0, 32)); const t = mod(toInt(enc.subarray(32)));
  const x = xswiftec(u, t);
  let y = sqrt(mod(x * x * x + 7n))!;
  if ((y & 1n) !== (t & 1n)) y = P - y;
  return Uint8Array.from([4, ...toBytes(x), ...toBytes(y)]);
}

/** A random-looking encoding of a 65-byte uncompressed (or 33-byte compressed) public key. */
export function ellswiftEncode(pub: Uint8Array, random: (n: number) => Uint8Array = (n) => randomBytes(n)): Uint8Array {
  let x: bigint; let odd: boolean;
  if (pub.length === 65 && pub[0] === 4) { x = toInt(pub.subarray(1, 33)); odd = (pub[64] & 1) === 1; }
  else if (pub.length === 33 && (pub[0] === 2 || pub[0] === 3)) { x = toInt(pub.subarray(1)); odd = pub[0] === 3; }
  else throw new Error('Not a public key.');
  for (;;) {
    const r = random(33);
    const u = toInt(r.subarray(0, 32));
    if (u === 0n || u >= P) continue;
    let t = xswiftecInv(x, u, r[32] & 7);
    if (t === null) continue;
    if (((t & 1n) === 1n) !== odd) t = P - t;
    return Uint8Array.from([...toBytes(u), ...toBytes(t)]);
  }
}
