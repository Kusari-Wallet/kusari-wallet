// The wallet side of Dash CoinJoin: coins kept on their own account (DIP-9, m/9'/5'/4'/0', as Dash's own
// mobile wallets do, so they restore there too), split into the standard sizes, then mixed round by round with
// masternodes until each has gone through enough rounds to be sent privately.
import { bip39Seed } from './seed';
import type { Agent } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getJson, requestJson } from './request';
import { formatAmount } from './amount';
import { randomBelow, DashPeer, DashTx, Dial, DASH_PORT, Masternode, MasternodeList, Reader, TxOut, getMnListDiff, hashHex, readMasternodeList, readTx, txBytes, txId } from './dash-p2p';
import { DENOMS, MAX_ENTRY, OwnCoin, collateralTx, denomBit, isCollateralAmount, isDenom, p2pkh, runSession, signAll, SessionStep, COLLATERAL, MAX_COLLATERAL } from './coinjoin';
import { Records, plainRecords } from './records';

const { HDKey } = require('@scure/bip32');
const btc = require('@scure/btc-signer');

export const COINJOIN_PATH = "m/9'/5'/4'/0'";
const DASH_NET = { bech32: 'dash', pubKeyHash: 0x4c, scriptHash: 0x10, wif: 0xcc };
/** Rounds before a coin counts as mixed. Dash Core's default is 4. */
export const MIX_ROUNDS = 4;
/** Collateral coins made when splitting: enough for many sessions, since one is only spent if we misbehave. */
const COLLATERAL_COINS = 3;
const FEE_PER_BYTE = 2n;
const EXPECTED_FOR_MS = 3 * 3600_000;
const LIST_FOR_MS = 3600_000;
const LIST_DEPTH = 8;
const BATCH = 40;
/** Unused addresses in a row after which a restore stops looking. */
const RESTORE_GAP = 40;
/** Where a first node is found for the masternode list. */
export const DASH_SEEDS = ['dnsseed.dash.org', 'dnsseed.dashdot.io'];
/** The most a private send may pay above its amount, as fee, because mixed coins can't be split. */
export const MAX_PRIVATE_OVERPAY = 100_001n;

/** Chain 0 holds the coins split in, chain 1 what mixing makes; each chain's addresses are used in order. */
interface Tracked { chain: 0 | 1; index: number; rounds: number; kind: 'denom' | 'collateral'; state: 'expected' | 'live'; at: number }
interface Store { next: number; next1: number; addrs: Record<string, Tracked>; paused?: boolean; scanned?: boolean; collateralChange?: number }
export interface MixCoin { txid: string; vout: number; value: bigint; address: string; chain: 0 | 1; index: number; rounds: number; kind: 'denom' | 'collateral'; confirmed: boolean }
export interface SplitPlan { start: number; outputs: { address: string; value: bigint }[]; mixable: bigint }
export interface MixStatus {
  running: boolean; step: string; error: string | null;
  mixed: string; mixing: string; collateral: string; total: string;
  progress: number; sessions: number; lastMix: number;
}

const sizeOf = (inputs: number, outputs: number): bigint => BigInt(10 + 148 * inputs + 34 * outputs);

export interface MixOptions {
  apis: string[];
  agent?: Agent;
  timeoutMs?: number;
  dir: string;
  /** Where the mixing addresses are kept: encrypted while the wallet is unlocked. */
  records?: Records;
  dial: Dial;
  /** Nodes to ask for the masternode list, as host or host:port. */
  seeds?: string[];
}

export class DashMixer {
  private store: Store = { next: 0, next1: 0, addrs: {} };
  private coins: MixCoin[] = [];
  private loaded = false;
  private list: (MasternodeList & { at: number }) | null = null;
  private recent: string[] = [];
  private loop: Promise<void> | null = null;
  private stopped = true;
  private peer: DashPeer | null = null;
  status: MixStatus = { running: false, step: '', error: null, mixed: '0', mixing: '0', collateral: '0', total: '0', progress: 0, sessions: 0, lastMix: 0 };

  /** The mixing account's private key stays in memory while the wallet is unlocked, so rounds run unattended. */
  constructor(private readonly opts: MixOptions, private readonly account: any) {}

