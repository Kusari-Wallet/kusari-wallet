// Kusari (KUS), the Monero fork in native/kusari-coin. Its wallet server is Monero's own, built for Kusari.
// The spend key comes from the same BIP39 seed as the other coins, so one seed brings this wallet back too, and the
// view key from the spend key as in Monero, so the key also restores in kusari-wallet-cli. Never change either.
import { computeHmac, keccak256, sha256, toUtf8Bytes } from 'ethers';
import { formatAmount } from './amount';
import type { KusariEngine } from './kusari-process';

const { mnemonicToSeedSync } = require('@scure/bip39');
const { ed25519 } = require('@noble/curves/ed25519.js');

export const KUS_DECIMALS = 12;
/** From native/kusari-coin/params.json. Consensus: never change. */
export const KUS_PREFIXES = { address: 110, integrated: 111, subaddress: 116 };
const RING_SIZE = 16;
const POLL_MS = 20_000;
const STORE_EVERY_MS = 120_000;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

export type KusariDraft = { to: string; value: bigint; fee: bigint; metadata: string[] };

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const leToBig = (b: Uint8Array) => BigInt('0x' + (hex(Uint8Array.from(b).reverse()) || '0'));
const bigToLe = (n: bigint) => Uint8Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex').reverse());
const reduce = (b: Uint8Array) => bigToLe(leToBig(b) % L);

function base58(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i < buf.length; i += 8) {
    const block = buf.subarray(i, i + 8);
    let v = 0n;
    for (const b of block) v = (v << 8n) | BigInt(b);
    let chunk = '';
    for (let k = 0; k < BLOCK_SIZES[block.length]; k++) { chunk = ALPHABET[Number(v % 58n)] + chunk; v /= 58n; }
    s += chunk;
  }
  return s;
}

function unbase58(str: string): Uint8Array | null {
  const parts: number[] = [];
  for (let i = 0; i < str.length; i += 11) {
    const chunk = str.slice(i, i + 11);
    const size = BLOCK_SIZES.indexOf(chunk.length);
    if (size < 1) return null;
    let v = 0n;
    for (const ch of chunk) {
      const d = ALPHABET.indexOf(ch);
      if (d < 0) return null;
      v = v * 58n + BigInt(d);
    }
    if (v >> BigInt(size * 8)) return null;
    for (let k = size - 1; k >= 0; k--) parts.push(Number((v >> BigInt(k * 8)) & 0xffn));
  }
  return Uint8Array.from(parts);
}

const checksum = (b: Uint8Array) => Buffer.from(keccak256(b).slice(2, 10), 'hex');

/** A Kusari address: the right prefix, length and checksum. Monero's addresses use other prefixes and fail here. */
export function isKusariAddress(address: string): boolean {
  if (!/^[KL][1-9A-HJ-NP-Za-km-z]{94}$|^K[1-9A-HJ-NP-Za-km-z]{105}$/.test(address)) return false;
  const b = unbase58(address);
  if (!b || b[0] & 0x80) return false;
  const kind = b.length === 69 ? (b[0] === KUS_PREFIXES.address || b[0] === KUS_PREFIXES.subaddress) : b.length === 77 && b[0] === KUS_PREFIXES.integrated;
  return kind && checksum(b.subarray(0, b.length - 4)).equals(Buffer.from(b.subarray(b.length - 4)));
}

export function kusariAddress(spendPub: Uint8Array, viewPub: Uint8Array): string {
  const body = Uint8Array.from([KUS_PREFIXES.address, ...spendPub, ...viewPub]);
  return base58(Uint8Array.from([...body, ...checksum(body)]));
}

export function kusariKeys(mnemonic: string, vaultSecret: string) {
  const seed: Uint8Array = mnemonicToSeedSync(mnemonic);
  const spend = reduce(Buffer.from(computeHmac('sha512', seed, toUtf8Bytes('kusari/kus/v1')).slice(2, 66), 'hex'));
  const view = reduce(Buffer.from(keccak256(spend).slice(2), 'hex'));
  const pub = (k: Uint8Array) => ed25519.Point.BASE.multiply(leToBig(k)).toBytes() as Uint8Array;
  return {
    spend: hex(spend),
    view: hex(view),
    address: kusariAddress(pub(spend), pub(view)),
    pass: sha256(toUtf8Bytes(`kusari/kus/file/v1\0${vaultSecret}`)).slice(2),
    // Not the key: says which wallet file this is without saying anything about it.
    file: `kusari-${sha256(toUtf8Bytes(`kusari/kus/name/v1\0${vaultSecret}`)).slice(2, 18)}`,
  };
}

