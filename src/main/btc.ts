import { bip39Seed } from './seed';
import type { Agent } from 'node:http';
import { getJson, requestText } from './request';
import { blockbookGet, blockbookSend, isBlockbook } from './blockbook';
import { formatAmount } from './amount';
import type { FilterSync } from './btc-filter-sync';
import { isSilentAddress, silentOutputs, taprootScript, spCandidates, spOutput, spOutputKey, spPrivateKey, SP_SPEND_PATH, SP_SCAN_PATH } from './btc-silent';
import type { SilentScanner } from './btc-filter-sync';
import { randomInt } from 'node:crypto';

// These packages are ESM only, which require() handles in this Node version.
const { HDKey } = require('@scure/bip32');
const btc = require('@scure/btc-signer');

export const BTC_PATH = "m/86'/0'/0'"; // taproot
/** Coins out of a CoinJoin live in their own account, so they're never spent together with unmixed ones by accident. */
export const BTC_MIXED_PATH = "m/86'/0'/1'";
/**
 * Change for a payment to an older (segwit v0) address goes to one of these (BIP84, bc1q), as Bitcoin Core does:
 * taproot change beside a bc1q payment would show which output is the change. Kept as "chain 2" of the account.
 */
export const BTC_V0_PATH = "m/84'/0'/0'";
export const V0_CHAIN = 2;
/** Coins received on the Silent Payments address: not on any derivation path, each spent with its own tweak. */
export const SP_CHAIN = 3;
const GAP = 20;
const GAP_CHANGE = 5;
const GAP_RECHECK = 3; // past the last used address, on the quick rechecks
const FULL_SCAN_MS = 6 * 60 * 60_000;
const COOLDOWN_MS = 90_000;
const DUST = 294n;
const CACHE_MS = 180_000;
/** A server that failed is skipped for this long, so a scan doesn't wait out its timeout on every address. */
const DOWN_MS = 60_000;
/** Answers from a scan that broke off are reused this long, so the next try picks up where it stopped. */
const RESUME_MS = 120_000;


export interface BtcScanHints { used: string[]; nexts: Record<string, number>; lastFullScan: number }
export interface BtcUtxo {
  txid: string; vout: number; value: bigint; address: string; chain: number; index: number; confirmed: boolean;
  /** Silent Payments coins (chain SP_CHAIN): t_k, hex. */
  tweak?: string;
}
export interface BtcDraft {
  to: string; amount: bigint; fee: bigint; change: bigint; changeAddress: string; changePath: [number, number]; inputs: BtcUtxo[];
  /** A fee bump: the send (by ID) this one replaces (RBF), or the waiting transaction it pulls along (CPFP). */
  replaces?: string; cpfpOf?: string;
  /** Set as Bitcoin Core sets them, so a send doesn't stand out (see `coreLike`): lock time, change placed first. */
  lockTime?: number; changeFirst?: boolean;
}

/**
 * What Bitcoin Core does with a new send, so this wallet's look like the most common ones: the lock time is the
 * current height (and one time in ten up to 99 blocks less), so a miner gains nothing by redoing the last block; the
 * coins go in in random order; the change takes a random place among the outputs.
 */
