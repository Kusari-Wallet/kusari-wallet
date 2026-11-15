// Decred (DCR): P2PKH coins from the 12 words (BIP44 m/44'/42'/0', as multi-coin wallets derive it), served by
// dcrdata's Insight API. Decred differs from Bitcoin in its hashes (BLAKE-256 everywhere), its address checksum, and
// its transaction format: a prefix (inputs without scripts, outputs with a script version, lock time, expiry) and a
// witness (each input's amount, block height and index, and signature script). The signature hash and serialization
// follow dcrd's txscript and wire packages; tests pin them to dcrd's own address vectors.
import { bip39Seed } from './seed';
import type { Agent } from 'node:http';
import { InsightDraft, InsightWallet } from './insight';

const { HDKey } = require('@scure/bip32');
const { blake256 } = require('@noble/hashes/blake1.js');
const { ripemd160 } = require('@noble/hashes/legacy.js');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { base58 } = require('@scure/base');

export const DCR_PATH = "m/44'/42'/0'";
export const DCR_API = 'https://dcrdata.decred.org/insight/api';
export const DCR_EXPLORER_TX = 'https://dcrdata.decred.org/tx/';
/** "Ds" and "Dc": pay-to-pubkey-hash (secp256k1) and pay-to-script-hash on mainnet. */
const P2PKH = [0x07, 0x3f];
const P2SH = [0x07, 0x1a];
/** dcrd's default relay fee, 0.0001 DCR per kB. */
const FEE_ATOMS_PER_BYTE = 10n;
/** dcrd's dust limit for a P2PKH output at that fee. */
const DUST = 6_030n;
/** Version, the two counts, lock time, expiry and the witness count. */
const SIZE_BASE = 15n;
/** Outpoint, tree and sequence; amount, height, index and a signature script of a signature and a key. */
const SIZE_INPUT = 165n;
/** Amount, script version and a P2PKH script. */
const SIZE_OUTPUT = 36n;
const TX_VERSION = 1;
const SIG_HASH_ALL = 1;

export type DcrDraft = InsightDraft;

const hash160 = (b: Uint8Array): Uint8Array => ripemd160(blake256(b));
const checksum = (b: Uint8Array): Uint8Array => blake256(blake256(b)).slice(0, 4);

export function dcrAccountXpub(mnemonic: string): string {
  return HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(DCR_PATH).publicExtendedKey;
}

export function dcrAddressOf(publicKey: Uint8Array): string {
  const payload = Uint8Array.from([...P2PKH, ...hash160(publicKey)]);
  return base58.encode(Uint8Array.from([...payload, ...checksum(payload)]));
}

