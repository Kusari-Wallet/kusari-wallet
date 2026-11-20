// SUI on Sui. The key is ed25519 at m/44'/784'/0'/0'/0' (SLIP-0010, the path Sui wallets use for 12 words), so the
// same words show the same address there. Must never change. Transactions are built and signed here with
// @mysten/sui (offline: the coins, gas price and budget are set here) and go out through Sui's GraphQL service,
// which replaced its JSON-RPC in 2026.
import type { Agent } from 'node:http';
import { computeHmac, getBytes, toUtf8Bytes } from 'ethers';
import { bip39Seed } from './seed';
import { requestJson } from './request';
import { formatAmount } from './amount';

const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
const { Transaction } = require('@mysten/sui/transactions');

export const SUI_PATH = [44, 784, 0, 0, 0];
const SUI_TYPE = '0x2::sui::SUI';
const COIN_TYPE = `0x2::coin::Coin<${SUI_TYPE}>`;
const CACHE_MS = 30_000;
const MAX_COINS = 50;
/** The budget a simulation runs with; the real one is what it used, with room. */
const SIM_BUDGET = 50_000_000n;

export interface SuiCoinRef { objectId: string; version: string; digest: string; balance: bigint }
export interface SuiDraft { to: string; amount: bigint; fee: bigint; budget: bigint; price: bigint; coins: SuiCoinRef[]; all: boolean }

function deriveSecret(mnemonic: string): Uint8Array {
  const step = (key: Uint8Array, data: Uint8Array) => getBytes(computeHmac('sha512', key, data));
  let node = step(toUtf8Bytes('ed25519 seed'), bip39Seed(mnemonic));
  for (const part of SUI_PATH) {
    const data = new Uint8Array(37);
    data.set(node.slice(0, 32), 1);
    new DataView(data.buffer).setUint32(33, (part | 0x80000000) >>> 0);
    node = step(node.slice(32), data);
  }
  return node.slice(0, 32);
}
const keypairOf = (mnemonic: string) => Ed25519Keypair.fromSecretKey(deriveSecret(mnemonic));
export function suiAddress(mnemonic: string): string { return keypairOf(mnemonic).toSuiAddress(); }
export const isSuiAddress = (a: string): boolean => /^0x[0-9a-f]{64}$/.test(a.trim());

/** The transaction's bytes: a split from the gas coin to the receiver, or (all) the gas coin itself. */
export async function buildSuiTransfer(sender: string, d: SuiDraft, budget = d.budget): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasOwner(sender);
  tx.setGasPrice(d.price);
  tx.setGasBudget(budget);
  tx.setGasPayment(d.coins.map((c) => ({ objectId: c.objectId, version: c.version, digest: c.digest })));
  if (d.all) tx.transferObjects([tx.gas], tx.pure.address(d.to));
  else { const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(d.amount)]); tx.transferObjects([coin], tx.pure.address(d.to)); }
  return tx.build();
}

export async function signSuiTransfer(mnemonic: string, sender: string, d: SuiDraft): Promise<{ bytes: string; signature: string }> {
  const kp = keypairOf(mnemonic);
  if (kp.toSuiAddress() !== sender) throw new Error('This wallet\'s seed does not match the SUI address.');
  const bytes = await buildSuiTransfer(sender, d);
  const { signature } = await kp.signTransaction(bytes);
  return { bytes: Buffer.from(bytes).toString('base64'), signature };
}

const UNEXPECTED = 'The Sui server gave an unexpected answer.';
const big = (v: unknown): bigint => { if (typeof v !== 'string' && typeof v !== 'number') throw new Error(UNEXPECTED); const s = String(v); if (!/^-?\d+$/.test(s)) throw new Error(UNEXPECTED); return BigInt(s); };

export class SuiClient {
  private cache: { at: number; total: bigint; spendable: bigint } | null = null;
  constructor(readonly address: string, private readonly endpoints: string[], private readonly agent?: Agent, private readonly timeoutMs = 20_000) {}
  get receiveAddress(): string { return this.address; }