export function coreLike(tip: number, rand: (n: number) => number = (n) => randomInt(n)): { lockTime: number; changeFirst: boolean; order: <T>(list: T[]) => T[] } {
  let lockTime = tip > 0 && tip < 500_000_000 ? tip : 0;
  if (lockTime && rand(10) === 0) lockTime = Math.max(0, lockTime - rand(100));
  const order = <T>(list: T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) { const j = rand(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  };
  return { lockTime, changeFirst: rand(2) === 0, order };
}
/** Each input says the transaction may be replaced by one paying more (BIP125), as most wallets do. */
export const RBF_SEQUENCE = 0xfffffffd;
/** Below this a taproot output isn't relayed. */
export const TAPROOT_DUST = 330n;
/** What differs between Bitcoin and the coins that copy its server API: keys, addresses, sizes and signing. */
export interface UtxoCoin {
  symbol: 'BTC' | 'LTC';
  address: (publicKey: Uint8Array) => string;
  sign: (draft: BtcDraft, mnemonic: string) => { hex: string; id: string };
  /** Virtual bytes of one input, the largest output, and dust. */
  inputVb: number; outputVb: number; dust: bigint; maxFeeRate: bigint;
  /** How far past the last used receiving address a full scan looks. */
  gap?: number;
  /** The address network, for reading addresses back into scripts (Bitcoin when left out). */
  network?: typeof btc.NETWORK;
}
export interface BtcHistoryItem { asset: 'BTC' | 'LTC'; hash: string; direction: 'in' | 'out' | 'self'; amount: string; counterparty: string; timestamp: number; status: 'confirmed' | 'pending'; dust: boolean }

/** Public keys only: enough to find addresses and balances, not to spend. */
export function btcAccountXpub(mnemonic: string, path = BTC_PATH): string {
  return HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(path).publicExtendedKey;
}

const xOnly = (publicKey: Uint8Array) => publicKey.slice(1);

export function isBtcAddress(address: string): boolean {
  try { btc.Address().decode(address); return true; } catch { return false; }
}

/**
 * Virtual size, rounded up. Outputs are counted at 43 vB, the taproot size and the largest common
 * one, so a smaller destination pays a touch more rather than getting stuck.
 */
export function estimateVbytes(inputs: number, outputs: number, inputVb = 57.5, outputVb = 43): bigint {
  return BigInt(Math.ceil(10.5 + inputVb * inputs + outputVb * outputs));
}

/** Virtual bytes of a payment to an address, by its kind. Silent Payments outputs are taproot. */
function outputVbFor(address: string): number {
  if (isSilentAddress(address)) return 43;
  try {
    const t = btc.Address().decode(address).type;
    return t === 'wpkh' ? 31 : t === 'pkh' ? 34 : t === 'sh' ? 32 : 43;
  } catch { return 43; }
}

/** Whether a payment's change should be segwit v0, as Bitcoin Core picks: taproot only beside a taproot payment. */
export function v0ChangeFor(to: string): boolean {
  if (isSilentAddress(to)) return false;
  try { return btc.Address().decode(to).type !== 'tr'; } catch { return false; }
}

/** The send's real size, inputs and outputs counted by their kinds, for fees that hold up with mixed coins. */
export function draftVbytes(d: { inputs: { chain: number }[]; to: string; change: bigint; changeAddress: string }): bigint {
  const ins = d.inputs.reduce((s, u) => s + (u.chain === V0_CHAIN ? 68.25 : 57.5), 0);
  const outs = outputVbFor(d.to) + (d.change > 0n ? outputVbFor(d.changeAddress) : 0);
  return BigInt(Math.ceil(10.5 + ins + outs));
}

/** Largest coins first, with no change output when the remainder would be dust. */
export function selectCoins(utxos: BtcUtxo[], amount: bigint | 'max', feeRate: bigint, coin: UtxoCoin = BITCOIN): { inputs: BtcUtxo[]; amount: bigint; fee: bigint; change: bigint } {
  const { symbol, dust } = coin;
  const size = (i: number, o: number) => estimateVbytes(i, o, coin.inputVb, coin.outputVb);
  const sorted = [...utxos].sort((a, b) => (b.value > a.value ? 1 : -1));
  if (sorted.length === 0) throw new Error(`No ${symbol} available to send. Deposits can be used after 1 confirmation.`);
  if (amount === 'max') {
    const total = sorted.reduce((s, u) => s + u.value, 0n);
    const fee = size(sorted.length, 1) * feeRate;
    if (total - fee < dust) throw new Error(`No ${symbol} left to send after the fee.`);
    return { inputs: sorted, amount: total - fee, fee, change: 0n };
  }
  if (amount < dust) throw new Error(`The minimum to send is ${formatAmount(dust, 8)} ${symbol}.`);
  // One coin when one is enough, and the smallest such: spending coins together shows they are one person's, and a
  // big coin for a small payment shows more of the wallet in the change than needed.
  const single = [...sorted].reverse().find((u) => u.value >= amount + size(1, 1) * feeRate);
  if (single) {
    const withChange = size(1, 2) * feeRate;
    if (single.value >= amount + withChange + dust) return { inputs: [single], amount, fee: withChange, change: single.value - amount - withChange };
    return { inputs: [single], amount, fee: single.value - amount, change: 0n };
  }
  const inputs: BtcUtxo[] = [];
  let total = 0n;
  for (const u of sorted) {
    inputs.push(u);
    total += u.value;
    const withChange = size(inputs.length, 2) * feeRate;
    if (total >= amount + withChange + dust) return { inputs, amount, fee: withChange, change: total - amount - withChange };
    const noChange = size(inputs.length, 1) * feeRate;
    if (total >= amount + noChange) return { inputs, amount, fee: total - amount, change: 0n };
  }
  throw new Error(`Not enough ${symbol} to cover the amount and fee.`);
}

export const coinId = (u: { txid: string; vout: number }): string => `${u.txid}:${u.vout}`;

/**
 * Coin selection counts every coin and output at taproot sizes; with bc1q coins in, the send is a little larger, so
 * the fee is topped up to the rate for its real size: from the change, from the amount when sending everything, or
 * by giving up a change too small to keep.
 */
export function fitFee(d: BtcDraft, rate: bigint, max: boolean, dust: bigint): BtcDraft {
  const need = draftVbytes(d) * rate;
  if (d.fee >= need) return d;
  const short = need - d.fee;
  if (d.change > 0n && d.change - short >= dust) return { ...d, change: d.change - short, fee: need };
  if (max && d.amount - short >= dust) return { ...d, amount: d.amount - short, fee: need };
  if (d.change > 0n) {
    const without = { ...d, change: 0n };
    const smaller = draftVbytes(without) * rate;
    if (d.fee + d.change >= smaller) return { ...without, fee: d.fee + d.change };
  }
  throw new Error('Not enough BTC to cover the amount and fee.');
}

/** All of these coins go in; what's left over comes back as change, or goes to the fee when it would be dust. */
export function spendExactly(inputs: BtcUtxo[], amount: bigint | 'max', feeRate: bigint, coin: UtxoCoin = BITCOIN): { inputs: BtcUtxo[]; amount: bigint; fee: bigint; change: bigint } {
  const { symbol, dust } = coin;
  const size = (o: number) => estimateVbytes(inputs.length, o, coin.inputVb, coin.outputVb);
  const total = inputs.reduce((s, u) => s + u.value, 0n);
  if (amount === 'max') {
    const fee = size(1) * feeRate;
    if (total - fee < dust) throw new Error(`The chosen coins leave no ${symbol} to send after the fee.`);
    return { inputs, amount: total - fee, fee, change: 0n };
  }
  if (amount < dust) throw new Error(`The minimum to send is ${formatAmount(dust, 8)} ${symbol}.`);
  const withChange = size(2) * feeRate;
  if (total >= amount + withChange + dust) return { inputs, amount, fee: withChange, change: total - amount - withChange };
  if (total >= amount + size(1) * feeRate) return { inputs, amount, fee: total - amount, change: 0n };
  throw new Error(`The chosen coins don't cover the amount and fee. Choose more coins or send less.`);
}

export class BtcClient {
  private readonly account: any;
  private state: { at: number; utxos: BtcUtxo[]; total: bigint; spendable: bigint; nextReceive: number; nextChange: number; nextChangeV0: number; used: Set<string>; addresses: Map<string, [number, number]> } | null = null;
  private inFlight: Promise<void> | null = null;
  private lastFullScan = 0;
  private readonly nexts = new Map<string, number>();
  private readonly cooling = new Map<string, { until: number; limited: boolean }>();
  private readonly resume = new Map<string, { at: number; value: any }>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Public servers limit requests per IP, so they go out one at a time with a gap. */
  static defaultSpacingMs = 400;
  spacingMs = BtcClient.defaultSpacingMs;
  private lastError: string | null = null;

  constructor(xpub: string, private readonly apis: string[], private readonly agent?: Agent, private readonly timeoutMs = 30_000, readonly coin: UtxoCoin = BITCOIN, private readonly onFailure?: () => void) {
    this.account = HDKey.fromExtendedKey(xpub);
  }

  /** The BIP84 account whose change addresses (chain 2 here) take change beside bc1q payments. Before useFilters. */
  private v0: any = null;
  useV0Change(xpub: string): void { this.v0 = HDKey.fromExtendedKey(xpub); }

  /**
   * Private sync: balances come from block filters checked on this device (see btc-filter-sync), so no server is
   * asked about any address. Fees and sends still use the servers, which learn nothing about the wallet from them.
   */
  private filters: { sync: FilterSync; id: string } | null = null;
  useFilters(sync: FilterSync, id: string): void {
    this.filters = { sync, id };
    sync.addAccount({ id, gap: [this.coin.gap ?? GAP, GAP_CHANGE], script: (chain, index) => btc.OutScript.encode(btc.Address(this.coin.network ?? btc.NETWORK).decode(this.addressAt(chain, index))) });
    // The segwit v0 change addresses, as an account of their own with change only.
    if (this.v0) sync.addAccount({ id: `${id}:v0`, gap: [0, GAP_CHANGE], script: (_chain, index) => btc.OutScript.encode(btc.Address(btc.NETWORK).decode(this.addressAt(V0_CHAIN, index))) });
  }
  /**
   * Silent Payments receiving on private sync: from block `from`, each block's tweaks (fetched by `tweaks`, through
   * Tor) give this wallet's possible outputs, which the block filters are checked for. The scan key stays in memory
   * while the wallet is open; spending needs the 12 words as usual.
   */
  private silent: { spendPub: Uint8Array } | null = null;
  useSilent(opts: { scanKey: Uint8Array; spendPub: Uint8Array; from: number; tweaks: (height: number) => Promise<Uint8Array[]> }): void {
    if (!this.filters) throw new Error('Silent Payments need private sync.');
    const { scanKey, spendPub } = opts;
    this.silent = { spendPub };
    const ahead = new Map<number, Promise<Uint8Array[]>>();
    const scanner: SilentScanner = {
      account: `${this.filters.id}:sp`, from: opts.from,
      next: (c) => spOutput(c.shared, c.k + 1, spendPub),
      candidates: async (heights, last) => {
        const out = new Map<number, Awaited<ReturnType<typeof spCandidates>>>();
        for (const h of heights) {
          // The next few blocks' tweaks are fetched while this one's candidates are worked out.
          for (let n = h; n <= Math.min(h + 3, last ?? h); n++) if (!ahead.has(n)) { const p = opts.tweaks(n); p.catch(() => undefined); ahead.set(n, p); }
          const list = ahead.get(h)!;
          ahead.delete(h);
          for (const k of [...ahead.keys()]) if (k < h) ahead.delete(k);
          out.set(h, await spCandidates(await list, scanKey, spendPub));
        }
        return out;
      },
    };
    this.filters.sync.setSilent(scanner);
  }
  stopSilent(): void { this.silent = null; this.filters?.sync.setSilent(null); }

  get usesFilters(): boolean { return this.filters !== null; }
  /** How far the private sync has got, when it is on. */
  get filterProgress(): { scanned: number; tip: number; error: string | null } | null {
    if (!this.filters) return null;
    const p = this.sendProblem;
    return { ...this.filters.sync.progress, error: p ? `A send (${p.id.slice(0, 10)}…) did not go out: ${p.message}` : this.filters.sync.lastError };
  }

  private stateFromFilters(): void {
    const f = this.filters!;
    const v = f.sync.view(f.id);
    if (!v) return;
    const v0 = this.v0 ? f.sync.view(`${f.id}:v0`) : null;
    const addresses = new Map<string, [number, number]>(this.state?.addresses ?? []);
    const used = new Set<string>();
    const coin = (c: { txid: string; vout: number; value: string; height: number; index: number }, chain: number): BtcUtxo => {
      const address = this.addressAt(chain, c.index);
      addresses.set(address, [chain, c.index]);
      used.add(address);
      return { txid: c.txid, vout: c.vout, value: BigInt(c.value), address, chain, index: c.index, confirmed: c.height > 0 };
    };
    const sp = f.sync.view(`${f.id}:sp`);
    const spCoin = (c: { txid: string; vout: number; value: string; height: number; index: number; tweak?: string }): BtcUtxo | null => {
      if (!c.tweak || !this.silent) return null;
      const address = silentCoinAddress(spOutputKey(this.silent.spendPub, Buffer.from(c.tweak, 'hex')));
      return { txid: c.txid, vout: c.vout, value: BigInt(c.value), address, chain: SP_CHAIN, index: c.index, confirmed: c.height > 0, tweak: c.tweak };
    };
    const utxos: BtcUtxo[] = [...v.coins.map((c) => coin(c, c.chain)), ...(v0?.coins ?? []).map((c) => coin(c, V0_CHAIN)), ...(sp?.coins ?? []).map(spCoin).filter((u): u is BtcUtxo => u !== null)];
    const total = utxos.reduce((s, u) => s + u.value, 0n);
    const spendable = utxos.filter((u) => u.confirmed).reduce((s, u) => s + u.value, 0n);
    this.nexts.set('taproot0', v.next[0]); this.nexts.set('taproot1', v.next[1]);
    if (v0) this.nexts.set('taproot2', v0.next[1]);
    this.state = { at: Date.now(), utxos, total, spendable, nextReceive: v.next[0], nextChange: v.next[1], nextChangeV0: v0?.next[1] ?? 0, addresses, used };
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
    if (chain === V0_CHAIN) {
      if (!this.v0) throw new Error('No segwit change account.');
      return btc.p2wpkh(this.v0.deriveChild(1).deriveChild(index).publicKey).address;
    }
    return this.coin.address(this.account.deriveChild(chain).deriveChild(index).publicKey);
  }

  get receiveAddress(): string { return this.addressAt(0, this.state?.nextReceive ?? 0); }
  /** The first receiving address index not seen in use, as of the last scan. */
  get nextReceiveIndex(): number { return this.state?.nextReceive ?? this.nexts.get('taproot0') ?? 0; }

  /**
   * A server that said "too many requests" is left alone for a while, and so is one that didn't answer, so the rest of
   * a scan goes straight to the next server. Each failure also moves to a new Tor route.
   */
  private async get(path: string, agent: Agent | undefined = this.agent, onFailure: (() => void) | undefined = this.onFailure): Promise<any> {
    const turn = this.queue.then(async () => {
      let last: unknown;
      const now = Date.now();
      const open = this.apis.filter((b) => (this.cooling.get(b)?.until ?? 0) <= now);
      // All of them down rather than limiting: asking again beats giving up.
      const order = open.length ? open : this.apis.filter((b) => !this.cooling.get(b)?.limited);
      for (const base of order) {
        try {
          const value = isBlockbook(base) ? await blockbookGet(base, path, { agent, timeoutMs: this.timeoutMs }) : await getJson(base + path, { agent, timeoutMs: this.timeoutMs });
          this.cooling.delete(base);
          return value;
        } catch (e) {
          last = e;
          const limited = /429/.test((e as Error).message);
          // A plain "not found" or bad request is an answer, not a server that's down. A refusal (403) is a blocked route.
          if (!/\((400|404)\)/.test((e as Error).message)) this.cooling.set(base, { until: Date.now() + (limited ? COOLDOWN_MS : DOWN_MS), limited });
          onFailure?.();
        }
      }
      if (!last || /429/.test((last as Error).message)) throw new Error(`The ${this.coin.symbol} server is limiting requests for now. Your coins are safe, and it will retry automatically.`);
      throw last instanceof Error ? last : new Error(`Could not reach the ${this.coin.symbol} server.`);
    });
    this.queue = turn.catch(() => undefined).then(() => (this.spacingMs ? new Promise((r) => setTimeout(r, this.spacingMs)) : undefined));
    return turn;
  }

  /** An address lookup, reusing what a scan that broke off already learned. */
  /**
   * Over Tor, each address is looked up on one of several routes, picked afresh for every scan, so no one server
   * connection sees this wallet's whole list of addresses. An address and its coins share a route.
   */
  lookupRoutes: { agent: Agent; renew: () => void }[] = [];
  private scanSalt = Math.random().toString(36);
  private routeFor(path: string): { agent: Agent | undefined; renew: (() => void) | undefined } {
    const address = /^\/address\/([^/]+)/.exec(path)?.[1];
    if (!address || !this.lookupRoutes.length) return { agent: this.agent, renew: this.onFailure };
    let h = 0;
    for (const c of address + this.scanSalt) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const r = this.lookupRoutes[h % this.lookupRoutes.length];
    return { agent: r.agent, renew: r.renew };
  }

  private async getAddress(path: string): Promise<any> {
    const kept = this.resume.get(path);
    if (kept && Date.now() - kept.at < RESUME_MS) return kept.value;
    const { agent, renew } = this.routeFor(path);
    const value = await this.get(path, agent, renew);
    this.resume.set(path, { at: Date.now(), value });
    return value;
  }

  /** Full: every address up to the gap. Otherwise only addresses seen in use, plus a few after them. */
  private async scanChain(chain: number, out: { utxos: BtcUtxo[]; total: bigint; addresses: Map<string, [number, number]>; used: Set<string> }, full: boolean, usedBefore: Set<string>): Promise<number> {
    const key = `taproot${chain}`;
    const fullGap = chain === 0 ? this.coin.gap ?? GAP : GAP_CHANGE;
    const gap = full ? fullGap : GAP_RECHECK;
    const known = this.nexts.get(key) ?? 0;
    let next = full ? 0 : known;
    for (let index = 0; index < next + gap; index++) {
      const address = this.addressAt(chain, index);
      out.addresses.set(address, [chain, index]);
      if (!full && index < known && !usedBefore.has(address)) continue;
      const info = await this.getAddress(`/address/${address}`);
      const c = info.chain_stats ?? {}; const m = info.mempool_stats ?? {};
      const count = (c.tx_count ?? 0) + (m.tx_count ?? 0);
      if (count === 0) continue;
      out.used.add(address);
      next = Math.max(next, index + 1);
      out.total += BigInt(c.funded_txo_sum ?? 0) - BigInt(c.spent_txo_sum ?? 0) + BigInt(m.funded_txo_sum ?? 0) - BigInt(m.spent_txo_sum ?? 0);
      if (BigInt(c.funded_txo_sum ?? 0) + BigInt(m.funded_txo_sum ?? 0) === BigInt(c.spent_txo_sum ?? 0) + BigInt(m.spent_txo_sum ?? 0)) continue;
      const list: any[] = await this.getAddress(`/address/${address}/utxo`);
      for (const u of list) {
        if (!/^[0-9a-f]{64}$/.test(u.txid) || !Number.isInteger(u.vout)) throw new Error(`The ${this.coin.symbol} server gave an unexpected answer.`);
        out.utxos.push({ txid: u.txid, vout: u.vout, value: BigInt(u.value), address, chain, index, confirmed: Boolean(u.status?.confirmed) });
      }
    }
    this.nexts.set(key, next);
    return next;
  }

  refresh(force: boolean | 'full' = false): Promise<void> {
    if (!force && this.state && Date.now() - this.state.at < CACHE_MS) return Promise.resolve();
    if (this.filters && !this.inFlight) {
      const f = this.filters;
      this.inFlight = (async () => {
        await f.sync.load();
        if (!this.state) this.stateFromFilters(); // the last known coins at once, while the sync catches up
        await f.sync.sync(Boolean(force));
        this.stateFromFilters();
        this.lastError = null;
      })().catch((e) => { this.lastError = (e as Error).message; throw e; }).finally(() => { this.inFlight = null; });
    }
    if (!this.inFlight) {
      this.inFlight = (async () => {
        const out = { utxos: [] as BtcUtxo[], total: 0n, addresses: new Map<string, [number, number]>(this.state?.addresses ?? []), used: new Set<string>() };
        const full = force === 'full' || (!this.state && !this.hintsUsed) || Date.now() - this.lastFullScan > FULL_SCAN_MS;
        const usedBefore = this.state?.used ?? this.hintsUsed ?? new Set<string>();
        const nextReceive = await this.scanChain(0, out, full, usedBefore);
        const nextChange = await this.scanChain(1, out, full, usedBefore);
        const nextChangeV0 = this.v0 ? await this.scanChain(V0_CHAIN, out, full, usedBefore) : 0;
        if (full) this.lastFullScan = Date.now();
        const spendable = out.utxos.filter((u) => u.confirmed).reduce((s, u) => s + u.value, 0n);
        this.state = { at: Date.now(), utxos: out.utxos, total: out.total, spendable, nextReceive, nextChange, nextChangeV0, addresses: out.addresses, used: out.used };
        this.lastError = null;
        this.resume.clear();
        this.scanSalt = Math.random().toString(36); // the next scan spreads addresses differently
        this.onHints?.({ used: [...out.used], nexts: Object.fromEntries(this.nexts), lastFullScan: this.lastFullScan });
      })().catch((e) => { this.lastError = (e as Error).message; throw e; }).finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  /** Newest balance available now; the first scan fills in on a later call. */
  async getBalance(waitMs = 1500): Promise<{ total: bigint; spendable: bigint } | null> {
    const scan = this.refresh().catch(() => undefined);
    await Promise.race([scan, new Promise((r) => setTimeout(r, waitMs))]);
    if (this.state) return { total: this.state.total, spendable: this.state.spendable };
    if (this.lastError) throw new Error(this.lastError);
    return null;
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
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) throw new Error(`Could not read ${this.coin.symbol} fee information.`);
    const fee = BigInt(Math.max(1, Math.ceil(rate)));
    if (fee > this.coin.maxFeeRate) throw new Error(`The fee is abnormally high, so this was stopped (${fee} sat/vB).`);
    return fee;
  }

  /**
   * The chain's height, for the lock time: from the private sync when on, else from the server. 0 when unknown,
   * which is never wrong (a height above the real one would make the send invalid until then).
   */
  async tipHeight(): Promise<number> {
    if (this.filters) return this.filters.sync.view(this.filters.id)?.tip ?? 0;
    try {
      const h = Number(await this.get('/blocks/tip/height'));
      return Number.isSafeInteger(h) && h > 0 ? h : 0;
    } catch { return 0; }
  }

  /** Confirmed coins, freshly listed: what a peg-in into MWEB spends. */
  async confirmedUtxos(): Promise<BtcUtxo[]> {
    await this.refresh(true);
    return this.state!.utxos.filter((u) => u.confirmed);
  }

  /** Every coin, waiting ones too, for choosing what to spend. */
  async coins(): Promise<BtcUtxo[]> {
    await this.refresh(true);
    return [...this.state!.utxos];
  }

  /** This wallet's own sends, kept so a stuck one can be replaced with a higher fee. Saved by the service. */
  private sent = new Map<string, { draft: BtcDraft; vsize: number; at: number }>();
  onSent: ((list: unknown) => void) | null = null;
  loadSent(list: unknown): void {
    if (!Array.isArray(list)) return;
    for (const r of list.slice(0, 50)) {
      try {
        const d = r.draft;
        const draft: BtcDraft = { ...d, amount: BigInt(d.amount), fee: BigInt(d.fee), change: BigInt(d.change), inputs: d.inputs.map((u: any) => ({ ...u, value: BigInt(u.value) })) };
        this.sent.set(String(r.id), { draft, vsize: Number(r.vsize), at: Number(r.at) });
      } catch { /* a damaged entry: skipped */ }
    }
  }
  sentList(): unknown {
    const big = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
    return JSON.parse(JSON.stringify([...this.sent.entries()].map(([id, r]) => ({ id, ...r })), big));
  }
  private rememberSent(id: string, draft: BtcDraft, hex: string): void {
    const vsize = btc.Transaction.fromRaw(Buffer.from(hex, 'hex')).vsize;
    if (draft.replaces) this.sent.delete(draft.replaces);
    this.sent.set(id, { draft: { ...draft, replaces: undefined, cpfpOf: undefined }, vsize, at: Date.now() });
    // Two weeks is plenty: a send still waiting after that has dropped out of mempools.
    for (const [k, r] of this.sent) if (Date.now() - r.at > 14 * 24 * 3600_000) this.sent.delete(k);
    this.onSent?.(this.sentList());
  }
  canReplace(txid: string): boolean { return this.sent.has(txid); }

  /**
   * The same send again (same coins, same recipient and amount) with a higher fee, taken from the change, so the
   * first one is replaced (BIP125: the new fee covers the old one plus the relay fee for its own size).
   */
  async bumpDraft(txid: string): Promise<BtcDraft> {
    const was = this.sent.get(txid);
    if (!was) throw new Error('Only a send made from this wallet on this device can be sped up this way.');
    const status = await this.get(`/tx/${txid}/status`).catch(() => null);
    if (status?.confirmed) throw new Error('This transaction is already confirmed.');
    const rate = await this.feeRate();
    const vsize = BigInt(was.vsize);
    const old = was.draft.fee;
    const fee = [rate * vsize, old + vsize, old + old / 4n].reduce((a, b) => (a > b ? a : b)); // at least a quarter more
    const more = fee - old;
    let change = was.draft.change - more;
    let paid = fee;
    if (change < TAPROOT_DUST) {
      if (change < 0n || was.draft.change === 0n) throw new Error('There is not enough change in this send to pay a higher fee. Speeding up a payment you received works differently: open that one.');
      paid = fee + change; change = 0n; // too little to keep: it goes to the fee
    }
    return { ...was.draft, fee: paid, change, replaces: txid };
  }

  /**
   * Speeds up a waiting payment to this wallet (CPFP): a new transaction spends its coins to this wallet with a fee
   * high enough for both together. Asks the server for the first one's fee and size.
   */
  async cpfpDraft(txid: string): Promise<BtcDraft> {
    await this.refresh(true);
    const state = this.state!;
    const coins = state.utxos.filter((u) => u.txid === txid && !u.confirmed);
    if (!coins.length) throw new Error('This wallet has no waiting coins from that transaction.');
    const parent = await this.get(`/tx/${txid}`);
    if (parent?.status?.confirmed) throw new Error('This transaction is already confirmed.');
    const parentFee = BigInt(parent?.fee ?? -1);
    const parentVsize = BigInt(Math.ceil(Number(parent?.weight ?? 0) / 4));
    if (parentFee < 0n || parentVsize <= 0n) throw new Error(`The ${this.coin.symbol} server did not say what that transaction pays.`);
    const rate = await this.feeRate();
    const childVsize = estimateVbytes(coins.length, 1);
    const want = rate * (parentVsize + childVsize) - parentFee;
    const fee = want > childVsize * 2n ? want : childVsize * 2n;
    const total = coins.reduce((s, u) => s + u.value, 0n);
    if (total - fee < TAPROOT_DUST) throw new Error('These coins are too small to pay for speeding the transaction up.');
    const index = state.nextChange;
    const look = coreLike(await this.tipHeight());
    return { to: this.addressAt(1, index), amount: total - fee, fee, change: 0n, changeAddress: this.addressAt(1, index), changePath: [1, index], inputs: look.order(coins), cpfpOf: txid, lockTime: look.lockTime };
  }

  /**
   * `use`: spend exactly these coins (txid:vout), all of them, so only the coins chosen are linked together.
   * `frozen`: coins never spent unless chosen.
   */
  async draft(to: string, amount: bigint | 'max', pick: { use?: string[]; frozen?: Set<string> } = {}): Promise<BtcDraft> {
    await this.refresh(true);
    const state = this.state!;
    const rate = await this.feeRate();
    let picked: { inputs: BtcUtxo[]; amount: bigint; fee: bigint; change: bigint };
    if (pick.use?.length) {
      const chosen = [...new Set(pick.use)].map((id) => state.utxos.find((u) => coinId(u) === id));
      if (chosen.some((u) => !u)) throw new Error('A chosen coin was spent or is no longer in this wallet. Choose again.');
      if (chosen.some((u) => !u!.confirmed)) throw new Error('A chosen coin is still waiting for its first confirmation.');
      if (chosen.some((u) => this.reserved.has(coinId(u!)))) throw new Error('A chosen coin is already in a send that goes out later.');
      picked = spendExactly(chosen as BtcUtxo[], amount, rate, this.coin);
    } else {
      picked = selectCoins(state.utxos.filter((u) => u.confirmed && !pick.frozen?.has(coinId(u)) && !this.reserved.has(coinId(u))), amount, rate, this.coin);
    }
    const look = coreLike(await this.tipHeight());
    const changePath: [number, number] = this.v0 && v0ChangeFor(to) ? [V0_CHAIN, state.nextChangeV0] : [1, state.nextChange];
    const draft: BtcDraft = { to, amount: picked.amount, fee: picked.fee, change: picked.change, changeAddress: this.addressAt(...changePath), changePath, inputs: look.order(picked.inputs), lockTime: look.lockTime, changeFirst: look.changeFirst };
    return this.v0 ? fitFee(draft, rate, amount === 'max', this.coin.dust) : draft;
  }

  /** Signs here, checks the result against what was approved, then broadcasts. */
  async send(draft: BtcDraft, mnemonic: string): Promise<string> {
    const { hex, id } = this.coin.sign(draft, mnemonic);
    return this.sendSigned(draft, hex, id);
  }

  /** Signed now, sent later (a delayed send): its coins are kept out of other sends until then. */
  readonly reserved = new Set<string>();
  sign(draft: BtcDraft, mnemonic: string): { hex: string; id: string } { return this.coin.sign(draft, mnemonic); }

  /**
   * `fallback`: another signed version of the same payment (a Payjoin's ordinary original). If peers never relay
   * this one and a server refuses it (the other side's coin was spent, say), the fallback goes out instead.
   */
  async sendSigned(draft: BtcDraft, hex: string, id: string, fallback?: { draft: BtcDraft; hex: string; id: string }): Promise<string> {
    if (this.filters) {
      // Handed to Bitcoin nodes over Tor. Only when fewer than two took it does a server get it too: a server that
      // is sent a transaction can tie it to the connection, while a node can't tell it from the ones it relays.
      const raw = Buffer.from(hex, 'hex');
      const peers = await this.filters.sync.broadcast(raw).catch(() => 0);
      let answer: string | null = null;
      if (peers < 2) answer = (await this.broadcast(hex)).trim();
      else this.checkLater(hex, id, fallback);
      if (answer !== null && answer !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
      // Only once it went out: a replacement frees the coins of the send it replaces.
      if (draft.replaces) this.filters.sync.dropPending(draft.replaces);
      this.filters.sync.recordSent(raw);
      this.rememberSent(id, draft, hex);
      this.stateFromFilters();
      return id;
    }
    const answer = (await this.broadcast(hex)).trim();
    if (answer !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
    this.rememberSent(id, draft, hex);
    this.state = null;
    this.resume.clear();
    return id;
  }

  /** Whether an address is one this wallet has handed out or seen paid. */
  ownsAddress(address: string): boolean { return this.state?.addresses.has(address) ?? false; }

  /**
   * Someone else's transaction, passed on (a Payjoin sender's ordinary payment, when the sender went quiet). Peers
   * first when syncing privately; a refusal (it conflicts with one already out) is no error here.
   */
  async relay(hex: string): Promise<void> {
    if (this.filters && (await this.filters.sync.broadcast(Buffer.from(hex, 'hex')).catch(() => 0)) >= 2) return;
    await this.broadcast(hex).catch(() => undefined);
  }

  /** How long after handing a send to peers it is looked for: nodes give out a waiting transaction after 2 minutes. */
  broadcastCheckMs = 150_000;
  /** Sends handed to peers whose check hasn't run yet. */
  private readonly checking = new Set<ReturnType<typeof setTimeout>>();
  /**
   * Peers don't say whether they took a transaction. If, once nodes would hand it out, none asked has it, it goes to
   * a server as well, which says why when it is refused.
   */
  private checkLater(hex: string, id: string, fallback?: { draft: BtcDraft; hex: string; id: string }): void {
    const sync = this.filters?.sync;
    if (!sync) return;
    const to = sync.lastBroadcastTo;
    const timer = setTimeout(() => {
      this.checking.delete(timer);
      void (async () => {
        const seen = await sync.seen(id, to).catch(() => null);
        if (seen === true) return;
        try {
          const answer = (await this.broadcast(hex)).trim();
          if (answer !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
        } catch (e) {
          if (fallback) {
            // The same payment, made the ordinary way: this one's coins are freed and the fallback goes out.
            try { sync.dropPending(id); await this.sendSigned(fallback.draft, fallback.hex, fallback.id); return; } catch { /* reported below */ }
          }
          this.sendProblem = { id, message: (e as Error).message };
        }
      })();
    }, this.broadcastCheckMs);
    (timer as any).unref?.(); // never what keeps the app running
    this.checking.add(timer);
  }
  /** A send that peers didn't take and a server refused, for the screen to tell. */
  sendProblem: { id: string; message: string } | null = null;

  private async broadcast(hex: string): Promise<string> {
    let last: unknown;
    for (const base of this.apis) {
      try {
        if (isBlockbook(base)) return await blockbookSend(base, hex, { agent: this.agent, timeoutMs: this.timeoutMs });
        return await requestText(`${base}/tx`, { method: 'POST', body: hex, agent: this.agent, timeoutMs: this.timeoutMs });
      } catch (e) { last = e; }
    }
    throw last instanceof Error ? new Error(`Send rejected: ${last.message}`) : new Error('The send failed.');
  }

  async getHistory(): Promise<BtcHistoryItem[]> {
    await this.refresh().catch((e) => { if (!this.state) throw e; });
    if (this.filters) {
      const id = this.filters.id;
      const v = this.filters.sync.view(id);
      if (!v) return [];
      // The bc1q change account's transactions too, each counted once across both.
      const v0 = this.v0 ? this.filters.sync.view(`${id}:v0`) : null;
      const sp = this.silent ? this.filters.sync.view(`${id}:sp`) : null;
      const byId = new Map(v.txs.map((t) => [t.txid, t]));
      for (const t of [...(v0?.txs ?? []), ...(sp?.txs ?? [])]) if (!byId.has(t.txid)) byId.set(t.txid, t);
      return [...byId.values()].map((t): BtcHistoryItem => {
        const parts = [t.accounts[id], t.accounts[`${id}:v0`], t.accounts[`${id}:sp`]].filter(Boolean);
        const got = parts.reduce((s, a) => s + BigInt(a.in), 0n); const spent = parts.reduce((s, a) => s + BigInt(a.out), 0n);
        const net = got - spent;
        const direction = spent === 0n ? 'in' : net < 0n ? 'out' : 'self';
        return {
          asset: this.coin.symbol, hash: t.txid, direction,
          amount: formatAmount(direction === 'in' ? got : net < 0n ? -net : net, 8),
          counterparty: '', timestamp: t.time * 1000,
          status: t.height > 0 ? 'confirmed' : 'pending', dust: direction === 'in' && got < 1000n,
        };
      }).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
    }
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
        asset: this.coin.symbol, hash: tx.txid, direction,
        amount: formatAmount(direction === 'in' ? out : net < 0n ? -net : net, 8),
        counterparty: '', timestamp: (tx.status?.block_time ?? Date.now() / 1000) * 1000,
        status: tx.status?.confirmed ? 'confirmed' : 'pending', dust: direction === 'in' && out < 1000n,
      };
    }).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  }
}

/** The private key of a BIP86 output: the internal key, made even, plus the taproot tweak (BIP341). */
export function taprootOutputKey(internal: Uint8Array): Uint8Array {
  const { secp256k1, schnorr } = require('@noble/curves/secp256k1.js');
  const n: bigint = secp256k1.Point.Fn.ORDER;
  let d = BigInt('0x' + Buffer.from(internal).toString('hex'));
  const P = secp256k1.Point.BASE.multiply(d);
  if (!P.hasEvenY()) d = n - d;
  const t = BigInt('0x' + Buffer.from(schnorr.utils.taggedHash('TapTweak', P.toBytes(true).slice(1))).toString('hex'));
  return Uint8Array.from(Buffer.from(((d + t) % n).toString(16).padStart(64, '0'), 'hex'));
}

export function signBtcDraft(draft: BtcDraft, mnemonic: string, path = BTC_PATH): { hex: string; id: string } {
  const root = HDKey.fromMasterSeed(bip39Seed(mnemonic));
  const taproot = root.derive(path);
  // bc1q change of the main account only: the CoinJoin account never has any.
  const v0 = path === BTC_PATH ? root.derive(BTC_V0_PATH) : null;
  const tx = new btc.Transaction({ lockTime: draft.lockTime ?? 0 });
  const keys: Uint8Array[] = [];
  const isTaproot: boolean[] = [];
  const spIdx: number[] = [];
  for (const u of draft.inputs) {
    if (u.chain === SP_CHAIN) {
      // A Silent Payments coin: its key is the spend key plus the coin's tweak, used as it is (no taproot tweak).
      if (path !== BTC_PATH || !u.tweak) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
      const key = spPrivateKey(root.derive(SP_SPEND_PATH).privateKey, Buffer.from(u.tweak, 'hex'));
      const xonly = xOnly(require('@noble/curves/secp256k1.js').secp256k1.getPublicKey(key, true));
      if (silentCoinAddress(xonly) !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
      tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: taprootScript(xonly), amount: u.value }, sequence: RBF_SEQUENCE });
      spIdx.push(keys.length);
      keys.push(key); isTaproot.push(true);
      continue;
    }
    if (u.chain === V0_CHAIN) {
      if (!v0) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
      const child = v0.deriveChild(1).deriveChild(u.index);
      const pay = btc.p2wpkh(child.publicKey);
      if (pay.address !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
      tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: pay.script, amount: u.value }, sequence: RBF_SEQUENCE });
      keys.push(child.privateKey); isTaproot.push(false);
      continue;
    }
    const child = taproot.deriveChild(u.chain).deriveChild(u.index);
    const pay = btc.p2tr(xOnly(child.publicKey));
    if (pay.address !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: pay.script, amount: u.value }, tapInternalKey: pay.tapInternalKey, sequence: RBF_SEQUENCE });
    keys.push(child.privateKey); isTaproot.push(true);
  }
  const pay = (): void => {
    if (isSilentAddress(draft.to)) {
      // Silent Payments: the output key comes from the recipient's keys and these inputs' (tweaked) private keys.
      const spend = draft.inputs.map((u, i) => ({ txid: u.txid, vout: u.vout, key: isTaproot[i] && u.chain !== SP_CHAIN ? taprootOutputKey(keys[i]) : keys[i], taproot: isTaproot[i] }));
      const [out] = silentOutputs(spend, [draft.to]);
      tx.addOutput({ script: taprootScript(out), amount: draft.amount });
    } else tx.addOutputAddress(draft.to, draft.amount);
  };
  const change = (): void => {
    if (draft.change <= 0n) return;
    const [chain, index] = draft.changePath;
    const mine = chain === V0_CHAIN
      ? v0 !== null && btc.p2wpkh(v0.deriveChild(1).deriveChild(index).publicKey).address === draft.changeAddress
      : btc.p2tr(xOnly(taproot.deriveChild(chain).deriveChild(index).publicKey)).address === draft.changeAddress;
    if (!mine) throw new Error('The change address does not match this wallet\'s keys, so signing was stopped.');
    tx.addOutputAddress(draft.changeAddress, draft.change);
  };
  if (draft.changeFirst) { change(); pay(); } else { pay(); change(); }
  const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0n);
  if (totalIn - draft.amount - draft.change !== draft.fee) throw new Error('The amounts do not add up, so signing was stopped.');
  keys.forEach((k, i) => { if (!spIdx.includes(i)) tx.signIdx(k, i); });
  if (spIdx.length) {
    // BIP341 key-path signatures over every input's script and amount, with SIGHASH_DEFAULT.
    const { schnorr } = require('@noble/curves/secp256k1.js');
    const prevScripts = draft.inputs.map((_, i) => tx.getInput(i).witnessUtxo.script);
    const amounts = draft.inputs.map((u) => u.value);
    for (const i of spIdx) tx.updateInput(i, { tapKeySig: schnorr.sign(tx.preimageWitnessV1(i, prevScripts, 0, amounts), keys[i]) });
  }
  tx.finalize();
  return { hex: tx.hex, id: tx.id };
}

