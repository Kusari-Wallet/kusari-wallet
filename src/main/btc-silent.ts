// Sending to Silent Payments addresses (BIP352, sp1...). The address holds two public keys; the sender combines
// them with the private keys of the coins it spends, so each payment lands on a taproot address nobody else can
// tie to the published sp1 address. Everything here runs on the device, at signing time.
const { secp256k1, schnorr } = require('@noble/curves/secp256k1.js');
const { bech32m } = require('@scure/base');

const Point = secp256k1.Point;
const N: bigint = Point.Fn.ORDER;
const K_MAX = 2323;

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const toBig = (b: Uint8Array): bigint => BigInt('0x' + (hex(b) || '0'));
const fromBig = (v: bigint): Uint8Array => Uint8Array.from(Buffer.from(v.toString(16).padStart(64, '0'), 'hex'));
const tagged = (tag: string, ...parts: Uint8Array[]): Uint8Array => schnorr.utils.taggedHash(tag, ...parts);

export interface SpAddress { scan: Uint8Array; spend: Uint8Array; testnet: boolean }

export function isSilentAddress(address: string): boolean {
  try { decodeSilentAddress(address); return true; } catch { return false; }
}

/** sp1q... : version 0 carries the 33-byte scan and spend keys; later versions keep them first (BIP352). */
export function decodeSilentAddress(address: string): SpAddress {
  const a = address.trim();
  if (a !== a.toLowerCase() && a !== a.toUpperCase()) throw new Error('Not a Silent Payments address.');
  const { prefix, words } = bech32m.decode(a.toLowerCase(), 1023);
  if (prefix !== 'sp' && prefix !== 'tsp') throw new Error('Not a Silent Payments address.');
  const version = words[0];
  if (version === 31) throw new Error('This Silent Payments address version is not supported.');
  const data = Uint8Array.from(bech32m.fromWords(words.slice(1)));
  if (version === 0 ? data.length !== 66 : data.length < 66) throw new Error('Not a valid Silent Payments address.');
  const scan = data.slice(0, 33); const spend = data.slice(33, 66);
  Point.fromHex(hex(scan)); Point.fromHex(hex(spend)); // both must be keys on the curve
  return { scan, spend, testnet: prefix === 'tsp' };
}

export interface SpendingKey {
  /** The outpoint: txid as explorers show it, and the output index. */
  txid: string; vout: number;
  /** The private key that signs this input: for taproot, the tweaked key of the output. */
  key: Uint8Array;
  taproot: boolean;
}

/** outpoint bytes as they travel: txid reversed, index little-endian. */
function outpointBytes(txid: string, vout: number): Uint8Array {
  const b = Buffer.alloc(36);
  Buffer.from(txid, 'hex').reverse().copy(b, 0);
  b.writeUInt32LE(vout, 32);
  return b;
}

/**
 * The x-only taproot output keys for `recipients` (one per entry, in order, the same address may repeat), given
 * every eligible input of the transaction. `allOutpoints`: every input's outpoint, eligible or not (the smallest one
 * is hashed in). Fails when the input keys cancel out.
 */
export function silentOutputs(inputs: SpendingKey[], recipients: string[], allOutpoints: { txid: string; vout: number }[] = inputs): Uint8Array[] {
  if (!inputs.length) throw new Error('A Silent Payments send needs at least one input of a supported kind.');
  let a = 0n;
  for (const i of inputs) {
    let d = toBig(i.key) % N;
    if (d === 0n) throw new Error('bad input key');
    if (i.taproot && !Point.BASE.multiply(d).hasEvenY()) d = N - d; // BIP340: the even-y key
    a = (a + d) % N;
  }
  if (a === 0n) throw new Error('The input keys of this send cancel out, so it can\'t pay a Silent Payments address. Choose other coins.');
  const A = Point.BASE.multiply(a);
  const smallest = allOutpoints.map((i) => outpointBytes(i.txid, i.vout)).sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)))[0];
  const inputHash = toBig(tagged('BIP0352/Inputs', smallest, A.toBytes(true)));
  if (inputHash === 0n || inputHash >= N) throw new Error('bad input hash');
  // Grouped by scan key, in order of first appearance; k counts within a group.
  const decoded = recipients.map(decodeSilentAddress);
  const groups = new Map<string, number>();
  const out: Uint8Array[] = new Array(recipients.length);
  const shared = new Map<string, Uint8Array>();
  for (let r = 0; r < decoded.length; r++) {
    const g = hex(decoded[r].scan);
    const k = groups.get(g) ?? 0;
    if (k >= K_MAX) throw new Error('Too many payments to one Silent Payments recipient in one send.');
    groups.set(g, k + 1);
    const ecdh: Uint8Array = shared.get(g) ?? Point.fromHex(g).multiply((inputHash * a) % N).toBytes(true);
    shared.set(g, ecdh);
    const kb = Buffer.alloc(4); kb.writeUInt32BE(k);
    const t = toBig(tagged('BIP0352/SharedSecret', ecdh, kb));
    if (t === 0n || t >= N) throw new Error('bad shared secret');
    const P = Point.fromHex(hex(decoded[r].spend)).add(Point.BASE.multiply(t));
    out[r] = P.toBytes(true).slice(1);
  }
  return out;
}

/** The taproot output script for an x-only key: OP_1 <32 bytes>, the key used as it is. */
export const taprootScript = (xonly: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...xonly]);
export { fromBig as scalarBytes };
