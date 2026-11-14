import { bip39Seed } from './seed';
import type { SparkEngine } from './spark-process';
import type { InsightUtxo } from './insight';
import { FIRO_NET, FIRO_PATH } from './firo';
import { formatAmount } from './amount';

const { HDKey } = require('@scure/bip32');
const btc = require('@scure/btc-signer');
const { sha256 } = require('@noble/hashes/sha2.js');

/**
 * Firo Spark: private FIRO. Amounts, senders and receivers are hidden; a spend proves ownership of one coin among a
 * whole anonymity set. The key is m/44'/136'/0'/6/1 of the seed with spend key index 1, as in Firo's own wallet and
 * Stack Wallet; the default receive address is diversifier 0. Must never change.
 *
 * The engine keeps the anonymity sets on disk and talks to Firo's ElectrumX servers itself, over Tor when it's on.
 */
export const SPARK_PATH = "m/44'/136'/0'/6/1";
export const SPARK_INDEX = 1;
export const SPARK_SERVERS = [
  { host: 'electrumx01.firo.org', port: 50002 },
  { host: 'electrumx02.firo.org', port: 50002 },
  { host: 'electrumx03.firo.org', port: 50002 },
];
/** Chaum V2 spends from this height on (transaction type 11, spend version 2). */
export const SPARK_V2_HEIGHT = 1_371_000;
/** A node refuses a Spark spend that makes more than this public in one transaction. */
export const SPARK_PUBLIC_LIMIT = 10_000n * 100_000_000n;
const MINT_FEE_PER_BYTE = 2n;
const SYNC_MS = 60_000;

export const isSparkAddress = (a: string): boolean => /^sm1[02-9ac-hj-np-z]{100,200}$/.test(a);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const join = (base: string, ...parts: string[]) => [base.replace(/[\\/]+$/, ''), ...parts].join(base.includes('\\') ? '\\' : '/');

export function sparkKey(mnemonic: string): string {
  return hex(HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(SPARK_PATH).privateKey!);
}

export interface SparkCoin { g: number; txid: string; value: number; d: number; type: number; lTagHash: string; memo: string; spent: boolean; spentTx: string }
export interface SparkDraft { to: string; amount: bigint; fee: bigint; hex: string; txid: string; used: string[]; publicOut: boolean }
export interface MintDraft { to: string; amount: bigint; fee: bigint; inputs: InsightUtxo[]; outputs: { script: string; value: bigint }[]; lockTime: number }
export interface SparkHistoryItem { asset: 'FIRO'; hash: string; direction: 'in' | 'out' | 'self'; amount: string; counterparty: string; timestamp: number; status: 'confirmed' | 'pending'; dust: boolean; private: true }

export interface SparkOptions {
  engine: () => SparkEngine;
  dir: string;
  socks?: number;       // Tor's SOCKS port: every connection goes through it
  connect?: string;     // an HTTP CONNECT proxy, for development
  servers?: { host: string; port: number }[];
  /** Server certificates, pinned on first use. */
  pins: () => Record<string, string>;
  savePin: (host: string, fingerprint: string) => void;
  canConnect: () => boolean;
  onChange: () => void;
}

