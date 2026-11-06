import type { Agent } from 'node:http';
import { requestJson } from './request';
import { parseAmount } from './amount';
import { randomUUID } from 'node:crypto';
import { Asset, DECIMALS } from './config';

export const SWAP_BASE = 'https://exolix.com/api/v2';
export const SWAP_PROVIDER = 'Exolix';

const COIN: Record<Asset, { coin: string; network: RegExp; fallback: string }> = {
  BTC: { coin: 'BTC', network: /^(btc|bitcoin)$/i, fallback: 'BTC' },
  XMR: { coin: 'XMR', network: /^(xmr|monero)$/i, fallback: 'XMR' },
  TRX: { coin: 'TRX', network: /^(trx|tron|trc-?20)$/i, fallback: 'TRX' },
  USDT: { coin: 'USDT', network: /^(trx|tron|trc-?20)$/i, fallback: 'TRX' },
  ETH: { coin: 'ETH', network: /^(eth|ethereum|erc-?20)$/i, fallback: 'ETH' },
  USDTE: { coin: 'USDT', network: /^(eth|ethereum|erc-?20)$/i, fallback: 'ETH' },
  DCR: { coin: 'DCR', network: /^(dcr|decred)$/i, fallback: 'DCR' },
  DASH: { coin: 'DASH', network: /^dash$/i, fallback: 'DASH' },
  FIRO: { coin: 'FIRO', network: /^firo$/i, fallback: 'FIRO' },
  ZEC: { coin: 'ZEC', network: /^(zec|zcash)$/i, fallback: 'ZEC' },
  ZANO: { coin: 'ZANO', network: /^zano$/i, fallback: 'ZANO' },
  ARRR: { coin: 'ARRR', network: /^(arrr|pirate)/i, fallback: 'ARRR' },
};

