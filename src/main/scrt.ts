import type { Agent } from 'node:http';
import { SigningKey, getBytes, ripemd160, sha256 } from 'ethers';
import { getJson, requestJson } from './request';
import { formatAmount } from './amount';

const { HDKey } = require('@scure/bip32');
const { mnemonicToSeedSync } = require('@scure/bip39');
const { bech32 } = require('@scure/base');
const { x25519 } = require('@noble/curves/ed25519.js');
const { aessiv } = require('@noble/ciphers/aes.js');
const { hkdf } = require('@noble/hashes/hkdf.js');
const { sha256: sha256Bytes } = require('@noble/hashes/sha2.js');
const { hmac } = require('@noble/hashes/hmac.js');

// Coin type 529 is Secret Network's, as Keplr and the Secret CLI use it. Must never change.
export const SCRT_PATH = "m/44'/529'/0'/0/0";
export const SCRT_CHAIN_ID = 'secret-4';
const DENOM = 'uscrt';
const PREFIX = 'secret';
// Validators take 0.1 uscrt per gas at the least; a little more gets in without waiting.
const GAS_PRICE_MILLI = 250n; // 0.25 uscrt, in thousandths
const MAX_GAS = 200_000n;
// Contract calls run inside the enclave and cost more than a plain transfer.
const MAX_CONTRACT_GAS = 400_000n;
const CACHE_MS = 30_000;
const HISTORY_LIMIT = 20;

/** A call to the sSCRT contract. msg is already encrypted for the chain's enclave, so signing never changes it. */
export interface ScrtExec { kind: 'wrap' | 'unwrap' | 'transfer' | 'key'; msg: Uint8Array; nonce: Uint8Array; funds: bigint }
export interface ScrtDraft { to: string; amount: bigint; fee: bigint; gas: bigint; accountNumber: bigint; sequence: bigint; exec?: ScrtExec }

// sSCRT, the private (SNIP-20) form of SCRT, run by Secret Network itself. Pinned so that no server can point the
// wallet at another contract.
export const SSCRT_CONTRACT = 'secret1k0jntykt7e4g3y88ltc60czgjuqdy4c9e8fzek';
export const SSCRT_CODE_HASH = 'af74387e276be8874f07bec3a87023ee49b0e7ebe08178c49d0a49c3c98ed60e';
// The enclave's public key on secret-4, as secret.js ships it. Pinned rather than asked for, because a server that
// handed out its own key could read every private amount and address.
const CONSENSUS_IO_PUBKEY = Uint8Array.from(Buffer.from('79++5YOHfm0SwhlpUDClv7cuCjq9xBZlWqSjDJWkRG8=', 'base64'));
const HKDF_SALT = Uint8Array.from(Buffer.from('000000000000000000024bead8df69990852c202db0e0097c1a12ea637d7e96d', 'hex'));
// Every private message is padded to a multiple of this, so its length says nothing about the amount or address.
const PAD_TO = 256;


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

const addressBytes = (address: string): Uint8Array => Uint8Array.from(bech32.fromWords(bech32.decode(address).words));

