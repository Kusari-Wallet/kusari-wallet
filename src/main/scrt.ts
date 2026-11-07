import type { Agent } from 'node:http';
import { SigningKey, getBytes, ripemd160, sha256 } from 'ethers';
import { getJson, requestJson } from './request';
import { formatAmount } from './amount';

const { HDKey } = require('@scure/bip32');
const { mnemonicToSeedSync } = require('@scure/bip39');
const { bech32 } = require('@scure/base');

// Coin type 529 is Secret Network's, as Keplr and the Secret CLI use it. Must never change.
export const SCRT_PATH = "m/44'/529'/0'/0/0";
export const SCRT_CHAIN_ID = 'secret-4';
const DENOM = 'uscrt';
const PREFIX = 'secret';
// Validators take 0.1 uscrt per gas at the least; a little more gets in without waiting.
const GAS_PRICE_MILLI = 250n; // 0.25 uscrt, in thousandths
const MAX_GAS = 200_000n;
const CACHE_MS = 30_000;
const HISTORY_LIMIT = 20;

export interface ScrtDraft { to: string; amount: bigint; fee: bigint; gas: bigint; accountNumber: bigint; sequence: bigint }

function key(mnemonic: string) {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(SCRT_PATH);
}

const hash160 = (b: Uint8Array) => getBytes(ripemd160(sha256(b)));

export function scrtAddressFromKey(publicKey: Uint8Array): string {
  return bech32.encode(PREFIX, bech32.toWords(hash160(publicKey)));
}

export function scrtAddress(mnemonic: string): string { return scrtAddressFromKey(key(mnemonic).publicKey); }

export function isScrtAddress(address: string): boolean {
  try {
    const { prefix, words } = bech32.decode(address);
    return prefix === PREFIX && bech32.fromWords(words).length === 20;
  } catch { return false; }
}

// ---- protobuf, just the messages a transfer needs ----

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function varint(n: bigint): Uint8Array {
  const out: number[] = [];
  let v = n;
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return Uint8Array.from(out);
}
const tag = (field: number, wire: number) => varint(BigInt((field << 3) | wire));
const bytesField = (field: number, b: Uint8Array) => (b.length ? join([tag(field, 2), varint(BigInt(b.length)), b]) : new Uint8Array());
const stringField = (field: number, s: string) => bytesField(field, new TextEncoder().encode(s));
const intField = (field: number, n: bigint) => (n ? join([tag(field, 0), varint(n)]) : new Uint8Array());
const any = (typeUrl: string, value: Uint8Array) => join([stringField(1, typeUrl), bytesField(2, value)]);
const coin = (amount: bigint) => join([stringField(1, DENOM), stringField(2, amount.toString())]);

function bodyBytes(from: string, to: string, amount: bigint): Uint8Array {
  const send = join([stringField(1, from), stringField(2, to), bytesField(3, coin(amount))]);
  return bytesField(1, any('/cosmos.bank.v1beta1.MsgSend', send));
}

function authInfoBytes(publicKey: Uint8Array, sequence: bigint, fee: bigint, gas: bigint): Uint8Array {
  const pub = any('/cosmos.crypto.secp256k1.PubKey', bytesField(1, publicKey));
  const modeInfo = bytesField(1, intField(1, 1n)); // single, SIGN_MODE_DIRECT
  const signer = join([bytesField(1, pub), bytesField(2, modeInfo), intField(3, sequence)]);
  const feeMsg = join([bytesField(1, coin(fee)), intField(2, gas)]);
  return join([bytesField(1, signer), bytesField(2, feeMsg)]);
}

export function scrtPublicKey(mnemonic: string): Uint8Array { return key(mnemonic).publicKey as Uint8Array; }

