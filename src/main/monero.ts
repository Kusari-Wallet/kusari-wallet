import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import moneroTs from 'monero-ts';
import { formatAmount } from './amount';

export interface MoneroHistoryItem {
  asset: 'XMR';
  hash: string;
  direction: 'in' | 'out' | 'self';
  amount: string;
  counterparty: string;
  timestamp: number;
  status: 'confirmed' | 'pending' | 'failed';
  confirmations: number;
  dust: boolean;
}

export interface MoneroState {
  connected: boolean;
  node: string | null;
  height: number;
  targetHeight: number;
  synced: boolean;
  percent: number;
  error: string | null;
}

export interface MoneroDraft { txs: any[]; fee: bigint; amount: bigint }

type NetType = 'mainnet' | 'stagenet';
const ENGINE_TIMEOUT_MS = 60_000;

function netEnum(type: NetType) {
  return type === 'mainnet' ? moneroTs.MoneroNetworkType.MAINNET : moneroTs.MoneroNetworkType.STAGENET;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('Timed out')), ms))]);
}

/** Point monero-ts at the unpacked worker when running from a packaged app. */
export function configureMoneroWorker(): void {
  // Bundled builds carry monero-ts's worker as one file next to the app's own bundle.
  const bundled = path.join(__dirname, 'monero-worker.js');
  if (path.basename(__filename) === 'app.js' && existsSync(bundled)) {
    moneroTs.LibraryUtils.setWorkerDistPath(bundled.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));
    return;
  }
  const current = moneroTs.LibraryUtils.WORKER_DIST_PATH;
  if (current && current.includes('app.asar') && !current.includes('app.asar.unpacked')) {
    moneroTs.LibraryUtils.setWorkerDistPath(current.replace('app.asar', 'app.asar.unpacked'));
  }
}

export async function generateMoneroSeed(type: NetType): Promise<string> {
  const keys = await withTimeout<any>(moneroTs.createWalletKeys({ networkType: netEnum(type), language: 'English' }), ENGINE_TIMEOUT_MS)
    .catch(() => { throw new Error('Could not start the Monero module.'); });
  const seed = await keys.getSeed();
  await keys.close();
  return seed;
}

export async function validateMoneroSeed(seed: string): Promise<string> {
  const normalized = seed.trim().toLowerCase().split(/\s+/).join(' ');
  if (normalized.split(' ').length !== 25) throw new Error('A Monero seed has 25 words.');
  try {
    const keys = await withTimeout<any>(moneroTs.createWalletKeys({ networkType: moneroTs.MoneroNetworkType.MAINNET, seed: normalized }), ENGINE_TIMEOUT_MS);
    await keys.close();
  } catch {
    throw new Error('The Monero seed phrase is not valid.');
  }
  return normalized;
}

export interface MoneroOptions {
  type: NetType;
  dir: string;
  filePassword: string;
  seed: string;
  restoreHeight: number;
  nodes: string[];
  /** Tests only: accepts a local regtest daemon, which reports a different network. */
  allowFakechain?: boolean;
  /** Tor's SOCKS address. When set, the wallet has no route to a node except through it. */
  proxyUri?: string;
  /** Android Tor: the forwarder handles Tor, but connections are just as slow. */
  overTor?: boolean;
  /** Android: no files, so keys and cache are stored as bytes. */
  store?: { load(): Promise<{ keys: Uint8Array; cache: Uint8Array } | null>; save(keys: Uint8Array, cache: Uint8Array): Promise<void> };
  /** Tests only: a different wallet engine behind the same interface. */
  walletFactory?: () => Promise<any>;
}

export class MoneroClient extends EventEmitter {
  private wallet: any = null;
  private retry: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private healthMisses = 0;
  private primaryAddress = '';
  private lastBalance: { total: bigint; unlocked: bigint } = { total: 0n, unlocked: 0n };
  private balanceInFlight: Promise<void> | null = null;
  state: MoneroState = { connected: false, node: null, height: 0, targetHeight: 0, synced: false, percent: 0, error: null };