function bodyBytes(from: string, to: string, amount: bigint, exec?: ScrtExec): Uint8Array {
  if (exec) {
    const call = join([bytesField(1, addressBytes(from)), bytesField(2, addressBytes(SSCRT_CONTRACT)), bytesField(3, exec.msg), stringField(4, ''), ...(exec.funds ? [bytesField(5, coin(exec.funds))] : [])]);
    return bytesField(1, any('/secret.compute.v1beta1.MsgExecuteContract', call));
  }
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
  if (draft.amount <= 0n && draft.exec?.kind !== 'key') throw new Error('The amount must be more than zero.');
  const body = bodyBytes(scrtAddressFromKey(publicKey), draft.to, draft.amount, draft.exec);
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

/**
 * Keys for private SCRT, made from the seed so a restored wallet reads the same private balance. The encryption seed
 * only decrypts this wallet's own messages to the enclave, and the viewing key only shows its sSCRT balance and history.
 */
export function scrtPrivacyKeys(mnemonic: string): { encryptionSeed: Uint8Array; viewingKey: string } {
  const k = key(mnemonic).privateKey as Uint8Array;
  const derive = (label: string) => hmac(sha256Bytes, k, new TextEncoder().encode(label));
  return { encryptionSeed: derive('kusari-scrt-tx-encryption'), viewingKey: 'api_key_' + Buffer.from(derive('kusari-sscrt-viewing-key')).toString('base64url') };
}

function txKey(seed: Uint8Array, nonce: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(seed, CONSENSUS_IO_PUBKEY);
  return hkdf(sha256Bytes, join([shared, nonce]), HKDF_SALT, new Uint8Array(), 32);
}

/** What secret.js sends: nonce, our public key, then AES-SIV of the code hash and the JSON. */
export function encryptForContract(seed: Uint8Array, msg: object, nonce: Uint8Array, codeHash = SSCRT_CODE_HASH): Uint8Array {
  const plain = new TextEncoder().encode(codeHash + JSON.stringify(msg));
  const sealed = aessiv(txKey(seed, nonce), new Uint8Array()).encrypt(plain);
  return join([nonce, x25519.getPublicKey(seed), sealed]);
}

export function decryptFromContract(seed: Uint8Array, nonce: Uint8Array, data: Uint8Array): Uint8Array {
  return aessiv(txKey(seed, nonce), new Uint8Array()).decrypt(data);
}

/** Adds SNIP-20's padding field so every message has a length in steps of PAD_TO. */
export function padded(msg: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const [name, inner] = Object.entries(msg)[0];
  const bare = JSON.stringify({ [name]: { ...inner, padding: '' } }).length + SSCRT_CODE_HASH.length;
  return { [name]: { ...inner, padding: ' '.repeat((PAD_TO - (bare % PAD_TO)) % PAD_TO) } };
}

/** Older servers send event attributes in base64. */
const attr = (v: unknown): string => {
  const t = String(v ?? '');
  if (/^[a-z0-9_.]+$|^secret1|^\d/.test(t)) return t;
  try { const d = Buffer.from(t, 'base64').toString('utf8'); return /^[\x20-\x7e]+$/.test(d) ? d : t; } catch { return t; }
};
/** Contract addresses in JSON come as bech32 on some servers and base64 bytes on others. */
const sameAddress = (v: unknown, address: string): boolean => {
  if (v === address) return true;
  try { return typeof v === 'string' && Buffer.from(v, 'base64').equals(Buffer.from(addressBytes(address))); } catch { return false; }
};
const randomNonce = (): Uint8Array => { const n = new Uint8Array(32); crypto.getRandomValues(n); return n; };
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const UNEXPECTED = 'The Secret Network server gave an unexpected answer.';
const uint = (v: unknown): bigint => { if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error(UNEXPECTED); return BigInt(v); };

/**
 * SCRT through public LCD (REST) servers. Plain SCRT transfers are public on the chain. sSCRT, its private form, hides
 * amounts and addresses: calls to its contract are encrypted for the enclave, and only a viewing key can read the balance.
 */
export class ScrtClient {
  private cache: { at: number; amount: bigint } | null = null;
  private privateCache: { at: number; amount: bigint | null } | null = null;
  readonly address: string;
  constructor(private readonly publicKey: Uint8Array, private readonly lcds: string[], private readonly agent?: Agent, private readonly timeoutMs = 20_000,
    private readonly privacy?: { encryptionSeed: Uint8Array; viewingKey: string }) { this.address = scrtAddressFromKey(publicKey); }

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

  /** The node runs the transaction without a real signature to tell how much gas it needs. */
  private async gasFor(trial: ScrtDraft, nonce?: Uint8Array): Promise<{ gas: bigint; fee: bigint }> {
    const sim = await this.post('/cosmos/tx/v1beta1/simulate', { tx_bytes: b64(encodeTransfer(this.publicKey, trial, () => new Uint8Array(64)).bytes) });
    const used = sim.body?.gas_info?.gas_used;
    if (sim.status >= 400 || typeof used !== 'string' || !/^\d+$/.test(used)) throw new Error(`Could not estimate the fee: ${this.reason(sim.body?.message ?? sim.status, nonce).slice(0, 200)}`);
    const gas = (BigInt(used) * 13n) / 10n + 1_000n;
    if (gas > (trial.exec ? MAX_CONTRACT_GAS : MAX_GAS)) throw new Error('This send needs an abnormal amount of gas, so it was stopped.');
    return { gas, fee: (gas * GAS_PRICE_MILLI + 999n) / 1000n };
  }

  /** The enclave encrypts its error messages too; this reads ours back. */
  private reason(message: unknown, nonce?: Uint8Array): string {
    const text = String(message);
    const m = text.match(/encrypted: ([A-Za-z0-9+/=]+)/);
    if (m && nonce && this.privacy) {
      try { return text.replace(m[0], new TextDecoder().decode(decryptFromContract(this.privacy.encryptionSeed, nonce, Uint8Array.from(Buffer.from(m[1], 'base64'))))); } catch { /* not ours */ }
    }
    return text;
  }

  async draft(to: string, amount: bigint | 'max'): Promise<ScrtDraft> {
    if (!isScrtAddress(to)) throw new Error('Not a Secret Network address. Only addresses starting with secret1 can be used.');
    if (to === this.address) throw new Error('You cannot send to your own address.');
    this.cache = null;
    const [held, acct] = await Promise.all([this.getBalance(), this.account()]);
    const { gas, fee } = await this.gasFor({ to, amount: amount === 'max' ? held || 1n : amount, fee: 0n, gas: 0n, ...acct });
    const value = amount === 'max' ? held - fee : amount;
    if (value <= 0n) throw new Error('No SCRT left to send after the fee.');
    if (value + fee > held) throw new Error('Not enough SCRT to cover the amount and fee.');
    return { to, amount: value, fee, gas, ...acct };
  }

  // ---- sSCRT ----

  private keys() {
    if (!this.privacy) throw new Error('Private SCRT isn\'t available in this session.');
    return this.privacy;
  }

  /** A private query to sSCRT. The answer is encrypted for us alone. */
  private async query(msg: object): Promise<any> {
    const { encryptionSeed } = this.keys();
    const nonce = randomNonce();
    const sealed = encryptForContract(encryptionSeed, msg, nonce);
    let r: any;
    try {
      r = await this.get(`/compute/v1beta1/query/${SSCRT_CONTRACT}?query=${encodeURIComponent(b64(sealed))}`);
    } catch (e) {
      throw new Error(this.reason(e instanceof Error ? e.message : e, nonce).slice(0, 200));
    }
    if (typeof r?.data !== 'string') throw new Error(UNEXPECTED);
    const plain = new TextDecoder().decode(decryptFromContract(encryptionSeed, nonce, Uint8Array.from(Buffer.from(r.data, 'base64'))));
    try { return JSON.parse(Buffer.from(plain, 'base64').toString('utf8')); } catch { throw new Error(UNEXPECTED); }
  }

  /** null means the viewing key isn't set on the contract yet, so the balance can't be read. */
  async getPrivateBalance(): Promise<bigint | null> {
    if (!this.privateCache || Date.now() - this.privateCache.at > CACHE_MS) {
      const r = await this.query({ balance: { address: this.address, key: this.keys().viewingKey } });
      const amount = r?.viewing_key_error ? null : uint(r?.balance?.amount);
      this.privateCache = { at: Date.now(), amount };
    }
    return this.privateCache.amount;
  }

  /**
   * wrap: SCRT into sSCRT. unwrap: back to plain SCRT. transfer: sSCRT to another address, with amount and address
   * hidden. key: sets this wallet's viewing key, once, so the balance can be read.
   */
  async draftPrivate(kind: ScrtExec['kind'], to: string, amount: bigint | 'max'): Promise<ScrtDraft> {
    const { encryptionSeed, viewingKey } = this.keys();
    if (kind === 'transfer') {
      if (!isScrtAddress(to)) throw new Error('Not a Secret Network address. Only addresses starting with secret1 can be used.');
      if (to === this.address) throw new Error('You cannot send to your own address.');
    }
    this.cache = null;
    this.privateCache = null;
    const [held, acct, hidden] = await Promise.all([this.getBalance(), this.account(), kind === 'unwrap' || kind === 'transfer' ? this.getPrivateBalance() : Promise.resolve(0n)]);
    if (hidden === null) throw new Error('Turn on the private balance first, so the wallet can read it.');
    const want = amount === 'max' ? (kind === 'wrap' ? held : hidden) : amount;
    if (kind !== 'key' && want <= 0n) throw new Error(kind === 'wrap' ? 'No SCRT to make private.' : 'No sSCRT to use.');
    const msg: Record<string, Record<string, unknown>> = kind === 'wrap' ? { deposit: {} }
      : kind === 'unwrap' ? { redeem: { amount: want.toString(), denom: DENOM } }
      : kind === 'transfer' ? { transfer: { recipient: to, amount: want.toString() } }
      : { set_viewing_key: { key: viewingKey } };
    const nonce = randomNonce();
    const exec = (funds: bigint): ScrtExec => ({ kind, msg: encryptForContract(encryptionSeed, padded(msg), nonce), nonce, funds });
    const target = kind === 'transfer' ? to : this.address;
    const { gas, fee } = await this.gasFor({ to: target, amount: want, fee: 0n, gas: 0n, ...acct, exec: exec(kind === 'wrap' ? want : 0n) }, nonce);
    let value = want;
    if (kind === 'wrap') {
      if (amount === 'max') value = held - fee;
      if (value <= 0n) throw new Error('No SCRT left to make private after the fee.');
      if (value + fee > held) throw new Error('Not enough SCRT to cover the amount and fee.');
    } else {
      if (fee > held) throw new Error('The fee is paid in plain SCRT, and there isn\'t enough of it.');
      if (kind !== 'key' && value > hidden) throw new Error('Not enough sSCRT.');
    }
    return { to: target, amount: value, fee, gas, ...acct, exec: exec(kind === 'wrap' ? value : 0n) };
  }

  /** Deposits, withdrawals and private transfers, read with the viewing key. */
  async getPrivateHistory() {
    const { viewingKey } = this.keys();
    if ((await this.getPrivateBalance()) === null) return [];
    let txs: any[] = [];
    try {
      const r = await this.query({ transaction_history: { address: this.address, key: viewingKey, page_size: HISTORY_LIMIT } });
      txs = r?.transaction_history?.txs ?? [];
    } catch {
      const r = await this.query({ transfer_history: { address: this.address, key: viewingKey, page_size: HISTORY_LIMIT } });
      txs = (r?.transfer_history?.txs ?? []).map((t: any) => ({ ...t, action: { transfer: { from: t.from, recipient: t.receiver } } }));
    }
    const items = [];
    for (const t of txs) {
      const amount = /^\d+$/.test(String(t?.coins?.amount)) ? BigInt(t.coins.amount) : null;
      if (amount === null || !t?.action) continue;
      const a = t.action;
      const direction = a.deposit || a.mint || (a.transfer && a.transfer.recipient === this.address) ? 'in' as const : 'out' as const;
      items.push({
        asset: 'SSCRT' as const, hash: `sSCRT-${t.id}`, direction, amount: formatAmount(amount, 6),
        counterparty: a.transfer ? (direction === 'in' ? a.transfer.from : a.transfer.recipient) ?? '' : a.deposit ? 'From SCRT' : a.redeem ? 'To SCRT' : '',
        timestamp: Number(t.block_time) ? Number(t.block_time) * 1000 : Date.now(),
        status: 'confirmed' as const, dust: false,
      });
    }
    return items;
  }

  async send(draft: ScrtDraft, mnemonic: string): Promise<string> {
    if (scrtAddress(mnemonic) !== this.address) throw new Error('This wallet\'s seed does not match the SCRT account.');
    const { bytes, hash } = signScrtTransfer(mnemonic, draft);
    const res = await this.post('/cosmos/tx/v1beta1/txs', { tx_bytes: b64(bytes), mode: 'BROADCAST_MODE_SYNC' });
    const r = res.body?.tx_response;
    if (res.status >= 400 || !r) throw new Error(`Send rejected: ${String(res.body?.message ?? res.status).slice(0, 200)}`);
    if (r.code) throw new Error(`Send rejected: ${this.reason(r.raw_log ?? r.code, draft.exec?.nonce).slice(0, 200)}`);
    if (String(r.txhash).toUpperCase() !== hash) throw new Error(`The server returned a different transaction ID. Check ${hash} on an explorer.`);
    this.cache = null;
    this.privateCache = null;
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
      // Making SCRT private sends it to the sSCRT contract; making it public again comes back as a transfer from it.
      for (const m of r.tx?.body?.messages ?? []) {
        if (m?.['@type'] !== '/secret.compute.v1beta1.MsgExecuteContract' || !sameAddress(m.contract, SSCRT_CONTRACT) || !sameAddress(m.sender, this.address)) continue;
        net -= (m.sent_funds ?? []).filter((c: any) => c?.denom === DENOM).reduce((t: bigint, c: any) => t + (/^\d+$/.test(String(c.amount)) ? BigInt(c.amount) : 0n), 0n);
      }
      for (const e of r.events ?? []) {
        if (e?.type !== 'transfer') continue;
        const at = Object.fromEntries((e.attributes ?? []).map((x: any) => [attr(x.key), attr(x.value)]));
        if (at.sender === SSCRT_CONTRACT && at.recipient === this.address) net += BigInt(/^(\d+)uscrt$/.exec(at.amount ?? '')?.[1] ?? '0');
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
