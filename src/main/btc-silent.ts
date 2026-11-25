// Silent Payments (BIP352, sp1...). The address holds two public keys; the sender combines them with the private keys
// of the coins it spends, so each payment lands on a taproot address nobody else can tie to the published sp1
// address. Sending runs at signing time. Receiving: each block's "tweaks" (input hash times summed input keys, one
// per eligible transaction) come from an index server; this wallet's scan key turns each into the output it would
// be, and the block filter says whether any of them is in the block.
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

// ---- Receiving ----

/** BIP352's paths: the scan key, which only finds payments, and the spend key, which spends them. */
export const SP_SCAN_PATH = "m/352'/0'/0'/1'/0";
export const SP_SPEND_PATH = "m/352'/0'/0'/0'/0";

/** sp1q... for these two compressed public keys. */
export function encodeSilentAddress(scan: Uint8Array, spend: Uint8Array, testnet = false): string {
  if (scan.length !== 33 || spend.length !== 33) throw new Error('bad key');
  return bech32m.encode(testnet ? 'tsp' : 'sp', [0, ...bech32m.toWords(Uint8Array.from([...scan, ...spend]))], 1023);
}

export interface SpCandidate {
  /** The shared secret (33 bytes), kept to look for the next output (k + 1) in the same transaction. */
  shared: Uint8Array;
  k: number;
  /** t_k: what's added to the spend key to spend this output. */
  tweak: Uint8Array;
  /** The x-only output key and its script. */
  xonly: Uint8Array;
  script: Uint8Array;
}

/** The output for shared secret `shared` and counter k: P_k = B_spend + t_k·G. */
export function spOutput(shared: Uint8Array, k: number, spendPub: Uint8Array): SpCandidate {
  const kb = Buffer.alloc(4); kb.writeUInt32BE(k);
  const t = toBig(tagged('BIP0352/SharedSecret', shared, kb));
  if (t === 0n || t >= N) throw new Error('bad shared secret');
  const xonly = Point.fromHex(hex(spendPub)).add(Point.BASE.multiply(t)).toBytes(true).slice(1);
  return { shared, k, tweak: fromBig(t), xonly, script: taprootScript(xonly) };
}

/** The shared secret for one tweak (33-byte point from the index server): tweak · b_scan. */
export function spShared(tweak: Uint8Array, scanKey: Uint8Array): Uint8Array {
  return Point.fromHex(hex(tweak)).multiply(toBig(scanKey) % N).toBytes(true);
}

/**
 * The k = 0 output of every tweak, in slices that let other work run between them (each takes a few milliseconds).
 * A tweak that isn't a valid point is skipped: a server could send anything.
 */
export async function spCandidates(tweaks: Uint8Array[], scanKey: Uint8Array, spendPub: Uint8Array): Promise<SpCandidate[]> {
  const out: SpCandidate[] = [];
  for (let i = 0; i < tweaks.length; i++) {
    try { out.push(spOutput(spShared(tweaks[i], scanKey), 0, spendPub)); } catch { /* not a point */ }
    if (i % 16 === 15) await new Promise((r) => setImmediate(r));
  }
  return out;
}

/**
 * Of a transaction's taproot outputs (x-only keys), those paid to this wallet, starting from a k = 0 match:
 * BIP352 numbers a sender's outputs to one recipient k = 0, 1, 2, ..., in any order among the outputs.
 */
export function spMatchTx(first: SpCandidate, outputs: Uint8Array[], spendPub: Uint8Array): { vout: number; c: SpCandidate }[] {
  const keys = outputs.map((o) => hex(o));
  const found: { vout: number; c: SpCandidate }[] = [];
  let c = first;
  for (;;) {
    const vout = keys.indexOf(hex(c.xonly));
    if (vout < 0) break;
    found.push({ vout, c });
    if (c.k + 1 >= K_MAX) break;
    c = spOutput(c.shared, c.k + 1, spendPub);
  }
  return found;
}

/** The x-only key of a received output from its tweak: B_spend + t·G. */
export function spOutputKey(spendPub: Uint8Array, tweak: Uint8Array): Uint8Array {
  return Point.fromHex(hex(spendPub)).add(Point.BASE.multiply(toBig(tweak))).toBytes(true).slice(1);
}

/** The private key of a received output: b_spend + t_k (made even by the signer, as BIP340 does). */
export function spPrivateKey(spendKey: Uint8Array, tweak: Uint8Array): Uint8Array {
  const d = (toBig(spendKey) + toBig(tweak)) % N;
  if (d === 0n) throw new Error('bad key');
  return fromBig(d);
}
