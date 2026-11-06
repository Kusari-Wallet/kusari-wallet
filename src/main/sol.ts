import type { Agent } from 'node:http';
import { computeHmac, getBytes, toUtf8Bytes } from 'ethers';
import { requestJson } from './request';
import { formatAmount } from './amount';

const { mnemonicToSeedSync } = require('@scure/bip39');
const { ed25519 } = require('@noble/curves/ed25519.js');
const { base58 } = require('@scure/base');

// The path Phantom and Solflare use, so this seed shows the same address there. Must never change.
export const SOL_PATH = [44, 501, 0, 0];
export const SOL_FEE = 5_000n; // lamports, one signature
export const SOL_RENT_MINIMUM = 890_880n; // what an empty account needs to exist
const SYSTEM_PROGRAM = new Uint8Array(32);
const CACHE_MS = 60_000;
const HISTORY_LIMIT = 15;

export interface SolDraft { to: string; amount: bigint; fee: bigint }

/** SLIP-0010: on this curve every step is hardened. */
function deriveSecret(mnemonic: string): Uint8Array {
  const step = (key: Uint8Array, data: Uint8Array) => getBytes(computeHmac('sha512', key, data));
  let node = step(toUtf8Bytes('ed25519 seed'), mnemonicToSeedSync(mnemonic));
  for (const part of SOL_PATH) {
    const data = new Uint8Array(37);
    data.set(node.slice(0, 32), 1);
    new DataView(data.buffer).setUint32(33, (part | 0x80000000) >>> 0);
    node = step(node.slice(32), data);
  }
  return node.slice(0, 32);
}

export function solAddress(mnemonic: string): string {
  return base58.encode(ed25519.getPublicKey(deriveSecret(mnemonic)));
}

export function isSolAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  try {
    const raw: Uint8Array = base58.decode(address);
    return raw.length === 32 && raw.some((b) => b !== 0); // all zeros is the system program, which can't hold coins for anyone
  } catch { return false; }
}

const compact = (n: number) => Uint8Array.from(n < 128 ? [n] : [(n & 127) | 128, n >> 7]);
function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A legacy message with one System Program transfer. Returns the signed transaction and its id. */
export function signSolTransfer(mnemonic: string, to: string, lamports: bigint, recentBlockhash: string): { base64: string; id: string } {
  if (!isSolAddress(to)) throw new Error('The receiving address is not a SOL address.');
  if (lamports <= 0n) throw new Error('The amount must be more than zero.');
  const secret = deriveSecret(mnemonic);
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // Transfer
  view.setBigUint64(4, lamports, true);
  const blockhash: Uint8Array = base58.decode(recentBlockhash);
  if (blockhash.length !== 32) throw new Error('The server gave an unexpected answer.');
  const message = join([
    Uint8Array.from([1, 0, 1]), // one signer, the program is read-only
    compact(3), ed25519.getPublicKey(secret), base58.decode(to), SYSTEM_PROGRAM,
    blockhash,
    compact(1), Uint8Array.from([2]), compact(2), Uint8Array.from([0, 1]), compact(data.length), data,
  ]);
  const signature: Uint8Array = ed25519.sign(message, secret);
  const raw = join([compact(1), signature, message]);
  return { base64: btoa(String.fromCharCode(...raw)), id: base58.encode(signature) };
}

export class SolClient {
  private cache: { at: number; lamports: bigint } | null = null;
  constructor(readonly address: string, private readonly rpcs: string[], private readonly agent?: Agent, private readonly timeoutMs = 30_000) {}

  get receiveAddress(): string { return this.address; }

  private async rpc(method: string, params: unknown[]): Promise<any> {
    let last: unknown;
    for (const url of this.rpcs) {
      try {
        const res = await requestJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, agent: this.agent, timeoutMs: this.timeoutMs });
        if (res.status === 429 || res.status === 403) throw new Error(`Request failed with status code ${res.status}`);
        if (res.status >= 400 && !res.body?.error) throw new Error(`Server error (${res.status})`);
        if (res.body?.error) {
          const e = new Error(String(res.body.error.message ?? 'The server refused this.').slice(0, 200));
          (e as any).final = true; // Another server would say the same.
          throw e;
        }
        return res.body?.result;
      } catch (e) {
        if ((e as any).final) throw e;
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error('Could not reach the SOL server.');
  }

  private async lamports(account: string): Promise<bigint> {
    const r = await this.rpc('getBalance', [account, { commitment: 'confirmed' }]);
    if (!Number.isSafeInteger(r?.value)) throw new Error('The SOL server gave an unexpected answer.');
    return BigInt(r.value);
  }

  async getBalance(): Promise<{ total: bigint; spendable: bigint }> {
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) this.cache = { at: Date.now(), lamports: await this.lamports(this.address) };
    return { total: this.cache.lamports, spendable: this.cache.lamports };
  }

  async draft(to: string, amount: bigint | 'max'): Promise<SolDraft> {
    this.cache = null;
    const balance = (await this.getBalance()).spendable;
    const value = amount === 'max' ? balance - SOL_FEE : amount;
    if (value <= 0n) throw new Error('No SOL left to send after the fee.');
    if (value + SOL_FEE > balance) throw new Error('Not enough SOL to cover the amount and fee.');
    const left = balance - value - SOL_FEE;
    if (left > 0n && left < SOL_RENT_MINIMUM) throw new Error(`Solana accounts must keep at least ${formatAmount(SOL_RENT_MINIMUM, 9)} SOL or be emptied. Send less, or send the maximum.`);
    if (value < SOL_RENT_MINIMUM && (await this.lamports(to)) === 0n) throw new Error(`This address has no SOL yet, so it needs at least ${formatAmount(SOL_RENT_MINIMUM, 9)} SOL to start.`);
    return { to, amount: value, fee: SOL_FEE };
  }

  async send(draft: SolDraft, mnemonic: string): Promise<string> {
    const latest = await this.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const blockhash = latest?.value?.blockhash;
    if (typeof blockhash !== 'string') throw new Error('The SOL server gave an unexpected answer.');
    const { base64, id } = signSolTransfer(mnemonic, draft.to, draft.amount, blockhash);
    const answer = await this.rpc('sendTransaction', [base64, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    if (answer !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
    this.cache = null;
    return id;
  }

  async getHistory() {
    const list: any[] = await this.rpc('getSignaturesForAddress', [this.address, { limit: HISTORY_LIMIT }]);
    const rows = (Array.isArray(list) ? list : []).filter((s) => !s.err && typeof s.signature === 'string');
    const items = await Promise.all(rows.map(async (s) => {
      const tx = await this.rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
      const keys: string[] = tx?.transaction?.message?.accountKeys ?? [];
      const me = keys.indexOf(this.address);
      if (me < 0 || !tx?.meta) return null;
      const net = BigInt(tx.meta.postBalances?.[me] ?? 0) - BigInt(tx.meta.preBalances?.[me] ?? 0);
      if (net === 0n) return null;
      return {
        asset: 'SOL' as const, hash: String(s.signature), direction: net > 0n ? 'in' as const : 'out' as const,
        amount: formatAmount(net < 0n ? -net : net, 9), counterparty: '',
        timestamp: Number(s.blockTime ?? Date.now() / 1000) * 1000,
        status: s.confirmationStatus === 'finalized' || s.confirmationStatus === 'confirmed' ? 'confirmed' as const : 'pending' as const,
        dust: net > 0n && net < 1_000n,
      };
    }));
    return items.filter((i): i is NonNullable<typeof i> => i !== null);
  }
}
