import { bip39Seed } from './seed';
import type { MwebEngine } from './mweb-process';
import { LTC_PATH } from './btc';
import type { BtcUtxo } from './btc';

// These packages are ESM only, which require() handles in this Node version.
const { HDKey } = require('@scure/bip32');
const { p2wpkh } = require('@scure/btc-signer');

/**
 * Litecoin MWEB (Mimblewimble extension blocks): amounts and addresses are hidden. The account is a scan key and a
 * spend key at m/1000'/2'/0'/0' and m/1000'/2'/0'/1' of the BIP39 seed, the layout mwebd documents. Must never change.
 * Address 0 takes change; the others receive.
 */
export const MWEB_SCAN_PATH = "m/1000'/2'/0'/0'";
export const MWEB_SPEND_PATH = "m/1000'/2'/0'/1'";
const POOL = 50; // addresses the wallet recognises coins on

export const isMwebAddress = (a: string): boolean => /^ltcmweb1[02-9ac-hj-np-z]{100,140}$/.test(a);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export function mwebKeys(mnemonic: string): { scan: string; spendPub: string; spend: string } {
  const root = HDKey.fromMasterSeed(bip39Seed(mnemonic));
  const scan = root.derive(MWEB_SCAN_PATH);
  const spend = root.derive(MWEB_SPEND_PATH);
  return { scan: hex(scan.privateKey!), spendPub: hex(spend.publicKey!), spend: hex(spend.privateKey!) };
}

export interface MwebCoin { outputId: string; value: number; address: string; height: number }
export interface MwebDraft { to: string; amount: bigint; fee: bigint; pegout: boolean; coins: { outputId: string; addrIndex: number }[]; max: boolean; feePerKb: number }
export interface PeginDraft { to: string; amount: bigint; fee: bigint; inputs: BtcUtxo[]; feePerKb: number }

export interface MwebOptions {
  engine: () => MwebEngine;
  dir: string;
  socks?: number;      // Tor's SOCKS port: peers and name lookups go through it only
  connect?: string;    // an HTTP CONNECT proxy, for development
  canConnect: () => boolean;
  onChange: () => void;
}

