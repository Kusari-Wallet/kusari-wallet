// Shielded Zcash. The engine holds the wallet in memory and hands its state back as bytes,
// which are kept encrypted on disk under a key from the vault. Scanning runs in the background;
// balances are read from the last finished scan, so a long scan never blocks the screen.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { formatAmount } from './amount';
import type { ZecEngine } from './zec-process';

const ZATS = 8;
export const ZEC_INDEX = 0; // ZIP-32 account, the one Zashi and other wallets use first
export const ZEC_SYNC_MS = 60_000;
export const SHIELD_MIN_ZATS = 100_000n;
const SECONDS_PER_BLOCK = 75;
// NU5 activation, used to turn a date into a height.
const NU5 = { height: 1_687_104, time: Date.UTC(2022, 4, 31) };
const SAPLING_HEIGHT = 419_200;

const ZEC_RETRY_MS = 5_000;
const ACCOUNT_LIMIT_MS = 150_000;
const FRESH_SCAN_LIMIT_MS = 300_000;
const STUCK = new Error('A Zcash server isn\'t answering. Trying another one.');

export type ZecDraft = { to: string; value: bigint; fee: bigint };

export function isZecAddress(address: string): boolean {
  return /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    || /^zs1[02-9ac-hj-np-z]{75}$/.test(address)
    || /^u1[02-9ac-hj-np-z]{100,}$/.test(address)
    || /^tex1[02-9ac-hj-np-z]{30,}$/.test(address);
}

/** With 30 days of margin, because this is only an estimate. */
export function zecHeightForDate(date: Date): number {
  const days = (date.getTime() - NU5.time) / 86_400_000;
  return Math.max(SAPLING_HEIGHT, Math.floor(NU5.height + (days - 30) * 86_400 / SECONDS_PER_BLOCK));
}

