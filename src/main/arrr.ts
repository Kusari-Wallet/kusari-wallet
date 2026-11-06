// Pirate Chain, on Pirate's own wallet core. The library keeps its wallet in an encrypted database under a passphrase
// from the vault, and scans in the background. The seed goes in once, when the wallet is first made.
import path from 'node:path';
import { sha256, toUtf8Bytes } from 'ethers';
import { formatAmount } from './amount';
import type { ArrrEngine } from './arrr-process';

const POLL_MS = 15_000;
const RETRY_MS = 5_000;
const SECONDS_PER_BLOCK = 60;
const SCAN_MARGIN_BLOCKS = 100;

export type ArrrDraft = { to: string; value: bigint; fee: bigint };

export function isArrrAddress(address: string): boolean {
  return /^zs1[02-9ac-hj-np-z]{75}$/.test(address) || /^pirate1[02-9ac-hj-np-z]{40,}$/.test(address);
}

export interface ArrrOptions {
  engine: () => ArrrEngine;
  dir: string;
  secret: string;
  servers: string[];
  /** Tor's port. With it, the library's only way out is through Tor. */
  socks?: number;
  canConnect: () => boolean;
  onChange: () => void;
}

export class ArrrClient {
  private engine: ArrrEngine | null = null;
  private wallet: string | null = null;
  private serverIndex = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private queue: Promise<unknown> = Promise.resolve();
  private view: { total: bigint; spendable: bigint } | null = null;
  private addressText = '';
  private scanning = true;
  percent = 0;
  lastError: string | null = null;
  phase = 'Not started';

  /** The seed is only kept until the wallet exists. */
  constructor(private readonly o: ArrrOptions, private seed: string | null, private readonly restoreDate?: string) {}

  get receive(): string { return this.addressText; }
  get isScanning(): boolean { return this.scanning; }
  private get server(): string { return this.o.servers[this.serverIndex % this.o.servers.length]; }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private call(method: string, params: Record<string, unknown> = {}) {
    if (!this.engine) throw new Error('The Pirate Chain engine has not started.');
    return this.engine.call(method, params);
  }

