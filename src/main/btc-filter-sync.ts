// Private Bitcoin sync with compact block filters (BIP157/158). Instead of asking a server about each address, the
// wallet follows the chain's headers from peers, downloads each block's filter, checks its own scripts against it
// here on the device, and fetches only the blocks that match. No server or peer learns which addresses are this
// wallet's. Peers are onion nodes reached over Tor; filters are only trusted when two peers agree on them.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BtcPeer, BTC_PORT, type PeerAddress } from './btc-p2p';
import type { Dial } from './dash-p2p';
import { RETARGET, bitsToTarget, dsha, fromHexLE, hashValue, headerWork, nextTarget, parseBlock, parseTx, readHeader } from './btc-block';
import { filterHash, filterMatchesAny } from './btc-gcs';
import type { Records } from './records';
import { BTC_ONION_SEEDS } from './btc-seeds';

/** Blocks the chain is followed from, from Bitcoin Core's own parameters, with the least difficulty expected after each. */
export interface Checkpoint { height: number; hash: string; minDifficulty: number }
export const BTC_CHECKPOINTS: Checkpoint[] = [
  { height: 481824, hash: '0000000000000000001c8018d9cb3b742ef25114f27563e3fc4a1902167f9893', minDifficulty: 2e11 },
  { height: 840000, hash: '0000000000000000000320283a032748cef8227873ff4872689bf23f1cda83a5', minDifficulty: 2e13 },
  { height: 880000, hash: '000000000000000000010b17283c3c400507969a9c2afd1dcf2082ec5cca2880', minDifficulty: 3e13 },
  { height: 910000, hash: '0000000000000000000108970acb9522ffd516eae17acddcb1bd16469194a821', minDifficulty: 3e13 },
  { height: 935000, hash: '0000000000000000000147034958af1652b2b91bba607beacc5e72a56f0fb5ee', minDifficulty: 4e13 },
  { height: 965000, hash: '00000000000000000001595977e6000ce56129f5c9b4073e31ccc30b90b97da9', minDifficulty: 4e13 },
];
/** Taproot (the wallet's address type) began here: nothing can have been sent to the wallet before. */
export const TAPROOT_HEIGHT = 709632;

const DIFF1 = 0xffffn << 208n;
const targetFor = (difficulty: number): bigint => (difficulty < 1 ? (1n << 256n) - 1n : DIFF1 / BigInt(Math.floor(difficulty)));

/** Block height around a date, from two known blocks (good to about a day). */
export function estimateBtcHeight(date: Date): number {
  const [h1, t1, h2, t2] = [840000, 1713571767, 966143, 1788925573];
  const t = date.getTime() / 1000;
  const per = (t2 - t1) / (h2 - h1);
  return Math.round(t <= t1 ? h1 - (t1 - t) / 600 : h1 + (t - t1) / per);
}

// ---- the header chain ----

export class HeaderChain {
  readonly hashes: Uint8Array[];
  private readonly raw: Buffer[] = [];
  private readonly index = new Map<string, number>();
  private works: bigint[] = [0n];

  constructor(readonly base: number, baseHash: Uint8Array, readonly maxTarget: bigint) {
    this.hashes = [baseHash];
    this.index.set(Buffer.from(baseHash).toString('hex'), base);
  }

  get tip(): number { return this.base + this.raw.length; }
  get tipHash(): Uint8Array { return this.hashes[this.hashes.length - 1]; }
  get work(): bigint { return this.works[this.works.length - 1]; }
  hashAt(h: number): Uint8Array | undefined { return this.hashes[h - this.base]; }
  heightOf(hashLE: Uint8Array): number | undefined { return this.index.get(Buffer.from(hashLE).toString('hex')); }
  private headerAt(h: number): Buffer | undefined { return h > this.base ? this.raw[h - this.base - 1] : undefined; }
  timeAt(h: number): number | undefined { const r = this.headerAt(h); return r ? r.readUInt32LE(68) : undefined; }

  /** Hashes a peer can find its place from: the newest ten, then further and further back. */
  locator(): Uint8Array[] {
    const out: Uint8Array[] = [];
    let step = 1;
    for (let h = this.tip; h > this.base; h -= step) { out.push(this.hashAt(h)!); if (out.length >= 10) step *= 2; }
    out.push(this.hashes[0]);
    return out;
  }

