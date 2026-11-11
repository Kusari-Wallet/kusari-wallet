import type { Agent } from 'node:http';
import { requestBytes, requestJson } from './request';
import { formatAmount } from './amount';

const { ed25519 } = require('@noble/curves/ed25519.js');
const { sha512 } = require('@noble/hashes/sha2.js');
const { hmac } = require('@noble/hashes/hmac.js');
const { pbkdf2 } = require('@noble/hashes/pbkdf2.js');
const { blake2b } = require('@noble/hashes/blake2.js');
const { bech32 } = require('@scure/base');
const { mnemonicToEntropy } = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english');

/**
 * Cardano (ADA), the way Yoroi, Eternl, Lace and Daedalus's Shelley wallets do it: an Icarus master key from the
 * seed's entropy, BIP32-Ed25519 below it, CIP-1852 paths (m/1852'/1815'/0'/0/0 to receive, …/2/0 to stake), and one
 * base address that holds both. Must never change. Transactions are written here in CBOR and checked in the tests
 * against Cardano's own serialization library.
 */

export const ADA_API = 'https://api.koios.rest/api/v1';
export const ADA_EXPLORER_TX = 'https://cardanoscan.io/transaction/';
const HARD = 0x80000000;
const N = ed25519.Point.Fn.ORDER as bigint;
/** Transactions stay valid for about two hours of slots. */
const TTL_SLOTS = 7200;
const CACHE_MS = 30_000;

// ---- keys ----

export interface XPrv { kL: Uint8Array; kR: Uint8Array; chain: Uint8Array }

const le = (b: Uint8Array): bigint => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
const toLe = (v: bigint, n: number): Uint8Array => { const out = new Uint8Array(n); for (let i = 0; i < n; i++) { out[i] = Number(v & 0xffn); v >>= 8n; } return out; };
const cat = (...parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const u32le = (i: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, i >>> 0, true); return b; };

export function publicKeyOf(k: XPrv): Uint8Array {
  return ed25519.Point.BASE.multiply(le(k.kL) % N).toBytes();
}

/** The Icarus master key: PBKDF2 over the seed's entropy, then clamped. */
export function adaMaster(mnemonic: string): XPrv {
  const entropy = mnemonicToEntropy(mnemonic.trim().normalize('NFKD').split(/\s+/).join(' '), wordlist);
  const x = pbkdf2(sha512, new Uint8Array(0), entropy, { c: 4096, dkLen: 96 });
  x[0] &= 0xf8;
  x[31] &= 0x1f;
  x[31] |= 0x40;
  return { kL: x.slice(0, 32), kR: x.slice(32, 64), chain: x.slice(64, 96) };
}

/** BIP32-Ed25519 child key, Khovratovich and Law's scheme as Cardano uses it (V2). */
export function deriveChild(k: XPrv, index: number): XPrv {
  const hard = index >= HARD;
  const data = hard ? cat(k.kL, k.kR) : publicKeyOf(k);
  const z = hmac(sha512, k.chain, cat(Uint8Array.of(hard ? 0x00 : 0x02), data, u32le(index)));
  const c = hmac(sha512, k.chain, cat(Uint8Array.of(hard ? 0x01 : 0x03), data, u32le(index)));
  const kL = le(z.slice(0, 28)) * 8n + le(k.kL);
  if (kL % N === 0n) throw new Error('Unusable key.');
  const kR = (le(z.slice(32, 64)) + le(k.kR)) % (1n << 256n);
  return { kL: toLe(kL, 32), kR: toLe(kR, 32), chain: c.slice(32, 64) };
}