/** Ethereum addresses differ only in checksum casing, which services often drop. */
function sameAddress(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  return /^0x/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface SwapQuote { from: Asset; to: Asset; amount: string; receive: string; rate: string; min: string | null; max: string | null; problem: string | null; provider: string; providerId: SwapProviderId; approximate: boolean }

export type SwapProviderId = 'exolix' | 'simpleswap' | 'ghostswap';

export interface SwapProvider {
  quote(from: Asset, to: Asset, amount: string): Promise<SwapQuote>;
  create(from: Asset, to: Asset, amount: string, expectedReceive: string, withdrawalAddress: string, refundAddress: string): Promise<SwapOrder>;
  status(id: string): Promise<{ status: string; hashIn?: string; hashOut?: string }>;
}
export interface SwapOrder { id: string; depositAddress: string; receive: string; rate: string; provider: string; approximate: boolean }
export interface SwapRecord { id: string; from: Asset; to: Asset; amount: string; receive: string; rate: string; createdAt: number; providerId?: SwapProviderId; provider?: string; withdrawalAddress?: string; privacyId?: string; approximate?: boolean; status: string; hashIn?: string; hashOut?: string }

function num(v: unknown): string | null {
  return typeof v === 'number' || (typeof v === 'string' && v !== '') ? String(v) : null;
}

/** Talks to the swap provider. Everything it returns is checked, because funds follow its answer. */
export class SwapClient implements SwapProvider {
  private networks = new Map<Asset, string>();

  constructor(private readonly base: string, private readonly agent?: Agent, private readonly timeoutMs = 30_000) {}

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }> {
    return requestJson(this.base + path, { method, body, agent: this.agent, timeoutMs: this.timeoutMs });
  }

  /** Exact network code for this coin, as the provider names it. */
  private async network(asset: Asset): Promise<string> {
    const known = this.networks.get(asset);
    if (known) return known;
    const info = COIN[asset];
    let code = info.fallback;
    try {
      const res = await this.call('GET', `/currencies/${info.coin}/networks`);
      const list: any[] = Array.isArray(res.body) ? res.body : res.body?.data ?? [];
      const match = list.find((n) => [n.network, n.shortName, n.name].some((v) => typeof v === 'string' && info.network.test(v)));
      if (match?.network) code = String(match.network);
    } catch { /* fall back to the usual code; the order response is still checked */ }
    this.networks.set(asset, code);
    return code;
  }

  async quote(from: Asset, to: Asset, amount: string): Promise<SwapQuote> {
    const q = new URLSearchParams({
      coinFrom: COIN[from].coin, networkFrom: await this.network(from),
      coinTo: COIN[to].coin, networkTo: await this.network(to),
      amount, rateType: 'fixed',
    });
    const res = await this.call('GET', `/rate?${q}`);
    const b = res.body ?? {};
    const min = num(b.minAmount);
    const max = num(b.maxAmount);
    const receive = num(b.toAmount);
    const problem = res.status >= 400 || !receive || Number(receive) <= 0
      ? (min && Number(amount) < Number(min) ? `The minimum amount is ${min} ${from}.`
        : max && Number(amount) > Number(max) ? `The maximum amount is ${max} ${from}.`
          : typeof b.message === 'string' && b.message ? b.message : 'No quote available for this swap right now.')
      : null;
    return { from, to, amount, receive: receive ?? '0', rate: num(b.rate) ?? '0', min, max, problem, provider: SWAP_PROVIDER, providerId: 'exolix', approximate: false };
  }

  async create(from: Asset, to: Asset, amount: string, expectedReceive: string, withdrawalAddress: string, refundAddress: string): Promise<SwapOrder> {
    const networkFrom = await this.network(from);
    const networkTo = await this.network(to);
    const res = await this.call('POST', '/transactions', {
      coinFrom: COIN[from].coin, networkFrom, coinTo: COIN[to].coin, networkTo,
      amount: Number(amount), withdrawalAddress, refundAddress, rateType: 'fixed',
    });
    const b = res.body ?? {};
    if (res.status >= 400) throw new Error(typeof b.message === 'string' && b.message ? `Swap order failed: ${b.message}` : `Could not create the swap order (${res.status}).`);

    const stop = (why: string): never => { throw new Error(`The provider's answer differs from the request, so this was stopped: ${why}. No coins have left your wallet.`); };
    if (typeof b.id !== 'string' && typeof b.id !== 'number') stop('no order number');
    if (typeof b.depositAddress !== 'string' || !b.depositAddress) stop('no deposit address');
    if (b.depositExtraId) stop('the deposit address needs an extra memo');
    if (!sameAddress(b.withdrawalAddress, withdrawalAddress)) stop('the receiving address is not yours');
    if (b.refundAddress && !sameAddress(b.refundAddress, refundAddress)) stop('the refund address is not yours');
    if (b.coinFrom?.coinCode && String(b.coinFrom.coinCode).toUpperCase() !== COIN[from].coin) stop('the sent coin differs');
    if (b.coinTo?.coinCode && String(b.coinTo.coinCode).toUpperCase() !== COIN[to].coin) stop('the received coin differs');
    if (b.coinFrom?.network && String(b.coinFrom.network) !== networkFrom) stop('the sending network differs');
    if (b.coinTo?.network && String(b.coinTo.network) !== networkTo) stop('the receiving network differs');
    if (parseAmount(String(b.amount), DECIMALS[from]) !== parseAmount(amount, DECIMALS[from])) stop('the send amount differs');
    const receive = num(b.amountTo);
    if (!receive || Number(receive) < Number(expectedReceive) * 0.98) stop('the receive amount is less than quoted');
    return { id: String(b.id), depositAddress: b.depositAddress, receive: receive as string, rate: num(b.rate) ?? '0', provider: SWAP_PROVIDER, approximate: false };
  }

  async status(id: string): Promise<{ status: string; hashIn?: string; hashOut?: string }> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid order number.');
    const res = await this.call('GET', `/transactions/${id}`);
    if (res.status >= 400) throw new Error(`Could not read the swap status (${res.status}).`);
    const hash = (v: any) => (typeof v === 'string' ? v : typeof v?.hash === 'string' ? v.hash : undefined);
    return { status: String(res.body?.status ?? 'unknown'), hashIn: hash(res.body?.hashIn), hashOut: hash(res.body?.hashOut) };
  }
}