/** The address of a Silent Payments output: its key is the output key itself, with no taproot tweak on top. */
export const silentCoinAddress = (xonly: Uint8Array): string => btc.Address(btc.NETWORK).encode({ type: 'tr', pubkey: xonly });

/** The Silent Payments keys from the 12 words (BIP352 paths): the scan key itself, and the public keys. */
export function silentKeys(mnemonic: string): { scan: Uint8Array; scanPub: Uint8Array; spendPub: Uint8Array } {
  const root = HDKey.fromMasterSeed(bip39Seed(mnemonic));
  const scan = root.derive(SP_SCAN_PATH);
  return { scan: Uint8Array.from(scan.privateKey), scanPub: scan.publicKey, spendPub: root.derive(SP_SPEND_PATH).publicKey };
}

export const BITCOIN: UtxoCoin = {
  symbol: 'BTC', address: (pub) => btc.p2tr(xOnly(pub)).address, sign: (d, m) => signBtcDraft(d, m),
  // A higher fee rate from an API is treated as broken.
  inputVb: 57.5, outputVb: 43, dust: DUST, maxFeeRate: 300n,
};
/** The CoinJoin account: rounds that fail leave unused addresses behind, so it looks further ahead. */
export const BITCOIN_MIXED: UtxoCoin = { ...BITCOIN, sign: (d, m) => signBtcDraft(d, m, BTC_MIXED_PATH), gap: 100 };