  constructor(private readonly opts: MoneroOptions) { super(); }

  private patch(update: Partial<MoneroState>): void {
    this.state = { ...this.state, ...update };
    this.emit('state', this.state);
  }

  async open(): Promise<void> {
    mkdirSync(this.opts.dir, { recursive: true });
    const file = path.join(this.opts.dir, 'wallet');
    if (this.opts.walletFactory) {
      this.wallet = await this.opts.walletFactory();
    } else if (this.opts.store) {
      const saved = await this.opts.store.load();
      this.wallet = saved
        ? await moneroTs.openWalletFull({ keysData: saved.keys, cacheData: saved.cache, password: this.opts.filePassword, networkType: netEnum(this.opts.type) } as any)
        : await moneroTs.createWalletFull({ password: this.opts.filePassword, networkType: netEnum(this.opts.type), seed: this.opts.seed, restoreHeight: await this.resolveRestoreHeight() });
      if (!saved) await this.save();
    } else if (existsSync(`${file}.keys`)) {
      this.wallet = await withTimeout(moneroTs.openWalletFull({ path: file, password: this.opts.filePassword, networkType: netEnum(this.opts.type) }), 180_000);
    } else {
      this.wallet = await moneroTs.createWalletFull({
        path: file, password: this.opts.filePassword, networkType: netEnum(this.opts.type),
        seed: this.opts.seed, restoreHeight: await this.resolveRestoreHeight(),
      });
      await this.wallet.save();
    }
    // Read these before syncing starts: wallet calls wait behind a sync step, which can take minutes.
    this.primaryAddress = await this.wallet.getAddress(0, 0);
    await this.refreshBalance();
    const self = this;
    class Listener extends moneroTs.MoneroWalletListener {
      async onSyncProgress(height: number, _start: number, end: number, percent: number): Promise<void> {
        self.patch({ height, targetHeight: end, percent, synced: percent >= 1 });
      }
      async onBalancesChanged(): Promise<void> { self.emit('balance'); }
    }
    await this.wallet.addListener(new Listener());
    this.saveTimer = setInterval(() => { void this.save(); }, 120_000);
    this.healthTimer = setInterval(() => { void this.checkHealth(); }, 60_000);
    void this.connect();
  }

  /** A negative height means a brand new seed: start at the current tip when a node answers. */
  private async resolveRestoreHeight(): Promise<number> {
    if (this.opts.restoreHeight >= 0) return this.opts.restoreHeight;
    try {
      const uri = await this.pickNode();
      const daemon = await moneroTs.connectToDaemonRpc({ uri, proxyUri: this.proxyFor(uri), proxyToWorker: false } as any);
      return Math.max(0, (await withTimeout(daemon.getHeight(), this.nodeTimeout)) - 10);
    } catch {
      return 0;
    }
  }

  /** A node on this PC or local network never needs Tor, and Tor couldn't reach it anyway. */
  private proxyFor(uri: string): string | undefined {
    if (!this.opts.proxyUri) return undefined;
    const host = new URL(uri).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ? undefined : this.opts.proxyUri;
  }

  private get viaTor() { return Boolean(this.opts.proxyUri || this.opts.overTor); }
  private get nodeTimeout() { return this.viaTor ? 60_000 : 10_000; }