function sameAmount(answer: unknown, amount: string, decimals: number): boolean {
  const clean = String(answer).trim().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  try { return parseAmount(clean, decimals) === parseAmount(amount, decimals); } catch { return false; }
}

function apiMessage(b: any, fallback: string): string {
  const m = b?.error?.message ?? b?.message ?? b?.error ?? b?.description;
  return typeof m === 'string' && m ? m : fallback;
}

const stop = (why: string): never => { throw new Error(`The provider's answer differs from the request, so this was stopped: ${why}. No coins have left your wallet.`); };
const ORDER_ID = /^[A-Za-z0-9_-]{1,80}$/;

// ---- SimpleSwap ----

/**
 * Partner keys shipped with the app, so nobody has to sign up. Anyone holding the app can extract them:
 * they identify the partner account and are not secrets. They stay out of the source; see scripts/gen-keys.js.
 */
export { BUILTIN_SWAP_KEYS } from './swap-keys.generated';

export const SIMPLESWAP_BASE = 'https://api.simpleswap.io';
const SIMPLE_COIN: Record<Asset, { ticker: string; network: string }> = {
  BTC: { ticker: 'btc', network: 'btc' },
  XMR: { ticker: 'xmr', network: 'xmr' },
  TRX: { ticker: 'trx', network: 'trx' },
  USDT: { ticker: 'usdt', network: 'trx' },
  ETH: { ticker: 'eth', network: 'eth' },
  USDTE: { ticker: 'usdt', network: 'eth' },
  DCR: { ticker: 'dcr', network: 'dcr' },
  DASH: { ticker: 'dash', network: 'dash' },
  FIRO: { ticker: 'firo', network: 'firo' },
  ZEC: { ticker: 'zec', network: 'zec' },
  ZANO: { ticker: 'zano', network: 'zano' },
  ARRR: { ticker: 'arrr', network: 'arrr' },
};

export class SimpleSwapClient implements SwapProvider {
  constructor(private readonly base: string, private readonly apiKey: string, private readonly agent?: Agent, private readonly timeoutMs = 30_000) {}

  private call(method: 'GET' | 'POST', path: string, body?: unknown) {
    return requestJson(this.base + path, { method, body, agent: this.agent, timeoutMs: this.timeoutMs, headers: { 'x-api-key': this.apiKey } });
  }

  private pair(from: Asset, to: Asset) {
    return { tickerFrom: SIMPLE_COIN[from].ticker, networkFrom: SIMPLE_COIN[from].network, tickerTo: SIMPLE_COIN[to].ticker, networkTo: SIMPLE_COIN[to].network };
  }

  async quote(from: Asset, to: Asset, amount: string): Promise<SwapQuote> {
    const q = new URLSearchParams({ fixed: 'false', ...this.pair(from, to), reverse: 'false', amount });
    const res = await this.call('GET', `/v3/estimates?${q}`);
    const row = res.body?.result ?? res.body ?? {};
    const receive = num(row.estimatedAmount);
    const base = { from, to, amount, min: null, max: null, provider: 'SimpleSwap', providerId: 'simpleswap' as const, approximate: true };
    if (res.status === 401 || res.status === 403) return { ...base, receive: '0', rate: '0', problem: 'Check the SimpleSwap API key.' };
    if (res.status >= 400 || !receive || Number(receive) <= 0) {
      return { ...base, receive: '0', rate: '0', problem: apiMessage(res.body, 'No quote available for this swap right now. Try a different amount.') };
    }
    return { ...base, receive, rate: String(Number(receive) / Number(amount)), problem: null };
  }

