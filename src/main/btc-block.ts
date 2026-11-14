// Reading Bitcoin blocks and headers as they come from a peer: enough to check proof of work, follow the chain,
// and find a wallet's coins in a block it fetched.
const { sha256 } = require('@noble/hashes/sha2.js');

export const dsha = (b: Uint8Array): Uint8Array => sha256(sha256(b));
/** A hash in its travelling order, written the way explorers show it. */
export const hexLE = (b: Uint8Array): string => Buffer.from(b).reverse().toString('hex');
export const fromHexLE = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex').reverse());

export interface BlockHeader { version: number; prev: Uint8Array; merkle: Uint8Array; time: number; bits: number; nonce: number; hash: Uint8Array }

export function readHeader(b: Uint8Array, at = 0): BlockHeader {
  if (b.length < at + 80) throw new Error('A Bitcoin block header was too short.');
  const raw = b.subarray(at, at + 80);
  const v = Buffer.from(raw);
  return { version: v.readInt32LE(0), prev: raw.slice(4, 36), merkle: raw.slice(36, 68), time: v.readUInt32LE(68), bits: v.readUInt32LE(72), nonce: v.readUInt32LE(76), hash: dsha(raw) };
}

/** The target a header's `bits` stands for. */
export function bitsToTarget(bits: number): bigint {
  const exp = bits >>> 24;
  const mant = BigInt(bits & 0x007fffff);
  if (bits & 0x00800000) return 0n; // negative: never valid
  return exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
}

export function targetToBits(target: bigint): number {
  let size = 0; for (let t = target; t > 0n; t >>= 8n) size++;
  let mant = size <= 3 ? Number(target << BigInt(8 * (3 - size))) : Number(target >> BigInt(8 * (size - 3)));
  if (mant & 0x00800000) { mant >>= 8; size++; }
  return ((size << 24) | mant) >>> 0;
}

export const hashValue = (hashLE: Uint8Array): bigint => BigInt('0x' + hexLE(hashLE));
/** Work a header proves: how many hashes it takes on average to meet its target. */
export const headerWork = (bits: number): bigint => { const t = bitsToTarget(bits); return t > 0n ? (1n << 256n) / (t + 1n) : 0n; };

export const POW_LIMIT = 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
export const RETARGET = 2016;
const TIMESPAN = 14 * 24 * 60 * 60;

/** The next period's target from the last one's (Bitcoin's rule, including its off-by-one). */
export function nextTarget(lastBits: number, firstTime: number, lastTime: number): number {
  let span = lastTime - firstTime;
  span = Math.min(Math.max(span, TIMESPAN / 4), TIMESPAN * 4);
  let t = (bitsToTarget(lastBits) * BigInt(span)) / BigInt(TIMESPAN);
  if (t > POW_LIMIT) t = POW_LIMIT;
  return targetToBits(t);
}

// ---- transactions ----

export interface TxOutput { value: bigint; script: Uint8Array }
export interface TxInput { prevTxid: string; prevVout: number }
export interface ParsedTx { txid: string; inputs: TxInput[]; outputs: TxOutput[]; coinbase: boolean }

class Cursor {
  constructor(readonly b: Uint8Array, public at = 0) {}
  need(n: number): void { if (n < 0 || this.at + n > this.b.length) throw new Error('A Bitcoin block was shorter than it said.'); }
  bytes(n: number): Uint8Array { this.need(n); const v = this.b.subarray(this.at, this.at + n); this.at += n; return v; }
  u8(): number { this.need(1); return this.b[this.at++]; }
  u32(): number { const v = Buffer.from(this.bytes(4)).readUInt32LE(0); return v; }
  u64(): bigint { return Buffer.from(this.bytes(8)).readBigUInt64LE(0); }
  varint(): number {
    const c = this.u8();
    if (c < 0xfd) return c;
    if (c === 0xfd) return Buffer.from(this.bytes(2)).readUInt16LE(0);
    if (c === 0xfe) return this.u32();
    const v = this.u64();
    if (v > 0xffffffffn) throw new Error('A Bitcoin block gave a size that is too large.');
    return Number(v);
  }
  count(min: number): number { const n = this.varint(); if (n * min > this.b.length - this.at) throw new Error('A Bitcoin block gave a count that is too large.'); return n; }
}