  private async pickNode(): Promise<string> {
    let lastError = 'No node';
    for (const uri of this.opts.nodes) {
      try {
        const daemon = await moneroTs.connectToDaemonRpc({ uri, proxyUri: this.proxyFor(uri), proxyToWorker: false } as any);
        if (this.opts.allowFakechain) { await withTimeout(daemon.getHeight(), this.nodeTimeout); return uri; }
        const info: any = await withTimeout(daemon.getInfo(), this.nodeTimeout);
        if (info.getNetworkType() !== netEnum(this.opts.type)) { lastError = 'The node is on a different network.'; continue; }
        if (info.getIsBusySyncing?.()) { lastError = 'The node is still syncing.'; continue; }
        return uri;
      } catch (e) {
        lastError = this.viaTor ? 'Could not reach a node through Tor.' : 'No public node answered.';
        void e;
      }
    }
    throw new Error(lastError);
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    try {
      const uri = await this.pickNode();
      if (this.closed) return;
      await this.wallet.setDaemonConnection(new moneroTs.MoneroRpcConnection({ uri, proxyUri: this.proxyFor(uri) } as any));
      this.patch({ connected: true, node: uri, error: null });
      await this.wallet.startSyncing(15_000);
      const [height, target] = await Promise.all([this.wallet.getHeight(), this.wallet.getDaemonHeight()]);
      this.patch({ height, targetHeight: target, synced: target > 0 && height >= target });
      this.emit('balance');
    } catch (e) {
      this.patch({ connected: false, node: null, error: (e as Error).message });
      this.retry = setTimeout(() => void this.connect(), 30_000);
    }
  }

  /**
   * A node or Tor can die after we connect. Asks the node directly, because the wallet's own
   * answer is cached and waits behind a sync step. Two misses in a row count as lost.
   */
  async checkHealth(): Promise<void> {
    if (this.closed || !this.state.connected || !this.wallet) return;
    const uri = this.state.node ?? '';
    try {
      const daemon = await moneroTs.connectToDaemonRpc({ uri, proxyUri: this.proxyFor(uri), proxyToWorker: false } as any);
      await withTimeout(daemon.getHeight(), this.nodeTimeout);
      this.healthMisses = 0;
      void withTimeout(this.refreshSynced(), 15_000).catch(() => undefined);
      return;
    } catch {
      if (++this.healthMisses < 2) return;
    }
    this.healthMisses = 0;
    this.patch({ connected: false, node: null, synced: false, error: this.viaTor ? 'The Tor connection dropped.' : 'The node connection dropped.' });
    await withTimeout<void>(this.wallet.stopSyncing(), 15_000).catch(() => undefined);
    void this.connect();
  }

  private async refreshSynced(): Promise<boolean> {
    if (!this.state.connected) return false;
    const [height, target] = await Promise.all([this.wallet.getHeight(), this.wallet.getDaemonHeight()]);
    const synced = target > 0 && height >= target;
    this.patch({ height, targetHeight: target, synced });
    return synced;
  }

  private refreshBalance(): Promise<void> {
    if (!this.balanceInFlight) {
      this.balanceInFlight = Promise.all([this.wallet.getBalance(0), this.wallet.getUnlockedBalance(0)])
        .then(([total, unlocked]) => { this.lastBalance = { total: BigInt(total), unlocked: BigInt(unlocked) }; })
        .finally(() => { this.balanceInFlight = null; });
    }
    return this.balanceInFlight;
  }

  /** Newest balance available right now. Never makes the screen wait for a sync step. */
  async getBalance(waitMs = 1500): Promise<{ total: bigint; unlocked: bigint }> {
    await withTimeout(this.refreshBalance(), waitMs).catch(() => undefined);
    return this.lastBalance;
  }

  async getPrimaryAddress(): Promise<string> { return this.primaryAddress; }

  async listAddresses(): Promise<{ index: number; address: string; label: string }[]> {
    const list = await this.wallet.getSubaddresses(0);
    return list.map((s: any) => ({ index: s.getIndex(), address: s.getAddress(), label: s.getLabel() ?? '' }));
  }

  async createSubaddress(): Promise<string> {
    const sub = await this.wallet.createSubaddress(0);
    await this.save();
    return sub.getAddress();
  }