  async create(from: Asset, to: Asset, amount: string, expectedReceive: string, withdrawalAddress: string, refundAddress: string): Promise<SwapOrder> {
    const res = await this.call('POST', '/v3/exchanges', {
      fixed: false, ...this.pair(from, to), amount, reverse: false,
      addressTo: withdrawalAddress, extraIdTo: '', userRefundAddress: refundAddress, userRefundExtraId: '',
    });
    if (res.status >= 400) throw new Error(`Swap order failed: ${apiMessage(res.body, String(res.status))}`);
    const b = res.body?.result ?? res.body ?? {};
    const id = b.publicId ?? b.id;
    if (typeof id !== 'string' || !ORDER_ID.test(id)) stop('no order number');
    if (typeof b.addressFrom !== 'string' || !b.addressFrom) stop('no deposit address');
    if (b.extraIdFrom) stop('the deposit address needs an extra memo');
    if (!sameAddress(b.addressTo, withdrawalAddress)) stop('the receiving address is not yours');
    if (b.userRefundAddress && !sameAddress(b.userRefundAddress, refundAddress)) stop('the refund address is not yours');
    if (b.tickerFrom && String(b.tickerFrom).toLowerCase() !== SIMPLE_COIN[from].ticker) stop('the sent coin differs');
    if (b.tickerTo && String(b.tickerTo).toLowerCase() !== SIMPLE_COIN[to].ticker) stop('the received coin differs');
    if (b.networkFrom && String(b.networkFrom).toLowerCase() !== SIMPLE_COIN[from].network) stop('the sending network differs');
    if (b.networkTo && String(b.networkTo).toLowerCase() !== SIMPLE_COIN[to].network) stop('the receiving network differs');
    if (!sameAmount(b.amountFrom, amount, DECIMALS[from])) stop('the send amount differs');
    const receive = num(b.amountTo);
    if (!receive || Number(receive) < Number(expectedReceive) * 0.98) stop('the receive amount is less than quoted');
    return { id, depositAddress: b.addressFrom, receive: receive as string, rate: String(Number(receive) / Number(amount)), provider: 'SimpleSwap', approximate: true };
  }

  async status(id: string): Promise<{ status: string; hashIn?: string; hashOut?: string }> {
    if (!ORDER_ID.test(id)) throw new Error('Invalid order number.');
    const res = await this.call('GET', `/v3/exchanges/${id}`);
    if (res.status >= 400) throw new Error(`Could not read the swap status (${res.status}).`);
    const b = res.body?.result ?? res.body ?? {};
    return { status: String(b.status ?? 'unknown'), hashIn: b.txFrom ?? undefined, hashOut: b.txTo ?? undefined };
  }
}

// ---- GhostSwap ----

export const GHOSTSWAP_BASE = 'https://partners-api.ghostswap.io';
const GHOST_TICKER: Record<Exclude<Asset, 'USDTE'>, string> = { BTC: 'btc', XMR: 'xmr', ETH: 'eth', TRX: 'trx', USDT: 'usdtrx', DCR: 'dcr', DASH: 'dash', FIRO: 'firo', ZEC: 'zec', ZANO: 'zano', ARRR: 'arrr' };

export class GhostSwapClient implements SwapProvider {
  constructor(private readonly base: string, private readonly bearer: string, private readonly agent?: Agent, private readonly timeoutMs = 30_000) {}

