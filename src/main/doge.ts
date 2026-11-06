import type { Agent } from 'node:http';
import { getJson, requestText } from './request';
import { InsightDraft, InsightWallet } from './insight';

const { HDKey } = require('@scure/bip32');
const { mnemonicToSeedSync } = require('@scure/bip39');
const btc = require('@scure/btc-signer');

// Coin type 3 and these prefixes are Dogecoin's own.
export const DOGE_PATH = "m/44'/3'/0'";
export const DOGE_NET = { bech32: 'doge', pubKeyHash: 30, scriptHash: 22, wif: 158 };
const FEE_SATS_PER_BYTE = 2_000n; // 0.02 DOGE per kB
const DUST = 1_000_000n; // 0.01 DOGE
const SIZE_BASE = 10n;
const SIZE_INPUT = 148n;
const SIZE_OUTPUT = 34n;
const PARALLEL = 5;

export type DogeDraft = InsightDraft;

export function dogeAccountXpub(mnemonic: string): string {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(DOGE_PATH).publicExtendedKey;
}

export function isDogeAddress(address: string): boolean {
  if (!/^[DA9][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  try { btc.Address(DOGE_NET).decode(address); return true; } catch { return false; }
}

export const typicalDogeFee = (): bigint => (SIZE_BASE + SIZE_INPUT + SIZE_OUTPUT * 2n) * FEE_SATS_PER_BYTE;

/**
 * Asks about each address on its own instead of handing over the account's xpub, which would tie all of them
 * together in one request. Answers are shaped like an Insight server's, which the shared wallet logic reads.
 */
export class DogeClient extends InsightWallet<'DOGE'> {
  private readonly account: any;
  constructor(xpub: string, apis: string[], agent?: Agent, timeoutMs = 30_000) {
    super({ symbol: 'DOGE', dust: DUST, feePerByte: FEE_SATS_PER_BYTE, base: SIZE_BASE, input: SIZE_INPUT, output: SIZE_OUTPUT, sign: signDogeDraft }, apis, agent, timeoutMs);
    this.account = HDKey.fromExtendedKey(xpub);
  }

  addressAt(chain: number, index: number): string {
    return btc.p2pkh(this.account.deriveChild(chain).deriveChild(index).publicKey, DOGE_NET).address;
  }

  protected async get(path: string): Promise<any> {
    let last: unknown;
    for (const base of this.apis) {
      try { return await getJson(base + path, { agent: this.agent, timeoutMs: this.timeoutMs, headers: { Accept: 'application/json', 'User-Agent': 'KusariWallet' } }); } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach the DOGE server.');
  }

  protected async lookup(addresses: string[]): Promise<{ utxoRows: any[]; txs: any[] }> {
    const used: string[] = [];
    for (let at = 0; at < addresses.length; at += PARALLEL) {
      const part = addresses.slice(at, at + PARALLEL);
      const infos = await Promise.all(part.map((a) => this.get(`/api/v2/address/${a}?details=basic`)));
      infos.forEach((info, i) => { if (Number(info?.txs ?? 0) > 0 || Number(info?.unconfirmedTxs ?? 0) > 0) used.push(part[i]); });
    }
    const utxoRows: any[] = [];
    const seen = new Map<string, any>();
    for (const a of used) {
      const [rows, details] = await Promise.all([this.get(`/api/v2/utxo/${a}`), this.get(`/api/v2/address/${a}?details=txs&pageSize=50`)]);
      for (const r of Array.isArray(rows) ? rows : []) utxoRows.push({ address: a, txid: r.txid, vout: r.vout, satoshis: r.value, confirmations: r.confirmations });
      for (const t of Array.isArray(details?.transactions) ? details.transactions : []) {
        seen.set(t.txid, {
          txid: t.txid, confirmations: t.confirmations, time: t.blockTime,
          vin: (t.vin ?? []).map((v: any) => ({ addr: v.addresses?.[0], value: Number(v.value ?? 0) / 1e8 })),
          vout: (t.vout ?? []).map((v: any) => ({ value: Number(v.value ?? 0) / 1e8, scriptPubKey: { addresses: v.addresses ?? [] } })),
        });
      }
    }
    return { utxoRows, txs: [...seen.values()] };
  }

  protected async broadcast(base: string, hex: string, id: string): Promise<void> {
    const text = await requestText(`${base}/api/v2/sendtx/`, { method: 'POST', body: hex, agent: this.agent, timeoutMs: this.timeoutMs });
    let answer: any = null;
    try { answer = JSON.parse(text); } catch { /* checked below */ }
    if (answer?.error) throw new Error(String(answer.error?.message ?? answer.error).slice(0, 200));
    if (answer?.result !== id) throw new Error(`The server returned a different transaction ID. Check ${id} on an explorer.`);
  }
}

/** Plain P2PKH with the legacy signature hash, which is what Dogecoin uses. */
export function signDogeDraft(draft: InsightDraft, mnemonic: string): { hex: string; id: string } {
  if (!isDogeAddress(draft.to)) throw new Error('The receiving address is not a DOGE address.');
  const totalIn = draft.inputs.reduce((s, u) => s + u.value, 0n);
  if (totalIn - draft.amount - draft.change !== draft.fee) throw new Error('The amounts do not add up, so signing was stopped.');
  const account = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(DOGE_PATH);
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
