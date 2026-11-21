import { bip39Seed } from './seed';
import type { Agent } from 'node:http';
import { getJson, requestJson, USER_AGENT } from './request';
import { InsightDraft, InsightWallet } from './insight';

const { HDKey } = require('@scure/bip32');
const btc = require('@scure/btc-signer');

// Coin type 3 and these prefixes are Dogecoin's own.
export const DOGE_PATH = "m/44'/3'/0'";
export const DOGE_NET = { bech32: 'doge', pubKeyHash: 30, scriptHash: 22, wif: 158 };
const FEE_SATS_PER_BYTE = 2_000n; // 0.02 DOGE per kB
const DUST = 1_000_000n; // 0.01 DOGE
const PRIMARY_DOWN_MS = 10 * 60_000;
const SIZE_BASE = 10n;
const SIZE_INPUT = 148n;
const SIZE_OUTPUT = 34n;
// BlockCypher's free tier allows 3 requests a second and 100 an hour, and each address is one.
const GAP_RECEIVE = 5;
const GAP_CHANGE = 2;
const CACHE_MS = 10 * 60_000;
const PACE_MS = 350;
const HISTORY_ROWS = 50;
const UNSPENT_ROWS = 2_000;
const REUSE_AFTER_FAILURE_MS = 2 * 60_000;
const VERIFY_TRIES = 3;
const VERIFY_DELAY_MS = 5_000;

export type DogeDraft = InsightDraft;

export function dogeAccountXpub(mnemonic: string): string {
  return HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(DOGE_PATH).publicExtendedKey;
}

