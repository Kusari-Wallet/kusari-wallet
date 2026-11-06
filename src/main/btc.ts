import type { Agent } from 'node:http';
import { getJson, requestText } from './request';
import { formatAmount } from './amount';

// These packages are ESM only, which require() handles in this Node version.
const { HDKey } = require('@scure/bip32');
const { mnemonicToSeedSync } = require('@scure/bip39');
const btc = require('@scure/btc-signer');

export const BTC_PATH = "m/86'/0'/0'"; // taproot
const GAP = 20;
const GAP_CHANGE = 5;
const GAP_RECHECK = 3; // past the last used address, on the quick rechecks
const FULL_SCAN_MS = 6 * 60 * 60_000;
const COOLDOWN_MS = 90_000;
const DUST = 294n;
const MAX_FEE_RATE = 300n; // sat/vB; a higher answer from an API is treated as broken
const CACHE_MS = 180_000;

export interface BtcScanHints { used: string[]; nexts: Record<string, number>; lastFullScan: number }
export interface BtcUtxo { txid: string; vout: number; value: bigint; address: string; chain: number; index: number; confirmed: boolean }
export interface BtcDraft { to: string; amount: bigint; fee: bigint; change: bigint; changeAddress: string; changePath: [number, number]; inputs: BtcUtxo[] }
export interface BtcHistoryItem { asset: 'BTC'; hash: string; direction: 'in' | 'out' | 'self'; amount: string; counterparty: string; timestamp: number; status: 'confirmed' | 'pending'; dust: boolean }

/** Public keys only: enough to find addresses and balances, not to spend. */
export function btcAccountXpub(mnemonic: string): string {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(BTC_PATH).publicExtendedKey;
}

const xOnly = (publicKey: Uint8Array) => publicKey.slice(1);

export function isBtcAddress(address: string): boolean {
  try { btc.Address().decode(address); return true; } catch { return false; }
}

/**
 * Virtual size, rounded up. Outputs are counted at 43 vB, the taproot size and the largest common
 * one, so a smaller destination pays a touch more rather than getting stuck.
 */
export function estimateVbytes(inputs: number, outputs: number): bigint {
  return BigInt(Math.ceil(10.5 + 57.5 * inputs + 43 * outputs));
}

/** Largest coins first, with no change output when the remainder would be dust. */
export function selectCoins(utxos: BtcUtxo[], amount: bigint | 'max', feeRate: bigint): { inputs: BtcUtxo[]; amount: bigint; fee: bigint; change: bigint } {
  const sorted = [...utxos].sort((a, b) => (b.value > a.value ? 1 : -1));
  if (sorted.length === 0) throw new Error('No BTC available to send. Deposits can be used after 1 confirmation.');
  if (amount === 'max') {
    const total = sorted.reduce((s, u) => s + u.value, 0n);
    const fee = estimateVbytes(sorted.length, 1) * feeRate;
    if (total - fee < DUST) throw new Error('No BTC left to send after the fee.');
    return { inputs: sorted, amount: total - fee, fee, change: 0n };
  }
  if (amount < DUST) throw new Error(`The minimum to send is ${formatAmount(DUST, 8)} BTC.`);
  const inputs: BtcUtxo[] = [];
  let total = 0n;
  for (const u of sorted) {
    inputs.push(u);
    total += u.value;
    const withChange = estimateVbytes(inputs.length, 2) * feeRate;
    if (total >= amount + withChange + DUST) return { inputs, amount, fee: withChange, change: total - amount - withChange };
    const noChange = estimateVbytes(inputs.length, 1) * feeRate;
    if (total >= amount + noChange) return { inputs, amount, fee: total - amount, change: 0n };
  }
  throw new Error('Not enough BTC to cover the amount and fee.');
}

export class BtcClient {
  private readonly account: any;
  private state: { at: number; utxos: BtcUtxo[]; total: bigint; spendable: bigint; nextReceive: number; nextChange: number; used: Set<string>; addresses: Map<string, [number, number]> } | null = null;
  private inFlight: Promise<void> | null = null;
  private lastFullScan = 0;
  private readonly nexts = new Map<string, number>();
  private readonly cooling = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Public servers limit requests per IP, so they go out one at a time with a gap. */
  static defaultSpacingMs = 400;
  spacingMs = BtcClient.defaultSpacingMs;
  private lastError: string | null = null;

  constructor(xpub: string, private readonly apis: string[], private readonly agent?: Agent, private readonly timeoutMs = 30_000) {
    this.account = HDKey.fromExtendedKey(xpub);
  }

  /** What the last scan learned, kept between launches so opening the app doesn't rescan every address. */
  onHints: ((hints: BtcScanHints) => void) | null = null;
  private hintsUsed: Set<string> | null = null;

