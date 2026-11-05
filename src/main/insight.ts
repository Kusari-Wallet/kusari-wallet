import type { Agent } from 'node:http';
import { getJson, requestJson } from './request';
import { formatAmount } from './amount';

/** Wallet logic for coins with plain outputs served by an Insight API: one request covers every address. */
const GAP_RECEIVE = 20;
const GAP_CHANGE = 5;
const CACHE_MS = 60_000;

export interface InsightUtxo { txid: string; vout: number; value: bigint; address: string; chain: number; index: number }
export interface InsightDraft { to: string; amount: bigint; fee: bigint; change: bigint; changeAddress: string; changeIndex: number; inputs: InsightUtxo[] }
export interface InsightHistoryItem<S extends string> { asset: S; hash: string; direction: 'in' | 'out' | 'self'; amount: string; counterparty: string; timestamp: number; status: 'confirmed' | 'pending'; dust: boolean }
export interface InsightCoin<S extends string> {
  symbol: S; dust: bigint; feePerByte: bigint; base: bigint; input: bigint; output: bigint;
  sign: (draft: InsightDraft, mnemonic: string) => { hex: string; id: string };
}

export abstract class InsightWallet<S extends string> {
  private state: { at: number; utxos: InsightUtxo[]; total: bigint; spendable: bigint; txs: any[]; nextReceive: number; nextChange: number; mine: Map<string, [number, number]> } | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly cfg: InsightCoin<S>, private readonly apis: string[], private readonly agent?: Agent, private readonly timeoutMs = 30_000) {}

  abstract addressAt(chain: number, index: number): string;
  private size(inputs: number, outputs: number): bigint { return this.cfg.base + this.cfg.input * BigInt(inputs) + this.cfg.output * BigInt(outputs); }
  get receiveAddress(): string { return this.addressAt(0, this.state?.nextReceive ?? 0); }

  private async get(path: string): Promise<any> {
    let last: unknown;
    for (const base of this.apis) {
      try { return await getJson(base + path, { agent: this.agent, timeoutMs: this.timeoutMs }); } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error(`${this.cfg.symbol} 서버에 연결하지 못했어.`);
  }

  /** One request covers every address, so a scan is cheap. */
  private async scan(): Promise<void> {
    const mine = new Map<string, [number, number]>();
    let nextReceive = 0;
    let nextChange = 0;
    let utxoRows: any[] = [];
    let txs: any[] = [];
    for (let round = 0; round < 10; round++) {
      mine.clear();
      for (let i = 0; i < nextReceive + GAP_RECEIVE; i++) mine.set(this.addressAt(0, i), [0, i]);
      for (let i = 0; i < nextChange + GAP_CHANGE; i++) mine.set(this.addressAt(1, i), [1, i]);
      const list = [...mine.keys()].join(',');
      const [u, t] = await Promise.all([this.get(`/addrs/${list}/utxo`), this.get(`/addrs/${list}/txs?from=0&to=50&noAsm=1`)]);
      utxoRows = Array.isArray(u) ? u : [];
      txs = Array.isArray(t?.items) ? t.items : [];
      let r = nextReceive;
      let c = nextChange;
      const seen = (a: unknown) => {
        const p = typeof a === 'string' ? mine.get(a) : undefined;
        if (!p) return;
        if (p[0] === 0) r = Math.max(r, p[1] + 1); else c = Math.max(c, p[1] + 1);
      };
      for (const row of utxoRows) seen(row.address);
      for (const tx of txs) {
        for (const v of tx.vout ?? []) for (const a of v.scriptPubKey?.addresses ?? []) seen(a);
        for (const v of tx.vin ?? []) seen(v.addr);
      }
      const done = r === nextReceive && c === nextChange;
      nextReceive = r;
      nextChange = c;
      if (done) break;
    }
    const utxos: InsightUtxo[] = [];
    let total = 0n;
    let spendable = 0n;
    for (const row of utxoRows) {
      const p = mine.get(row.address);
      if (!p || !/^[0-9a-f]{64}$/.test(row.txid) || !Number.isInteger(row.vout)) throw new Error(`${this.cfg.symbol} 서버 응답이 이상해.`);
      const value = BigInt(row.satoshis ?? row.atoms ?? 0);
      if (value <= 0n) throw new Error(`${this.cfg.symbol} 서버 응답이 이상해.`);
      total += value;
      if ((row.confirmations ?? 0) < 1) continue;
      spendable += value;
      utxos.push({ txid: row.txid, vout: row.vout, value, address: row.address, chain: p[0], index: p[1] });
    }
    this.state = { at: Date.now(), utxos, total, spendable, txs, nextReceive, nextChange, mine };
  }

  refresh(force = false): Promise<void> {
    if (!force && this.state && Date.now() - this.state.at < CACHE_MS) return Promise.resolve();
    if (!this.inFlight) this.inFlight = this.scan().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async getBalance(): Promise<{ total: bigint; spendable: bigint }> {
    await this.refresh();
    return { total: this.state!.total, spendable: this.state!.spendable };
  }

  async draft(to: string, amount: bigint | 'max'): Promise<InsightDraft> {
    await this.refresh(true);
    const state = this.state!;
    const coins = [...state.utxos].sort((a, b) => (b.value > a.value ? 1 : -1));
    if (!coins.length) throw new Error(`보낼 수 있는 ${this.cfg.symbol}가 없어. 입금은 1컨펌 뒤에 쓸 수 있어.`);
    const base = { to, changeAddress: this.addressAt(1, state.nextChange), changeIndex: state.nextChange };
    if (amount === 'max') {
      const sum = coins.reduce((s, u) => s + u.value, 0n);
      const fee = this.size(coins.length, 1) * this.cfg.feePerByte;
      if (sum - fee < this.cfg.dust) throw new Error(`수수료를 빼면 보낼 ${this.cfg.symbol}가 없어.`);
      return { ...base, amount: sum - fee, fee, change: 0n, inputs: coins };
    }
    if (amount < this.cfg.dust) throw new Error(`최소 ${formatAmount(this.cfg.dust, 8)} ${this.cfg.symbol}부터 보낼 수 있어.`);
    const inputs: InsightUtxo[] = [];
    let sum = 0n;
    for (const u of coins) {
      inputs.push(u);
      sum += u.value;
      const withChange = this.size(inputs.length, 2) * this.cfg.feePerByte;
      if (sum >= amount + withChange + this.cfg.dust) return { ...base, amount, fee: withChange, change: sum - amount - withChange, inputs };
      const noChange = this.size(inputs.length, 1) * this.cfg.feePerByte;
      if (sum >= amount + noChange) return { ...base, amount, fee: sum - amount, change: 0n, inputs };
    }
    throw new Error(`수수료까지 합치면 ${this.cfg.symbol} 잔액이 부족해.`);
  }

  async send(draft: InsightDraft, mnemonic: string): Promise<string> {
    const { hex, id } = this.cfg.sign(draft, mnemonic);
    let last: unknown;
    for (const base of this.apis) {
      try {
        const res = await requestJson(`${base}/tx/send`, { method: 'POST', body: { rawtx: hex }, agent: this.agent, timeoutMs: this.timeoutMs });
        if (res.status >= 400) throw new Error(String(res.body?.message ?? res.body?.error ?? res.status).slice(0, 200));
        if (res.body?.txid && res.body.txid !== id) throw new Error(`서버가 다른 거래 ID를 돌려줬어. 탐색기에서 ${id}를 확인해.`);
        this.state = null;
        return id;
      } catch (e) { last = e; }
    }
    throw new Error(`전송 거부됨: ${(last as Error)?.message ?? ''}`);
  }

  async getHistory(): Promise<InsightHistoryItem<S>[]> {
    await this.refresh();
    const { txs, mine } = this.state!;
    const atoms = (v: unknown) => BigInt(Math.round(Number(v ?? 0) * 1e8));
    const items: InsightHistoryItem<S>[] = [];
    for (const tx of txs) {
      if (typeof tx.txid !== 'string' || !/^[0-9a-f]{64}$/.test(tx.txid)) continue;
      const out = (tx.vout ?? []).reduce((s: bigint, v: any) => s + ((v.scriptPubKey?.addresses ?? []).some((a: string) => mine.has(a)) ? atoms(v.value) : 0n), 0n);
      const spent = (tx.vin ?? []).reduce((s: bigint, v: any) => s + (mine.has(v.addr) ? atoms(v.value) : 0n), 0n);
      const net = out - spent;
      const direction = spent === 0n ? 'in' : net < 0n ? 'out' : 'self';
      items.push({
        asset: this.cfg.symbol, hash: tx.txid, direction,
        amount: formatAmount(direction === 'in' ? out : net < 0n ? -net : net, 8),
        counterparty: '', timestamp: (tx.time ?? Date.now() / 1000) * 1000,
        status: (tx.confirmations ?? 0) > 0 ? 'confirmed' : 'pending', dust: direction === 'in' && out < this.cfg.dust,
      });
    }
    return items.sort((a, b) => b.timestamp - a.timestamp);
  }
}