export class MwebClient {
  private engine: MwebEngine | null = null;
  private keys: { scan: string; spendPub: string };
  private pool = new Map<string, number>();
  private coins: MwebCoin[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  lastError: string | null = null;
  status: { headers: number; mwebUtxos: number; peers: number; scanReady: boolean; scanDone: number; scanSize: number } | null = null;
  ready = false;
  changeAddress = '';
  receiveAddress = '';

  constructor(private readonly opts: MwebOptions, mnemonic: string) {
    const k = mwebKeys(mnemonic);
    this.keys = { scan: k.scan, spendPub: k.spendPub };
  }

  async start(): Promise<void> {
    const engine = this.opts.engine();
    this.engine = engine;
    await engine.call('start', { dataDir: engine.dir(this.opts.dir), socks: this.opts.socks ? `127.0.0.1:${this.opts.socks}` : '', connect: this.opts.connect ?? '' });
    const list: string[] = await engine.call('addresses', { Scan: this.keys.scan, SpendPub: this.keys.spendPub, From: 0, To: POOL });
    list.forEach((a, i) => this.pool.set(a, i));
    this.changeAddress = list[0];
    this.receiveAddress = list[1];
    await engine.call('watch', { Scan: this.keys.scan });
    this.timer = setInterval(() => void this.poll(), 10_000);
    this.timer.unref?.();
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (!this.engine || !this.opts.canConnect()) return;
    try {
      const [st, c] = await Promise.all([this.engine.call('status'), this.engine.call('coins')]);
      this.status = { headers: st.headers, mwebUtxos: st.mwebUtxos, peers: st.peers, scanReady: Boolean(st.scanReady), scanDone: Number(st.scanDone ?? 0), scanSize: Number(st.scanSize ?? 0) };
      // Coins on addresses outside this account's pool are never counted: they can't be spent from here.
      const coins: MwebCoin[] = (c.coins ?? []).filter((x: MwebCoin) => this.pool.has(x.address));
      const before = JSON.stringify(this.coins);
      this.coins = coins;
      // Synced: the UTXO set is at the chain tip and one whole pass over it is done.
      const ready = Boolean(c.ready) && st.headers > 0 && st.mwebUtxos >= st.headers - 1;
      const changed = before !== JSON.stringify(coins) || ready !== this.ready;
      this.ready = ready;
      this.lastError = null;
      if (changed) this.opts.onChange();
    } catch (e) {
      this.lastError = (e as Error).message;
    }
  }

  /** total includes coins still unconfirmed; spendable is confirmed only. */
  balance(): { total: bigint; spendable: bigint } | null {
    if (!this.ready) return null;
    const total = this.coins.reduce((s, c) => s + BigInt(c.value), 0n);
    const spendable = this.coins.filter((c) => c.height > 0).reduce((s, c) => s + BigInt(c.value), 0n);
    return { total, spendable };
  }

  info() {
    const s = this.status;
    return {
      ready: this.ready, receive: this.receiveAddress, error: this.lastError,
      percent: !s ? 0 : !s.headers ? 0 : s.mwebUtxos < s.headers - 1 ? Math.floor((Math.max(0, s.mwebUtxos) / s.headers) * 90) : s.scanSize ? 90 + Math.floor((s.scanDone / s.scanSize) * 10) : 95,
      peers: s?.peers ?? 0,
    };
  }

  /** Private coins to `to`: an MWEB address stays private; an ordinary address is a peg-out, public on arrival. */
  async draft(to: string, amount: bigint | 'max', feePerKb: number): Promise<MwebDraft> {
    if (!this.engine || !this.ready) throw new Error('The private (MWEB) balance is still syncing. Try again shortly.');
    if (to === this.receiveAddress || to === this.changeAddress) throw new Error('You cannot send to your own address.');
    const confirmed = this.coins.filter((c) => c.height > 0).sort((a, b) => b.value - a.value);
    if (!confirmed.length) throw new Error('No confirmed private LTC to send yet.');
    // The fee depends on the outputs, not the inputs, so the largest coins are taken until the amount is covered.
    const all = confirmed.map((c) => ({ outputId: c.outputId, addrIndex: this.pool.get(c.address)! }));
    const probe = await this.engine.call('send', { Scan: this.keys.scan, coins: all, to: { address: to, value: amount === 'max' ? 0 : Number(amount) }, max: amount === 'max', change: this.changeAddress, feePerKb, dryRun: true });
    let coins = all;
    if (amount !== 'max') {
      const need = amount + BigInt(probe.fee);
      let sum = 0n;
      coins = [];
      for (const c of confirmed) {
        if (sum >= need) break;
        coins.push({ outputId: c.outputId, addrIndex: this.pool.get(c.address)! });
        sum += BigInt(c.value);
      }
    }
    const r = await this.engine.call('send', { Scan: this.keys.scan, coins, to: { address: to, value: amount === 'max' ? 0 : Number(amount) }, max: amount === 'max', change: this.changeAddress, feePerKb, dryRun: true });
    return { to, amount: BigInt(r.amount), fee: BigInt(r.fee), pegout: Boolean(r.pegout), coins, max: amount === 'max', feePerKb };
  }

  async send(d: MwebDraft, mnemonic: string): Promise<string> {
    if (!this.engine) throw new Error('MWEB is not running.');
    const k = mwebKeys(mnemonic);
    if (k.scan !== this.keys.scan) throw new Error('This wallet\'s seed does not match the MWEB account.');
    const r = await this.engine.call('send', { Scan: k.scan, Spend: k.spend, coins: d.coins, to: { address: d.to, value: Number(d.amount) }, max: d.max, change: this.changeAddress, feePerKb: d.feePerKb, dryRun: false });
    if (BigInt(r.amount) !== d.amount || BigInt(r.fee) !== d.fee) throw new Error('The private transaction came out different from what was approved, so it was not sent.');
    void this.poll();
    return String(r.txid);
  }

  /** Every confirmed public LTC coin into this account's MWEB address. Nothing comes back as public change. */
  async peginDraft(inputs: BtcUtxo[], feePerKb: number): Promise<PeginDraft> {
    if (!this.engine || !this.ready) throw new Error('The private (MWEB) balance is still syncing. Try again shortly.');
    if (!inputs.length) throw new Error('No confirmed public LTC to make private.');
    const r = await this.engine.call('pegin', { to: this.receiveAddress, inputs: inputs.map((u) => ({ txid: u.txid, vout: u.vout, value: Number(u.value), script: scriptOf(u) })), feePerKb, dryRun: true });
    return { to: this.receiveAddress, amount: BigInt(r.amount), fee: BigInt(r.fee), inputs, feePerKb };
  }

  async pegin(d: PeginDraft, mnemonic: string): Promise<string> {
    if (!this.engine) throw new Error('MWEB is not running.');
    const account = HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(LTC_PATH);
    const inputs = d.inputs.map((u) => {
      const child = account.deriveChild(u.chain).deriveChild(u.index);
      return { txid: u.txid, vout: u.vout, value: Number(u.value), script: scriptOf(u, child.publicKey!), key: hex(child.privateKey!) };
    });
    const r = await this.engine.call('pegin', { to: d.to, inputs, feePerKb: d.feePerKb, dryRun: false });
    if (BigInt(r.amount) !== d.amount || BigInt(r.fee) !== d.fee) throw new Error('The private transaction came out different from what was approved, so it was not sent.');
    void this.poll();
    return String(r.txid);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.engine?.close();
    this.engine = null;
  }
}

/** The P2WPKH script a coin pays to: read from the address, or from the key when it's at hand (and checked). */
function scriptOf(u: BtcUtxo, pub?: Uint8Array): string {
  const LTC = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };
  if (pub) {
    const pay = p2wpkh(pub, LTC);
    if (pay.address !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    return hex(pay.script);
  }
  const m = /^ltc1q([02-9ac-hj-np-z]+)$/.exec(u.address);
  if (!m) throw new Error('Only ltc1q coins can be made private.');
  const { bech32 } = require('@scure/base');
  const { words } = bech32.decode(u.address);
  return '0014' + hex(Uint8Array.from(bech32.fromWords(words.slice(1))));
}
