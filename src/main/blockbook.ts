// Answers in the shape of an Esplora server (what the BTC and LTC wallets read), from a Blockbook server, so a
// Blockbook can stand in when the Esplora one is down. Only the few calls those wallets make are covered.
import type { Agent } from 'node:http';
import { getJson } from './request';

export const BLOCKBOOK = 'blockbook+';
export const isBlockbook = (base: string): boolean => base.startsWith(BLOCKBOOK);

const UNEXPECTED = 'The backup server gave an unexpected answer.';
const int = (v: unknown): bigint => {
  if (typeof v !== 'string' && typeof v !== 'number') throw new Error(UNEXPECTED);
  const s = String(v);
  if (!/^-?\d+$/.test(s)) throw new Error(UNEXPECTED);
  return BigInt(s);
};
const txid = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw new Error(UNEXPECTED);
  return v;
};

interface Opts { agent?: Agent; timeoutMs?: number }

export async function blockbookGet(base: string, path: string, opts: Opts): Promise<any> {
  const root = base.slice(BLOCKBOOK.length);
  const get = (p: string) => getJson(root + p, { agent: opts.agent, timeoutMs: opts.timeoutMs, headers: { Accept: 'application/json' } });
  let m = /^\/address\/([A-Za-z0-9]+)$/.exec(path);
  if (m) {
    const a = await get(`/api/v2/address/${m[1]}?details=basic`);
    if (a?.address !== m[1]) throw new Error(UNEXPECTED);
    const unconfirmed = int(a.unconfirmedBalance ?? 0);
    const txs = Number(a.txs ?? 0);
    const pending = Number(a.unconfirmedTxs ?? 0);
    if (!Number.isSafeInteger(txs) || !Number.isSafeInteger(pending)) throw new Error(UNEXPECTED);
    // Received and sent so far, confirmed; what's waiting shows as the mempool's share.
    return {
      chain_stats: { tx_count: txs - pending, funded_txo_sum: String(int(a.totalReceived)), spent_txo_sum: String(int(a.totalSent)) },
      mempool_stats: { tx_count: pending, funded_txo_sum: String(unconfirmed > 0n ? unconfirmed : 0n), spent_txo_sum: String(unconfirmed < 0n ? -unconfirmed : 0n) },
    };
  }
  m = /^\/address\/([A-Za-z0-9]+)\/utxo$/.exec(path);
  if (m) {
    const list = await get(`/api/v2/utxo/${m[1]}`);
    if (!Array.isArray(list)) throw new Error(UNEXPECTED);
    return list.map((u: any) => {
      if (!Number.isInteger(u.vout)) throw new Error(UNEXPECTED);
      return { txid: txid(u.txid), vout: u.vout, value: String(int(u.value)), status: { confirmed: Number(u.confirmations ?? 0) > 0 } };
    });
  }
  m = /^\/address\/([A-Za-z0-9]+)\/txs$/.exec(path);
  if (m) {
    const a = await get(`/api/v2/address/${m[1]}?details=txs&pageSize=50`);
    return (Array.isArray(a?.transactions) ? a.transactions : []).map((t: any) => ({
      txid: txid(t.txid),
      vin: (t.vin ?? []).map((i: any) => ({ prevout: { scriptpubkey_address: i.addresses?.[0], value: String(int(i.value ?? 0)) } })),
      vout: (t.vout ?? []).map((o: any) => ({ scriptpubkey_address: o.addresses?.[0], value: String(int(o.value ?? 0)) })),
      status: { confirmed: Number(t.confirmations ?? 0) > 0, block_time: t.blockTime },
    }));
  }
  if (path === '/blocks/tip/height') {
    const r = await get('/api/v2');
    const h = Number(r?.blockbook?.bestHeight ?? r?.backend?.blocks);
    if (!Number.isSafeInteger(h) || h <= 0) throw new Error(UNEXPECTED);
    return h;
  }
  if (path === '/fee-estimates') {
    // Blockbook gives coins per kilobyte for a target of blocks.
    const r = await get('/api/v2/estimatefee/3');
    const perKb = Number(r?.result);
    if (!Number.isFinite(perKb) || perKb <= 0) throw new Error(UNEXPECTED);
    return { 3: (perKb * 1e8) / 1000 };
  }
  throw new Error('Not served by the backup server.');
}

/** Broadcasts and returns the transaction ID, as Esplora's POST /tx does. */
export async function blockbookSend(base: string, hex: string, opts: Opts): Promise<string> {
  if (!/^[0-9a-f]+$/i.test(hex)) throw new Error('Not a transaction.');
  const r = await getJson(`${base.slice(BLOCKBOOK.length)}/api/v2/sendtx/${hex}`, { agent: opts.agent, timeoutMs: opts.timeoutMs });
  if (r?.error) throw new Error(String(r.error?.message ?? r.error).slice(0, 200));
  return txid(r?.result);
}