  importHints(h: BtcScanHints): void {
    if (!h || !Array.isArray(h.used) || typeof h.nexts !== 'object' || !Number.isFinite(h.lastFullScan)) return;
    for (const [k, v] of Object.entries(h.nexts)) if (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 100_000) this.nexts.set(k, v as number);
    this.hintsUsed = new Set(h.used.filter((a) => typeof a === 'string'));
    this.lastFullScan = h.lastFullScan;
  }

  addressAt(chain: number, index: number): string {
    return btc.p2tr(xOnly(this.account.deriveChild(chain).deriveChild(index).publicKey)).address;
  }

  get receiveAddress(): string { return this.addressAt(0, this.state?.nextReceive ?? 0); }

  /** A server that said "too many requests" is left alone for a while. */
  private async get(path: string): Promise<any> {
    const turn = this.queue.then(async () => {
      let last: unknown;
      for (const base of this.apis) {
        if ((this.cooling.get(base) ?? 0) > Date.now()) continue;
        try {
          return await getJson(base + path, { agent: this.agent, timeoutMs: this.timeoutMs });
        } catch (e) {
          last = e;
          if (/429/.test((e as Error).message)) this.cooling.set(base, Date.now() + COOLDOWN_MS);
        }
      }
      if (!last || /429/.test((last as Error).message)) throw new Error('The BTC server is limiting requests for now. Your coins are safe, and it will retry automatically.');
      throw last instanceof Error ? last : new Error('Could not reach the BTC server.');
    });
    this.queue = turn.catch(() => undefined).then(() => (this.spacingMs ? new Promise((r) => setTimeout(r, this.spacingMs)) : undefined));
    return turn;
  }

  /** Full: every address up to the gap. Otherwise only addresses seen in use, plus a few after them. */
  private async scanChain(chain: number, out: { utxos: BtcUtxo[]; total: bigint; addresses: Map<string, [number, number]>; used: Set<string> }, full: boolean, usedBefore: Set<string>): Promise<number> {
    const key = `taproot${chain}`;
    const fullGap = chain === 0 ? GAP : GAP_CHANGE;
    const gap = full ? fullGap : GAP_RECHECK;
    const known = this.nexts.get(key) ?? 0;
    let next = full ? 0 : known;
    for (let index = 0; index < next + gap; index++) {
      const address = this.addressAt(chain, index);
      out.addresses.set(address, [chain, index]);
      if (!full && index < known && !usedBefore.has(address)) continue;
      const info = await this.get(`/address/${address}`);
      const c = info.chain_stats ?? {}; const m = info.mempool_stats ?? {};
      const count = (c.tx_count ?? 0) + (m.tx_count ?? 0);
      if (count === 0) continue;
      out.used.add(address);
      next = Math.max(next, index + 1);
      out.total += BigInt(c.funded_txo_sum ?? 0) - BigInt(c.spent_txo_sum ?? 0) + BigInt(m.funded_txo_sum ?? 0) - BigInt(m.spent_txo_sum ?? 0);
      if (BigInt(c.funded_txo_sum ?? 0) + BigInt(m.funded_txo_sum ?? 0) === BigInt(c.spent_txo_sum ?? 0) + BigInt(m.spent_txo_sum ?? 0)) continue;
      const list: any[] = await this.get(`/address/${address}/utxo`);
      for (const u of list) {
        if (!/^[0-9a-f]{64}$/.test(u.txid) || !Number.isInteger(u.vout)) throw new Error('The BTC server gave an unexpected answer.');
        out.utxos.push({ txid: u.txid, vout: u.vout, value: BigInt(u.value), address, chain, index, confirmed: Boolean(u.status?.confirmed) });
      }
    }
    this.nexts.set(key, next);
    return next;
  }

  refresh(force: boolean | 'full' = false): Promise<void> {
    if (!force && this.state && Date.now() - this.state.at < CACHE_MS) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = (async () => {
        const out = { utxos: [] as BtcUtxo[], total: 0n, addresses: new Map<string, [number, number]>(this.state?.addresses ?? []), used: new Set<string>() };
        const full = force === 'full' || (!this.state && !this.hintsUsed) || Date.now() - this.lastFullScan > FULL_SCAN_MS;
        const usedBefore = this.state?.used ?? this.hintsUsed ?? new Set<string>();
        const nextReceive = await this.scanChain(0, out, full, usedBefore);
        const nextChange = await this.scanChain(1, out, full, usedBefore);
        if (full) this.lastFullScan = Date.now();
        const spendable = out.utxos.filter((u) => u.confirmed).reduce((s, u) => s + u.value, 0n);
        this.state = { at: Date.now(), utxos: out.utxos, total: out.total, spendable, nextReceive, nextChange, addresses: out.addresses, used: out.used };
        this.lastError = null;
        this.onHints?.({ used: [...out.used], nexts: Object.fromEntries(this.nexts), lastFullScan: this.lastFullScan });
      })().catch((e) => { this.lastError = (e as Error).message; throw e; }).finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  /** Newest balance available now; the first scan fills in on a later call. */
  async getBalance(waitMs = 1500): Promise<{ total: bigint; spendable: bigint } | null> {
    const scan = this.refresh().catch(() => undefined);
    await Promise.race([scan, new Promise((r) => setTimeout(r, waitMs))]);
    if (!this.state && this.lastError) throw new Error(this.lastError);
    return this.state ? { total: this.state.total, spendable: this.state.spendable } : null;
  }

  async feeRate(): Promise<bigint> {
    let rate: number | undefined;
    try {
      const r = await this.get('/v1/fees/recommended');
      rate = r.halfHourFee;
    } catch { /* not every server has this */ }
    if (typeof rate !== 'number') {
      const r = await this.get('/fee-estimates');
      rate = r['3'];
    }
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) throw new Error('Could not read BTC fee information.');
    const fee = BigInt(Math.max(1, Math.ceil(rate)));
    if (fee > MAX_FEE_RATE) throw new Error(`The fee is abnormally high, so this was stopped (${fee} sat/vB).`);
    return fee;
  }