export function isDogeAddress(address: string): boolean {
  if (!/^[DA9][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  try { btc.Address(DOGE_NET).decode(address); return true; } catch { return false; }
}

export const typicalDogeFee = (): bigint => (SIZE_BASE + SIZE_INPUT + SIZE_OUTPUT * 2n) * FEE_SATS_PER_BYTE;

/** backup: dogechain's API base, asked when the main server can't answer. */
export interface DogeOptions {
  pushUrls?: string[]; paceMs?: number; verifyDelayMs?: number; backup?: string;
  /** Blockchair-style raw transaction lookups (the ID is appended), asked when BlockCypher can't give one. */
  rawUrls?: string[];
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UNEXPECTED = 'The DOGE server gave an unexpected answer.';

/**
 * Asks about each address on its own instead of handing over the account's xpub, which would tie all of them
 * together in one request. Answers are shaped like an Insight server's, which the shared wallet logic reads.
 */
export class DogeClient extends InsightWallet<'DOGE'> {
  private readonly account: any;
  private readonly pushUrls: string[];
  private readonly backup?: string;
  private readonly rawUrls: string[];
  private readonly paceMs: number;
  private readonly verifyDelayMs: number;
  private answers = new Map<string, { at: number; info: any; unspent: any }>();
  private scanFinished = true;
  private lastAsked = 0;

  constructor(xpub: string, apis: string[], agent?: Agent, timeoutMs = 30_000, opts: DogeOptions = {}) {
    super({ symbol: 'DOGE', dust: DUST, feePerByte: FEE_SATS_PER_BYTE, base: SIZE_BASE, input: SIZE_INPUT, output: SIZE_OUTPUT, sign: signDogeDraft, script: (a: string) => btc.OutScript.encode(btc.Address(DOGE_NET).decode(a)), gapReceive: GAP_RECEIVE, gapChange: GAP_CHANGE, cacheMs: CACHE_MS }, apis, agent, timeoutMs);
    this.account = HDKey.fromExtendedKey(xpub);
    this.pushUrls = opts.pushUrls ?? apis.map((a) => `${a}/txs/push`);
    this.backup = opts.backup;
    this.rawUrls = opts.rawUrls ?? [];
    this.paceMs = opts.paceMs ?? PACE_MS;
    this.verifyDelayMs = opts.verifyDelayMs ?? VERIFY_DELAY_MS;
  }

  addressAt(chain: number, index: number): string {
    return btc.p2pkh(this.account.deriveChild(chain).deriveChild(index).publicKey, DOGE_NET).address;
  }

  protected async get(path: string): Promise<any> {
    const hold = this.lastAsked + this.paceMs - Date.now();
    if (hold > 0) await wait(hold);
    this.lastAsked = Date.now();
    let last: unknown;
    for (const base of this.apis) {
      try { return await getJson(base + path, { agent: this.agent, timeoutMs: this.timeoutMs, headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }); } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach the DOGE server.');
  }

  /** From any server: the caller checks the hash against the ID, so a wrong answer can't pass. */
  protected async rawTx(txid: string): Promise<string> {
    try {
      const r = await this.get(`/txs/${txid}?includeHex=true&limit=1`);
      if (typeof r?.hex === 'string' && r.hex) return r.hex;
    } catch { /* try the others */ }
    for (const base of this.rawUrls) {
      try {
        const r = await getJson(base + txid, { agent: this.agent, timeoutMs: this.timeoutMs, headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
        const hex = r?.data?.[txid]?.raw_transaction;
        if (typeof hex === 'string' && hex) return hex;
      } catch { /* next */ }
    }
    throw new Error('Could not read the DOGE transaction.');
  }

  /** A full history page answers most addresses; only one with more history needs a second request for its coins. */
  private async ask(address: string): Promise<{ info: any; unspent: any }> {
    const known = this.answers.get(address);
    if (known) return known;
    const info = await this.get(`/addrs/${address}?limit=${HISTORY_ROWS}`);
    if (info?.address !== address) throw new Error(UNEXPECTED);
    const unspent = info.hasMore && Number(info.final_balance ?? 0) > 0 ? await this.get(`/addrs/${address}?unspentOnly=true&limit=${UNSPENT_ROWS}`) : info;
    if (unspent?.address !== address) throw new Error(UNEXPECTED);
    const answer = { at: Date.now(), info, unspent };
    this.answers.set(address, answer);
    return answer;
  }

  /** The server's unspent rows, cross-checked against its balance so a partial list can't pass as the whole. */
  private coinsOf(address: string, source: any): any[] {
    const rows = [...(source.txrefs ?? []), ...(source.unconfirmed_txrefs ?? [])].filter((r: any) => r.tx_output_n >= 0 && !r.spent && !r.double_spend);
    const seen = new Set<string>();
    const coins: any[] = [];
    for (const r of rows) {
      if (!Number.isSafeInteger(r.value)) throw new Error(UNEXPECTED);
      const key = `${r.tx_hash}:${r.tx_output_n}`;
      if (seen.has(key)) continue;
      seen.add(key);
      coins.push({ address, txid: r.tx_hash, vout: r.tx_output_n, satoshis: r.value, confirmations: r.confirmations ?? 0 });
    }
    // While something is unconfirmed the two can differ for a moment. The network still refuses a coin already spent.
    const settled = !source.unconfirmed_n_tx && !source.unconfirmed_txrefs?.length;
    if (settled && coins.reduce((s, c) => s + BigInt(c.satoshis), 0n) !== BigInt(source.final_balance ?? -1)) throw new Error('The DOGE server gave an incomplete list of coins.');
    return coins;
  }

  /**
   * The backup server (dogechain's API) when BlockCypher can't answer: coins per address, and which addresses
   * have history, so the scan still finds them all. It doesn't say which way a transaction went, so history
   * isn't drawn from it.
   */
  private async lookupBackup(addresses: string[]): Promise<{ utxoRows: any[]; txs: any[] }> {
    const base = this.backup!;
    const ask = async (p: string) => {
      const hold = this.lastAsked + this.paceMs - Date.now();
      if (hold > 0) await wait(hold);
      this.lastAsked = Date.now();
      const r = await getJson(base + p, { agent: this.agent, timeoutMs: this.timeoutMs, headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
      if (r?.success !== 1) throw new Error(UNEXPECTED);
      return r;
    };
    const utxoRows: any[] = [];
    const txs: any[] = [];
    for (const a of addresses) {
      const seen = (await ask(`/address/transactions/${a}`)).transactions;
      if (!Array.isArray(seen)) throw new Error(UNEXPECTED);
      if (!seen.length) continue;
      txs.push({ txid: String(seen[0].hash ?? ''), placeholder: true, vin: [], vout: [{ value: 0, scriptPubKey: { addresses: [a] } }] });
      const coins = (await ask(`/address/unspent/${a}`)).unspent_outputs;
      if (!Array.isArray(coins)) throw new Error(UNEXPECTED);
      for (const c of coins) {
        if (c.address !== a || !Number.isSafeInteger(c.value) || !Number.isInteger(c.tx_output_n)) throw new Error(UNEXPECTED);
        utxoRows.push({ address: a, txid: c.tx_hash, vout: c.tx_output_n, satoshis: c.value, confirmations: c.confirmations ?? 0 });
      }
    }
    return { utxoRows, txs };
  }

  /** When BlockCypher failed, the backup is asked first for a while instead of waiting on it again each time. */
  private primaryDownUntil = 0;
  protected async lookup(addresses: string[], round: number): Promise<{ utxoRows: any[]; txs: any[] }> {
    if (this.backup && Date.now() < this.primaryDownUntil) {
      try { return await this.lookupBackup(addresses); } catch { /* the backup failed too: try BlockCypher after all */ }
    }
    try {
      const r = await this.lookupPrimary(addresses, round);
      this.primaryDownUntil = 0;
      return r;
    } catch (e) {
      if (!this.backup) throw e;
      this.primaryDownUntil = Date.now() + PRIMARY_DOWN_MS;
      return this.lookupBackup(addresses);
    }
  }

  private async lookupPrimary(addresses: string[], round: number): Promise<{ utxoRows: any[]; txs: any[] }> {
    // Later rounds only add addresses, and a retry after a failure keeps what it already paid for.
    if (round === 0) {
      if (this.scanFinished) this.answers.clear();
      else for (const [a, known] of this.answers) if (Date.now() - known.at > REUSE_AFTER_FAILURE_MS) this.answers.delete(a);
    }
    this.scanFinished = false;
    const utxoRows: any[] = [];
    const txs = new Map<string, any>();
    for (const a of addresses) {
      const { info, unspent } = await this.ask(a);
      utxoRows.push(...this.coinsOf(a, unspent));
      for (const r of [...(info.txrefs ?? []), ...(info.unconfirmed_txrefs ?? [])]) {
        if (r.double_spend || !Number.isSafeInteger(r.value)) continue;
        const when = Date.parse(r.confirmed ?? r.received ?? '');
        const tx = txs.get(r.tx_hash) ?? { txid: r.tx_hash, confirmations: r.confirmations ?? 0, time: Number.isNaN(when) ? undefined : when / 1000, vin: [], vout: [] };
        if (r.tx_input_n >= 0) tx.vin.push({ addr: a, value: r.value / 1e8 });
        if (r.tx_output_n >= 0) tx.vout.push({ value: r.value / 1e8, scriptPubKey: { addresses: [a] } });
        txs.set(r.tx_hash, tx);
      }
    }
    this.scanFinished = true;
    return { utxoRows, txs: [...txs.values()] };
  }

  private async push(url: string, hex: string, id: string): Promise<void> {
    // Blockchair's documented form is a GET with the transaction in the query.
    const res = url.endsWith('/push/transaction')
      ? await requestJson(`${url}?data=${hex}`, { agent: this.agent, timeoutMs: this.timeoutMs })
      : await requestJson(url, { method: 'POST', body: { tx: hex }, agent: this.agent, timeoutMs: this.timeoutMs });
    const b = res.body;
    const refusal = b?.error?.message ?? b?.error ?? b?.errors?.[0]?.error ?? b?.context?.error;
    if (res.status >= 300 || refusal || b?.success === 0) throw new Error(String(refusal ?? `Server error (${res.status})`).slice(0, 200));
    const hash = b?.tx?.hash ?? b?.tx_hash ?? b?.hash ?? b?.data?.transaction_hash;
    if (hash && hash !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
  }

  private async visible(id: string): Promise<boolean> {
    for (let i = 0; i < VERIFY_TRIES; i++) {
      await wait(this.verifyDelayMs);
      try { if ((await this.get(`/txs/${id}?limit=1`))?.hash === id) return true; } catch { /* not there yet */ }
    }
    return false;
  }

  /** A server's OK isn't enough here: one that took the transaction may never pass it on, so the reading server has to see it. */
  async send(draft: InsightDraft, mnemonic: string): Promise<string> {
    const { hex, id } = signDogeDraft(draft, mnemonic);
    let accepted = false;
    let last: unknown;
    for (const url of this.pushUrls) {
      try { await this.push(url, hex, id); accepted = true; } catch (e) { last = e; continue; }
      if (await this.visible(id)) { this.forget(); return id; }
    }
    this.forget();
    if (accepted) throw new Error(`The transaction was submitted but doesn't show on the network yet. Don't send again until you've checked ${id} on an explorer.`);
    throw new Error(`Send rejected: ${(last as Error)?.message ?? ''}`);
  }
}

/** Plain P2PKH with the legacy signature hash, which is what Dogecoin uses. */
export function signDogeDraft(draft: InsightDraft, mnemonic: string): { hex: string; id: string } {
  if (!isDogeAddress(draft.to)) throw new Error('The receiving address is not a DOGE address.');
  const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0n);
  if (totalIn - draft.amount - draft.change !== draft.fee) throw new Error('The amounts do not add up, so signing was stopped.');
  const account = HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(DOGE_PATH);
  const tx = new btc.Transaction({ allowLegacyWitnessUtxo: true, version: 1 });
  const keys: Uint8Array[] = [];
  for (const u of draft.inputs) {
    const child = account.deriveChild(u.chain).deriveChild(u.index);
    const pay = btc.p2pkh(child.publicKey, DOGE_NET);
    if (pay.address !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: pay.script, amount: u.value } });
    keys.push(child.privateKey);
  }
  tx.addOutputAddress(draft.to, draft.amount, DOGE_NET);
  if (draft.change > 0n) {
    const change = account.deriveChild(1).deriveChild(draft.changeIndex);
    if (btc.p2pkh(change.publicKey, DOGE_NET).address !== draft.changeAddress) throw new Error('The change address does not match this wallet\'s keys, so signing was stopped.');
    tx.addOutputAddress(draft.changeAddress, draft.change, DOGE_NET);
  }
  keys.forEach((k, i) => tx.signIdx(k, i));
  tx.finalize();
  return { hex: tx.hex, id: tx.id };
}
