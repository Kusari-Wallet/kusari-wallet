// BIP158 compact block filters: a block's output scripts and the scripts its inputs spend, hashed into a
// Golomb-coded set. The wallet checks its own scripts against the filter here, on the device, so no server learns
// which addresses are this wallet's. Only blocks that match are fetched.
const { sha256 } = require('@noble/hashes/sha2.js');

export const FILTER_P = 19;
export const FILTER_M = 784931n;
const MASK64 = (1n << 64n) - 1n;

const rotl = (x: bigint, b: bigint): bigint => ((x << b) | (x >> (64n - b))) & MASK64;

/** SipHash-2-4 of `data` under the 128-bit key (k0, k1). */
export function siphash(k0: bigint, k1: bigint, data: Uint8Array): bigint {
  let v0 = 0x736f6d6570736575n ^ k0;
  let v1 = 0x646f72616e646f6dn ^ k1;
  let v2 = 0x6c7967656e657261n ^ k0;
  let v3 = 0x7465646279746573n ^ k1;
  const round = (): void => {
    v0 = (v0 + v1) & MASK64; v1 = rotl(v1, 13n); v1 ^= v0; v0 = rotl(v0, 32n);
    v2 = (v2 + v3) & MASK64; v3 = rotl(v3, 16n); v3 ^= v2;
    v0 = (v0 + v3) & MASK64; v3 = rotl(v3, 21n); v3 ^= v0;
    v2 = (v2 + v1) & MASK64; v1 = rotl(v1, 17n); v1 ^= v2; v2 = rotl(v2, 32n);
  };
  const len = data.length;
  const whole = len - (len % 8);
  for (let i = 0; i < whole; i += 8) {
    let m = 0n;
    for (let j = 7; j >= 0; j--) m = (m << 8n) | BigInt(data[i + j]);
    v3 ^= m; round(); round(); v0 ^= m;
  }
  let last = BigInt(len & 0xff) << 56n;
  for (let j = len - 1; j >= whole; j--) last |= BigInt(data[j]) << BigInt((j - whole) * 8);
  v3 ^= last; round(); round(); v0 ^= last;
  v2 ^= 0xffn;
  round(); round(); round(); round();
  return (v0 ^ v1 ^ v2 ^ v3) & MASK64;
}

/** The filter's key: the first 16 bytes of the block hash, in the order the hash travels. */
export function filterKey(blockHashLE: Uint8Array): [bigint, bigint] {
  const le = (o: number): bigint => { let v = 0n; for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(blockHashLE[o + j]); return v; };
  return [le(0), le(8)];
}

const hashToRange = (k: [bigint, bigint], item: Uint8Array, f: bigint): bigint => (siphash(k[0], k[1], item) * f) >> 64n;

function readVarint(b: Uint8Array, at: number): [number, number] {
  const c = b[at];
  if (c < 0xfd) return [c, 1];
  if (c === 0xfd) return [b[at + 1] | (b[at + 2] << 8), 3];
  if (c === 0xfe) return [(b[at + 1] | (b[at + 2] << 8) | (b[at + 3] << 16)) + b[at + 4] * 2 ** 24, 5];
  throw new Error('A block filter gave a size that is too large.');
}

/** The sorted values a filter holds. */
export function decodeFilter(filter: Uint8Array): { n: number; values: bigint[] } {
  if (!filter.length) return { n: 0, values: [] };
  const [n, off] = readVarint(filter, 0);
  if (n > 1_000_000) throw new Error('A block filter is too large.');
  const values: bigint[] = new Array(n);
  let bit = off * 8;
  const total = filter.length * 8;
  const readBit = (): number => {
    if (bit >= total) throw new Error('A block filter ended early.');
    const v = (filter[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit++;
    return v;
  };
  let acc = 0n;
  for (let i = 0; i < n; i++) {
    let q = 0;
    while (readBit() === 1) { q++; if (q > 1 << 20) throw new Error('A block filter is damaged.'); }
    let r = 0;
    for (let j = 0; j < FILTER_P; j++) r = r * 2 + readBit();
    acc += (BigInt(q) << BigInt(FILTER_P)) + BigInt(r);
    values[i] = acc;
  }
  return { n, values };
}

/** Whether any of `items` may be in the block (false positives about 1 in 784931 per item). */
export function filterMatchesAny(filter: Uint8Array, blockHashLE: Uint8Array, items: Uint8Array[]): boolean {
  if (!items.length || !filter.length) return false;
  const [n, off] = readVarint(filter, 0);
  if (!n) return false;
  if (n > 1_000_000) throw new Error('A block filter is too large.');
  const key = filterKey(blockHashLE);
  const f = BigInt(n) * FILTER_M;
  // Values stay below n * M (< 2^53), so plain numbers hold them exactly, and the filter is read only as far as needed.
  const wanted = items.map((i) => Number(hashToRange(key, i, f))).sort((a, b) => a - b);
  let bit = off * 8;
  const total = filter.length * 8;
  let acc = 0;
  let w = 0;
  for (let k = 0; k < n && w < wanted.length; k++) {
    let q = 0;
    for (;;) {
      if (bit >= total) throw new Error('A block filter ended early.');
      const b = (filter[bit >> 3] >> (7 - (bit & 7))) & 1; bit++;
      if (!b) break;
      if (++q > 1 << 20) throw new Error('A block filter is damaged.');
    }
    if (bit + FILTER_P > total) throw new Error('A block filter ended early.');
    let r = 0;
    for (let j = 0; j < FILTER_P; j++) { r = r * 2 + ((filter[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; }
    acc += q * 2 ** FILTER_P + r;
    while (w < wanted.length && wanted[w] < acc) w++;
    if (w < wanted.length && wanted[w] === acc) return true;
  }
  return false;
}

/** Builds a basic filter from its items: used by tests, and to check the coding against Bitcoin Core's vectors. */
export function buildFilter(blockHashLE: Uint8Array, items: Uint8Array[]): Uint8Array {
  const unique = [...new Map(items.filter((i) => i.length).map((i) => [Buffer.from(i).toString('hex'), i])).values()];
  const n = unique.length;
  const head: number[] = n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 0xff, n >> 8] : [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  if (!n) return Uint8Array.from([0]);
  const key = filterKey(blockHashLE);
  const f = BigInt(n) * FILTER_M;
  const values = unique.map((i) => hashToRange(key, i, f)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const bits: number[] = [];
  let last = 0n;
  for (const v of values) {
    const d = v - last; last = v;
    const q = Number(d >> BigInt(FILTER_P));
    for (let i = 0; i < q; i++) bits.push(1);
    bits.push(0);
    for (let j = FILTER_P - 1; j >= 0; j--) bits.push(Number((d >> BigInt(j)) & 1n));
  }
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return Uint8Array.from([...head, ...out]);
}

const dsha = (b: Uint8Array): Uint8Array => sha256(sha256(b));

/** A filter's header: commits to the filter and to the header before it, so one checked header vouches for all. */
export function filterHeader(filter: Uint8Array, prevHeaderLE: Uint8Array): Uint8Array {
  const h = dsha(filter);
  const both = new Uint8Array(64);
  both.set(h, 0); both.set(prevHeaderLE, 32);
  return dsha(both);
}

export const filterHash = (filter: Uint8Array): Uint8Array => dsha(filter);