/** Amounts can pass 2^53, so they go through as text. */
export function parseRpc(text: string): any {
  return JSON.parse(text.replace(/("(?:balance|unlocked_balance|amount|fee|amount_list|fee_list|amounts)"\s*:\s*)(\[[\d\s,]*\]|\d+)/g,
    (_, key, v) => key + (v.startsWith('[') ? `[${v.slice(1, -1).split(',').filter((x: string) => x.trim()).map((x: string) => `"${x.trim()}"`).join(',')}]` : `"${v}"`)));
}

function unwrap(text: string): any {
  const answer = parseRpc(text);
  if (answer.error) throw new Error(String(answer.error.message ?? answer.error.code ?? 'Kusari wallet error'));
  return answer.result;
}

export interface KusariOptions {
  engine: () => Promise<KusariEngine>;
  canConnect: () => boolean;
  onChange: () => void;
}

export class KusariClient {
  private engine: KusariEngine | null = null;
  private opened = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private lastStore = 0;
  private view: { total: bigint; spendable: bigint } | null = null;
  private synced = false;
  private addressText = '';
  private busy: Promise<unknown> = Promise.resolve();
  lastError: string | null = null;
  phase = 'Not started';

  constructor(private readonly o: KusariOptions, private readonly keys: ReturnType<typeof kusariKeys>) {
    this.addressText = keys.address;
  }