function readTx(c: Cursor): ParsedTx {
  const start = c.at;
  c.bytes(4);
  let segwit = false;
  if (c.b[c.at] === 0 && c.b[c.at + 1] === 1) { segwit = true; c.at += 2; }
  const insStart = c.at;
  const inputs: TxInput[] = [];
  let coinbase = false;
  for (let n = c.count(41); n > 0; n--) {
    const prev = c.bytes(32);
    const vout = c.u32();
    c.bytes(c.varint());
    c.bytes(4);
    if (prev.every((x) => x === 0) && vout === 0xffffffff) coinbase = true;
    inputs.push({ prevTxid: hexLE(prev), prevVout: vout });
  }
  const outputs: TxOutput[] = [];
  for (let n = c.count(9); n > 0; n--) outputs.push({ value: c.u64(), script: Uint8Array.from(c.bytes(c.varint())) });
  const insEnd = c.at;
  if (segwit) for (let i = 0; i < inputs.length; i++) for (let k = c.varint(); k > 0; k--) c.bytes(c.varint());
  const lock = c.bytes(4);
  // The ID leaves out the marker, flag and witnesses.
  const plain = new Uint8Array(4 + (insEnd - insStart) + 4);
  plain.set(c.b.subarray(start, start + 4), 0);
  plain.set(c.b.subarray(insStart, insEnd), 4);
  plain.set(lock, 4 + (insEnd - insStart));
  return { txid: hexLE(dsha(plain)), inputs: coinbase ? [] : inputs, outputs, coinbase };
}

/** One raw transaction on its own. */
export function parseTx(raw: Uint8Array): ParsedTx {
  const c = new Cursor(raw, 0);
  const t = readTx(c);
  if (c.at !== raw.length) throw new Error('A Bitcoin transaction had extra bytes.');
  return t;
}

export function parseBlock(raw: Uint8Array): { header: BlockHeader; txs: ParsedTx[] } {
  const header = readHeader(raw, 0);
  const c = new Cursor(raw, 80);
  const txs: ParsedTx[] = [];
  for (let n = c.count(60); n > 0; n--) txs.push(readTx(c));
  if (c.at !== raw.length) throw new Error('A Bitcoin block had extra bytes.');
  // The transactions must be the ones the header commits to.
  let level = txs.map((t) => fromHexLE(t.txid));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]; const b = level[i + 1] ?? level[i];
      const both = new Uint8Array(64); both.set(a, 0); both.set(b, 32);
      next.push(dsha(both));
    }
    level = next;
  }
  if (!level.length || Buffer.compare(Buffer.from(level[0]), Buffer.from(header.merkle)) !== 0) throw new Error('A Bitcoin block did not match its header.');
  return { header, txs };
}

/**
 * A transaction of a coin without witnesses (Dogecoin, Dash, Firo): its ID is the hash of all of it, and anything
 * after the outputs (lock time, or a Dash/Firo special payload) isn't needed to read what an output holds.
 */
export function legacyTx(raw: Uint8Array): { txid: string; outputs: TxOutput[] } {
  const c = new Cursor(raw, 0);
  c.bytes(4);
  if (c.b[c.at] === 0) throw new Error('A transaction came in a form this coin does not use.');
  for (let n = c.count(41); n > 0; n--) { c.bytes(36); c.bytes(c.varint()); c.bytes(4); }
  const outputs: TxOutput[] = [];
  for (let n = c.count(9); n > 0; n--) outputs.push({ value: c.u64(), script: Uint8Array.from(c.bytes(c.varint())) });
  c.bytes(4);
  return { txid: hexLE(dsha(raw)), outputs };
}
