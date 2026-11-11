import type { Agent } from 'node:http';
import { computeHmac, getBytes, sha256, toUtf8Bytes } from 'ethers';
import { getJson, requestJson } from './request';
import { formatAmount } from './amount';

const { mnemonicToSeedSync } = require('@scure/bip39');
const { ed25519 } = require('@noble/curves/ed25519.js');
const { base58 } = require('@scure/base');

/**
 * NEAR on its own chain. The account is the implicit one, the public key in hex, from m/44'/397'/0' as MyNearWallet
 * and near-seed-phrase derive it, so the same seed shows the same account there. Must never change.
 */
export const NEAR_PATH = [44, 397, 0];
const YOCTO = 10n ** 24n;
// An account keeps storage_usage × this much, always; the protocol refuses sends that would cut into it.
const STORAGE_PRICE = 10n ** 19n; // yoctoNEAR per byte
// A plain transfer burns about 0.45 Tgas; with the protocol's 2× price buffer this covers it with room.
const TRANSFER_GAS = 450_000_000_000n;
const CACHE_MS = 30_000;

export interface NearDraft { to: string; amount: bigint; fee: bigint; nonce: bigint; blockHash: string }

function deriveSecret(mnemonic: string): Uint8Array {
  const step = (key: Uint8Array, data: Uint8Array) => getBytes(computeHmac('sha512', key, data));
  let node = step(toUtf8Bytes('ed25519 seed'), mnemonicToSeedSync(mnemonic));
  for (const part of NEAR_PATH) {
    const data = new Uint8Array(37);
    data.set(node.slice(0, 32), 1);
    new DataView(data.buffer).setUint32(33, (part | 0x80000000) >>> 0);
    node = step(node.slice(32), data);
  }
  return node.slice(0, 32);
}

export function nearPublicKey(mnemonic: string): Uint8Array { return ed25519.getPublicKey(deriveSecret(mnemonic)); }
export const nearAccountOf = (publicKey: Uint8Array): string => Buffer.from(publicKey).toString('hex');
export function nearAccount(mnemonic: string): string { return nearAccountOf(nearPublicKey(mnemonic)); }

/** Named accounts (alice.near, x.tg), implicit ones (64 hex) and Ethereum-style implicit ones (0x + 40 hex). */
export function isNearAccount(id: string): boolean {
  if (/^[0-9a-f]{64}$/.test(id) || /^0x[0-9a-f]{40}$/.test(id)) return true;
  return id.length >= 2 && id.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id) && /\./.test(id);
}

// ---- Borsh, just what a transfer needs ----
const u8 = (n: number) => Uint8Array.of(n);
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const u128 = (n: bigint) => join([u64(n & 0xffff_ffff_ffff_ffffn), u64(n >> 64n)]);
const str = (s: string) => { const b = new TextEncoder().encode(s); return join([u32(b.length), b]); };
function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Transaction { signer, key, nonce, receiver, block hash, [Transfer] }, signed over its SHA-256. */
export function signNearTransfer(mnemonic: string, draft: NearDraft): { base64: string; hash: string } {
  if (!isNearAccount(draft.to)) throw new Error('Not a NEAR account.');
  if (draft.amount <= 0n) throw new Error('The amount must be more than zero.');
  const secret = deriveSecret(mnemonic);
  const pub = ed25519.getPublicKey(secret);
  const blockHash = base58.decode(draft.blockHash);
  if (blockHash.length !== 32) throw new Error('The NEAR server gave an unexpected answer.');
  const tx = join([
    str(nearAccountOf(pub)), u8(0), pub, u64(draft.nonce), str(draft.to), blockHash,
    u32(1), u8(3), u128(draft.amount), // one action: Transfer
  ]);
  const digest = getBytes(sha256(tx));
  const signature: Uint8Array = ed25519.sign(digest, secret);
  return { base64: Buffer.from(join([tx, u8(0), signature])).toString('base64'), hash: base58.encode(digest) };
}

const UNEXPECTED = 'The NEAR server gave an unexpected answer.';
const yocto = (v: unknown): bigint => { if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error(UNEXPECTED); return BigInt(v); };

export class NearClient {
  private cache: { at: number; total: bigint; spendable: bigint } | null = null;
  readonly account: string;
  constructor(private readonly publicKey: Uint8Array, private readonly rpcs: string[], private readonly history: string | string[], private readonly agent?: Agent, private readonly timeoutMs = 20_000) {
    this.account = nearAccountOf(publicKey);
  }

  get receiveAddress(): string { return this.account; }