/** The kind and hash of a mainnet address, or null for anything else (a bad checksum included). */
function decode(address: string): { kind: 'pkh' | 'sh'; hash: Uint8Array } | null {
  if (!/^D[sc][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return null;
  let b: Uint8Array;
  try { b = base58.decode(address); } catch { return null; }
  if (b.length !== 26) return null;
  const payload = b.slice(0, 22);
  if (Buffer.compare(Buffer.from(checksum(payload)), Buffer.from(b.slice(22))) !== 0) return null;
  const kind = payload[0] === P2PKH[0] && payload[1] === P2PKH[1] ? 'pkh' : payload[0] === P2SH[0] && payload[1] === P2SH[1] ? 'sh' : null;
  return kind ? { kind, hash: payload.slice(2) } : null;
}

export const isDcrAddress = (address: string): boolean => decode(address.trim()) !== null;

/** The output script (version 0) an address is paid with. */
export function dcrScript(address: string): Uint8Array {
  const d = decode(address);
  if (!d) throw new Error('Not a Decred address.');
  return d.kind === 'pkh' ? Uint8Array.from([0x76, 0xa9, 0x14, ...d.hash, 0x88, 0xac]) : Uint8Array.from([0xa9, 0x14, ...d.hash, 0x87]);
}

export const typicalDcrFee = (): bigint => (SIZE_BASE + SIZE_INPUT + SIZE_OUTPUT * 2n) * FEE_ATOMS_PER_BYTE;

export class DcrClient extends InsightWallet<'DCR'> {
  private readonly account: any;
  // No coin check against raw transactions (`script` left out): Decred's consensus rejects an input whose stated
  // amount differs from the coin's, so a server that misreports a coin only makes the send fail.
  constructor(xpub: string, apis: string[], agent?: Agent, timeoutMs = 30_000) {
    super({ symbol: 'DCR', dust: DUST, feePerByte: FEE_ATOMS_PER_BYTE, base: SIZE_BASE, input: SIZE_INPUT, output: SIZE_OUTPUT, sign: signDcrDraft }, apis, agent, timeoutMs);
    this.account = HDKey.fromExtendedKey(xpub);
  }
  addressAt(chain: number, index: number): string {
    return dcrAddressOf(this.account.deriveChild(chain).deriveChild(index).publicKey);
  }
}

// ---- transactions ----

class Writer {
  private parts: Uint8Array[] = [];
  bytes(b: Uint8Array): this { this.parts.push(Uint8Array.from(b)); return this; }
  u8(v: number): this { return this.bytes(Uint8Array.of(v & 0xff)); }
  u16(v: number): this { const b = Buffer.alloc(2); b.writeUInt16LE(v); return this.bytes(b); }
  u32(v: number): this { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return this.bytes(b); }
  i64(v: bigint): this { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return this.bytes(b); }
  varint(n: number): this {
    if (n < 0xfd) return this.u8(n);
    if (n <= 0xffff) return this.u8(0xfd).u16(n);
    return this.u8(0xfe).u32(n);
  }
  varBytes(b: Uint8Array): this { return this.varint(b.length).bytes(b); }
  done(): Uint8Array { return Uint8Array.from(Buffer.concat(this.parts)); }
}

export interface DcrTxIn { txid: string; vout: number; tree: number; sequence: number; value: bigint; blockHeight: number; blockIndex: number; sigScript: Uint8Array }
export interface DcrTxOut { value: bigint; version: number; script: Uint8Array }
export interface DcrTx { version: number; inputs: DcrTxIn[]; outputs: DcrTxOut[]; lockTime: number; expiry: number }

/** The txid's bytes as they travel (reversed from how explorers show it). */
const outpointHash = (txid: string): Uint8Array => Uint8Array.from(Buffer.from(txid, 'hex').reverse());

function writePrefix(w: Writer, tx: DcrTx): Writer {
  w.varint(tx.inputs.length);
  for (const i of tx.inputs) w.bytes(outpointHash(i.txid)).u32(i.vout).u8(i.tree).u32(i.sequence);
  w.varint(tx.outputs.length);
  for (const o of tx.outputs) w.i64(o.value).u16(o.version).varBytes(o.script);
  return w.u32(tx.lockTime).u32(tx.expiry);
}

/** The full transaction as it is broadcast: version and serialization type 0, prefix, witness. */
export function serializeDcrTx(tx: DcrTx): Uint8Array {
  const w = writePrefix(new Writer().u32(tx.version), tx);
  w.varint(tx.inputs.length);
  for (const i of tx.inputs) w.i64(i.value).u32(i.blockHeight).u32(i.blockIndex).varBytes(i.sigScript);
  return w.done();
}

/** The transaction ID: BLAKE-256 of the prefix (serialization type 1), shown reversed. */
export function dcrTxid(tx: DcrTx): string {
  const prefix = writePrefix(new Writer().u32(tx.version | (1 << 16)), tx).done();
  return Buffer.from(blake256(prefix)).reverse().toString('hex');
}

/**
 * What a SigHashAll signature of input `index` signs: BLAKE-256 of the hash type, the prefix hash and the witness
 * hash, where the witness carries only the signed input's script (dcrd txscript CalcSignatureHash).
 */
export function dcrSignatureHash(tx: DcrTx, index: number, subScript: Uint8Array): Uint8Array {
  const prefixHash = blake256(writePrefix(new Writer().u32(tx.version | (1 << 16)), tx).done());
  const w = new Writer().u32(tx.version | (3 << 16)).varint(tx.inputs.length);
  tx.inputs.forEach((_, i) => (i === index ? w.varBytes(subScript) : w.varint(0)));
  const witnessHash = blake256(w.done());
  return blake256(new Writer().u32(SIG_HASH_ALL).bytes(prefixHash).bytes(witnessHash).done());
}

/** A low-S DER signature with the hash type, and the compressed key: the script that spends a P2PKH coin. */
function p2pkhSigScript(hash: Uint8Array, privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const der: Uint8Array = secp256k1.sign(hash, privateKey, { prehash: false, lowS: true, format: 'der' });
  const sig = Uint8Array.from([...der, SIG_HASH_ALL]);
  return Uint8Array.from([sig.length, ...sig, publicKey.length, ...publicKey]);
}

export function verifyDcrInput(tx: DcrTx, index: number, subScript: Uint8Array, publicKey: Uint8Array): boolean {
  const s = tx.inputs[index].sigScript;
  const sig = s.slice(1, 1 + s[0] - 1);
  try { return secp256k1.verify(sig, dcrSignatureHash(tx, index, subScript), publicKey, { prehash: false, lowS: true, format: 'der' }); } catch { return false; }
}

/** A payment with change from this wallet's coins, every input and the change checked against its keys. */
export function signDcrDraft(draft: InsightDraft, mnemonic: string): { hex: string; id: string } {
  if (!isDcrAddress(draft.to)) throw new Error('The receiving address is not a Decred address.');
  const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0n);
  if (totalIn - draft.amount - draft.change !== draft.fee || draft.fee < 0n) throw new Error('The amounts do not add up, so signing was stopped.');
  const account = HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(DCR_PATH);
  const keys: { priv: Uint8Array; pub: Uint8Array; script: Uint8Array }[] = [];
  const tx: DcrTx = { version: TX_VERSION, inputs: [], outputs: [], lockTime: 0, expiry: 0 };
  for (const u of draft.inputs) {
    const child = account.deriveChild(u.chain).deriveChild(u.index);
    if (dcrAddressOf(child.publicKey) !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    // As dcrwallet fills them: the coin's amount, no block height or index.
    tx.inputs.push({ txid: u.txid, vout: u.vout, tree: 0, sequence: 0xffffffff, value: u.value, blockHeight: 0, blockIndex: 0xffffffff, sigScript: new Uint8Array() });
    keys.push({ priv: child.privateKey, pub: child.publicKey, script: dcrScript(u.address) });
  }
  tx.outputs.push({ value: draft.amount, version: 0, script: dcrScript(draft.to) });
  if (draft.change > 0n) {
    const change = account.deriveChild(1).deriveChild(draft.changeIndex);
    if (dcrAddressOf(change.publicKey) !== draft.changeAddress) throw new Error('The change address does not match this wallet\'s keys, so signing was stopped.');
    tx.outputs.push({ value: draft.change, version: 0, script: dcrScript(draft.changeAddress) });
  }
  keys.forEach((k, i) => { tx.inputs[i].sigScript = p2pkhSigScript(dcrSignatureHash(tx, i, k.script), k.priv, k.pub); });
  keys.forEach((k, i) => { if (!verifyDcrInput(tx, i, k.script, k.pub)) throw new Error('A signature did not check out, so this was stopped.'); });
  return { hex: Buffer.from(serializeDcrTx(tx)).toString('hex'), id: dcrTxid(tx) };
}