  static account(mnemonic: string): any { return HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(COINJOIN_PATH); }

  private key(chain: number, index: number) { return this.account.deriveChild(chain).deriveChild(index); }
  addressAt(chain: number, index: number): string { return btc.p2pkh(this.key(chain, index).publicKey, DASH_NET).address; }
  private scriptOf(chain: number, index: number): Buffer { return p2pkh(btc.p2pkh(this.key(chain, index).publicKey, DASH_NET).hash); }
  private file(): string { return path.join(this.opts.dir, 'coinjoin.json'); }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const s = await (this.opts.records ?? plainRecords).read(this.file());
      if (Number.isInteger(s?.next) && Number.isInteger(s?.next1) && s.addrs && typeof s.addrs === 'object') this.store = s;
    } catch { /* first use, or restored from the seed: found by scanning */ }
    if (!this.store.scanned) await this.recover();
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await (this.opts.records ?? plainRecords).write(this.file(), this.store);
  }

  /** New addresses on the mixing chain, one per coin: mixing refuses any address used twice. */
  private reserve(n: number, kind: Tracked['kind'], rounds: number): { address: string; index: number; script: Buffer }[] {
    const out = [];
    for (let i = 0; i < n; i++) {
      const index = this.store.next1++;
      const address = this.addressAt(1, index);
      this.store.addrs[address] = { chain: 1, index, rounds, kind, state: 'expected', at: Date.now() };
      out.push({ address, index, script: this.scriptOf(1, index) });
    }
    return out;
  }

  /** Hands back the newest addresses of the mixing chain when nothing used them, so no gap opens for a restore. */
  private release(from: number, to: number): void {
    for (let i = from; i < to; i++) delete this.store.addrs[this.addressAt(1, i)];
    if (this.store.next1 === to) this.store.next1 = from;
  }

  /** Collateral change goes to one address until it's paid: collateral is only spent if a session is charged. */
  private collateralChange(): Buffer {
    let i = this.store.collateralChange;
    const used = i !== undefined && (this.coins.some((c) => c.chain === 1 && c.index === i) || this.store.addrs[this.addressAt(1, i)]?.state === 'live');
    if (i === undefined || used) {
      i = this.store.next1++;
      this.store.collateralChange = i;
    }
    this.store.addrs[this.addressAt(1, i)] = { chain: 1, index: i, rounds: 0, kind: 'collateral', state: 'expected', at: Date.now() };
    return this.scriptOf(1, i);
  }

  private async get(p: string): Promise<any> {
    let last: unknown;
    for (const base of this.opts.apis) {
      try { return await getJson(base + p, { agent: this.opts.agent, timeoutMs: this.opts.timeoutMs ?? 30_000 }); } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach the DASH server.');
  }

  private async broadcast(hex: string, id: string): Promise<void> {
    let last: unknown;
    for (const base of this.opts.apis) {
      try {
        const res = await requestJson(`${base}/tx/send`, { method: 'POST', body: { rawtx: hex }, agent: this.opts.agent, timeoutMs: this.opts.timeoutMs ?? 30_000 });
        if (res.status >= 400) throw new Error(String(res.body?.message ?? res.body?.error ?? res.status).slice(0, 200));
        if (res.body?.txid && res.body.txid !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
        return;
      } catch (e) { last = e; }
    }
    throw new Error(`Send rejected: ${(last as Error)?.message ?? ''}`);
  }

  private async utxos(addresses: string[]): Promise<any[]> {
    const rows: any[] = [];
    for (let i = 0; i < addresses.length; i += BATCH) {
      const r = await this.get(`/addrs/${addresses.slice(i, i + BATCH).join(',')}/utxo`);
      if (Array.isArray(r)) rows.push(...r);
    }
    return rows;
  }

  /**
   * After a restore there is no record: both chains are scanned for coins, which start again at round 0. Only
   * coins matter here (spent addresses never need watching), and addresses are used in order, so the scan stops
   * after a run of unused ones.
   */
  private async recover(): Promise<void> {
    for (const chain of [0, 1] as const) {
      let gapEnd = RESTORE_GAP;
      let next = 0;
      for (let start = 0; start < gapEnd && start < 5000; start += BATCH) {
        const addrs = Array.from({ length: BATCH }, (_, i) => this.addressAt(chain, start + i));
        const used = new Set<string>();
        const r = await this.get(`/addrs/${addrs.join(',')}/txs?from=0&to=50&noAsm=1`);
        for (const tx of r?.items ?? []) for (const v of tx.vout ?? []) for (const a of v.scriptPubKey?.addresses ?? []) used.add(a);
        const coins = new Set((await this.utxos(addrs)).map((row) => row.address));
        addrs.forEach((a, i) => {
          if (!used.has(a) && !coins.has(a)) return;
          next = Math.max(next, start + i + 1);
          gapEnd = Math.max(gapEnd, start + i + 1 + RESTORE_GAP);
          if (coins.has(a)) this.store.addrs[a] = { chain, index: start + i, rounds: 0, kind: 'denom', state: 'expected', at: Date.now() };
        });
      }
      if (chain === 0) this.store.next = Math.max(this.store.next, next); else this.store.next1 = Math.max(this.store.next1, next);
    }
    this.store.scanned = true;
    await this.save();
  }

  private refreshedAt = 0;

  /** For the balance screen: reads again only when the last read is older than `ms`. */
  async refreshIfStale(ms = 60_000): Promise<void> {
    if (Date.now() - this.refreshedAt < ms) return;
    await this.refresh();
  }

  /** Whether this wallet has ever used CoinJoin, so nothing runs for those that haven't. */
  async used(): Promise<boolean> { await this.load(); return Object.keys(this.store.addrs).length > 0; }

  async paused(): Promise<boolean> { await this.load(); return this.store.paused === true; }

  async setPaused(p: boolean): Promise<void> {
    await this.load();
    this.store.paused = p;
    await this.save();
    if (p) this.stop(); else this.start();
  }

  async refresh(): Promise<void> {
    await this.load();
    const watched = Object.keys(this.store.addrs);
    const rows = await this.utxos(watched);
    const coins: MixCoin[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const t = this.store.addrs[row.address];
      if (!t || !/^[0-9a-f]{64}$/.test(row.txid) || !Number.isInteger(row.vout)) continue;
      const value = BigInt(row.satoshis ?? 0);
      if (value <= 0n) continue;
      seen.add(row.address);
      // A coin that isn't a standard size can't be mixed; small ones serve as collateral.
      const kind: Tracked['kind'] = isDenom(value) ? 'denom' : 'collateral';
      coins.push({ txid: row.txid, vout: row.vout, value, address: row.address, chain: t.chain, index: t.index, rounds: kind === 'denom' ? t.rounds : 0, kind, confirmed: (row.confirmations ?? 0) >= 1 || row.txlock === true });
    }
    let changed = false;
    for (const [a, t] of Object.entries(this.store.addrs)) {
      if (seen.has(a)) { if (t.state !== 'live') { t.state = 'live'; changed = true; } continue; }
      // Spent, or never arrived (a mix that didn't go through): no longer watched.
      if (t.state === 'live' || Date.now() - t.at > EXPECTED_FOR_MS) { delete this.store.addrs[a]; changed = true; }
    }
    if (changed) await this.save();
    this.coins = coins;
    this.refreshedAt = Date.now();
    this.updateStatus();
  }

  private updateStatus(): void {
    const sum = (f: (c: MixCoin) => boolean) => this.coins.filter(f).reduce((s, c) => s + c.value, 0n);
    const mixed = sum((c) => c.kind === 'denom' && c.rounds >= MIX_ROUNDS);
    const mixing = sum((c) => c.kind === 'denom' && c.rounds < MIX_ROUNDS);
    const collateral = sum((c) => c.kind === 'collateral');
    const done = this.coins.filter((c) => c.kind === 'denom').reduce((s, c) => s + BigInt(Math.min(c.rounds, MIX_ROUNDS)) * c.value, 0n);
    const goal = (mixed + mixing) * BigInt(MIX_ROUNDS);
    Object.assign(this.status, {
      mixed: formatAmount(mixed, 8), mixing: formatAmount(mixing, 8), collateral: formatAmount(collateral, 8),
      total: formatAmount(mixed + mixing + collateral, 8), progress: goal > 0n ? Number((done * 1000n) / goal) / 10 : 0,
    });
  }

  balance(): { total: bigint; mixed: bigint } {
    const total = this.coins.reduce((s, c) => s + c.value, 0n);
    const mixed = this.coins.filter((c) => c.kind === 'denom' && c.rounds >= MIX_ROUNDS && c.confirmed).reduce((s, c) => s + c.value, 0n);
    return { total, mixed };
  }

  // ---- splitting regular coins into the standard sizes ----

  /** The standard sizes an amount splits into, largest first, plus a few collateral coins. */
  static split(amount: bigint): bigint[] {
    const out: bigint[] = [];
    let left = amount;
    for (const d of DENOMS) while (left >= d) { out.push(d); left -= d; }
    return out;
  }

  /**
   * Outputs for splitting `amount` of regular DASH into this account. The caller builds and signs the
   * transaction with the regular account's coins and change; what doesn't fit a size stays as change.
   */
  async planSplit(amount: bigint, needCollateral = true): Promise<SplitPlan> {
    await this.load();
    const parts = DashMixer.split(amount);
    if (!parts.length) throw new Error(`The smallest amount to mix is ${formatAmount(DENOMS[DENOMS.length - 1], 8)} DASH.`);
    if (parts.length > RESTORE_GAP) throw new Error(`That amount would make more than ${RESTORE_GAP} coins at once. Mix a smaller amount, then the rest.`);
    const haveCollateral = this.coins.some((c) => c.kind === 'collateral');
    const values = [...parts, ...Array.from({ length: needCollateral && !haveCollateral ? COLLATERAL_COINS : 0 }, () => MAX_COLLATERAL)];
    for (let i = values.length - 1; i > 0; i--) { const j = randomBelow(i + 1); [values[i], values[j]] = [values[j], values[i]]; }
    // The addresses are only taken when the split is confirmed (commitSplit), so a preview never leaves a gap.
    const start = this.store.next;
    const outputs = values.map((value, i) => ({ address: this.addressAt(0, start + i), value }));
    return { start, outputs, mixable: parts.reduce((s, v) => s + v, 0n) };
  }

  /** Takes a split's addresses, or refuses if another split took them first. */
  async commitSplit(plan: SplitPlan): Promise<void> {
    await this.load();
    if (plan.start !== this.store.next) throw new Error('The review expired. Try again.');
    plan.outputs.forEach((o, i) => {
      if (o.address !== this.addressAt(0, plan.start + i)) throw new Error('A CoinJoin address does not match this wallet\'s keys, so signing was stopped.');
      this.store.addrs[o.address] = { chain: 0, index: plan.start + i, rounds: 0, kind: isDenom(o.value) ? 'denom' : 'collateral', state: 'expected', at: Date.now() };
    });
    this.store.next = plan.start + plan.outputs.length;
    await this.save();
  }

  // ---- the masternode list ----

  private async masternodes(): Promise<Masternode[]> {
    if (this.list && Date.now() - this.list.at < LIST_FOR_MS) return this.list.masternodes;
    const best = await this.get('/status?q=getBestBlockHash');
    const tip = await this.get(`/block/${best?.bestblockhash}`);
    if (!Number.isInteger(tip?.height)) throw new Error('The DASH server gave an unexpected answer.');
    const at = await this.get(`/block-index/${tip.height - LIST_DEPTH}`);
    const block = await this.get(`/block/${at?.blockHash}`);
    if (typeof block?.merkleroot !== 'string' || block.hash !== at.blockHash) throw new Error('The DASH server gave an unexpected answer.');
    let last: unknown;
    for (const seed of this.opts.seeds ?? DASH_SEEDS) {
      const [host, port] = seed.split(':');
      let peer: DashPeer | null = null;
      try {
        peer = new DashPeer(await this.opts.dial(host, Number(port ?? DASH_PORT)));
        await peer.handshake(host, Number(port ?? DASH_PORT), false);
        peer.send('getmnlistd', getMnListDiff(block.hash));
        const m = await peer.next(['mnlistdiff'], 60_000);
        const list = readMasternodeList(m.payload, { blockHash: block.hash, merkleRoot: block.merkleroot });
        if (Array.isArray(block.tx) && block.tx[0] !== list.coinbase) throw new Error('The masternode list does not belong to that block.');
        this.list = { ...list, at: Date.now() };
        return list.masternodes;
      } catch (e) { last = e; } finally { peer?.close(); }
    }
    throw new Error(`Could not get the masternode list: ${(last as Error)?.message ?? 'no node answered'}`);
  }

  private own(c: { chain: number; index: number; txid: string; vout: number; value: bigint }): OwnCoin {
    const k = this.key(c.chain, c.index);
    return { txid: c.txid, vout: c.vout, value: c.value, script: this.scriptOf(c.chain, c.index), privateKey: k.privateKey, publicKey: k.publicKey };
  }

  // ---- mixing ----

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.status.running = true;
    this.status.error = null;
    if (!this.loop) this.loop = this.run().finally(() => { this.loop = null; });
  }

  stop(): void {
    this.stopped = true;
    this.status.running = false;
    this.status.step = '';
    this.peer?.close();
  }

  get running(): boolean { return !this.stopped; }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => { const t = setTimeout(r, ms); (t as any).unref?.(); });
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        const worked = await this.round();
        failures = worked ? 0 : failures;
        // Coins still to confirm are checked every minute; with everything mixed, now and then for new ones.
        if (!worked) await this.wait(this.status.step === 'done' ? 600_000 : 60_000);
      } catch (e) {
        failures++;
        this.status.error = (e as Error).message;
        this.status.step = 'retrying';
        await this.wait(Math.min(15_000 * 2 ** Math.min(failures, 4), 300_000));
      }
    }
  }

  /** One session: the size with coins furthest from done, up to 9 of them with the same rounds. False when nothing is left to mix. */
  async round(): Promise<boolean> {
    this.status.step = 'checking';
    await this.refresh();
    const ready = this.coins.filter((c) => c.kind === 'denom' && c.confirmed && c.rounds < MIX_ROUNDS);
    if (!ready.length) {
      this.status.step = this.coins.some((c) => c.kind === 'denom' && c.rounds < MIX_ROUNDS) ? 'waiting' : 'done';
      return false;
    }
    const collateral = this.coins.find((c) => c.kind === 'collateral' && c.confirmed && c.value >= COLLATERAL);
    if (!collateral) throw new Error('No collateral coin is ready. Mix a little more DASH to make one.');
    // Fewest rounds first, then the size with most of those coins.
    const minRounds = Math.min(...ready.map((c) => c.rounds));
    const atMin = ready.filter((c) => c.rounds === minRounds);
    const bySize = new Map<bigint, MixCoin[]>();
    for (const c of atMin) bySize.set(c.value, [...(bySize.get(c.value) ?? []), c]);
    const [value, group] = [...bySize.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    for (let i = group.length - 1; i > 0; i--) { const j = randomBelow(i + 1); [group[i], group[j]] = [group[j], group[i]]; }
    const picked = group.slice(0, 1 + randomBelow(Math.min(group.length, MAX_ENTRY)));

    this.status.step = 'masternodes';
    const usable = (await this.masternodes()).filter((m) => m.valid && /^\d+\.\d+\.\d+\.\d+$/.test(m.host));
    if (!usable.length) throw new Error('No masternode is available to mix with.');
    // A different masternode each time where possible.
    const fresh = usable.filter((m) => !this.recent.includes(m.proTxHash));
    const all = fresh.length ? fresh : usable;
    const mn = all[randomBelow(all.length)];
    this.recent = [mn.proTxHash, ...this.recent].slice(0, Math.max(10, Math.floor(all.length / 10)));

    const changeScript = this.collateralChange();
    const first = this.store.next1;
    const outputs = this.reserve(picked.length, 'denom', minRounds + 1);
    await this.save();
    const plan = {
      denom: denomBit(value), proTxHash: mn.proTxHash,
      coins: picked.map((c) => this.own(c)),
      outputs: outputs.map((o) => ({ value, script: o.script })) as TxOut[],
      collateral: collateralTx(this.own(collateral), changeScript),
    };
    this.status.step = 'connecting';
    const peer = new DashPeer(await this.opts.dial(mn.host, mn.port));
    this.peer = peer;
    try {
      await peer.handshake(mn.host, mn.port, true);
      const steps: Record<SessionStep, string> = { queued: 'queued', ready: 'mixing', entered: 'mixing', signing: 'signing', done: 'done' };
      await runSession(peer, plan, (s) => { this.status.step = steps[s]; });
    } catch (e) {
      // The new addresses were never paid: handed back, so the next session uses them and no gap opens.
      this.release(first, first + outputs.length);
      await this.save();
      throw e;
    } finally {
      peer.close();
      this.peer = null;
    }
    this.status.sessions++;
    this.status.lastMix = Date.now();
    this.status.error = null;
    return true;
  }

  // ---- private sends ----

  /** Mixed coins for a payment: no change, so the smallest overshoot goes to the miners as fee. */
  async draftPrivate(to: string, amount: bigint | 'max'): Promise<{ to: string; amount: bigint; fee: bigint; coins: MixCoin[] }> {
    await this.refresh();
    const mixed = this.coins.filter((c) => c.kind === 'denom' && c.rounds >= MIX_ROUNDS && c.confirmed).sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
    if (!mixed.length) throw new Error('No mixed DASH yet. Mixing has to finish a few rounds first.');
    if (amount === 'max') {
      const sum = mixed.reduce((s, c) => s + c.value, 0n);
      const fee = sizeOf(mixed.length, 1) * FEE_PER_BYTE;
      return { to, amount: sum - fee, fee, coins: mixed };
    }
    // Largest first while it doesn't overshoot, then the smallest coin that covers what's left.
    const picked: MixCoin[] = [];
    let sum = 0n;
    const needed = () => amount + sizeOf(picked.length + 1, 1) * FEE_PER_BYTE;
    for (const c of mixed) if (sum + c.value <= needed()) { picked.push(c); sum += c.value; }
    if (sum < needed()) {
      const rest = mixed.filter((c) => !picked.includes(c)).sort((a, b) => (a.value > b.value ? 1 : -1));
      const top = rest.find((c) => sum + c.value >= amount + sizeOf(picked.length + 1, 1) * FEE_PER_BYTE);
      if (!top) throw new Error('Not enough mixed DASH for that amount and fee.');
      picked.push(top);
      sum += top.value;
    }
    const fee = sum - amount;
    if (fee - sizeOf(picked.length, 1) * FEE_PER_BYTE > MAX_PRIVATE_OVERPAY) throw new Error(`Mixed coins come in fixed sizes and would overpay by more than ${formatAmount(MAX_PRIVATE_OVERPAY, 8)} DASH. Choose an amount closer to your mixed balance, or send all of it.`);
    return { to, amount, fee, coins: picked };
  }

  async sendPrivate(draft: { to: string; amount: bigint; fee: bigint; coins: MixCoin[] }): Promise<string> {
    const out = btc.OutScript.encode(btc.Address(DASH_NET).decode(draft.to));
    const sum = draft.coins.reduce((s, c) => s + c.value, 0n);
    if (sum - draft.amount !== draft.fee || draft.amount <= 0n) throw new Error('The amounts do not add up, so signing was stopped.');
    if (draft.fee > sizeOf(draft.coins.length, 1) * FEE_PER_BYTE + MAX_PRIVATE_OVERPAY) throw new Error('The fee is too high, so signing was stopped.');
    const tx: DashTx = {
      version: 2, type: 0, lockTime: 0,
      inputs: draft.coins.map((c) => ({ txid: c.txid, vout: c.vout, script: Buffer.alloc(0), sequence: 0xffffffff })),
      outputs: [{ value: draft.amount, script: Buffer.from(out) }],
    };
    const signed = signAll(tx, draft.coins.map((c) => this.own(c)));
    const id = txId(signed);
    await this.broadcast(txBytes(signed).toString('hex'), id);
    await this.refresh().catch(() => undefined);
    return id;
  }
}

export { isCollateralAmount, readTx, Reader, hashHex };
