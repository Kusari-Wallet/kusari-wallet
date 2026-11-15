// Decred (DCR): P2PKH coins from the 12 words (BIP44 m/44'/42'/0', as multi-coin wallets derive it), served by
// dcrdata's Insight API. Decred differs from Bitcoin in its hashes (BLAKE-256 everywhere), its address checksum, and
// its transaction format: a prefix (inputs without scripts, outputs with a script version, lock time, expiry) and a
// witness (each input's amount, block height and index, and signature script). The signature hash and serialization
// follow dcrd's txscript and wire packages; tests pin them to dcrd's own address vectors.
import { bip39Seed } from './seed';
import type { Agent } from 'node:http';
import { InsightDraft, InsightWallet } from './insight';
import { getJson } from './request';
import { randomInt } from 'node:crypto';

const { HDKey } = require('@scure/bip32');
const { blake256 } = require('@noble/hashes/blake1.js');
const { ripemd160 } = require('@noble/hashes/legacy.js');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { base58 } = require('@scure/base');

export const DCR_PATH = "m/44'/42'/0'";
/** Mixed coins (StakeShuffle) live in their own account, never spent together with unmixed ones. */
export const DCR_MIXED_PATH = "m/44'/42'/1'";
export const DCR_API = 'https://dcrdata.decred.org/insight/api';
export const DCR_EXPLORER_TX = 'https://dcrdata.decred.org/tx/';

/** The network parameters this wallet uses, from dcrd's chaincfg. Simnet is for tests against a local dcrd. */
export interface DcrNet {
  name: 'mainnet' | 'simnet';
  /** The first letter of every address ("D" on mainnet). */
  lead: string;
  /** Pay-to-pubkey-hash (secp256k1) and pay-to-script-hash address IDs, and the private key (WIF) ID. */
  pkh: [number, number]; sh: [number, number]; wif: [number, number];
  /** Blocks before a vote's or revocation's outputs can be spent (CoinbaseMaturity). */
  coinbaseMaturity: number;
  ticketMaturity: number; ticketExpiry: number; ticketPoolSize: number; ticketsPerBlock: number;
  /** Blocks per ticket price window (StakeDiffWindowSize). */
  window: number;
  baseSubsidy: bigint; subsidyReductionInterval: number; stakeValidationHeight: number;
}
export const DCR_MAINNET: DcrNet = {
  name: 'mainnet', lead: 'D', pkh: [0x07, 0x3f], sh: [0x07, 0x1a], wif: [0x22, 0xde],
  coinbaseMaturity: 256, ticketMaturity: 256, ticketExpiry: 40960, ticketPoolSize: 8192, ticketsPerBlock: 5, window: 144,
  baseSubsidy: 3_119_582_664n, subsidyReductionInterval: 6144, stakeValidationHeight: 4096,
};
export const DCR_SIMNET: DcrNet = {
  name: 'simnet', lead: 'S', pkh: [0x0e, 0x91], sh: [0x0e, 0x6c], wif: [0x23, 0x07],
  coinbaseMaturity: 16, ticketMaturity: 16, ticketExpiry: 384, ticketPoolSize: 64, ticketsPerBlock: 5, window: 8,
  baseSubsidy: 50_000_000_000n, subsidyReductionInterval: 128, stakeValidationHeight: 144,
};
export let dcrNet: DcrNet = DCR_MAINNET;
/** Only tests and the developer setting for a local simnet change this. */
export function useDcrNetwork(name: 'mainnet' | 'simnet'): void { dcrNet = name === 'simnet' ? DCR_SIMNET : DCR_MAINNET; }
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

export const hash160 = (b: Uint8Array): Uint8Array => ripemd160(blake256(b));
const checksum = (b: Uint8Array): Uint8Array => blake256(blake256(b)).slice(0, 4);

export function dcrAccountXpub(mnemonic: string, path = DCR_PATH): string {
  return HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(path).publicExtendedKey;
}

export function dcrAddressOf(publicKey: Uint8Array): string { return dcrPkhAddress(hash160(publicKey)); }

export function dcrPkhAddress(hash: Uint8Array): string {
  const payload = Uint8Array.from([...dcrNet.pkh, ...hash]);
  return base58.encode(Uint8Array.from([...payload, ...checksum(payload)]));
}

/** The kind and hash of an address on this network, or null for anything else (a bad checksum included). */
export function decodeDcrAddress(address: string): { kind: 'pkh' | 'sh'; hash: Uint8Array } | null {
  if (!new RegExp(`^${dcrNet.lead}[sc][1-9A-HJ-NP-Za-km-z]{33}$`).test(address)) return null;
  let b: Uint8Array;
  try { b = base58.decode(address); } catch { return null; }
  if (b.length !== 26) return null;
  const payload = b.slice(0, 22);
  if (Buffer.compare(Buffer.from(checksum(payload)), Buffer.from(b.slice(22))) !== 0) return null;
  const { pkh, sh } = dcrNet;
  const kind = payload[0] === pkh[0] && payload[1] === pkh[1] ? 'pkh' : payload[0] === sh[0] && payload[1] === sh[1] ? 'sh' : null;
  return kind ? { kind, hash: payload.slice(2) } : null;
}