  private async gql(query: string, variables: Record<string, unknown>): Promise<any> {
    let last: unknown;
    for (const url of this.endpoints) {
      try {
        const res = await requestJson(url, { method: 'POST', body: { query, variables }, agent: this.agent, timeoutMs: this.timeoutMs });
        if (res.status === 429 || res.status >= 500) throw new Error(`Server error (${res.status})`);
        if (Array.isArray(res.body?.errors) && res.body.errors.length) {
          const e = new Error(String(res.body.errors[0]?.message ?? 'The server refused this.').slice(0, 200));
          (e as any).final = true;
          throw e;
        }
        if (!res.body?.data) throw new Error(UNEXPECTED);
        return res.body.data;
      } catch (e) { if ((e as any).final) throw e; last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach the Sui server.');
  }

  /** total counts every SUI the address holds; spendable is what sits in coins, which is what sends use. */
  async getBalance(): Promise<{ total: bigint; spendable: bigint }> {
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      const d = await this.gql('query($a: SuiAddress!) { address(address: $a) { balance(coinType: "0x2::sui::SUI") { totalBalance coinBalance } } }', { a: this.address });
      const b = d?.address?.balance;
      const total = b ? big(b.totalBalance ?? '0') : 0n;
      const coins = b ? big(b.coinBalance ?? b.totalBalance ?? '0') : 0n;
      this.cache = { at: Date.now(), total, spendable: coins };
    }
    return { total: this.cache.total, spendable: this.cache.spendable };
  }

  private async coins(): Promise<SuiCoinRef[]> {
    const d = await this.gql(`query($a: SuiAddress!) { address(address: $a) { objects(first: ${MAX_COINS}, filter: { type: "${COIN_TYPE}" }) { nodes { address version digest contents { json } } } } }`, { a: this.address });
    const nodes: any[] = d?.address?.objects?.nodes ?? [];
    return nodes.map((n) => {
      if (!isSuiAddress(String(n?.address ?? '')) || typeof n?.digest !== 'string') throw new Error(UNEXPECTED);
      return { objectId: n.address, version: String(n.version), digest: n.digest, balance: big(n?.contents?.json?.balance ?? '0') };
    }).sort((a, b) => (b.balance > a.balance ? 1 : -1));
  }

  async draft(to: string, amount: bigint | 'max'): Promise<SuiDraft> {
    const dest = to.trim().toLowerCase();
    if (!isSuiAddress(dest)) throw new Error('Not a Sui address. Sui addresses are 0x and 64 hex characters.');
    if (dest === this.address) throw new Error('You cannot send to your own address.');
    this.cache = null;
    const [coins, epoch] = await Promise.all([this.coins(), this.gql('{ epoch { referenceGasPrice } }', {})]);
    const price = big(epoch?.epoch?.referenceGasPrice);
    if (price <= 0n || price > 100_000n) throw new Error('The fee is abnormally high, so this was stopped.');
    if (!coins.length) throw new Error('No SUI to send yet.');
    const held = coins.reduce((s, c) => s + c.balance, 0n);
    const all = amount === 'max';
    const trial: SuiDraft = { to: dest, amount: all ? 0n : amount, fee: 0n, budget: held < SIM_BUDGET ? held : SIM_BUDGET, price, coins, all };
    if (!all && amount + SIM_BUDGET > held) trial.budget = held > amount ? held - amount : 1n;
    // What it costs, from a dry run of this very transaction.
    const sim = await this.gql('query($t: JSON!) { simulateTransaction(transaction: $t) { effects { status executionError { message } gasEffects { gasSummary { computationCost storageCost storageRebate } } } } }',
      { t: { bcs: { value: Buffer.from(await buildSuiTransfer(this.address, trial)).toString('base64') } } });
    const eff = sim?.simulateTransaction?.effects;
    const g = eff?.gasEffects?.gasSummary;
    if (!g) throw new Error(UNEXPECTED);
    if (eff.status !== 'SUCCESS' && !all) throw new Error(`The network would refuse this: ${String(eff?.executionError?.message ?? 'not enough SUI').slice(0, 160)}`);
    const used = big(g.computationCost) + big(g.storageCost);
    const fee = used - big(g.storageRebate) > 0n ? used - big(g.storageRebate) : used;
    const budget = (used * 12n) / 10n + 1_000n;
    const value = all ? held - fee : amount;
    if (value <= 0n) throw new Error('No SUI left to send after the fee.');
    if (!all && value + budget > held) throw new Error(`Not enough SUI. Up to ${formatAmount(held > budget ? held - budget : 0n, 9)} SUI can be sent with the fee.`);
    return { to: dest, amount: value, fee, budget, price, coins, all };
  }

  async send(d: SuiDraft, mnemonic: string): Promise<string> {
    const { bytes, signature } = await signSuiTransfer(mnemonic, this.address, d);
    const r = await this.gql('mutation($tx: Base64!, $sigs: [Base64!]!) { executeTransaction(transactionDataBcs: $tx, signatures: $sigs) { effects { digest status executionError { message } } } }', { tx: bytes, sigs: [signature] });
    const eff = r?.executeTransaction?.effects;
    if (!eff?.digest) throw new Error(UNEXPECTED);
    if (eff.status !== 'SUCCESS') throw new Error(`Send rejected: ${String(eff?.executionError?.message ?? eff.status).slice(0, 200)}`);
    this.cache = null;
    return String(eff.digest);
  }

  async getHistory() {
    const d = await this.gql('query($a: SuiAddress!) { address(address: $a) { transactions(last: 20, relation: AFFECTED) { nodes { digest sender { address } effects { status timestamp balanceChanges(first: 20) { nodes { owner { address } amount coinType { repr } } } } } } } }', { a: this.address });
    const items: any[] = [];
    for (const t of d?.address?.transactions?.nodes ?? []) {
      const changes: any[] = t?.effects?.balanceChanges?.nodes ?? [];
      const mine = changes.find((c) => c?.owner?.address === this.address && /::sui::SUI$/.test(String(c?.coinType?.repr ?? '')));
      if (!mine) continue;
      const delta = big(mine.amount);
      const incoming = delta > 0n;
      const other = changes.find((c) => c?.owner?.address !== this.address && /::sui::SUI$/.test(String(c?.coinType?.repr ?? '')));
      items.push({
        asset: 'SUI' as const, hash: String(t.digest), direction: incoming ? 'in' as const : 'out' as const,
        amount: formatAmount(incoming ? delta : -delta, 9), counterparty: String(incoming ? t?.sender?.address ?? '' : other?.owner?.address ?? ''),
        timestamp: Date.parse(String(t?.effects?.timestamp ?? '')) || Date.now(),
        status: t?.effects?.status === 'SUCCESS' ? 'confirmed' as const : 'failed' as const,
        dust: incoming && delta < 1_000_000n,
      });
    }
    return items.reverse();
  }
}