  /**
   * Adds headers a peer sent, after checking each one's proof of work and difficulty. Headers that branch off
   * replace the newest ones only when their branch has more work. Returns the lowest height that changed, if any.
   */
  connect(list: Buffer[]): { changedFrom: number | null } {
    if (!list.length) return { changedFrom: null };
    const first = readHeader(list[0]);
    const at = this.heightOf(first.prev);
    if (at === undefined) throw new Error('The Bitcoin peer sent headers that do not join the chain.');
    const fresh: { raw: Buffer; hash: Uint8Array; bits: number; time: number }[] = [];
    const hdr = (h: number): { bits: number; time: number } | undefined => {
      if (h > at) { const f = fresh[h - at - 1]; return f && { bits: f.bits, time: f.time }; }
      const r = this.headerAt(h);
      return r && { bits: r.readUInt32LE(72), time: r.readUInt32LE(68) };
    };
    let prev = this.hashAt(at)!;
    let work = this.works[at - this.base];
    for (let i = 0; i < list.length; i++) {
      const h = at + 1 + i;
      const head = readHeader(list[i]);
      if (Buffer.compare(Buffer.from(head.prev), Buffer.from(prev)) !== 0) throw new Error('The Bitcoin peer sent headers out of order.');
      const target = bitsToTarget(head.bits);
      if (target <= 0n || target > this.maxTarget) throw new Error('A Bitcoin header claims too little work.');
      if (hashValue(head.hash) > target) throw new Error('A Bitcoin header does not have the work it claims.');
      const before = hdr(h - 1);
      if (h % RETARGET !== 0) {
        if (before && before.bits !== head.bits) throw new Error('A Bitcoin header changed difficulty out of turn.');
      } else {
        const firstOfPeriod = hdr(h - RETARGET);
        if (before && firstOfPeriod && nextTarget(before.bits, firstOfPeriod.time, before.time) !== head.bits) throw new Error('A Bitcoin header has the wrong difficulty.');
      }
      fresh.push({ raw: Buffer.from(list[i]), hash: head.hash, bits: head.bits, time: head.time });
      work += headerWork(head.bits);
      prev = head.hash;
    }
    const newTip = at + fresh.length;
    if (newTip <= this.tip && work <= this.work) return { changedFrom: null }; // nothing new, or a weaker branch
    if (at < this.tip && work <= this.work) return { changedFrom: null };
    // Drop what the new branch replaces, then add it.
    for (let h = this.tip; h > at; h--) this.index.delete(Buffer.from(this.hashes[h - this.base]).toString('hex'));
    this.raw.length = at - this.base;
    this.hashes.length = at - this.base + 1;
    this.works.length = at - this.base + 1;
    let w = this.works[this.works.length - 1];
    for (const f of fresh) {
      this.raw.push(f.raw);
      this.hashes.push(f.hash);
      w += headerWork(f.bits);
      this.works.push(w);
      this.index.set(Buffer.from(f.hash).toString('hex'), this.base + this.raw.length);
    }
    return { changedFrom: at + 1 };
  }

  serialize(): Buffer {
    const head = Buffer.alloc(40);
    head.write('KBH1', 0, 'ascii');
    head.writeUInt32LE(this.base, 4);
    Buffer.from(this.hashes[0]).copy(head, 8);
    return Buffer.concat([head, ...this.raw]);
  }

  static restore(buf: Buffer, base: number, baseHash: Uint8Array, maxTarget: bigint): HeaderChain {
    const chain = new HeaderChain(base, baseHash, maxTarget);
    if (buf.length < 40 || buf.toString('ascii', 0, 4) !== 'KBH1' || buf.readUInt32LE(4) !== base || !buf.subarray(8, 40).equals(Buffer.from(baseHash))) return chain;
    const list: Buffer[] = [];
    for (let at = 40; at + 80 <= buf.length; at += 80) list.push(buf.subarray(at, at + 80));
    // Checked again on the way in: the file is only a shortcut.
    for (let i = 0; i < list.length; i += 2000) { try { chain.connect(list.slice(i, i + 2000)); } catch { break; } }
    return chain;
  }
}

// ---- peers ----

