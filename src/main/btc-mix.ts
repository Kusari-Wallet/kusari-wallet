// Bitcoin CoinJoin for this wallet: runs WabiSabi rounds with a coordinator until the chosen coins are mixed, and
// sends what comes out to the CoinJoin account (see BTC_MIXED_PATH), on fresh addresses each round.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Agent } from 'node:http';
import { requestJson } from './request';
import { CoordinatorError, MixCoin, MixResult, MixStatus, Transport, mixOnce } from './wabisabi/client';

const btc = require('@scure/btc-signer');

/** Coordinators that charge nothing and take taproot coins. The first is the default. */
export const COINJOIN_COORDINATORS = [
  { name: 'Kruw', url: 'https://coinjoin.kruw.io/' },
  { name: 'OpenCoordinator', url: 'https://api.opencoordinator.org/' },
  { name: 'Noderunners', url: 'https://coinjoin.nl/' },
];
/** At most this many coins per round, as Wasabi does, so one wallet doesn't crowd a round. */
export const MAX_COINS_PER_ROUND = 10;
/** Fewer inputs than this and the transaction isn't signed: too few others to hide among. */
export const MIN_INPUTS = 21;
const RETRY_MS = 30_000;

/** Posts to <base>wabisabi/<path>, each identity on a Tor route of its own, with only plain headers. */
export function coordinatorTransport(base: string, agentFor: (identity: string) => Agent | undefined, timeoutMs = 120_000): Transport {
  const root = base.endsWith('/') ? base : `${base}/`;
  return {
    async post(p, body, identity) {
      const res = await requestJson(`${root}wabisabi/${p}`, { method: 'POST', body, agent: agentFor(identity), timeoutMs, plain: true, route: identity });
      if (res.status >= 200 && res.status < 300) return res.body ?? {};
      const e = res.body;
      throw new CoordinatorError(typeof e?.errorCode === 'string' ? e.errorCode : `HTTP${res.status}`, String(e?.description ?? `The coordinator answered ${res.status}.`).slice(0, 200), e?.exceptionData);
    },
  };
}

export interface MixKeys {
  /** Private key of each coin to mix, by "txid:vout". */
  coinKeys: Map<string, Uint8Array>;
  idKey: Uint8Array;
  /** The CoinJoin account's public key, for fresh output addresses. */
  mixedAccount: { deriveChild(i: number): any };
}
export interface MixerStatus { running: boolean; stage: MixStatus['stage'] | 'stopped'; detail?: string; roundId?: string; inputs?: number; coins: number; last?: { at: number; ok: boolean; txid?: string; reason?: string } }

export class BtcMixer {
  private abort: AbortController | null = null;
  private keys: MixKeys | null = null;
  private current: MixerStatus = { running: false, stage: 'stopped', coins: 0 };
  private agents = new Map<string, Agent | undefined>();
  onChange: (() => void) | null = null;

  constructor(private readonly o: {
    dir: string;
    coordinator: () => string;
    newAgent: () => Agent | undefined;
    /** The coins still in the wallet and confirmed, for each new attempt. */
    coins: () => Promise<MixCoin[]>;
    /** Fresh addresses must start past what the CoinJoin account has used. */
    firstUnused: () => number;
    maxFeePerK: () => Promise<bigint>;
    canConnect: () => boolean;
    onMixed?: () => void;
    /** For tests. */
    transport?: Transport;
    mix?: typeof mixOnce;
    extra?: Partial<Parameters<typeof mixOnce>[1]>;
  }) {}

  get status(): MixerStatus { return { ...this.current }; }
  private set(s: Partial<MixerStatus>): void { this.current = { ...this.current, ...s }; this.onChange?.(); }

  private file() { return path.join(this.o.dir, 'btc-coinjoin.json'); }
  private async load(): Promise<{ next: number; last?: MixerStatus['last'] }> {
    try { const j = JSON.parse(await fs.readFile(this.file(), 'utf8')); return { next: Number.isInteger(j.next) && j.next >= 0 ? j.next : 0, last: j.last }; } catch { return { next: 0 }; }
  }
  private async save(v: { next: number; last?: MixerStatus['last'] }): Promise<void> {
    await fs.mkdir(this.o.dir, { recursive: true });
    await fs.writeFile(this.file(), JSON.stringify(v), { mode: 0o600 });
  }
  async lastResult() { return (await this.load()).last; }

