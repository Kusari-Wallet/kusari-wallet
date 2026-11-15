// "Mix DCR": keeps mixing this wallet's regular DCR into the mixed account, the way dcrwallet's `mixaccount` does.
// Each confirmed coin is mixed on its own into up to four outputs of one of dcrwallet's denominations (powers of two
// below the ticket price), with any change back to the regular account, where it is mixed again later. Every session
// is with whoever else mixes that denomination in the same ten-minute epoch, over Tor.
import { DcrClient, dcrScript, decodeDcrAddress, hash160 } from './dcr';
import type { InsightUtxo } from './insight';
import { CoinJoin, MixClient, MixPool, estimateSize, feeForSize } from './dcr-mix';
import { MixNetwork, MixNetOpts } from './dcr-mixnet';

const { HDKey } = require('@scure/bip32');

/** dcrwallet's split points, 687.19 down to 0.00262144 DCR. */
export const SPLIT_POINTS = [36, 34, 32, 30, 28, 26, 24, 22, 20, 18].map((e) => 1n << BigInt(e));
const SMALLEST = SPLIT_POINTS[SPLIT_POINTS.length - 1];
const smallestMixChange = () => feeForSize(estimateSize(1, 1, false)) + SMALLEST;
export const EPOCH_MS = 10 * 60_000;
const STAGE_TIMEOUT_MS = 30_000;
const PAIRING_VERSION = 3;

/** How a coin of `amount` is split (wallet.MixOutput): the denomination, how many, and the change; null if it can't be. */
export function splitFor(amount: bigint, ticketPrice: bigint): { mixValue: bigint; count: number; change: bigint } | null {
  for (let i = 0; i < SPLIT_POINTS.length; i++) {
    const last = i === SPLIT_POINTS.length - 1;
    const mixValue = SPLIT_POINTS[i];
    if (!last && mixValue >= ticketPrice) continue;
    for (let count = Number(amount / mixValue < 4n ? amount / mixValue : 4n); count > 0; count--) {
      const rem = amount - BigInt(count) * mixValue;
      if (rem < 0n) continue;
      let change = rem - feeForSize(estimateSize(1, count, true));
      if (last) change = 0n;
      if (change <= 0n) {
        if (rem < feeForSize(estimateSize(1, count, false))) continue;
        change = 0n;
      }
      if (change < smallestMixChange()) change = 0n;
      return { mixValue, count, change };
    }
  }
  return null;
}

export interface DcrMixStatus { running: boolean; mixing: number; mixes: number; step: string; error: string | null }

export interface DcrMixerDeps {
  regular: DcrClient; mixed: DcrClient;
  /** Fresh change addresses of the regular account, and mixed-account receive addresses, not handed out before. */
  changeIndex: () => number; mixedIndex: () => number;
  useChange: (i: number) => void; useMixed: (i: number) => void;
  /** Mixed-account indexes handed out for a mix that didn't happen and whose secrets weren't revealed. */
  unuseMixed: (indexes: number[]) => void;
  /** Coins being mixed, held back from sends. */
  hold: (keys: string[]) => void;
  net: Omit<MixNetOpts, 'height'>;
  maxExpiryBlocks: number;
  onMixed: () => void;
  onChange: () => void;
  log?: (s: string) => void;
}

export class DcrMixer {
  status: DcrMixStatus = { running: false, mixing: 0, mixes: 0, step: '', error: null };
  private client: MixClient | null = null;
  private net: MixNetwork | null = null;
  private pool: MixPool | null = null;
  private account: any = null;
  private height = 0;
  private price = 0n;
  private active = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(private readonly d: DcrMixerDeps) {}

  private set(p: Partial<DcrMixStatus>) { Object.assign(this.status, p); this.d.onChange(); }