/** Onion peers that serve filters, found through the seed nodes, kept between launches. */
export class PeerPool {
  private known: PeerAddress[] = [];
  private live: BtcPeer[] = [];
  private loaded = false;
  private bad = new Map<string, number>();

  constructor(private readonly opts: { dial: Dial; file: string; seeds?: string[]; parallel?: number }) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const j = JSON.parse(await fs.readFile(this.opts.file, 'utf8'));
      if (Array.isArray(j)) this.known = j.filter((p) => typeof p?.host === 'string' && Number.isInteger(p.port)).map((p) => ({ host: p.host, port: p.port, services: BigInt(p.services ?? 0) })).slice(0, 500);
    } catch { /* none yet */ }
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.opts.file), { recursive: true });
    await fs.writeFile(this.opts.file, JSON.stringify(this.known.slice(0, 500).map((p) => ({ host: p.host, port: p.port, services: p.services.toString() }))), { mode: 0o600 });
  }

  private async open(host: string, port: number): Promise<BtcPeer> {
    const peer = new BtcPeer(await this.opts.dial(host, port), host);
    try { await peer.handshake(); } catch (e) { peer.close(); throw e; }
    return peer;
  }

  get connected(): BtcPeer[] { this.live = this.live.filter((p) => !p.isClosed); return [...this.live]; }

  /** Drops a peer that misbehaved, and keeps away from it for a while. */
  drop(peer: BtcPeer): void {
    this.bad.set(peer.host, Date.now() + 30 * 60_000);
    peer.close();
    this.live = this.live.filter((p) => p !== peer);
  }

  /** At least `n` connected peers that serve filters (fewer only if none more can be found). */
  async get(n: number, exclude: BtcPeer[] = []): Promise<BtcPeer[]> {
    await this.load();
    const usable = () => this.connected.filter((p) => p.servesFilters && !exclude.includes(p));
    const now = Date.now();
    const tried = new Set<string>([...this.connected.map((p) => p.host)]);
    const par = this.opts.parallel ?? 4;
    for (let round = 0; round < 4 && usable().length < n; round++) {
      const candidates = this.known.filter((p) => !tried.has(p.host) && (this.bad.get(p.host) ?? 0) < now).sort(() => Math.random() - 0.5).slice(0, Math.max(par, (n - usable().length) * 2));
      if (candidates.length) {
        for (const c of candidates) tried.add(c.host);
        const got = await Promise.allSettled(candidates.map((c) => this.open(c.host, c.port)));
        for (const g of got) if (g.status === 'fulfilled') { if (g.value.servesFilters) this.live.push(g.value); else g.value.close(); }
        // The ones that didn't answer go to the back.
        const failed = new Set(candidates.filter((_, i) => got[i].status === 'rejected').map((c) => c.host));
        this.known = [...this.known.filter((p) => !failed.has(p.host)), ...this.known.filter((p) => failed.has(p.host))];
      }
      if (usable().length < n) await this.discover(tried);
    }
    return usable().slice(0, Math.max(n, usable().length));
  }

  /** Asks seed nodes (and peers already connected) for more onion nodes that serve filters. */
  private async discover(tried: Set<string>): Promise<void> {
    const seeds = (this.opts.seeds ?? BTC_ONION_SEEDS).filter((s) => !tried.has(s.replace(/:\d+$/, ''))).sort(() => Math.random() - 0.5).slice(0, this.opts.parallel ?? 4);
    const ask = async (peer: BtcPeer): Promise<void> => {
      const found = await peer.addresses().catch(() => []);
      const add = found.filter((p) => (p.services & (1n << 6n)) && (p.services & ((1n << 0n) | (1n << 10n))));
      const have = new Set(this.known.map((k) => k.host));
      for (const p of add) if (!have.has(p.host)) { this.known.push(p); have.add(p.host); }
    };
    await Promise.allSettled(this.connected.map(ask));
    const got = await Promise.allSettled(seeds.map((s) => { const [host, port] = s.split(':'); tried.add(host); return this.open(host, Number(port ?? BTC_PORT)); }));
    for (const g of got) {
      if (g.status !== 'fulfilled') continue;
      await ask(g.value);
      if (g.value.servesFilters) this.live.push(g.value); else g.value.close();
    }
    await this.save().catch(() => undefined);
  }

  closeAll(): void { for (const p of this.live) p.close(); this.live = []; }
}