  async start(): Promise<void> {
    this.engine = this.o.engine();
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.tick(); }, ms);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (!this.o.canConnect()) { this.phase = 'Waiting for Tor'; this.schedule(3000); return; }
    await this.run(() => this.poll());
    this.schedule(this.lastError ? RETRY_MS : POLL_MS);
  }

  private birthdayFrom(tip: number, date?: string): number {
    if (!date) return Math.max(1, tip - SCAN_MARGIN_BLOCKS);
    const seconds = (Date.now() - new Date(date + 'T00:00:00Z').getTime()) / 1000 + 30 * 86_400;
    return Math.max(1, Math.floor(tip - seconds / SECONDS_PER_BLOCK));
  }

  private async openWallet(): Promise<void> {
    const name = sha256(toUtf8Bytes(`kusari/arrr/name/v1\0${this.o.secret}`)).slice(2, 18);
    const pass = sha256(toUtf8Bytes(`kusari/arrr/file/v1\0${this.o.secret}`)).slice(2);
    const dir = path.join(this.engine!.dir(this.o.dir), name);
    this.phase = 'Opening wallet';
    const opened = await this.call('open', { dir, pass, ...(this.o.socks ? { socks: this.o.socks } : {}) });
    this.wallet = opened.wallet;
    if (!this.wallet) {
      this.phase = `Creating wallet (server ${this.serverIndex % this.o.servers.length + 1})`;
      const tip = await this.call('tip', { server: this.server });
      if (!tip.ok || !tip.height) throw new Error(`No answer from the server: ${String(tip.error ?? '').slice(0, 80)}`);
      this.wallet = await this.call('restore', { seed: this.seed, birthday: this.birthdayFrom(tip.height, this.restoreDate) });
      this.seed = null;
    }
    this.seed = null;
    await this.call('use', { wallet: this.wallet, server: this.server });
    this.addressText = (await this.call('address', { wallet: this.wallet })).address;
    this.o.onChange();
  }

  private async poll(): Promise<void> {
    try {
      if (!this.wallet) await this.openWallet();
      const before = await this.call('status', { wallet: this.wallet });
      if (!before.running) await this.call('sync', { wallet: this.wallet });
      const s = await this.call('status', { wallet: this.wallet });
      const total = BigInt(s.total);
      const spendable = BigInt(s.spendable);
      const changed = !this.view || this.view.total !== total || this.view.spendable !== spendable;
      this.view = { total, spendable };
      const behind = Number(s.target) - Number(s.local);
      this.scanning = Number(s.target) === 0 || behind > 5;
      this.percent = Math.floor(Number(s.percent) || 0);
      this.phase = this.scanning ? `Scanning ${this.percent}% (server ${this.serverIndex % this.o.servers.length + 1})` : 'Up to date';
      this.lastError = null;
      if (changed) this.o.onChange();
    } catch (e) {
      const message = (e as Error).message;
      this.lastError = /transport|connect|dns|Unavailable|timed out|No answer from the server/i.test(message) ? 'Could not reach a Pirate Chain server. Trying another one.' : message.slice(0, 160);
      this.phase = 'Error, retrying soon';
      this.serverIndex++;
      if (message.includes('engine stopped') && !this.stopped) {
        this.wallet = null;
        this.engine = this.o.engine();
      } else if (this.wallet && this.engine) {
        await this.call('use', { wallet: this.wallet, server: this.server }).catch(() => undefined);
      }
      this.o.onChange();
    }
  }

  balance(): [bigint, bigint] | null { return this.view ? [this.view.total, this.view.spendable] : null; }

  async draft(to: string, amount: bigint | 'max'): Promise<ArrrDraft> {
    if (!this.wallet) throw new Error('The Pirate Chain wallet is getting ready. Try again shortly.');
    if (this.scanning) throw new Error('Pirate Chain must finish scanning before it can send.');
    return this.run(async () => {
      if (!(await this.call('validate', { address: to }))) throw new Error('Not a Pirate Chain address.');
      try {
        const q = await this.call('quote', { wallet: this.wallet, to, ...(amount === 'max' ? {} : { value: Number(amount) }) });
        return { to, value: BigInt(q.value), fee: BigInt(q.fee) };
      } catch (e) {
        throw new Error(`Not enough spendable balance, or it can't be used yet. (${(e as Error).message.slice(0, 120)})`);
      }
    });
  }

  send(draft: ArrrDraft): Promise<string> {
    return this.run(async () => (await this.call('send', { wallet: this.wallet, to: draft.to, value: Number(draft.value), maxFee: Number(draft.fee) })).txid as string);
  }

  /** Starts over from a date, for a wallet restored from its seed. */
  rescan(date: string): Promise<void> {
    return this.run(async () => {
      if (!this.wallet) throw new Error('The Pirate Chain wallet is getting ready. Try again shortly.');
      const tip = await this.call('tip', { server: this.server });
      if (!tip.ok || !tip.height) throw new Error('Could not reach the server. Try again shortly.');
      await this.call('rescan', { wallet: this.wallet, from: this.birthdayFrom(tip.height, date) });
      this.scanning = true;
    });
  }

  async getHistory() {
    if (!this.wallet) return [];
    const items = await this.run(() => this.call('history', { wallet: this.wallet })) as any[];
    return items.map((t) => {
      const amount = BigInt(t.amount);
      const direction = amount > 0n ? 'in' as const : amount < 0n ? 'out' as const : 'self' as const;
      return {
        asset: 'ARRR' as const, hash: String(t.txid), direction, amount: formatAmount(amount < 0n ? -amount : amount, 8), counterparty: '',
        timestamp: Number(t.time) > 1e12 ? Number(t.time) : Number(t.time) ? Number(t.time) * 1000 : Date.now(),
        status: t.expired ? 'failed' as const : t.confirmed ? 'confirmed' as const : 'pending' as const, dust: false,
      };
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.seed = null;
    this.engine?.close();
    this.engine = null;
  }
}