  /** XMR that reached one of my addresses. Null while the wallet is too busy to answer. */
  async receivedBy(address: string, waitMs = 5000): Promise<{ total: bigint; unlocked: bigint } | null> {
    if (!this.state.connected) return null;
    const read = async () => {
      const subs: any[] = await this.wallet.getSubaddresses(0);
      const sub = subs.find((s) => s.getAddress() === address);
      if (!sub) throw new Error('This address is not from this wallet.');
      const transfers: any[] = await this.wallet.getIncomingTransfers({ accountIndex: 0, subaddressIndex: sub.getIndex() });
      let total = 0n;
      let unlocked = 0n;
      for (const t of transfers) {
        const amount = BigInt(t.getAmount());
        total += amount;
        if ((t.getTx().getNumConfirmations() ?? 0) >= 10) unlocked += amount;
      }
      return { total, unlocked };
    };
    try { return await withTimeout(read(), waitMs); } catch (e) {
      if (/not from this wallet/.test((e as Error).message)) throw e;
      return null;
    }
  }

  async isValidAddress(address: string): Promise<boolean> {
    return moneroTs.MoneroUtils.isValidAddress(address, netEnum(this.opts.type));
  }

  async draft(to: string, amount: bigint | 'max'): Promise<MoneroDraft> {
    const synced = await withTimeout(this.refreshSynced(), this.viaTor ? 40_000 : 8_000).catch(() => false);
    if (!synced) throw new Error('Monero must finish syncing before it can send.');
    const txs: any[] = amount === 'max'
      ? await this.wallet.sweepUnlocked({ accountIndex: 0, address: to, relay: false })
      : [await this.wallet.createTx({ accountIndex: 0, address: to, amount, relay: false })];
    const fee = txs.reduce((sum, tx) => sum + BigInt(tx.getFee()), 0n);
    const sent = amount === 'max'
      ? txs.reduce((sum, tx) => sum + BigInt(tx.getOutgoingAmount()), 0n)
      : amount;
    return { txs, fee, amount: sent };
  }

  async relay(draft: MoneroDraft): Promise<string[]> {
    const hashes: string[] = await this.wallet.relayTxs(draft.txs);
    await this.wallet.sync();
    await this.save();
    this.emit('balance');
    return hashes;
  }

  async getHistory(): Promise<MoneroHistoryItem[]> {
    if (!this.state.connected) throw new Error('Available once connected to a node.');
    const txs: any[] = await this.wallet.getTxs();
    const items = txs.map((tx): MoneroHistoryItem => {
      const incoming = BigInt(tx.getIncomingAmount() ?? 0);
      const outgoing = BigInt(tx.getOutgoingAmount() ?? 0);
      const isOut = Boolean(tx.getIsOutgoing());
      const isIn = Boolean(tx.getIsIncoming());
      const direction = isOut && isIn && incoming >= outgoing ? 'self' : isOut ? 'out' : 'in';
      const block = tx.getBlock?.();
      return {
        asset: 'XMR', hash: tx.getHash(), direction,
        amount: formatAmount(direction === 'in' ? incoming : outgoing, 12),
        counterparty: '',
        timestamp: block ? block.getTimestamp() * 1000 : Date.now(),
        status: tx.getIsFailed() ? 'failed' : tx.getIsConfirmed() ? 'confirmed' : 'pending',
        confirmations: tx.getNumConfirmations() ?? 0,
        dust: false,
      };
    });
    return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
  }

  async flush(): Promise<void> { await this.save(); }

  private async save(): Promise<void> {
    try {
      if (this.opts.store && this.wallet) {
        const [keys, cache] = await this.wallet.getData();
        await this.opts.store.save(keys, cache);
      } else {
        await this.wallet?.save();
      }
    } catch { /* next interval retries */ }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.opts.store) await withTimeout(this.save(), 20_000).catch(() => undefined);
    if (this.retry) clearTimeout(this.retry);
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    const wallet = this.wallet;
    this.wallet = null;
    this.removeAllListeners();
    if (wallet) await wallet.close(true).catch(() => undefined);
  }
}