  private call(method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}) {
    return requestJson(this.base + path, { method, body, agent: this.agent, timeoutMs: this.timeoutMs, headers: { Authorization: `Bearer ${this.bearer}`, ...extra } });
  }

  private usdtEth: string | null = null;

  /** Their docs do not name the Ethereum USDT ticker, so it is read from their list and never guessed. */
  private async ticker(asset: Asset): Promise<string> {
    if (asset !== 'USDTE') return GHOST_TICKER[asset];
    if (this.usdtEth) return this.usdtEth;
    const res = await this.call('GET', '/v1/currencies');
    const list: any[] = Array.isArray(res.body?.currencies) ? res.body.currencies : [];
    const row = list.find((c) => /^usdt/i.test(String(c?.ticker)) && /^(eth|ethereum|erc-?20)$/i.test(String(c?.blockchain)) && c?.enabled !== false);
    if (!row) throw new Error('GhostSwap doesn\'t list USDT (Eth).');
    this.usdtEth = String(row.ticker);
    return this.usdtEth;
  }

  async quote(from: Asset, to: Asset, amount: string): Promise<SwapQuote> {
    const res = await this.call('POST', '/v1/quotes', { from: await this.ticker(from), to: await this.ticker(to), amountFrom: amount, mode: 'float' });
    const q = res.body?.quote ?? {};
    const receive = num(q.amountUserReceives);
    const base = { from, to, amount, provider: 'GhostSwap', providerId: 'ghostswap' as const, approximate: true };
    if (res.status === 401 || res.status === 403) return { ...base, receive: '0', rate: '0', min: null, max: null, problem: 'Check the GhostSwap API key.' };
    const min = num(q.min);
    const max = num(q.max);
    if (res.status >= 400 || !receive || Number(receive) <= 0) {
      return { ...base, receive: '0', rate: '0', min, max, problem: apiMessage(res.body, 'No quote available for this swap right now. Try a different amount.') };
    }
    return { ...base, receive, rate: num(q.rate) ?? String(Number(receive) / Number(amount)), min, max, problem: null };
  }

  async create(from: Asset, to: Asset, amount: string, expectedReceive: string, withdrawalAddress: string, refundAddress: string): Promise<SwapOrder> {
    const tickerFrom = await this.ticker(from);
    const tickerTo = await this.ticker(to);
    const res = await this.call('POST', '/v1/swaps', {
      from: tickerFrom, to: tickerTo, amountFrom: amount, address: withdrawalAddress, refundAddress, mode: 'float', extraIdNotRequired: true,
    }, { 'Idempotency-Key': randomUUID() });
    if (res.status >= 400) throw new Error(`Swap order failed: ${apiMessage(res.body, String(res.status))}`);
    const b = res.body?.swap ?? {};
    if (typeof b.id !== 'string' || !ORDER_ID.test(b.id)) stop('no order number');
    if (typeof b.payinAddress !== 'string' || !b.payinAddress) stop('no deposit address');
    if (b.payinExtraId) stop('the deposit address needs an extra memo');
    if (!sameAddress(b.payoutAddress, withdrawalAddress)) stop('the receiving address is not yours');
    if (b.refundAddress && !sameAddress(b.refundAddress, refundAddress)) stop('the refund address is not yours');
    if (b.from && String(b.from).toLowerCase() !== tickerFrom.toLowerCase()) stop('the sent coin differs');
    if (b.to && String(b.to).toLowerCase() !== tickerTo.toLowerCase()) stop('the received coin differs');
    if (!sameAmount(b.amountExpectedFrom ?? b.amountFrom, amount, DECIMALS[from])) stop('the send amount differs');
    const gross = Number(b.amountExpectedTo);
    const fee = Number(b.networkFee ?? 0);
    const net = gross - (Number.isFinite(fee) ? fee : 0);
    if (!Number.isFinite(net) || net < Number(expectedReceive) * 0.98) stop('the receive amount is less than quoted');
    return { id: b.id, depositAddress: b.payinAddress, receive: String(net), rate: num(b.rate) ?? String(net / Number(amount)), provider: 'GhostSwap', approximate: true };
  }

  async status(id: string): Promise<{ status: string; hashIn?: string; hashOut?: string }> {
    if (!ORDER_ID.test(id)) throw new Error('Invalid order number.');
    const res = await this.call('GET', `/v1/swaps/${id}`);
    if (res.status >= 400) throw new Error(`Could not read the swap status (${res.status}).`);
    const b = res.body?.swap ?? {};
    return { status: String(b.status ?? 'unknown'), hashIn: b.payinHash ?? undefined, hashOut: b.payoutHash ?? undefined };
  }
}

/** Two separate orders through a fresh Monero subaddress. The second needs the password again. */
export interface PrivacySwap {
  id: string; from: Asset; to: Asset; amount: string; destination: string; via: string;
  stage: 'first' | 'ready' | 'second' | 'done' | 'failed';
  firstId: string; firstProviderId: SwapProviderId; expectedXmr: string;
  received: string; unlocked: string; secondId?: string; secondProviderId?: SwapProviderId; note?: string; createdAt: number;
}

export const PRIVACY_ASSETS: Asset[] = ['BTC', 'ETH', 'USDTE'];
export const SWAP_DEAD = ['failed', 'refunded', 'refund', 'overdue', 'expired'];
export const SWAP_DONE = ['success', 'finished'];