const b64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function stateKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`kusari/zec/state/v1\0${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export interface ZecOptions {
  engine: () => ZecEngine;
  dir: string;
  /** From the vault's random secrets, so the state file is unreadable without the password. */
  secret: string;
  servers: string[];
  /** The Tor port. When Tor mode is on this is always set, and the engine then has no direct route. */
  socks?: number;
  /** False while Tor is still connecting: nothing goes out until it's up. */
  canConnect: () => boolean;
  onChange: () => void;
  accountLimitMs?: number;
}

type View = { total: bigint; spendable: bigint; transparent: bigint; tip: number; scanned: number };

export class ZecClient {
  private engine: ZecEngine | null = null;
  private key: Promise<CryptoKey>;
  private serverIndex = 0;
  private account: number | null = null;
  private seed: string | null;
  private birthday: number | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private syncing = false;
  private firstScanDone = false;
  private view: View | null = null;
  private addresses: { unified: string; transparent: string } | null = null;
  lastError: string | null = null;
  /** What it's doing right now, in words, for Settings. */
  phase = 'Not started';

  /** The seed is only kept until the account exists, which takes the network once. */
  constructor(private readonly o: ZecOptions, seed: string, birthday?: number) {
    this.key = stateKey(o.secret);
    this.seed = seed;
    this.birthday = birthday;
  }

  private get file() { return path.join(this.o.dir, 'zec-state.json'); }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private limited<T>(ms: number, work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(STUCK), ms); })]).finally(() => clearTimeout(timer));
  }

  private call(method: string, params: Record<string, unknown> = {}) {
    if (!this.engine) throw new Error('The Zcash engine has not started.');
    return this.engine.call(method, params);
  }

  private async readState(): Promise<{ db: string; account: number } | null> {
    let raw: string;
    try { raw = await fs.readFile(this.file, 'utf8') as unknown as string; } catch { return null; }
    const f = JSON.parse(raw);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv) }, await this.key, unb64(f.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  private async save(): Promise<void> {
    if (this.account === null) return;
    const db: string = await this.call('dump');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key, new TextEncoder().encode(JSON.stringify({ db, account: this.account }))));
    await fs.mkdir(this.o.dir, { recursive: true });
    const temp = `${this.file}.new`;
    await fs.writeFile(temp, JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) }), { mode: 0o600 });
    await fs.rename(temp, this.file);
  }

  private openParams(db?: string) {
    return { server: this.o.servers[this.serverIndex % this.o.servers.length], ...(this.o.socks ? { socks: this.o.socks } : {}), ...(db ? { db } : {}) };
  }

  /** Reads what's saved. A file that can't be decrypted stops here rather than being overwritten. */
  async start(): Promise<void> {
    const saved = await this.readState();
    this.engine = this.o.engine();
    await this.call('open', this.openParams(saved?.db));
    if (saved) {
      this.account = saved.account;
      this.seed = null;
      await this.loadAddresses();
      await this.loadSummary().catch(() => undefined);
    }
    this.schedule(0);
  }

  private async loadAddresses(): Promise<void> {
    const a = await this.call('address', { account: this.account });
    this.addresses = { unified: a.unified, transparent: a.transparent };
  }

  private async loadSummary(): Promise<void> {
    const s = await this.call('summary');
    if (!s) return;
    this.view = { total: BigInt(s.total), spendable: BigInt(s.spendable), transparent: BigInt(s.transparent), tip: s.tip, scanned: s.scanned };
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.tick(); }, delay);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (!this.o.canConnect()) { this.phase = 'Waiting for Tor'; this.schedule(3000); return; }
    await this.syncNow();
    this.schedule(this.lastError ? ZEC_RETRY_MS : ZEC_SYNC_MS);
  }

  /** Scans to the tip, then saves. A failed server gives way to the next one on the following round. */
  syncNow(): Promise<void> {
    return this.run(async () => {
      if (this.stopped) return;
      this.syncing = true;
      this.o.onChange();
      try {
        let fresh = false;
        if (this.account === null) {
          this.phase = `Creating account (server ${this.serverIndex % this.o.servers.length + 1})`;
          this.account = await this.limited(this.o.accountLimitMs ?? ACCOUNT_LIMIT_MS, this.call('account', { seed: this.seed, index: ZEC_INDEX, ...(this.birthday ? { birthday: this.birthday } : {}) }));
          fresh = !this.birthday;
          this.seed = null;
          await this.loadAddresses();
          await this.save();
          this.o.onChange();
        }
        this.phase = `Scanning blocks (server ${this.serverIndex % this.o.servers.length + 1})`;
        // A new account starts near the tip, so a long wait means a stuck connection, not a long scan.
        await (fresh ? this.limited(FRESH_SCAN_LIMIT_MS, this.call('sync')) : this.call('sync'));
        await this.loadSummary();
        await this.save();
        this.firstScanDone = true;
        this.lastError = null;
        this.phase = 'Up to date';
      } catch (e) {
        const message = (e as Error).message;
        this.lastError = /Grpc|transport|dns error|Unavailable/i.test(message) ? 'Could not reach a Zcash server. Trying another one.' : message.slice(0, 160);
        this.serverIndex++;
        this.phase = 'Error, retrying soon';
        if (this.engine && !this.stopped) {
          // If the engine itself died, what's on disk is the last good scan. Nothing is lost but the rescan.
          const stuck = e === STUCK;
          const died = stuck || message.includes('engine stopped');
          if (stuck) this.engine.close();
          if (died) this.engine = this.o.engine();
          const db = died
            ? (await this.readState().catch(() => null))?.db
            : this.account !== null ? await this.call('dump').catch(() => undefined) : undefined;
          await this.call('open', this.openParams(db)).catch(() => undefined);
        }
      } finally {
        this.syncing = false;
        if (!this.stopped) this.o.onChange();
      }
    });
  }

  get receive() { return this.addresses; }
  get transparentAddress() { return this.addresses?.transparent ?? ''; }
  get isScanning() { return this.syncing && !this.firstScanDone; }

  state() {
    return {
      syncing: this.syncing,
      firstScanDone: this.firstScanDone,
      transparent: this.view ? formatAmount(this.view.transparent, ZATS) : '0',
      canShield: Boolean(this.view && this.view.transparent >= SHIELD_MIN_ZATS),
      tip: this.view?.tip ?? 0,
      error: this.lastError,
    };
  }

  /** [total, spendable]; only the shielded part can be spent until the transparent part is shielded. */
  balance(): [bigint, bigint] | null { return this.view ? [this.view.total, this.view.spendable] : null; }

  async draft(to: string, amount: bigint | 'max'): Promise<ZecDraft> {
    if (this.isScanning) throw new Error('Zcash must finish scanning before it can send.');
    if (this.account === null) throw new Error('The Zcash wallet is getting ready. Try again shortly.');
    return this.run(async () => {
      if (!(await this.call('validate', { address: to }))) throw new Error('Not a Zcash mainnet address.');
      try {
        const q = await this.call('quote', { account: this.account, to, ...(amount === 'max' ? {} : { value: Number(amount) }) });
        return { to, value: BigInt(q.value), fee: BigInt(q.fee) };
      } catch (e) {
        const left = this.view?.transparent ?? 0n;
        throw new Error(left > 0n ? 'Not enough shielded balance. Transparent balance must be shielded before it can be sent.' : `Not enough shielded balance, or it can't be used yet. (${(e as Error).message.slice(0, 120)})`);
      }
    });
  }

  send(draft: ZecDraft, seed: string): Promise<string[]> {
    return this.run(async () => {
      try {
        const res = await this.call('send', { seed, index: ZEC_INDEX, account: this.account, to: draft.to, value: Number(draft.value), maxFee: Number(draft.fee) });
        return res.txids as string[];
      } finally {
        await this.save().catch(() => undefined);
        await this.loadSummary().catch(() => undefined);
        this.o.onChange();
      }
    });
  }

  shield(seed: string): Promise<string[]> {
    return this.run(async () => {
      try {
        return (await this.call('shield', { seed, index: ZEC_INDEX, account: this.account })).txids as string[];
      } finally {
        await this.save().catch(() => undefined);
        await this.loadSummary().catch(() => undefined);
        this.o.onChange();
      }
    });
  }

  /** Starts again from a height, for a wallet restored from its seed. */
  async rescan(seed: string, birthday: number): Promise<void> {
    await this.run(async () => {
      await fs.rm(this.file, { force: true });
      this.account = null;
      this.view = null;
      this.addresses = null;
      this.firstScanDone = false;
      this.seed = seed;
      this.birthday = birthday;
      await this.call('open', this.openParams());
    });
    this.schedule(0);
  }

  async getHistory() {
    if (this.account === null) return [];
    const res = await this.run(() => this.call('history', { account: this.account }));
    const now = Date.now();
    return (res.items as any[]).map((t) => {
      const received = BigInt(t.received);
      const sent = BigInt(t.sent);
      const net = received - sent;
      const direction = sent === 0n ? 'in' as const : net < 0n ? 'out' as const : 'self' as const;
      const amount = direction === 'in' ? received : net < 0n ? -net : sent;
      return {
        asset: 'ZEC' as const, hash: String(t.txid), direction, amount: formatAmount(amount, ZATS), counterparty: '',
        // Compact blocks carry no usable clock here, so the time is worked out from the height.
        timestamp: t.height && res.tip ? now - Math.max(0, res.tip - t.height) * SECONDS_PER_BLOCK * 1000 : now,
        status: t.status as 'confirmed' | 'pending' | 'failed', dust: false,
      };
    }).sort((a, b) => b.timestamp - a.timestamp);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.seed = null;
    const engine = this.engine;
    this.engine = null;
    // Waiting would hold the screen for as long as a scan takes, and the last scan is already saved.
    engine?.close();
  }
}
