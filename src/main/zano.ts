// Zano, and Kusari (KSR): a chain built from Zano's code, run by the same wallet library with its own prefixes. The
// wallet file is the library's own, encrypted with a password from the vault. The key comes from the same BIP39 seed
// as the other coins, so one seed brings this wallet back too. The derivation must never change, and each chain has
// labels of its own: the same key on both would show that a Zano address and a K... address are one person's.
import { bip39Seed } from './seed';
import { computeHmac, toUtf8Bytes, sha256 } from 'ethers';
import { formatAmount } from './amount';
import type { ZanoEngine } from './zano-process';


export const ZANO_DECIMALS = 12;
export const ZANO_FEE = 10_000_000_000n; // 0.01 ZANO, the network's fixed minimum
export const KSR_DECIMALS = 12;
export const KSR_FEE = 10_000_000_000n; // 0.01 KSR, as on Zano
const ZANO_MIXIN = 15;
const ZANO_NATIVE_ASSET = 'd6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a';
// Nothing derived here can hold coins from before this feature existed, so scanning starts there on every restore.
const ZANO_EPOCH_SECONDS = Date.UTC(2026, 10, 1) / 1000;
const POLL_MS = 15_000;
const STORE_EVERY_MS = 120_000;

export type ZanoDraft = { to: string; value: bigint; fee: bigint };

export function isZanoAddress(address: string): boolean {
  return /^(Zx|iZ|aZ|ai)[1-9A-HJ-NP-Za-km-z]{90,120}$/.test(address);
}

/** K... (regular and integrated) and L... (auditable). M... gateway addresses can't receive directly, as on Zano. */
export function isKsrAddress(address: string): boolean {
  return /^[KL][1-9A-HJ-NP-Za-km-z]{90,120}$/.test(address);
}

export interface ZanoChain {
  asset: 'ZANO' | 'KSR';
  name: string;
  /** In the key derivation: never change one that is in use. */
  label: string;
  filePrefix: string;
  fee: bigint;
  isAddress(address: string): boolean;
}
export const ZANO_CHAIN: ZanoChain = { asset: 'ZANO', name: 'Zano', label: 'zano', filePrefix: 'kusari-', fee: ZANO_FEE, isAddress: isZanoAddress };
export const KSR_CHAIN: ZanoChain = { asset: 'KSR', name: 'Kusari', label: 'ksr', filePrefix: 'ksr-', fee: KSR_FEE, isAddress: isKsrAddress };

export function zanoKeys(mnemonic: string, vaultSecret: string, chain: ZanoChain = ZANO_CHAIN) {
  const seed: Uint8Array = bip39Seed(mnemonic);
  return {
    secret: computeHmac('sha512', seed, toUtf8Bytes(`kusari/${chain.label}/v1`)).slice(2, 66),
    pass: sha256(toUtf8Bytes(`kusari/${chain.label}/file/v1\0${vaultSecret}`)).slice(2),
    // Not the key: says which wallet file this is without saying anything about it.
    file: `${chain.filePrefix}${sha256(toUtf8Bytes(`kusari/${chain.label}/name/v1\0${vaultSecret}`)).slice(2, 18)}`,
  };
}

export const ksrKeys = (mnemonic: string, vaultSecret: string) => zanoKeys(mnemonic, vaultSecret, KSR_CHAIN);

/** Amounts can pass 2^53, so they go through as text. */
function parse(text: string): any {
  return JSON.parse(text.replace(/("(?:balance|unlocked_balance|awaiting_in|awaiting_out|total|unlocked|amount|fee)"\s*:\s*)(\d+)/g, '$1"$2"'));
}

function failure(answer: any): string | null {
  const e = answer?.error;
  if (!e) return null;
  return typeof e === 'string' ? e : String(e.message ?? e.code ?? 'unknown');
}

export interface ZanoOptions {
  engine: () => ZanoEngine;
  node: string;
  /** Tor's port. When Tor mode is on, the engine reaches the node through it and no other way. */
  socks?: number;
  canConnect: () => boolean;
  onChange: () => void;
  /** Zano unless given. */
  chain?: ZanoChain;
}

export class ZanoClient {
  private engine: ZanoEngine | null = null;
  private id: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private lastStore = 0;
  private view: { total: bigint; spendable: bigint } | null = null;
  private synced = false;
  private addressText = '';
  private busy: Promise<unknown> = Promise.resolve();
  lastError: string | null = null;
  phase = 'Not started';

  private readonly chain: ZanoChain;

  constructor(private readonly o: ZanoOptions, private readonly keys: ReturnType<typeof zanoKeys>) {
    this.chain = o.chain ?? ZANO_CHAIN;
  }