// ---- the wallet's view ----

export interface FilterAccount { id: string; script(chain: number, index: number): Uint8Array; gap: [number, number] }
export interface FilterCoin { txid: string; vout: number; value: string; account: string; chain: number; index: number; height: number; spentBy?: string; spentHeight?: number }
export interface FilterTx { txid: string; height: number; time: number; accounts: Record<string, { in: string; out: string }> }
interface SyncState {
  v: 1; birthday: number; base: number; scanned: number; filterHeader: string;
  next: Record<string, [number, number]>;
  coins: Record<string, FilterCoin>;
  txs: Record<string, FilterTx>;
  pending: Record<string, { at: number; spends: string[] }>;
}

export interface FilterSyncOptions {
  dir: string; records: Records; dial: Dial; birthday: number;
  checkpoints?: Checkpoint[]; seeds?: string[];
  onProgress?: (p: { scanned: number; tip: number }) => void;
}

const BATCH = 1000;
const CACHE_MS = 120_000;
const FORCE_MIN_MS = 20_000;
const PENDING_MS = 3 * 24 * 3600_000;

export class FilterSync {
  private accounts: FilterAccount[] = [];
  private state: SyncState | null = null;
  private chain: HeaderChain | null = null;
  private readonly pool: PeerPool;
  private inFlight: Promise<void> | null = null;
  private lastSync = 0;
  private scripts = new Map<string, { account: string; chain: number; index: number }>();
  private items: Buffer[] = [];
  private readonly checkpoint: Checkpoint;
  lastError: string | null = null;
  progress = { scanned: 0, tip: 0 };

  constructor(private readonly opts: FilterSyncOptions) {
    const cps = opts.checkpoints ?? BTC_CHECKPOINTS;
    // The chain is followed from the newest checkpoint below the first filter needed.
    const start = Math.floor((Math.max(opts.birthday, 1) - 1) / BATCH) * BATCH;
    this.checkpoint = [...cps].reverse().find((c) => c.height <= start) ?? cps[0];
    this.pool = new PeerPool({ dial: opts.dial, file: path.join(opts.dir, 'btc-peers.json'), seeds: opts.seeds });
  }

  get file(): string { return path.join(this.opts.dir, 'btc-filters.json'); }
  get headersFile(): string { return path.join(this.opts.dir, 'btc-headers.txt'); }

  addAccount(a: FilterAccount): void {
    this.accounts = [...this.accounts.filter((x) => x.id !== a.id), a];
    if (this.state) this.rebuildScripts();
  }

  private fresh(): SyncState {
    const start = Math.max(this.checkpoint.height, Math.floor((Math.max(this.opts.birthday, 1) - 1) / BATCH) * BATCH);
    return { v: 1, birthday: this.opts.birthday, base: this.checkpoint.height, scanned: start, filterHeader: '', next: {}, coins: {}, txs: {}, pending: {} };
  }

  async load(): Promise<void> {
    if (this.state) return;
    let s = await this.opts.records.read(this.file).catch(() => undefined) as SyncState | undefined;
    if (!s || s.v !== 1 || s.birthday !== this.opts.birthday || s.base !== this.checkpoint.height) s = this.fresh();
    this.state = s;
    const baseHash = fromHexLE(this.checkpoint.hash);
    const maxTarget = targetFor(this.checkpoint.minDifficulty);
    let buf: Buffer | null = null;
    // Kept as base64 text: the same on every platform's file store.
    try { buf = Buffer.from(String(await fs.readFile(this.headersFile, 'utf8')), 'base64'); } catch { /* none yet */ }
    this.chain = buf ? HeaderChain.restore(buf, this.checkpoint.height, baseHash, maxTarget) : new HeaderChain(this.checkpoint.height, baseHash, maxTarget);
    if (this.state.scanned > this.chain.tip) { this.state = this.fresh(); } // headers lost: scan again
    this.rebuildScripts();
  }

  private rebuildScripts(): void {
    const s = this.state!;
    this.scripts.clear();
    for (const a of this.accounts) {
      const next = s.next[a.id] ?? [0, 0];
      for (const chain of [0, 1]) for (let i = 0; i < next[chain] + a.gap[chain]; i++) this.scripts.set(Buffer.from(a.script(chain, i)).toString('hex'), { account: a.id, chain, index: i });
    }
    this.items = [...this.scripts.keys()].map((k) => Buffer.from(k, 'hex'));
  }