export function derivePath(k: XPrv, path: string): XPrv {
  const parts = path.replace(/^m\//, '').split('/');
  return parts.reduce((acc, p) => deriveChild(acc, p.endsWith("'") ? (Number(p.slice(0, -1)) + HARD) >>> 0 : Number(p)), k);
}

/** Ed25519 with an extended key: the nonce comes from the key's right half, as BIP32-Ed25519 signs. */
export function signExtended(k: XPrv, message: Uint8Array): Uint8Array {
  const a = publicKeyOf(k);
  const r = le(sha512(cat(k.kR, message))) % N;
  const R = ed25519.Point.BASE.multiply(r === 0n ? N : r).toBytes();
  const h = le(sha512(cat(R, a, message))) % N;
  const s = (r + h * (le(k.kL) % N)) % N;
  return cat(R, toLe(s, 32));
}

export const ADA_PAYMENT_PATH = "m/1852'/1815'/0'/0/0";
export const ADA_STAKE_PATH = "m/1852'/1815'/0'/2/0";

const hash224 = (b: Uint8Array) => blake2b(b, { dkLen: 28 });
const hash256 = (b: Uint8Array) => blake2b(b, { dkLen: 32 });

export function adaKeys(mnemonic: string): { payment: XPrv; stake: XPrv } {
  const account = derivePath(adaMaster(mnemonic), "m/1852'/1815'/0'");
  return { payment: derivePath(account, '0/0'), stake: derivePath(account, '2/0') };
}

/** The mainnet base address: header 0x01, then the payment and stake key hashes. */
export function adaAddress(mnemonic: string): string {
  const { payment, stake } = adaKeys(mnemonic);
  const bytes = cat(Uint8Array.of(0x01), hash224(publicKeyOf(payment)), hash224(publicKeyOf(stake)));
  return bech32.encode('addr', bech32.toWords(bytes), 1000);
}

/** A Shelley mainnet address (addr1…), as bytes. Byron (Ae2…, DdzFF…) and stake addresses aren't sent to. */
export function adaAddressBytes(address: string): Uint8Array {
  let d: { prefix: string; words: number[] };
  try { d = bech32.decode(address, 1000); } catch { throw new Error('Not a Cardano address. Use a Shelley address starting with addr1.'); }
  if (d.prefix !== 'addr') throw new Error('Not a Cardano mainnet address. Use an address starting with addr1.');
  const b = Uint8Array.from(bech32.fromWords(d.words));
  const type = b[0] >> 4;
  if ((b[0] & 0x0f) !== 1) throw new Error('This address is not for Cardano mainnet.');
  // Base (0-3): payment and stake parts. Pointer (4-5): payment part and a pointer. Enterprise (6-7): payment part only.
  const ok = type <= 3 ? b.length === 57 : type <= 5 ? b.length > 29 && b.length < 64 : type <= 7 ? b.length === 29 : false;
  if (!ok) throw new Error('Not a Cardano payment address.');
  return b;
}

export const isAdaAddress = (a: string): boolean => { try { adaAddressBytes(a); return true; } catch { return false; } };

// ---- CBOR, just what a simple transaction needs ----

function head(major: number, n: number | bigint): Uint8Array {
  const v = BigInt(n);
  const m = major << 5;
  if (v < 24n) return Uint8Array.of(m | Number(v));
  if (v < 0x100n) return Uint8Array.of(m | 24, Number(v));
  if (v < 0x10000n) return Uint8Array.of(m | 25, Number(v >> 8n), Number(v & 0xffn));
  if (v < 0x100000000n) { const b = new Uint8Array(5); b[0] = m | 26; new DataView(b.buffer).setUint32(1, Number(v)); return b; }
  const b = new Uint8Array(9); b[0] = m | 27; new DataView(b.buffer).setBigUint64(1, v); return b;
}
const cUint = (n: number | bigint) => head(0, n);
const cBytes = (b: Uint8Array) => cat(head(2, b.length), b);
const cArray = (items: Uint8Array[]) => cat(head(4, items.length), ...items);
const cMap = (pairs: [number, Uint8Array][]) => cat(head(5, pairs.length), ...pairs.flatMap(([k, v]) => [cUint(k), v]));
const cTag = (tag: number, v: Uint8Array) => cat(head(6, tag), v);
const CBOR_TRUE = Uint8Array.of(0xf5);
const CBOR_NULL = Uint8Array.of(0xf6);

// ---- transactions ----

export interface AdaUtxo { txHash: string; index: number; lovelace: bigint; assets: boolean }
export interface AdaParams { minFeeA: bigint; minFeeB: bigint; coinsPerByte: bigint; maxTxSize: number }
export interface AdaDraft { to: string; amount: bigint; fee: bigint; change: bigint; inputs: AdaUtxo[]; ttl: number }

const outputCbor = (address: Uint8Array, lovelace: bigint) => cArray([cBytes(address), cUint(lovelace)]);

/** Lovelace an output of this size must hold (Babbage rule: 160 bytes of overhead plus the output). */
export function minAda(address: Uint8Array, p: AdaParams): bigint {
  return (160n + BigInt(outputCbor(address, 1_000_000_000_000n).length)) * p.coinsPerByte;
}

export function txBody(inputs: AdaUtxo[], outputs: { address: Uint8Array; lovelace: bigint }[], fee: bigint, ttl: number): Uint8Array {
  // Inputs in a set, ordered as the ledger keeps them: by transaction id, then index.
  const sorted = [...inputs].sort((a, b) => (a.txHash === b.txHash ? a.index - b.index : a.txHash < b.txHash ? -1 : 1));
  return cMap([
    [0, cTag(258, cArray(sorted.map((u) => cArray([cBytes(hexBytes(u.txHash)), cUint(u.index)]))))],
    [1, cArray(outputs.map((o) => outputCbor(o.address, o.lovelace)))],
    [2, cUint(fee)],
    [3, cUint(ttl)],
  ]);
}

export function signTx(body: Uint8Array, key: XPrv): { cbor: Uint8Array; id: string } {
  const id = hash256(body);
  const witness = cMap([[0, cTag(258, cArray([cArray([cBytes(publicKeyOf(key)), cBytes(signExtended(key, id))])]))]]);
  return { cbor: cArray([body, witness, CBOR_TRUE, CBOR_NULL]), id: bytesHex(id) };
}

const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const bytesHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Fee for a body plus one key witness, at the ledger's linear rate. */
export function feeFor(body: Uint8Array, p: AdaParams): bigint {
  // One key witness (key, signature, set tag, map and array heads) and the transaction's own frame: about 110 bytes.
  const size = BigInt(body.length + 120);
  return p.minFeeA * size + p.minFeeB;
}

/**
 * Picks ADA-only coins to cover the amount and the fee, change back to this wallet. Coins carrying tokens are left
 * alone, so no token is ever sent away by mistake.
 */
export function planAda(utxos: AdaUtxo[], from: Uint8Array, to: Uint8Array, amount: bigint | 'max', p: AdaParams, ttl: number): Omit<AdaDraft, 'to'> {
  const pure = utxos.filter((u) => !u.assets).sort((a, b) => (a.lovelace === b.lovelace ? 0 : a.lovelace > b.lovelace ? -1 : 1));
  if (!pure.length) throw new Error('No ADA to send.');
  const min = minAda(to, p);
  if (amount === 'max') {
    const total = pure.reduce((s, u) => s + u.lovelace, 0n);
    let fee = feeFor(txBody(pure, [{ address: to, lovelace: total }], 200_000n, ttl), p);
    const value = total - fee;
    if (value < min) throw new Error(`Too little ADA: a payment must carry at least ${formatAmount(min, 6)} ADA.`);
    fee = feeFor(txBody(pure, [{ address: to, lovelace: value }], fee, ttl), p);
    return { amount: total - fee, fee, change: 0n, inputs: pure, ttl };
  }
  if (amount < min) throw new Error(`A Cardano payment must carry at least ${formatAmount(min, 6)} ADA.`);
  const chosen: AdaUtxo[] = [];
  let sum = 0n;
  for (const u of pure) {
    chosen.push(u);
    sum += u.lovelace;
    const fee = feeFor(txBody(chosen, [{ address: to, lovelace: amount }, { address: from, lovelace: sum }], 200_000n, ttl), p);
    const change = sum - amount - fee;
    if (change === 0n) return { amount, fee, change: 0n, inputs: [...chosen], ttl };
    if (change >= minAda(from, p)) {
      const exact = feeFor(txBody(chosen, [{ address: to, lovelace: amount }, { address: from, lovelace: change }], fee, ttl), p);
      return { amount, fee: exact, change: sum - amount - exact, inputs: [...chosen], ttl };
    }
  }
  // Too little left for change: the rest goes to the fee only if it's small; otherwise ask for a different amount.
  const fee = feeFor(txBody(pure, [{ address: to, lovelace: amount }], 200_000n, ttl), p);
  const rest = sum - amount - fee;
  if (rest >= 0n && rest < minAda(from, p) && rest < 1_000_000n) return { amount, fee: fee + rest, change: 0n, inputs: pure, ttl };
  throw new Error(rest < 0n ? 'Not enough ADA for this amount and the fee.' : 'What would be left is below Cardano\'s minimum for a change output. Send a little more or a little less, or use Max.');
}

// ---- the network ----

export class AdaClient {
  private cache: { at: number; utxos: AdaUtxo[] } | null = null;
  private params: { at: number; value: AdaParams } | null = null;
  readonly receiveAddress: string;
  private readonly addressBytes: Uint8Array;

  constructor(address: string, private readonly api = ADA_API, private readonly agent?: Agent, private readonly timeoutMs = 30_000) {
    this.receiveAddress = address;
    this.addressBytes = adaAddressBytes(address);
  }

  private async call(path: string, body?: unknown): Promise<any> {
    const r = await requestJson(this.api + path, { method: body === undefined ? 'GET' : 'POST', body, agent: this.agent, timeoutMs: this.timeoutMs });
    if (r.status >= 400) throw new Error(`The Cardano server answered with an error (${r.status}).`);
    return r.body;
  }

  async utxos(fresh = false): Promise<AdaUtxo[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.utxos;
    const rows = await this.call('/address_utxos', { _addresses: [this.receiveAddress], _extended: true });
    if (!Array.isArray(rows)) throw new Error('The Cardano server gave an unexpected answer.');
    const utxos = rows.map((r: any) => {
      if (!/^[0-9a-f]{64}$/.test(String(r.tx_hash)) || !Number.isInteger(r.tx_index) || !/^\d+$/.test(String(r.value))) throw new Error('The Cardano server gave an unexpected answer.');
      return { txHash: String(r.tx_hash), index: Number(r.tx_index), lovelace: BigInt(r.value), assets: Array.isArray(r.asset_list) && r.asset_list.length > 0 };
    });
    this.cache = { at: Date.now(), utxos };
    return utxos;
  }

  /** Coins with tokens on them count too; only ADA-only coins can be spent from here. */
  async getBalance(): Promise<{ total: bigint; spendable: bigint }> {
    const u = await this.utxos();
    return { total: u.reduce((s, x) => s + x.lovelace, 0n), spendable: u.filter((x) => !x.assets).reduce((s, x) => s + x.lovelace, 0n) };
  }

  private async protocol(): Promise<AdaParams> {
    if (this.params && Date.now() - this.params.at < 3_600_000) return this.params.value;
    const rows = await this.call('/epoch_params?limit=1&order=epoch_no.desc&select=epoch_no,min_fee_a,min_fee_b,coins_per_utxo_size,max_tx_size');
    const r = Array.isArray(rows) ? rows[0] : null;
    const value = { minFeeA: BigInt(r?.min_fee_a), minFeeB: BigInt(r?.min_fee_b), coinsPerByte: BigInt(r?.coins_per_utxo_size), maxTxSize: Number(r?.max_tx_size) };
    // A server lying about these could only make a send fail, but out-of-range numbers are refused anyway.
    if (value.minFeeA <= 0n || value.minFeeA > 1000n || value.minFeeB > 10_000_000n || value.coinsPerByte <= 0n || value.coinsPerByte > 100_000n || !(value.maxTxSize > 1000)) throw new Error('The Cardano server gave unexpected protocol numbers.');
    this.params = { at: Date.now(), value };
    return value;
  }

  private async slot(): Promise<number> {
    const r = await this.call('/tip');
    const s = Number(Array.isArray(r) ? r[0]?.abs_slot : NaN);
    if (!Number.isSafeInteger(s) || s <= 0) throw new Error('The Cardano server gave an unexpected answer.');
    return s;
  }

  async draft(to: string, amount: bigint | 'max'): Promise<AdaDraft> {
    const target = adaAddressBytes(to);
    if (to === this.receiveAddress) throw new Error('You cannot send to your own address.');
    const [utxos, p, slot] = await Promise.all([this.utxos(true), this.protocol(), this.slot()]);
    const plan = planAda(utxos, this.addressBytes, target, amount, p, slot + TTL_SLOTS);
    return { to, ...plan };
  }

  async send(d: AdaDraft, mnemonic: string): Promise<string> {
    const { payment } = adaKeys(mnemonic);
    if (adaAddress(mnemonic) !== this.receiveAddress) throw new Error('The wallet keys do not match this address, so signing was stopped.');
    const outputs = [{ address: adaAddressBytes(d.to), lovelace: d.amount }, ...(d.change > 0n ? [{ address: this.addressBytes, lovelace: d.change }] : [])];
    const totalIn = d.inputs.reduce((s, u) => s + u.lovelace, 0n);
    if (totalIn !== d.amount + d.change + d.fee) throw new Error('The amounts do not add up, so signing was stopped.');
    const { cbor, id } = signTx(txBody(d.inputs, outputs, d.fee, d.ttl), payment);
    const answer = (await requestBytes(`${this.api}/submittx`, { body: cbor, contentType: 'application/cbor', agent: this.agent, timeoutMs: this.timeoutMs })).replace(/"/g, '').trim();
    if (answer !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
    this.cache = null;
    return id;
  }

  async getHistory(): Promise<{ asset: 'ADA'; hash: string; direction: 'in' | 'out' | 'self'; amount: string; counterparty: string; timestamp: number; status: 'confirmed'; dust: boolean }[]> {
    const rows = await this.call('/address_txs', { _addresses: [this.receiveAddress] });
    const list = (Array.isArray(rows) ? rows : []).slice(0, 15).map((r: any) => String(r.tx_hash)).filter((h: string) => /^[0-9a-f]{64}$/.test(h));
    if (!list.length) return [];
    const info = await this.call('/tx_info', { _tx_hashes: list, _inputs: true });
    const me = this.receiveAddress;
    return (Array.isArray(info) ? info : []).map((t: any) => {
      const sum = (rows: any[]) => (rows ?? []).filter((x: any) => x?.payment_addr?.bech32 === me).reduce((s: bigint, x: any) => s + BigInt(/^\d+$/.test(String(x.value)) ? x.value : 0), 0n);
      const spent = sum(t.inputs);
      const got = sum(t.outputs);
      const net = got - spent;
      const other = (t.outputs ?? []).find((x: any) => x?.payment_addr?.bech32 !== me)?.payment_addr?.bech32 ?? '';
      const direction: 'in' | 'out' | 'self' = net > 0n ? 'in' : other ? 'out' : 'self';
      return { asset: 'ADA' as const, hash: String(t.tx_hash), direction, amount: formatAmount(net < 0n ? -net : net, 6), counterparty: direction === 'out' ? other : '', timestamp: Number(t.tx_timestamp ?? t.block_time ?? 0) * 1000, status: 'confirmed' as const, dust: false };
    });
  }
}