export const isDcrAddress = (address: string): boolean => decodeDcrAddress(address.trim()) !== null;

/** The output script (version 0) an address is paid with. */
export function dcrScript(address: string): Uint8Array {
  const d = decodeDcrAddress(address);
  if (!d) throw new Error('Not a Decred address.');
  return d.kind === 'pkh' ? Uint8Array.from([0x76, 0xa9, 0x14, ...d.hash, 0x88, 0xac]) : Uint8Array.from([0xa9, 0x14, ...d.hash, 0x87]);
}

export const typicalDcrFee = (): bigint => (SIZE_BASE + SIZE_INPUT + SIZE_OUTPUT * 2n) * FEE_ATOMS_PER_BYTE;

/** Script opcodes that tag a P2PKH script as a stake output: a vote's reward, a revocation's, a ticket's change. */
const OP_SSGEN = 0xbb;
const OP_SSRTX = 0xbc;

/**
 * What a coin row from dcrdata is. Plain P2PKH coins are in the regular tree; a vote's or revocation's outputs
 * (a ticket's reward, back at the address its commitment named) are in the stake tree, tagged, and can be spent
 * only after CoinbaseMaturity blocks. Anything else (a ticket's zero-value stake change, scripts this wallet
 * doesn't make) is left out.
 */
export function dcrCoinKind(row: any): { tree: number; script?: string; mature: boolean } | null {
  const script = typeof row?.scriptPubKey === 'string' ? row.scriptPubKey.toLowerCase() : undefined;
  if (script === undefined) return { tree: 0, mature: true };
  if (/^76a914[0-9a-f]{40}88ac$/.test(script)) return { tree: 0, script, mature: true };
  if (/^b[bc]76a914[0-9a-f]{40}88ac$/.test(script)) return { tree: 1, script, mature: Number(row.confirmations ?? 0) > dcrNet.coinbaseMaturity };
  return null;
}

/** A connection of its own, on its own Tor route: `agent` on desktop, a route name for Android's forwarder. */
export type DcrIsolate = () => { agent?: Agent; route?: string };

export class DcrClient extends InsightWallet<'DCR'> {
  private readonly account: any;
  // No coin check against raw transactions (`script` left out): Decred's consensus rejects an input whose stated
  // amount differs from the coin's, so a server that misreports a coin only makes the send fail.
  constructor(xpub: string, apis: string[], agent?: Agent, timeoutMs = 30_000, private readonly isolate: DcrIsolate = () => ({ agent }), readonly path = DCR_PATH) {
    // A smaller gap and a longer reuse than other coins: each address is asked about on its own (see lookup).
    super({ symbol: 'DCR', dust: DUST, feePerByte: FEE_ATOMS_PER_BYTE, base: SIZE_BASE, input: SIZE_INPUT, output: SIZE_OUTPUT, sign: (d, m) => signDcrDraft(d, m, path), gapReceive: 10, gapChange: 4, cacheMs: 3 * 60_000, coin: dcrCoinKind }, apis, agent, timeoutMs);
    this.account = HDKey.fromExtendedKey(xpub);
  }