  private async save(): Promise<void> {
    await this.opts.records.write(this.file, this.state);
    const tmp = `${this.headersFile}.tmp`;
    await fs.writeFile(tmp, this.chain!.serialize().toString('base64'), { mode: 0o600 });
    await fs.rename(tmp, this.headersFile);
  }

  get tip(): number { return this.chain?.tip ?? 0; }
  get synced(): boolean { return !!this.state && !!this.chain && this.state.scanned >= this.chain.tip && this.lastSync > 0; }

  sync(force = false): Promise<void> {
    // A forced sync (a send being drafted, coins listed) within seconds of the last one has nothing new to find.
    if (Date.now() - this.lastSync < (force ? FORCE_MIN_MS : CACHE_MS)) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = this.run().then(() => { this.lastSync = Date.now(); this.lastError = null; }, (e) => { this.lastError = (e as Error).message; throw e; }).finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  private async run(): Promise<void> {
    await this.load();
    const s = this.state!; const chain = this.chain!;
    const peers = await this.pool.get(2);
    if (peers.length < 2) throw new Error('Could not reach enough Bitcoin nodes over Tor to check block filters. It will retry automatically.');
    // Headers from every peer: the chain with the most work wins.
    let changedFrom: number | null = null;
    for (const p of peers) {
      try {
        for (let i = 0; i < 400; i++) {
          const list = await p.headers(chain.locator());
          const r = chain.connect(list);
          if (r.changedFrom !== null) changedFrom = Math.min(changedFrom ?? Infinity, r.changedFrom);
          if (list.length < 2000) break;
        }
      } catch { this.pool.drop(p); }
    }
    if (changedFrom !== null && changedFrom <= s.scanned) this.rewind(changedFrom - 1);
    const tip = chain.tip;
    this.progress = { scanned: s.scanned, tip };
    this.opts.onProgress?.(this.progress);
    if (s.scanned >= tip) { this.expirePending(); await this.save(); return; }

    const ok = await this.pool.get(2);
    if (ok.length < 2) throw new Error('Could not reach enough Bitcoin nodes over Tor to check block filters. It will retry automatically.');
    const checkpoints = await this.agreedCheckpoints(ok, chain.tipHash);

    let retries = 0;
    const retry = (p: BtcPeer): void => {
      this.pool.drop(p);
      if (++retries > 12) throw new Error('The Bitcoin nodes reached keep sending filters that don\'t check out. It will retry with others later.');
    };
    while (s.scanned < tip) {
      const start = s.scanned + 1;
      const end = Math.min(tip, Math.floor(s.scanned / BATCH) * BATCH + BATCH);
      const stop = chain.hashAt(end)!;
      const [a, b] = await this.pool.get(2);
      if (!a || !b) throw new Error('Lost the connection to the Bitcoin nodes. It will retry automatically.');
      // The filter hashes, chained from the last checked filter header, must meet the checkpoint both peers gave.
      const fh = await a.filterHashes(start, stop);
      if (fh.hashes.length !== end - start + 1) { retry(a); continue; }
      const prevKnown = s.filterHeader ? Buffer.from(s.filterHeader, 'hex') : (start - 1) % BATCH === 0 && start - 1 > 0 ? checkpoints[(start - 1) / BATCH - 1] : undefined;
      if (!prevKnown || !fh.prev.equals(prevKnown)) {
        // A peer with a different history: the agreed checkpoint settles it.
        retry(a); continue;
      }
      const headers: Buffer[] = [];
      let h = fh.prev;
      for (const x of fh.hashes) { const both = Buffer.concat([x, h]); h = Buffer.from(dsha(both)); headers.push(h); }
      if (end % BATCH === 0) {
        const want = checkpoints[end / BATCH - 1];
        if (!want || !headers[headers.length - 1].equals(want)) { retry(a); continue; }
      } else {
        // Past the last checkpoint: the second peer must give the same filter headers.
        const other = await b.filterHashes(start, stop).catch(() => null);
        if (!other || !other.prev.equals(fh.prev) || other.hashes.length !== fh.hashes.length || other.hashes.some((x, i) => !x.equals(fh.hashes[i]))) {
          throw new Error('Two Bitcoin nodes disagree about the newest block filters. It will retry with others.');
        }
      }
      const filters = await a.filters(start, stop, end - start + 1);
      for (let i = 0; i < filters.length; i++) {
        const height = start + i;
        const f = filters[i];
        if (!f.block.equals(Buffer.from(chain.hashAt(height)!)) || !Buffer.from(filterHash(f.filter)).equals(fh.hashes[i])) throw new Error('A Bitcoin node sent a filter that does not match.');
        if (filterMatchesAny(f.filter, f.block, this.items)) await this.applyBlock(height, f.block, ok);
      }
      s.scanned = end;
      s.filterHeader = headers[headers.length - 1].toString('hex');
      this.progress = { scanned: end, tip };
      this.opts.onProgress?.(this.progress);
      await this.save();
    }
    this.expirePending();
    await this.save();
  }

  /** Filter headers at each thousandth block, as two peers agree (a third settles a disagreement). */
  private async agreedCheckpoints(peers: BtcPeer[], stop: Uint8Array): Promise<Buffer[]> {
    const pair = peers.slice(0, 2);
    const lists = await Promise.all(pair.map((p) => p.filterCheckpoints(stop).catch(() => null)));
    const same = (x: Buffer[] | null, y: Buffer[] | null) => !!x && !!y && x.length === y.length && x.every((v, i) => v.equals(y[i]));
    if (same(lists[0], lists[1])) return lists[0]!;
    const more = peers.length > 2 ? peers.slice(2) : await this.pool.get(1, pair);
    const third = more.find((p) => !pair.includes(p));
    const c = third ? await third.filterCheckpoints(stop).catch(() => null) : null;
    if (same(c, lists[0])) { this.pool.drop(pair[1]); return lists[0]!; }
    if (same(c, lists[1])) { this.pool.drop(pair[0]); return lists[1]!; }
    throw new Error('Bitcoin nodes disagree about block filters. It will retry with others.');
  }

  private async applyBlock(height: number, hash: Buffer, peers: BtcPeer[]): Promise<void> {
    const recent = this.chain!.tip - height < 280;
    let raw: Buffer | null = null;
    for (const p of [...peers.filter((x) => x.fullHistory || recent), ...this.pool.connected.filter((x) => !peers.includes(x) && (x.fullHistory || recent))]) {
      try { raw = await p.block(hash); break; } catch { /* the next one */ }
    }
    if (!raw) throw new Error('Could not download a Bitcoin block that has this wallet\'s coins. It will retry automatically.');
    const { header, txs } = parseBlock(raw);
    if (!Buffer.from(header.hash).equals(hash)) throw new Error('A Bitcoin node sent the wrong block.');
    const s = this.state!;
    for (const tx of txs) {
      const touched: Record<string, { in: bigint; out: bigint }> = {};
      const mark = (acc: string) => (touched[acc] ??= { in: 0n, out: 0n });
      for (const i of tx.inputs) {
        const c = s.coins[`${i.prevTxid}:${i.prevVout}`];
        if (c && (!c.spentBy || c.spentHeight === 0)) { c.spentBy = tx.txid; c.spentHeight = height; mark(c.account).out += BigInt(c.value); }
      }
      tx.outputs.forEach((o, vout) => {
        const m = this.scripts.get(Buffer.from(o.script).toString('hex'));
        if (!m) return;
        const key = `${tx.txid}:${vout}`;
        const had = s.coins[key];
        s.coins[key] = { txid: tx.txid, vout, value: o.value.toString(), account: m.account, chain: m.chain, index: m.index, height, ...(had?.spentBy ? { spentBy: had.spentBy, spentHeight: had.spentHeight } : {}) };
        mark(m.account).in += o.value;
        const next = (s.next[m.account] ??= [0, 0]);
        if (m.index + 1 > next[m.chain]) { next[m.chain] = m.index + 1; this.rebuildScripts(); }
      });
      if (Object.keys(touched).length) {
        s.txs[tx.txid] = { txid: tx.txid, height, time: header.time, accounts: Object.fromEntries(Object.entries(touched).map(([k, v]) => [k, { in: v.in.toString(), out: v.out.toString() }])) };
        delete s.pending[tx.txid];
      }
    }
  }

  /** A reorganisation: what the replaced blocks did is undone and they are scanned again. */
  private rewind(to: number): void {
    const s = this.state!;
    for (const [k, c] of Object.entries(s.coins)) {
      if (c.height > to) delete s.coins[k];
      else if (c.spentHeight && c.spentHeight > to) { delete c.spentBy; delete c.spentHeight; }
    }
    for (const [k, t] of Object.entries(s.txs)) if (t.height > to) delete s.txs[k];
    const start = Math.max(this.fresh().scanned, Math.floor(to / BATCH) * BATCH);
    s.scanned = start;
    s.filterHeader = '';
  }

  private expirePending(): void {
    const s = this.state!;
    for (const [txid, p] of Object.entries(s.pending)) {
      if (Date.now() - p.at < PENDING_MS) continue;
      for (const k of p.spends) { const c = s.coins[k]; if (c?.spentBy === txid && c.spentHeight === 0) { delete c.spentBy; delete c.spentHeight; } }
      for (const [k, c] of Object.entries(s.coins)) if (c.txid === txid && c.height === 0) delete s.coins[k];
      delete s.pending[txid];
    }
  }

  /** A transaction this wallet just sent: its coins count as spent and its change as waiting, until a block has it. */
  recordSent(raw: Uint8Array): void {
    if (!this.state) return;
    const s = this.state;
    const tx = parseTx(raw);
    const spends: string[] = [];
    for (const i of tx.inputs) { const k = `${i.prevTxid}:${i.prevVout}`; const c = s.coins[k]; if (c && !c.spentBy) { c.spentBy = tx.txid; c.spentHeight = 0; spends.push(k); } }
    tx.outputs.forEach((o, vout) => {
      const m = this.scripts.get(Buffer.from(o.script).toString('hex'));
      if (m) s.coins[`${tx.txid}:${vout}`] = { txid: tx.txid, vout, value: o.value.toString(), account: m.account, chain: m.chain, index: m.index, height: 0 };
    });
    s.pending[tx.txid] = { at: Date.now(), spends };
    void this.save().catch(() => undefined);
  }

  /** A send replaced by another (a fee bump): its coins are free again and its change is gone. */
  dropPending(txid: string): void {
    const s = this.state;
    if (!s?.pending[txid]) return;
    for (const k of s.pending[txid].spends) { const c = s.coins[k]; if (c?.spentBy === txid && c.spentHeight === 0) { delete c.spentBy; delete c.spentHeight; } }
    for (const [k, c] of Object.entries(s.coins)) if (c.txid === txid && c.height === 0) delete s.coins[k];
    delete s.pending[txid];
  }

  /** Hands a transaction to the connected peers. */
  async broadcast(raw: Buffer): Promise<number> {
    const peers = await this.pool.get(2).catch(() => this.pool.connected);
    let sent = 0;
    for (const p of peers) { try { p.sendTx(raw); sent++; } catch { /* closed */ } }
    return sent;
  }

  view(account: string): { coins: FilterCoin[]; next: [number, number]; txs: FilterTx[]; tip: number } | null {
    if (!this.state) return null;
    const s = this.state;
    return {
      coins: Object.values(s.coins).filter((c) => c.account === account && !c.spentBy),
      next: s.next[account] ?? [0, 0],
      txs: [...Object.values(s.txs).filter((t) => t.accounts[account]), ...this.pendingTxs(account)],
      tip: this.chain?.tip ?? 0,
    };
  }

  /** Sends of this wallet still waiting for a block, as history entries (height 0). */
  private pendingTxs(account: string): FilterTx[] {
    const s = this.state!;
    const out: FilterTx[] = [];
    for (const [txid, p] of Object.entries(s.pending)) {
      let spent = 0n; let back = 0n;
      for (const c of Object.values(s.coins)) {
        if (c.account !== account) continue;
        if (c.spentBy === txid && c.spentHeight === 0) spent += BigInt(c.value);
        if (c.txid === txid && c.height === 0) back += BigInt(c.value);
      }
      if (spent || back) out.push({ txid, height: 0, time: Math.floor(p.at / 1000), accounts: { [account]: { in: back.toString(), out: spent.toString() } } });
    }
    return out;
  }

  close(): void { this.pool.closeAll(); }
}