  /** Output addresses are never reused, even after a round that failed: the coordinator has seen them. */
  private reserved = 0;
  private lastSaved?: MixerStatus['last'];

  async start(keys: MixKeys): Promise<void> {
    if (this.abort) throw new Error('Mixing is already running.');
    const saved = await this.load();
    this.reserved = Math.max(saved.next, this.o.firstUnused());
    this.lastSaved = saved.last;
    this.keys = keys;
    const abort = new AbortController();
    this.abort = abort;
    this.set({ running: true, stage: 'waiting', detail: undefined, roundId: undefined, coins: keys.coinKeys.size });
    void this.loop(abort).finally(() => {
      if (this.abort === abort) this.abort = null;
      this.wipe();
      this.set({ running: false, stage: this.current.stage === 'done' ? 'done' : 'stopped' });
    });
  }

  stop(): void {
    const was = this.abort;
    this.abort?.abort();
    this.abort = null;
    this.wipe();
    if (was) this.set({ running: false, stage: 'stopped' });
  }

  private wipe(): void {
    for (const k of this.keys?.coinKeys.values() ?? []) k.fill(0);
    this.keys?.idKey.fill(0);
    this.keys = null;
    this.agents.clear();
  }

  private async loop(abort: AbortController): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); abort.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
    while (!abort.signal.aborted) {
      const keys = this.keys;
      if (!keys) return;
      if (!this.o.canConnect()) { this.set({ stage: 'waiting', detail: 'tor' }); await sleep(10_000); continue; }
      let coins: MixCoin[];
      try {
        coins = (await this.o.coins()).filter((c) => keys.coinKeys.has(`${c.txid}:${c.vout}`)).sort((a, b) => (b.value > a.value ? 1 : -1)).slice(0, MAX_COINS_PER_ROUND);
      } catch { await sleep(RETRY_MS); continue; }
      if (!coins.length) { this.set({ stage: 'done', detail: undefined }); return; }
      this.agents.clear();
      const transport = this.o.transport ?? coordinatorTransport(this.o.coordinator(), (id) => {
        if (!this.agents.has(id)) this.agents.set(id, this.o.newAgent());
        return this.agents.get(id);
      });
      let result: MixResult;
      try {
        const maxFeePerK = await this.o.maxFeePerK();
        result = await (this.o.mix ?? mixOnce)(coins, {
          transport,
          keyFor: (c) => { const k = this.keys?.coinKeys.get(`${c.txid}:${c.vout}`); if (!k) throw new Error('Stopped.'); return k; },
          destinations: (n) => {
            // Reserved synchronously from the last known count; saved right after.
            const first = this.reserved;
            this.reserved += n;
            void this.save({ next: this.reserved, last: this.lastSaved }).catch(() => undefined);
            return Array.from({ length: n }, (_, i) => btc.p2tr(keys.mixedAccount.deriveChild(0).deriveChild(first + i).publicKey.slice(1)).script);
          },
          idKey: keys.idKey, maxFeePerK, minInputs: MIN_INPUTS, signal: abort.signal,
          onStatus: (s) => this.set({ stage: s.stage, detail: s.detail, roundId: s.roundId, inputs: s.inputs }),
          ...this.o.extra,
        });
      } catch (e) {
        if (abort.signal.aborted) return;
        result = { ok: false, reason: (e as Error).message, signed: false };
      }
      const last = result.ok ? { at: Date.now(), ok: true, txid: result.txid } : { at: Date.now(), ok: false, reason: result.reason };
      this.lastSaved = last;
      await this.save({ next: this.reserved, last }).catch(() => undefined);
      this.set({ last });
      if (result.ok) {
        for (const c of result.inputs) { const k = keys.coinKeys.get(`${c.txid}:${c.vout}`); k?.fill(0); keys.coinKeys.delete(`${c.txid}:${c.vout}`); }
        this.o.onMixed?.();
        if (!keys.coinKeys.size) { this.set({ stage: 'done', detail: undefined }); return; }
      }
      await sleep(result.ok ? 5_000 : RETRY_MS);
    }
  }

}