export class SparkClient {
  private engine: SparkEngine | null = null;
  private fvk = '';
  private walletDir = '';
  private setsDir = '';
  private coins: SparkCoin[] = [];
  private pending = new Map<string, { used: string[]; amount: bigint; fee: bigint; at: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;
  private times = new Map<string, number>();
  lastError: string | null = null;
  ready = false;
  height = 0;
  progress: any = null;
  receiveAddress = '';

  /** The spend key stays in memory while the wallet is unlocked, so a spend can be built before it is approved. */
  constructor(private readonly opts: SparkOptions, private key: string) {}

  async start(): Promise<void> {
    const engine = this.opts.engine();
    this.engine = engine;
    this.fvk = await engine.call('fvk', { key: this.key, index: SPARK_INDEX });
    this.receiveAddress = await engine.call('address', { key: this.key, index: SPARK_INDEX, diversifier: 0 });
    const base = engine.dir(this.opts.dir);
    this.setsDir = join(base, 'sets');
    // Coins of each wallet apart; the sets are the chain's and shared.
    this.walletDir = join(base, 'w-' + hex(sha256(Buffer.from(this.fvk, 'hex'))).slice(0, 16));
    this.timer = setInterval(() => void this.sync().catch(() => undefined), SYNC_MS);
    this.timer.unref?.();
    void this.sync().catch(() => undefined);
  }

  private servers() {
    const pins = this.opts.pins();
    return (this.opts.servers ?? SPARK_SERVERS).map((s) => ({ ...s, pin: pins[s.host] ?? '' }));
  }

  private net() {
    return { servers: this.servers(), socks: this.opts.socks ? `127.0.0.1:${this.opts.socks}` : '', connect: this.opts.connect ?? '' };
  }

  sync(): Promise<void> {
    if (!this.engine || !this.opts.canConnect()) return Promise.resolve();
    if (this.syncing) return this.syncing;
    const engine = this.engine;
    const watch = setInterval(() => { void engine.call('status').then((p) => { this.progress = p; }).catch(() => undefined); }, 1500);
    this.syncing = (async () => {
      try {
        const r = await engine.call('sync', { ...this.net(), setsDir: this.setsDir, walletDir: this.walletDir, fvk: this.fvk });
        if (r.host && r.fingerprint && !this.opts.pins()[r.host]) this.opts.savePin(r.host, r.fingerprint);
        const before = JSON.stringify(this.coins);
        this.coins = r.coins;
        this.height = Number(r.height) || this.height;
        for (const [txid, p] of this.pending) {
          // Settled once its coins show as spent, or given up on after a day.
          if (p.used.every((t) => this.coins.find((c) => c.lTagHash === t)?.spent) || Date.now() - p.at > 86_400_000) this.pending.delete(txid);
        }
        const changed = before !== JSON.stringify(this.coins) || !this.ready;
        this.ready = true;
        this.lastError = null;
        await this.fillTimes().catch(() => undefined);
        if (changed) this.opts.onChange();
      } catch (e) {
        this.lastError = (e as Error).message;
      } finally {
        clearInterval(watch);
        this.progress = null;
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  /** Block times for the newest transactions, asked once each. */
  private async fillTimes(): Promise<void> {
    const ids = [...new Set(this.coins.flatMap((c) => [c.txid, c.spentTx]).filter((t) => t && !this.times.has(t)))].slice(-30);
    for (const id of ids) {
      const tx = await this.engine!.call('rpc', { ...this.net(), method: 'blockchain.transaction.get', params: [id, true] }).catch(() => null);
      this.times.set(id, Number(tx?.blocktime ?? tx?.time ?? 0) * 1000 || Date.now());
    }
  }

  private unspent(): SparkCoin[] {
    const busy = new Set([...this.pending.values()].flatMap((p) => p.used));
    return this.coins.filter((c) => !c.spent && !busy.has(c.lTagHash));
  }

  /** Coins appear once mined, so all of the balance is confirmed; coins in a send not yet mined are left out. */
  balance(): { total: bigint; spendable: bigint } | null {
    if (!this.ready) return null;
    const spendable = this.unspent().reduce((s, c) => s + BigInt(c.value), 0n);
    return { total: spendable, spendable };
  }

  info() {
    const p = this.progress;
    const percent = !p ? (this.ready ? 100 : 0)
      : p.stage === 'sets' ? Math.floor(((p.group - 1 + (p.total ? p.done / p.total : 0)) / Math.max(1, p.groups)) * 70)
      : p.stage === 'identify' ? 70 + Math.floor(((p.group - 1 + (p.total ? p.done / p.total : 0)) / Math.max(1, p.groups)) * 25)
      : p.stage === 'tags' ? 96 : p.stage === 'done' ? 99 : 0;
    return { ready: this.ready, receive: this.receiveAddress, error: this.lastError, percent: Math.min(99, percent), syncing: Boolean(this.syncing) };
  }

  /** Private FIRO to `to`: a Spark address stays private; a transparent one makes the amount and that address public. */
  async draft(to: string, amount: bigint | 'max'): Promise<SparkDraft> {
    if (!this.engine || !this.ready) throw new Error('The private (Spark) balance is still syncing. Try again shortly.');
    if (to === this.receiveAddress) throw new Error('You cannot send to your own address.');
    const priv = isSparkAddress(to);
    if (priv && !(await this.engine.call('valid', { address: to }))) throw new Error('Not a valid Spark address.');
    const have = this.unspent().reduce((s, c) => s + BigInt(c.value), 0n);
    if (!have) throw new Error('No confirmed private FIRO to send yet.');
    const value = amount === 'max' ? have : amount;
    if (!priv && value > SPARK_PUBLIC_LIMIT) throw new Error('At most 10,000 FIRO can leave the private balance in one transaction.');
    const out = priv
      ? { private: [{ address: to, value: Number(value), memo: '' }] }
      : { transparent: [{ script: hex(btc.OutScript.encode(btc.Address(FIRO_NET).decode(to))), value: Number(value) }] };
    const lockTime = this.height;
    const r = await this.engine.call('send', {
      key: this.key, index: SPARK_INDEX, setsDir: this.setsDir, walletDir: this.walletDir, ...out,
      subtractFee: amount === 'max', exclude: [...this.pending.values()].flatMap((p) => p.used),
      lockTime, version: lockTime + 1 >= SPARK_V2_HEIGHT ? 2 : 1,
    });
    const sent = BigInt(r.amounts[0]);
    if (amount !== 'max' && sent !== amount) throw new Error('The private transaction came out different from what was asked, so it was stopped.');
    return { to, amount: sent, fee: BigInt(r.fee), hex: r.hex, txid: r.txid, used: r.used, publicOut: !priv };
  }

  async send(d: SparkDraft): Promise<string> {
    if (!this.engine) throw new Error('Spark is not running.');
    const id = await this.engine.call('rpc', { ...this.net(), method: 'blockchain.transaction.broadcast', params: [d.hex] });
    if (typeof id !== 'string' || id !== d.txid) throw new Error(`The server returned a different transaction ID. Check ${d.txid} on an explorer.`);
    this.pending.set(d.txid, { used: d.used, amount: d.amount, fee: d.fee, at: Date.now() });
    this.opts.onChange();
    return d.txid;
  }

  /** Every confirmed public FIRO coin into this wallet's Spark address. Nothing comes back as public change. */
  async mintDraft(inputs: InsightUtxo[]): Promise<MintDraft> {
    if (!this.engine || !this.ready) throw new Error('The private (Spark) balance is still syncing. Try again shortly.');
    if (!inputs.length) throw new Error('No confirmed public FIRO to make private.');
    const total = inputs.reduce((s, u) => s + u.value, 0n);
    const ins = inputs.map((u) => ({ txid: hex(Uint8Array.from(Buffer.from(u.txid, 'hex')).reverse()), vout: u.vout }));
    const make = async (value: bigint) => {
      const r: { script: string; value: number }[] = await this.engine!.call('mint', { inputs: ins, outputs: [{ address: this.receiveAddress, value: Number(value), memo: '' }] });
      return r.map((o) => ({ script: o.script, value: BigInt(o.value) }));
    };
    const probe = await make(total);
    const size = 10n + 148n * BigInt(inputs.length) + probe.reduce((s, o) => s + 8n + BigInt(o.script.length / 2) + (o.script.length / 2 < 0xfd ? 1n : 3n), 0n);
    const fee = size * MINT_FEE_PER_BYTE;
    if (total - fee < 10_000n) throw new Error('Too little public FIRO to make private after the fee.');
    const outputs = await make(total - fee);
    return { to: this.receiveAddress, amount: total - fee, fee, inputs, outputs, lockTime: this.height };
  }

  async mint(d: MintDraft, mnemonic: string, broadcast: (hex: string, id: string) => Promise<void>): Promise<string> {
    const { hex: raw, id } = signFiroMint(d, mnemonic);
    await broadcast(raw, id);
    this.opts.onChange();
    return id;
  }

  history(): SparkHistoryItem[] {
    const items: SparkHistoryItem[] = [];
    const spends = new Set(this.coins.filter((c) => c.spent && c.spentTx).map((c) => c.spentTx));
    const byTx = new Map<string, bigint>();
    for (const c of this.coins) if (!spends.has(c.txid)) byTx.set(c.txid, (byTx.get(c.txid) ?? 0n) + BigInt(c.value));
    for (const [txid, v] of byTx) items.push(this.item(txid, 'in', v, 'confirmed'));
    for (const t of spends) {
      const spent = this.coins.filter((c) => c.spentTx === t).reduce((s, c) => s + BigInt(c.value), 0n);
      const back = this.coins.filter((c) => c.txid === t).reduce((s, c) => s + BigInt(c.value), 0n);
      items.push(this.item(t, 'out', spent - back, 'confirmed'));
    }
    for (const [txid, p] of this.pending) if (!spends.has(txid)) items.push({ ...this.item(txid, 'out', p.amount + p.fee, 'pending'), timestamp: p.at });
    return items.sort((a, b) => b.timestamp - a.timestamp);
  }

  private item(hash: string, direction: 'in' | 'out', v: bigint, status: 'confirmed' | 'pending'): SparkHistoryItem {
    return { asset: 'FIRO', hash, direction, amount: formatAmount(v, 8), counterparty: '', timestamp: this.times.get(hash) ?? 0, status, dust: false, private: true };
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.engine?.close();
    this.engine = null;
    this.key = '';
  }
}

/** Public FIRO into Spark: legacy P2PKH inputs, version 1, sequence max-1 so the lock time holds, as Firo's own wallet. */
export function signFiroMint(d: MintDraft, mnemonic: string): { hex: string; id: string } {
  const totalIn = d.inputs.reduce((s, u) => s + u.value, 0n);
  const totalOut = d.outputs.reduce((s, o) => s + o.value, 0n);
  if (totalIn - totalOut !== d.fee || totalOut !== d.amount) throw new Error('The amounts do not add up, so signing was stopped.');
  if (!d.outputs.every((o) => o.script.startsWith('d1'))) throw new Error('Not a Spark mint, so signing was stopped.');
  const account = HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(FIRO_PATH);
  const inputs = d.inputs.map((u) => {
    const child = account.deriveChild(u.chain).deriveChild(u.index);
    const pay = btc.p2pkh(child.publicKey, FIRO_NET);
    if (pay.address !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    return { txid: u.txid, vout: u.vout, script: Uint8Array.from(pay.script), key: child.privateKey as Uint8Array, pub: child.publicKey as Uint8Array };
  });
  return signLegacy(inputs, d.outputs.map((o) => ({ script: Uint8Array.from(Buffer.from(o.script, 'hex')), value: o.value })), 1, d.lockTime, 0xfffffffe);
}

/**
 * A legacy (pre-SegWit) transaction with P2PKH inputs, SIGHASH_ALL. Written out here because the general signer refuses
 * output scripts it doesn't know, and Spark mint outputs start with Firo's own opcode.
 */
export function signLegacy(
  inputs: { txid: string; vout: number; script: Uint8Array; key: Uint8Array; pub: Uint8Array }[],
  outputs: { script: Uint8Array; value: bigint }[], version: number, lockTime: number, sequence: number,
): { hex: string; id: string } {
  const { secp256k1 } = require('@noble/curves/secp256k1.js');
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const varint = (n: number) => (n < 0xfd ? Buffer.from([n]) : n <= 0xffff ? Buffer.concat([Buffer.from([0xfd]), Buffer.from([n & 0xff, n >> 8])]) : Buffer.concat([Buffer.from([0xfe]), u32(n)]));
  const push = (b: Uint8Array) => { if (b.length > 75) throw new Error('push too long'); return Buffer.concat([Buffer.from([b.length]), b]); };
  const ser = (scripts: Uint8Array[]) => Buffer.concat([
    u32(version), varint(inputs.length),
    ...inputs.flatMap((i, n) => [Buffer.from(i.txid, 'hex').reverse(), u32(i.vout), varint(scripts[n].length), Buffer.from(scripts[n]), u32(sequence)]),
    varint(outputs.length), ...outputs.flatMap((o) => [u64(o.value), varint(o.script.length), Buffer.from(o.script)]),
    u32(lockTime),
  ]);
  const dsha = (b: Uint8Array) => sha256(sha256(b));
  const sigs = inputs.map((inp, n) => {
    const preimage = Buffer.concat([ser(inputs.map((x, k) => (k === n ? x.script : new Uint8Array(0)))), u32(1)]);
    const der = secp256k1.sign(dsha(preimage), inp.key, { prehash: false, lowS: true, format: 'der' });
    return Buffer.concat([push(Buffer.concat([der, Buffer.from([1])])), push(inp.pub)]);
  });
  const raw = ser(sigs);
  return { hex: raw.toString('hex'), id: Buffer.from(dsha(raw)).reverse().toString('hex') };
}