  get receive(): string { return this.addressText; }
  get isScanning(): boolean { return !this.synced; }

  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.busy.then(task, task);
    this.busy = next.catch(() => undefined);
    return next;
  }

  private async invoke(method: string, params: unknown = {}, raw?: string, timeoutMs?: number): Promise<any> {
    if (!this.engine) throw new Error('The Kusari wallet isn\'t open yet.');
    return unwrap(await this.engine.call(method, params, raw, timeoutMs));
  }

  private async open(): Promise<void> {
    if (!this.engine) this.engine = await this.o.engine();
    const { pass, file } = this.keys;
    this.phase = 'Opening wallet';
    try {
      await this.invoke('open_wallet', { filename: file, password: pass });
    } catch {
      // A new chain, so scanning from its first block costs little and finds everything.
      await this.invoke('generate_from_keys', { filename: file, password: pass, address: this.keys.address, spendkey: this.keys.spend, viewkey: this.keys.view, restore_height: 0, autosave_current: true });
    }
    this.keys.spend = ''; // The file holds it from here on.
    const address = String((await this.invoke('get_address', { account_index: 0 })).address ?? '');
    if (address !== this.keys.address) throw new Error('The Kusari wallet file is for another key.');
    // This client decides when to sync, so a send never waits behind a background refresh.
    await this.invoke('auto_refresh', { enable: false }).catch(() => undefined);
    this.opened = true;
    this.o.onChange();
  }

  async start(): Promise<void> { this.schedule(0); }

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
      if (!this.opened) await this.open();
      this.phase = this.synced ? 'Up to date' : 'Scanning';
      const was = this.synced;
      await this.invoke('refresh', {}, undefined, 30 * 60_000);
      this.synced = true;
      this.phase = 'Up to date';
      const b = await this.invoke('get_balance', { account_index: 0 });
      const total = BigInt(b.balance);
      const spendable = BigInt(b.unlocked_balance);
      if (!this.view || this.view.total !== total || this.view.spendable !== spendable || was !== this.synced) this.o.onChange();
      this.view = { total, spendable };
      if (Date.now() - this.lastStore > STORE_EVERY_MS) {
        this.lastStore = Date.now();
        await this.invoke('store').catch(() => undefined);
      }
      this.lastError = null;
    } catch (e) {
      const message = (e as Error).message;
      this.lastError = message.slice(0, 160);
      this.phase = 'Error, retrying soon';
      if (/engine stopped|ECONNREFUSED|did not start/.test(message) && !this.stopped) {
        const old = this.engine;
        this.engine = null;
        this.opened = false;
        void old?.close();
      }
      this.o.onChange();
    }
  }

  balance(): [bigint, bigint] | null { return this.view ? [this.view.total, this.view.spendable] : null; }

  /** Builds and signs the transaction without sending it, so the review screen shows the real fee. */
  async draft(to: string, amount: bigint | 'max'): Promise<KusariDraft> {
    if (!this.synced) throw new Error('Kusari must finish scanning before it can send.');
    if (!isKusariAddress(to)) throw new Error('Not a Kusari address.');
    return this.run(async () => {
      const short = (e: unknown): never => {
        const m = (e as Error).message;
        if (/not enough|unlocked/i.test(m)) throw new Error('Not enough spendable balance. Received coins can be used after 10 confirmations, and mined coins after 60.');
        throw e;
      };
      if (amount === 'max') {
        const r = await this.invoke('sweep_all', { address: to, account_index: 0, ring_size: RING_SIZE, priority: 0, do_not_relay: true, get_tx_metadata: true }).catch(short);
        const metadata = (r.tx_metadata_list ?? []).map(String);
        if (!metadata.length) throw new Error('Not enough spendable balance.');
        return { to, value: (r.amount_list ?? []).reduce((a: bigint, x: string) => a + BigInt(x), 0n), fee: (r.fee_list ?? []).reduce((a: bigint, x: string) => a + BigInt(x), 0n), metadata };
      }
      if (amount <= 0n) throw new Error('Enter an amount.');
      // Built by hand so the amount stays exact.
      const body = `{"jsonrpc":"2.0","id":"0","method":"transfer","params":{"destinations":[{"address":${JSON.stringify(to)},"amount":${amount}}],"account_index":0,"ring_size":${RING_SIZE},"priority":0,"do_not_relay":true,"get_tx_metadata":true}}`;
      const r = await this.invoke('transfer', undefined, body).catch(short);
      if (!r?.tx_metadata) throw new Error('Could not create the transaction.');
      return { to, value: BigInt(r.amount), fee: BigInt(r.fee), metadata: [String(r.tx_metadata)] };
    });
  }

  send(draft: KusariDraft): Promise<string[]> {
    return this.run(async () => {
      const hashes: string[] = [];
      for (const hexTx of draft.metadata) {
        const r = await this.invoke('relay_tx', { hex: hexTx });
        if (!r?.tx_hash) throw new Error('Could not send the transaction.');
        hashes.push(String(r.tx_hash));
      }
      await this.invoke('store').catch(() => undefined);
      return hashes;
    });
  }

  async getHistory() {
    if (!this.opened) return [];
    const r = await this.run(() => this.invoke('get_transfers', { in: true, out: true, pending: true, pool: true, failed: false, account_index: 0 }));
    const rows = [...(r?.in ?? []), ...(r?.out ?? []), ...(r?.pending ?? []), ...(r?.pool ?? [])] as any[];
    return rows.map((t) => {
      const out = t.type === 'out' || t.type === 'pending';
      const selfSend = out && Array.isArray(t.destinations) && t.destinations.every((d: any) => d.address === this.addressText);
      return {
        asset: 'KUS' as const,
        hash: String(t.txid),
        direction: selfSend ? 'self' as const : out ? 'out' as const : 'in' as const,
        amount: formatAmount(BigInt(t.amount), KUS_DECIMALS),
        counterparty: out && t.destinations?.[0]?.address ? String(t.destinations[0].address) : '',
        timestamp: Number(t.timestamp) ? Number(t.timestamp) * 1000 : Date.now(),
        status: Number(t.height) > 0 ? 'confirmed' as const : 'pending' as const,
        dust: false,
      };
    }).sort((a, b) => b.timestamp - a.timestamp);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const engine = this.engine;
    this.engine = null;
    this.opened = false;
    // Not waiting for a scan in progress: stop_wallet saves the file and ends it.
    await engine?.close();
  }
}