  /** Starts with the regular account's private key, held in memory only while mixing runs. */
  async start(accountXprv: string): Promise<void> {
    if (this.status.running) return;
    this.stopping = false;
    this.account = HDKey.fromExtendedKey(accountXprv);
    const st = await this.d.regular.stakeState();
    this.height = st.height; this.price = st.price;
    this.pool = new MixPool(EPOCH_MS, () => this.height, this.d.maxExpiryBlocks);
    this.net = new MixNetwork({ ...this.d.net, height: () => this.height });
    this.set({ running: true, error: null, step: 'Connecting to the Decred network…' });
    try { await this.net.start(this.pool); } catch (e) { this.stop(); throw e; }
    if (!this.net.connected) { this.stop(); throw new Error('Could not reach any Decred node. Try again in a moment.'); }
    this.client = new MixClient(this.pool, this.net, { epochMs: EPOCH_MS, stageTimeoutMs: STAGE_TIMEOUT_MS, pairingVersion: PAIRING_VERSION, solveRoots: true, log: this.d.log });
    this.set({ step: 'Listening for other mixers until the next epoch…' });
    this.timer = setInterval(() => void this.tick().catch((e) => this.set({ error: (e as Error).message })), 60_000);
    (this.timer as any).unref?.();
    void this.tick().catch((e) => this.set({ error: (e as Error).message }));
  }

  stop(): void {
    this.stopping = true;
    for (const cancel of this.active.values()) cancel();
    this.active.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.client?.stop(); this.net?.stop();
    this.client = null; this.net = null; this.pool = null; this.account = null;
    this.d.hold([]);
    this.set({ running: false, mixing: 0, step: '' });
  }

  /** Coins that can be mixed now: confirmed twice, not being mixed, splittable. */
  async eligible(): Promise<InsightUtxo[]> {
    const coins = await this.d.regular.confirmedUtxos();
    return coins.filter((u) => !this.active.has(`${u.txid}:${u.vout}`) && splitFor(u.value, this.price || (1n << 62n)) !== null);
  }

  private async tick(): Promise<void> {
    if (!this.client || this.stopping) return;
    const st = await this.d.regular.stakeState();
    this.height = st.height; this.price = st.price;
    this.pool?.expire(this.height);
    await this.d.regular.refresh(true);
    for (const u of await this.eligible()) this.mixCoin(u);
    this.set({ mixing: this.active.size, step: this.active.size ? 'Waiting for a mix with others (every 10 minutes)…' : 'Nothing left to mix.' });
  }

  private mixCoin(u: InsightUtxo): void {
    const split = splitFor(u.value, this.price);
    if (!split || !this.client || !this.account) return;
    const key = `${u.txid}:${u.vout}`;
    const k = this.account.deriveChild(u.chain).deriveChild(u.index);
    const script = u.script ? Uint8Array.from(Buffer.from(u.script, 'hex')) : Uint8Array.from([0x76, 0xa9, 0x14, ...hash160(k.publicKey), 0x88, 0xac]);
    let change = null;
    if (split.change > 0n) {
      const i = this.d.changeIndex(); this.d.useChange(i);
      change = { value: split.change, version: 0, script: Uint8Array.from(dcrScript(this.d.regular.addressAt(1, i))) };
    }
    const issued: number[] = [];
    const gen = (n: number) => Array.from({ length: n }, () => {
      const i = this.d.mixedIndex(); this.d.useMixed(i); issued.push(i);
      return Uint8Array.from(decodeDcrAddress(this.d.mixed.addressAt(0, i))!.hash);
    });
    const cj = new CoinJoin([{ txid: u.txid, vout: u.vout, tree: u.tree ?? 0, value: u.value, script, priv: Uint8Array.from(k.privateKey) }], change, split.mixValue, this.height + this.d.maxExpiryBlocks - 1, split.count, gen);
    let cancelled = false;
    this.active.set(key, () => { cancelled = true; });
    this.d.hold([...this.active.keys()]);
    this.client.dicemix(cj, () => cancelled || this.stopping).then(() => {
      this.status.mixes++;
      this.d.onMixed();
    }, (e) => {
      // Addresses never seen by anyone can be handed out again, so failed tries don't widen the address gap.
      if (!cj.revealed) this.d.unuseMixed(issued);
      if (!this.stopping && !/expired|cancelled/.test((e as Error).message)) this.set({ error: (e as Error).message });
    }).finally(() => {
      this.active.delete(key);
      if (!this.stopping) this.d.hold([...this.active.keys()]);
      this.set({ mixing: this.active.size });
    });
  }
}