/** The transfer as the chain sees it. With a blank signature it is only good for asking a node how much gas it needs. */
function encodeTransfer(publicKey: Uint8Array, draft: ScrtDraft, sign: (signDoc: Uint8Array) => Uint8Array): { bytes: Uint8Array; hash: string } {
  if (!isScrtAddress(draft.to)) throw new Error('The receiving address is not a SCRT address.');
  if (draft.amount <= 0n) throw new Error('The amount must be more than zero.');
  const body = bodyBytes(scrtAddressFromKey(publicKey), draft.to, draft.amount);
  const auth = authInfoBytes(publicKey, draft.sequence, draft.fee, draft.gas);
  const signDoc = join([bytesField(1, body), bytesField(2, auth), stringField(3, SCRT_CHAIN_ID), intField(4, draft.accountNumber)]);
  const bytes = join([bytesField(1, body), bytesField(2, auth), bytesField(3, sign(signDoc))]);
  return { bytes, hash: sha256(bytes).slice(2).toUpperCase() };
}

/** A signed bank transfer, SIGN_MODE_DIRECT. Returns the raw bytes and the hash the chain will call it by. */
export function signScrtTransfer(mnemonic: string, draft: ScrtDraft): { bytes: Uint8Array; hash: string } {
  const k = key(mnemonic);
  return encodeTransfer(k.publicKey, draft, (doc) => {
    const s = new SigningKey(k.privateKey as Uint8Array).sign(getBytes(sha256(doc)));
    return join([getBytes(s.r), getBytes(s.s)]);
  });
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const UNEXPECTED = 'The Secret Network server gave an unexpected answer.';
const uint = (v: unknown): bigint => { if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error(UNEXPECTED); return BigInt(v); };

/**
 * Plain SCRT through public LCD (REST) servers. Native SCRT transfers are public on the chain; only Secret's private
 * tokens hide amounts, and those aren't part of this wallet.
 */
export class ScrtClient {
  private cache: { at: number; amount: bigint } | null = null;
  readonly address: string;
  constructor(private readonly publicKey: Uint8Array, private readonly lcds: string[], private readonly agent?: Agent, private readonly timeoutMs = 20_000) { this.address = scrtAddressFromKey(publicKey); }

  get receiveAddress(): string { return this.address; }

  private async get(path: string): Promise<any> {
    let last: unknown;
    for (const base of this.lcds) {
      try { return await getJson(base + path, { agent: this.agent, timeoutMs: this.timeoutMs, headers: { Accept: 'application/json' } }); } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach a Secret Network server.');
  }

  private async post(path: string, body: unknown): Promise<any> {
    let last: unknown;
    for (const base of this.lcds) {
      try {
        const res = await requestJson(base + path, { method: 'POST', body, agent: this.agent, timeoutMs: this.timeoutMs });
        if (res.status >= 500) throw new Error(`Server error (${res.status})`);
        return res;
      } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach a Secret Network server.');
  }

  async getBalance(): Promise<bigint> {
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      const r = await this.get(`/cosmos/bank/v1beta1/balances/${this.address}`);
      if (!Array.isArray(r?.balances)) throw new Error(UNEXPECTED);
      const row = r.balances.find((b: any) => b?.denom === DENOM);
      this.cache = { at: Date.now(), amount: row ? uint(row.amount) : 0n };
    }
    return this.cache.amount;
  }

  private async account(): Promise<{ accountNumber: bigint; sequence: bigint }> {
    const r = await this.get(`/cosmos/auth/v1beta1/accounts/${this.address}`);
    const a = r?.account?.base_account ?? r?.account;
    if (a?.address !== this.address) throw new Error(UNEXPECTED);
    return { accountNumber: uint(a.account_number ?? '0'), sequence: uint(a.sequence ?? '0') };
  }

  async draft(to: string, amount: bigint | 'max'): Promise<ScrtDraft> {
    if (!isScrtAddress(to)) throw new Error('Not a Secret Network address. Only addresses starting with secret1 can be used.');
    if (to === this.address) throw new Error('You cannot send to your own address.');
    this.cache = null;
    const [held, acct] = await Promise.all([this.getBalance(), this.account()]);
    // The node runs the transfer without a real signature to tell how much gas it needs.
    const trial: ScrtDraft = { to, amount: amount === 'max' ? held || 1n : amount, fee: 0n, gas: 0n, ...acct };
    const sim = await this.post('/cosmos/tx/v1beta1/simulate', { tx_bytes: b64(encodeTransfer(this.publicKey, trial, () => new Uint8Array(64)).bytes) });
    const used = sim.body?.gas_info?.gas_used;
    if (sim.status >= 400 || typeof used !== 'string' || !/^\d+$/.test(used)) throw new Error(`Could not estimate the fee: ${String(sim.body?.message ?? sim.status).slice(0, 160)}`);
    const gas = (BigInt(used) * 13n) / 10n + 1_000n;
    if (gas > MAX_GAS) throw new Error('This send needs an abnormal amount of gas, so it was stopped.');
    const fee = (gas * GAS_PRICE_MILLI + 999n) / 1000n;
    const value = amount === 'max' ? held - fee : amount;
    if (value <= 0n) throw new Error('No SCRT left to send after the fee.');
    if (value + fee > held) throw new Error('Not enough SCRT to cover the amount and fee.');
    return { to, amount: value, fee, gas, ...acct };
  }

  async send(draft: ScrtDraft, mnemonic: string): Promise<string> {
    if (scrtAddress(mnemonic) !== this.address) throw new Error('This wallet\'s seed does not match the SCRT account.');
    const { bytes, hash } = signScrtTransfer(mnemonic, draft);
    const res = await this.post('/cosmos/tx/v1beta1/txs', { tx_bytes: b64(bytes), mode: 'BROADCAST_MODE_SYNC' });
    const r = res.body?.tx_response;
    if (res.status >= 400 || !r) throw new Error(`Send rejected: ${String(res.body?.message ?? res.status).slice(0, 200)}`);
    if (r.code) throw new Error(`Send rejected: ${String(r.raw_log ?? r.code).slice(0, 200)}`);
    if (String(r.txhash).toUpperCase() !== hash) throw new Error(`The server returned a different transaction ID. Check ${hash} on an explorer.`);
    this.cache = null;
    return hash;
  }

  /** Newer servers search with "query", older ones with "events". */
  private async search(condition: string): Promise<any[]> {
    const q = encodeURIComponent(condition);
    const tail = `&order_by=ORDER_BY_DESC&pagination.limit=${HISTORY_LIMIT}&limit=${HISTORY_LIMIT}`;
    try {
      const r = await this.get(`/cosmos/tx/v1beta1/txs?query=${q}${tail}`);
      if (Array.isArray(r?.tx_responses)) return r.tx_responses;
    } catch { /* try the older form */ }
    const r = await this.get(`/cosmos/tx/v1beta1/txs?events=${q}${tail}`);
    return Array.isArray(r?.tx_responses) ? r.tx_responses : [];
  }

  async getHistory() {
    const [sent, received] = await Promise.all([this.search(`message.sender='${this.address}'`), this.search(`transfer.recipient='${this.address}'`)]);
    const seen = new Map<string, any>();
    for (const r of [...sent, ...received]) if (typeof r?.txhash === 'string' && /^[0-9A-F]{64}$/i.test(r.txhash)) seen.set(r.txhash.toUpperCase(), r);
    const items = [];
    for (const [hash, r] of seen) {
      let net = 0n;
      for (const m of r.tx?.body?.messages ?? []) {
        if (m?.['@type'] !== '/cosmos.bank.v1beta1.MsgSend') continue;
        const amount = (m.amount ?? []).filter((c: any) => c?.denom === DENOM).reduce((s: bigint, c: any) => s + (/^\d+$/.test(String(c.amount)) ? BigInt(c.amount) : 0n), 0n);
        if (m.to_address === this.address) net += amount;
        if (m.from_address === this.address) net -= amount;
      }
      if (net === 0n) continue;
      items.push({
        asset: 'SCRT' as const, hash, direction: net > 0n ? 'in' as const : 'out' as const,
        amount: formatAmount(net < 0n ? -net : net, 6), counterparty: '',
        timestamp: Date.parse(r.timestamp) || Date.now(),
        status: r.code ? 'failed' as const : 'confirmed' as const,
        dust: net > 0n && net < 10_000n,
      });
    }
    return items.sort((a, b) => b.timestamp - a.timestamp);
  }
}