  get receive(): string { return this.addressText; }
  get isScanning(): boolean { return !this.synced; }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.busy.then(task, task);
    this.busy = next.catch(() => undefined);
    return next;
  }

  private async invoke(method: string, params: unknown = {}, raw?: string): Promise<any> {
    if (this.id === null || !this.engine) throw new Error(`The ${this.chain.name} wallet isn't open yet.`);
    const body = raw ?? JSON.stringify({ jsonrpc: '2.0', id: 0, method, params });
    const answer = parse(await this.engine.call('invoke', this.id, body));
    const problem = failure(answer);
    if (problem) throw new Error(problem);
    return answer.result;
  }

  private async open(): Promise<void> {
    if (!this.engine) return;
    const { pass, file, secret } = this.keys;
    this.phase = 'Opening wallet';
    await this.engine.call('init', 0, `${this.o.node}\x1f${this.o.socks ?? ''}\x1f${this.engine.dir}`);
    let answer = parse(await this.engine.call('open', 0, JSON.stringify({ path: file, pass })));
    if (failure(answer) || !answer.result) {
      answer = parse(await this.engine.call('restore_from_derivations', 0, JSON.stringify({ pass, path: file, secret_derivation: secret, is_auditable: false, creation_timestamp: ZANO_EPOCH_SECONDS })));
    }
    const problem = failure(answer);
    if (problem || !answer.result) throw new Error(problem ?? 'Could not open the wallet.');
    this.id = Number(answer.result.wallet_id);
    this.keys.secret = ''; // The file holds it from here on.
    this.addressText = String(answer.result.wi?.address ?? answer.result.address ?? '');
    if (!this.addressText) this.addressText = String((await this.invoke('getaddress')).address ?? '');
    this.o.onChange();
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
    this.schedule(POLL_MS);
  }

  private async poll(): Promise<void> {
    try {
      if (this.id === null) await this.open();
      const status = parse(await this.engine!.call('get_wallet_status', this.id!, ''));
      const was = this.synced;
      this.synced = status.is_in_long_refresh === false && status.is_daemon_connected === true && Number(status.progress) >= 100;
      this.phase = this.synced ? 'Up to date' : status.is_daemon_connected ? `Scanning ${Number(status.progress) || 0}%` : 'Connecting to the node';
      if (!status.is_in_long_refresh) {
        const b = await this.invoke('getbalance');
        const total = BigInt(b.balance);
        const spendable = BigInt(b.unlocked_balance);
        if (!this.view || this.view.total !== total || this.view.spendable !== spendable || was !== this.synced) this.o.onChange();
        this.view = { total, spendable };
        if (Date.now() - this.lastStore > STORE_EVERY_MS && this.synced) {
          this.lastStore = Date.now();
          await this.invoke('store').catch(() => undefined);
        }
      }
      this.lastError = null;
    } catch (e) {
      const message = (e as Error).message;
      this.lastError = message.slice(0, 160);
      this.phase = 'Error, retrying soon';
      if (message.includes('engine stopped') && !this.stopped) {
        this.id = null;
        this.engine = this.o.engine();
      }
      this.o.onChange();
    }
  }

  balance(): [bigint, bigint] | null { return this.view ? [this.view.total, this.view.spendable] : null; }

  async draft(to: string, amount: bigint | 'max'): Promise<ZanoDraft> {
    if (!this.synced) throw new Error(`${this.chain.name} must finish scanning before it can send.`);
    return this.run(async () => {
      const info = parse(await this.engine!.call('address_info', 0, to));
      if (!info.valid || !this.chain.isAddress(to)) throw new Error(`Not a ${this.chain.name} address.`);
      if (info.wrap) throw new Error(`This address can't receive ${this.chain.asset} directly.`);
      const fee = this.chain.fee;
      const spendable = this.view?.spendable ?? 0n;
      const value = amount === 'max' ? spendable - fee : amount;
      if (value <= 0n) throw new Error('Not enough spendable balance.');
      if (value + fee > spendable) throw new Error(`Not enough spendable balance. ${formatAmount(value + fee, ZANO_DECIMALS)} ${this.chain.asset} is needed including the fee. Received coins can be used after 10 confirmations.`);
      return { to, value, fee };
    });
  }

  send(draft: ZanoDraft): Promise<string> {
    return this.run(async () => {
      // Built by hand so the amounts stay exact.
      const body = `{"jsonrpc":"2.0","id":0,"method":"transfer","params":{"destinations":[{"address":${JSON.stringify(draft.to)},"amount":${draft.value}}],"fee":${draft.fee},"mixin":${ZANO_MIXIN},"payment_id":"","comment":"","service_entries_permanent":true,"service_entries":[]}}`;
      const result = await this.invoke('transfer', undefined, body);
      if (!result?.tx_hash) throw new Error('Could not create the transaction.');
      await this.invoke('store').catch(() => undefined);
      return String(result.tx_hash);
    });
  }

  async getHistory() {
    if (this.id === null) return [];
    const result = await this.run(() => this.invoke('get_recent_txs_and_info2', { offset: 0, count: 100, update_provision_info: false, exclude_mining_txs: false, exclude_unconfirmed: false, order: 'FROM_END_TO_BEGIN' }));
    return ((result?.transfers ?? []) as any[]).map((t) => {
      let income = 0n;
      let outgo = 0n;
      for (const group of t.subtransfers_by_pid ?? t.subtransfers ?? []) {
        for (const s of group.subtransfers ?? [group]) {
          if (s.asset_id && s.asset_id !== ZANO_NATIVE_ASSET) continue;
          if (s.is_income) income += BigInt(s.amount); else outgo += BigInt(s.amount);
        }
      }
      const net = income - outgo;
      const direction = net > 0n ? 'in' as const : outgo > 0n && net < 0n ? 'out' as const : 'self' as const;
      return {
        asset: this.chain.asset, hash: String(t.tx_hash), direction, amount: formatAmount(net < 0n ? -net : net, ZANO_DECIMALS), counterparty: '',
        timestamp: Number(t.timestamp) ? Number(t.timestamp) * 1000 : Date.now(),
        status: Number(t.height) ? 'confirmed' as const : 'pending' as const, dust: false,
      };
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const engine = this.engine;
    const id = this.id;
    this.engine = null;
    this.id = null;
    if (engine && id !== null) await Promise.race([engine.call('close', id, ''), new Promise((r) => setTimeout(r, 3000))]).catch(() => undefined);
    engine?.close();
  }
}