// ---- Litecoin ----

// BIP84 with coin type 2, as Litecoin Core and Electrum-LTC use for ltc1q addresses.
export const LTC_PATH = "m/84'/2'/0'";
export const LTC_NET = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };

export function ltcAccountXpub(mnemonic: string): string {
  return HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(LTC_PATH).publicExtendedKey;
}

/** ltc1, L and M addresses. Old 3 addresses are refused: they look exactly like Bitcoin ones. MWEB isn't supported. */
export function isLtcAddress(address: string): boolean {
  if (!/^(ltc1[02-9ac-hj-np-z]{8,87}|[LM][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(address)) return false;
  try { btc.Address(LTC_NET).decode(address); return true; } catch { return false; }
}

export function signLtcDraft(draft: BtcDraft, mnemonic: string): { hex: string; id: string } {
  if (!isLtcAddress(draft.to)) throw new Error('The receiving address is not an LTC address.');
  const account = HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(LTC_PATH);
  const tx = new btc.Transaction({ lockTime: draft.lockTime ?? 0 });
  const keys: Uint8Array[] = [];
  for (const u of draft.inputs) {
    const child = account.deriveChild(u.chain).deriveChild(u.index);
    const pay = btc.p2wpkh(child.publicKey, LTC_NET);
    if (pay.address !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    // As Litecoin Core's sends: final but for the lock time, not replaceable.
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: pay.script, amount: u.value }, sequence: 0xfffffffe });
    keys.push(child.privateKey);
  }
  const change = (): void => {
    if (draft.change <= 0n) return;
    const c = account.deriveChild(draft.changePath[0]).deriveChild(draft.changePath[1]);
    if (btc.p2wpkh(c.publicKey, LTC_NET).address !== draft.changeAddress) throw new Error('The change address does not match this wallet\'s keys, so signing was stopped.');
    tx.addOutputAddress(draft.changeAddress, draft.change, LTC_NET);
  };
  if (draft.changeFirst) change();
  tx.addOutputAddress(draft.to, draft.amount, LTC_NET);
  if (!draft.changeFirst) change();
  const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0n);
  if (totalIn - draft.amount - draft.change !== draft.fee) throw new Error('The amounts do not add up, so signing was stopped.');
  keys.forEach((k, i) => tx.signIdx(k, i));
  tx.finalize();
  return { hex: tx.hex, id: tx.id };
}

export const LITECOIN: UtxoCoin = {
  symbol: 'LTC', address: (pub) => btc.p2wpkh(pub, LTC_NET).address, sign: signLtcDraft, network: LTC_NET as typeof btc.NETWORK,
  inputVb: 68, outputVb: 43, dust: 1_000n, maxFeeRate: 500n,
};