  /** dcrdata's own API next to its Insight API, for what Insight doesn't cover (ticket price, ticket status). */
  private async api(path: string): Promise<any> {
    let last: unknown;
    for (const base of this.apis) {
      try { return await getJson(base.replace(/\/insight\/api\/?$/, '/api') + path, { agent: this.agent, timeoutMs: this.timeoutMs }); } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach the DCR server.');
  }

  /** The chain tip and the ticket price for the next block (dcrd's "next" stake difficulty), in atoms. */
  async stakeState(): Promise<{ height: number; price: bigint }> {
    const [h, d] = await Promise.all([this.api('/block/best/height'), this.api('/stake/diff')]);
    const height = Number(h);
    const next = Number(d?.next);
    if (!Number.isInteger(height) || height <= 0 || !(next > 0)) throw new Error('The DCR server gave an unexpected answer.');
    return { height, price: BigInt(Math.round(next * 1e8)) };
  }

  /** A ticket's state as the server sees it: "unmined", "immature", "live", "voted", "missed", "expired", "revoked". */
  async ticketStatus(hash: string): Promise<string> {
    const r = await this.api(`/tx/${hash}/tinfo`);
    return typeof r?.status === 'string' ? r.status : 'unknown';
  }

  /** Whether a transaction is known to the server (in a block or waiting), and its confirmations. */
  async txConfirmations(txid: string): Promise<number | null> {
    try { const r = await this.get(`/tx/${txid}`); return Number(r?.confirmations ?? 0); } catch { return null; }
  }

  /** Where change goes for the next `n` outputs this wallet pays itself: unused change addresses in a row. */
  changeAddresses(n: number): { address: string; index: number }[] {
    const first = this.changeTarget().index;
    return Array.from({ length: n }, (_, i) => ({ address: this.addressAt(1, first + i), index: first + i }));
  }

  /** Addresses already asked about in this scan, so a later round only asks about the new ones. */
  private asked = new Map<string, { utxoRows: any[]; txs: any[] }>();

  /**
   * Each address on its own request, in random order, and through Tor each on its own route: a server sent the
   * whole list at once (as Insight allows) would learn which addresses belong to one wallet.
   */
  protected override async lookup(addresses: string[], round: number): Promise<{ utxoRows: any[]; txs: any[] }> {
    if (round === 0) this.asked.clear();
    const todo = addresses.filter((a) => !this.asked.has(a));
    for (let i = todo.length - 1; i > 0; i--) { const j = randomInt(i + 1); [todo[i], todo[j]] = [todo[j], todo[i]]; }
    const one = async (a: string) => {
      const { agent, route } = this.isolate();
      const [u, t] = await Promise.all([this.get(`/addr/${a}/utxo`, agent ?? this.agent, route), this.get(`/addrs/${a}/txs?from=0&to=50&noAsm=1`, agent ?? this.agent, route)]);
      this.asked.set(a, { utxoRows: Array.isArray(u) ? u : [], txs: Array.isArray(t?.items) ? t.items : [] });
    };
    for (let i = 0; i < todo.length; i += 3) await Promise.all(todo.slice(i, i + 3).map(one));
    const utxoRows: any[] = []; const txs = new Map<string, any>();
    for (const a of addresses) {
      const r = this.asked.get(a)!;
      utxoRows.push(...r.utxoRows);
      for (const tx of r.txs) if (typeof tx?.txid === 'string') txs.set(tx.txid, tx);
    }
    return { utxoRows, txs: [...txs.values()] };
  }
  addressAt(chain: number, index: number): string {
    return dcrAddressOf(this.account.deriveChild(chain).deriveChild(index).publicKey);
  }
}

// ---- transactions ----

export class Writer {
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

export function writePrefix(w: Writer, tx: DcrTx): Writer {
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
export function p2pkhSigScript(hash: Uint8Array, privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
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
export function signDcrDraft(draft: InsightDraft, mnemonic: string, path = DCR_PATH): { hex: string; id: string } {
  if (!isDcrAddress(draft.to)) throw new Error('The receiving address is not a Decred address.');
  const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0n);
  if (totalIn - draft.amount - draft.change !== draft.fee || draft.fee < 0n) throw new Error('The amounts do not add up, so signing was stopped.');
  const account = HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(path);
  const keys: { priv: Uint8Array; pub: Uint8Array; script: Uint8Array }[] = [];
  const tagged = (script: string | undefined, address: string) => !!script && (script === `${OP_SSGEN.toString(16)}${Buffer.from(dcrScript(address)).toString('hex')}` || script === `${OP_SSRTX.toString(16)}${Buffer.from(dcrScript(address)).toString('hex')}`);
  const tx: DcrTx = { version: TX_VERSION, inputs: [], outputs: [], lockTime: 0, expiry: 0 };
  for (const u of draft.inputs) {
    const child = account.deriveChild(u.chain).deriveChild(u.index);
    if (dcrAddressOf(child.publicKey) !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    // A stake output (a ticket's reward) is spent from the stake tree, and its signature covers its tagged script.
    const stake = u.tree === 1;
    if (stake && !tagged(u.script, u.address)) throw new Error('A coin from a ticket did not match this wallet\'s keys, so signing was stopped.');
    // The coin's amount, and the null block height and index (wire.NullBlockHeight, NullBlockIndex).
    tx.inputs.push({ txid: u.txid, vout: u.vout, tree: stake ? 1 : 0, sequence: 0xffffffff, value: u.value, blockHeight: 0, blockIndex: 0xffffffff, sigScript: new Uint8Array() });
    keys.push({ priv: child.privateKey, pub: child.publicKey, script: stake ? Uint8Array.from(Buffer.from(u.script!, 'hex')) : dcrScript(u.address) });
  }
  tx.outputs.push({ value: draft.amount, version: 0, script: dcrScript(draft.to) });
  if (draft.change > 0n) {
    const changeAccount = draft.changePath ? HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(draft.changePath) : account;
    const change = changeAccount.deriveChild(1).deriveChild(draft.changeIndex);
    if (dcrAddressOf(change.publicKey) !== draft.changeAddress) throw new Error('The change address does not match this wallet\'s keys, so signing was stopped.');
    // At a random place, as dcrwallet puts it, so the change isn't always the last output.
    tx.outputs.splice(randomInt(2), 0, { value: draft.change, version: 0, script: dcrScript(draft.changeAddress) });
  }
  keys.forEach((k, i) => { tx.inputs[i].sigScript = p2pkhSigScript(dcrSignatureHash(tx, i, k.script), k.priv, k.pub); });
  keys.forEach((k, i) => { if (!verifyDcrInput(tx, i, k.script, k.pub)) throw new Error('A signature did not check out, so this was stopped.'); });
  return { hex: Buffer.from(serializeDcrTx(tx)).toString('hex'), id: dcrTxid(tx) };
}