  async draft(to: string, amount: bigint | 'max'): Promise<BtcDraft> {
    await this.refresh(true);
    const state = this.state!;
    const rate = await this.feeRate();
    const picked = selectCoins(state.utxos.filter((u) => u.confirmed), amount, rate);
    return { to, amount: picked.amount, fee: picked.fee, change: picked.change, changeAddress: this.addressAt(1, state.nextChange), changePath: [1, state.nextChange], inputs: picked.inputs };
  }

  /** Signs here, checks the result against what was approved, then broadcasts. */
  async send(draft: BtcDraft, mnemonic: string): Promise<string> {
    const { hex, id } = signBtcDraft(draft, mnemonic);
    const answer = (await this.broadcast(hex)).trim();
    if (answer !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
    this.state = null;
    return id;
  }

  private async broadcast(hex: string): Promise<string> {
    let last: unknown;
    for (const base of this.apis) {
      try { return await requestText(`${base}/tx`, { method: 'POST', body: hex, agent: this.agent, timeoutMs: this.timeoutMs }); } catch (e) { last = e; }
    }
    throw last instanceof Error ? new Error(`Send rejected: ${last.message}`) : new Error('The send failed.');
  }

  async getHistory(): Promise<BtcHistoryItem[]> {
    await this.refresh().catch((e) => { if (!this.state) throw e; });
    const state = this.state;
    if (!state) return [];
    const mine = state.addresses;
    const used = [...state.used];
    const seen = new Map<string, any>();
    for (const address of used.slice(0, 20)) {
      for (const tx of (await this.get(`/address/${address}/txs`)) as any[]) seen.set(tx.txid, tx);
    }
    return [...seen.values()].map((tx): BtcHistoryItem => {
      const out = (tx.vout as any[]).reduce((s, o) => s + (mine.has(o.scriptpubkey_address) ? BigInt(o.value) : 0n), 0n);
      const spent = (tx.vin as any[]).reduce((s, i) => s + (mine.has(i.prevout?.scriptpubkey_address) ? BigInt(i.prevout.value) : 0n), 0n);
      const net = out - spent;
      const direction = spent === 0n ? 'in' : net < 0n ? 'out' : 'self';
      return {
        asset: 'BTC', hash: tx.txid, direction,
        amount: formatAmount(direction === 'in' ? out : net < 0n ? -net : net, 8),
        counterparty: '', timestamp: (tx.status?.block_time ?? Date.now() / 1000) * 1000,
        status: tx.status?.confirmed ? 'confirmed' : 'pending', dust: direction === 'in' && out < 1000n,
      };
    }).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  }
}

export function signBtcDraft(draft: BtcDraft, mnemonic: string): { hex: string; id: string } {
  const taproot = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(BTC_PATH);
  const tx = new btc.Transaction();
  const keys: Uint8Array[] = [];
  for (const u of draft.inputs) {
    const child = taproot.deriveChild(u.chain).deriveChild(u.index);
    const pay = btc.p2tr(xOnly(child.publicKey));
    if (pay.address !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: pay.script, amount: u.value }, tapInternalKey: pay.tapInternalKey });
    keys.push(child.privateKey);
  }
  tx.addOutputAddress(draft.to, draft.amount);
  if (draft.change > 0n) {
    const change = taproot.deriveChild(draft.changePath[0]).deriveChild(draft.changePath[1]);
    if (btc.p2tr(xOnly(change.publicKey)).address !== draft.changeAddress) throw new Error('The change address does not match this wallet\'s keys, so signing was stopped.');
    tx.addOutputAddress(draft.changeAddress, draft.change);
  }
  const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0n);
  if (totalIn - draft.amount - draft.change !== draft.fee) throw new Error('The amounts do not add up, so signing was stopped.');
  keys.forEach((k, i) => tx.signIdx(k, i));
  tx.finalize();
  return { hex: tx.hex, id: tx.id };
}