  private async rpc(method: string, params: unknown): Promise<any> {
    let last: unknown;
    for (const url of this.rpcs) {
      try {
        const res = await requestJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: 'kusari', method, params }, agent: this.agent, timeoutMs: this.timeoutMs });
        if (res.status >= 500 || res.status === 429) throw new Error(`Server error (${res.status})`);
        const b = res.body;
        if (b?.error) {
          const cause = String(b.error?.cause?.name ?? b.error?.name ?? '');
          if (cause === 'UNKNOWN_ACCOUNT') return { unknownAccount: true };
          throw new Error(String(b.error?.data ?? b.error?.message ?? cause).slice(0, 200));
        }
        return b?.result;
      } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach a NEAR server.');
  }

  /** total is what the account holds; spendable leaves out the part storage must keep. */
  async getBalance(): Promise<{ total: bigint; spendable: bigint }> {
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      const r = await this.rpc('query', { request_type: 'view_account', finality: 'final', account_id: this.account });
      // The chain creates an implicit account when NEAR first arrives at it.
      if (r?.unknownAccount) this.cache = { at: Date.now(), total: 0n, spendable: 0n };
      else {
        const total = yocto(r?.amount);
        const keep = BigInt(Number(r?.storage_usage ?? 0)) * STORAGE_PRICE;
        this.cache = { at: Date.now(), total, spendable: total > keep ? total - keep : 0n };
      }
    }
    return { total: this.cache.total, spendable: this.cache.spendable };
  }

  async draft(to: string, amount: bigint | 'max'): Promise<NearDraft> {
    const id = to.trim();
    if (!isNearAccount(id)) throw new Error('Not a NEAR account. Use a name like alice.near or a 64-character account.');
    if (id === this.account) throw new Error('You cannot send to your own address.');
    this.cache = null;
    const [{ spendable }, key, gasPrice] = await Promise.all([
      this.getBalance(),
      this.rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: this.account, public_key: `ed25519:${base58.encode(this.publicKey)}` }),
      this.rpc('gas_price', [null]),
    ]);
    if (key?.unknownAccount) throw new Error('This account has never received NEAR, so there is nothing to send yet.');
    // Someone holding this seed can remove its key from the account; then nothing can be signed with it.
    if (typeof key?.error === 'string') throw new Error('This seed\'s key is no longer on the NEAR account, so it can\'t send from it.');
    if (typeof key?.nonce !== 'number' || typeof key?.block_hash !== 'string') throw new Error(UNEXPECTED);
    const price = yocto(gasPrice?.gas_price);
    if (price > 10n ** 12n) throw new Error('The fee is abnormally high, so this was stopped.');
    const fee = TRANSFER_GAS * price * 2n;
    const value = amount === 'max' ? spendable - fee : amount;
    if (value <= 0n) throw new Error('No NEAR left to send after the fee and the part the account must keep.');
    if (value + fee > spendable) throw new Error(`Not enough NEAR. An account always keeps a small amount for its storage, so up to ${formatAmount(spendable > fee ? spendable - fee : 0n, 24)} NEAR can be sent.`);
    return { to: id, amount: value, fee, nonce: BigInt(key.nonce) + 1n, blockHash: key.block_hash };
  }

  async send(draft: NearDraft, mnemonic: string): Promise<string> {
    if (nearAccount(mnemonic) !== this.account) throw new Error('This wallet\'s seed does not match the NEAR account.');
    const { base64, hash } = signNearTransfer(mnemonic, draft);
    const r = await this.rpc('send_tx', { signed_tx_base64: base64, wait_until: 'INCLUDED' });
    const got = r?.transaction?.hash ?? r?.transaction_outcome?.id;
    if (got && got !== hash) throw new Error(`The server returned a different transaction ID. Check ${hash} on an explorer.`);
    const failure = r?.status?.Failure;
    if (failure) throw new Error(`Send rejected: ${JSON.stringify(failure).slice(0, 200)}`);
    this.cache = null;
    return hash;
  }

  /** Transfers in and out, from NearBlocks (the RPC keeps no history). Gas refunds from "system" are left out. */
  async getHistory() {
    // NearBlocks answers on more than one address; the next is asked when one fails.
    let body: any;
    let last: unknown;
    for (const base of Array.isArray(this.history) ? this.history : [this.history]) {
      try { body = await getJson(`${base}/account/${this.account}/txns?per_page=25`, { agent: this.agent, timeoutMs: this.timeoutMs, headers: { Accept: 'application/json' } }); break; } catch (e) { last = e; }
    }
    if (body === undefined) throw last instanceof Error ? last : new Error('Could not reach the NEAR history server.');
    const rows: any[] = Array.isArray(body?.txns) ? body.txns : [];
    const items = [];
    for (const r of rows) {
      const hash = String(r?.transaction_hash ?? '');
      if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash) || r?.predecessor_account_id === 'system') continue;
      const deposit = (r?.actions ?? []).filter((a: any) => a?.action === 'TRANSFER').reduce((s: number, a: any) => s + Number(a?.deposit ?? 0), 0);
      if (!(deposit > 0)) continue;
      const incoming = r.receiver_account_id === this.account && r.predecessor_account_id !== this.account;
      const outgoing = r.predecessor_account_id === this.account && r.receiver_account_id !== this.account;
      if (!incoming && !outgoing) continue;
      items.push({
        asset: 'NEAR' as const, hash, direction: incoming ? 'in' as const : 'out' as const,
        amount: (deposit / 1e24).toFixed(6).replace(/\.?0+$/, ''), counterparty: String(incoming ? r.predecessor_account_id : r.receiver_account_id),
        timestamp: Math.floor(Number(r.block_timestamp) / 1e6) || Date.now(),
        status: r?.outcomes?.status === false ? 'failed' as const : 'confirmed' as const,
        dust: incoming && deposit < 1e21,
      });
    }
    return items;
  }
}

export const NEAR_DECIMALS = 24;
export const NEAR_YOCTO = YOCTO;
