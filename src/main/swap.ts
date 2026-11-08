import type { Agent } from 'node:http';
import { requestJson } from './request';
import { parseAmount } from './amount';
import { randomUUID } from 'node:crypto';
import { computeHmac, toUtf8Bytes } from 'ethers';
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
  LINK: { coin: 'LINK', network: /^(eth|ethereum|erc-?20)$/i, fallback: 'ETH' },
  WLD: { coin: 'WLD', network: /^(eth|ethereum|erc-?20)$/i, fallback: 'ETH' },
  DASH: { coin: 'DASH', network: /^dash$/i, fallback: 'DASH' },
  FIRO: { coin: 'FIRO', network: /^firo$/i, fallback: 'FIRO' },
  SOL: { coin: 'SOL', network: /^(sol|solana)$/i, fallback: 'SOL' },
  USDTS: { coin: 'USDT', network: /^(sol|solana|spl)$/i, fallback: 'SOL' },
  POL: { coin: 'POL', network: /^(pol|polygon|matic)$/i, fallback: 'POL' },
  USDTP: { coin: 'USDT', network: /^(pol|polygon|matic)$/i, fallback: 'POLYGON' },
  ARB: { coin: 'ARB', network: /^(arb|arbitrum|arbitrum one)$/i, fallback: 'ARBITRUM' },
  ETHA: { coin: 'ETH', network: /^(arb|arbitrum|arbitrum one)$/i, fallback: 'ARBITRUM' },
  USDTA: { coin: 'USDT', network: /^(arb|arbitrum|arbitrum one)$/i, fallback: 'ARBITRUM' },
  BCH: { coin: 'BCH', network: /^(bch|bitcoin ?cash)$/i, fallback: 'BCH' },
  LTC: { coin: 'LTC', network: /^(ltc|litecoin)$/i, fallback: 'LTC' },
  DOGE: { coin: 'DOGE', network: /^(doge|dogecoin)$/i, fallback: 'DOGE' },
  ZEC: { coin: 'ZEC', network: /^(zec|zcash)$/i, fallback: 'ZEC' },
  ZANO: { coin: 'ZANO', network: /^zano$/i, fallback: 'ZANO' },
  ARRR: { coin: 'ARRR', network: /^(arrr|pirate)/i, fallback: 'ARRR' },
  SCRT: { coin: 'SCRT', network: /^(scrt|secret)/i, fallback: 'SCRT' },
  SSCRT: { coin: '', network: /^$/, fallback: '' }, // never offered: see NOT_SWAPPABLE
};

/** Ethereum addresses differ only in checksum casing, which services often drop. */
function sameAddress(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  // Bitcoin Cash addresses are often written without their bitcoincash: prefix, and either case is the same address.
  const bch = (x: string) => x.toLowerCase().replace(/^bitcoincash:/, '');
  if (/^bitcoincash:/i.test(b)) return bch(a) === bch(b);
  return /^0x/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface SwapQuote { from: Asset; to: Asset; amount: string; receive: string; rate: string; min: string | null; max: string | null; problem: string | null; provider: string; providerId: SwapProviderId; approximate: boolean }

/** No provider takes the private form of a coin; it's made from or turned back into the plain one in the wallet. */
export const NOT_SWAPPABLE: ReadonlySet<Asset> = new Set<Asset>(['SSCRT']);

export type SwapProviderId = 'exolix' | 'simpleswap' | 'ghostswap' | 'etzswap' | 'ccecash' | 'changenow';

export interface SwapProvider {
  quote(from: Asset, to: Asset, amount: string): Promise<SwapQuote>;
  create(from: Asset, to: Asset, amount: string, expectedReceive: string, withdrawalAddress: string, refundAddress: string): Promise<SwapOrder>;
  status(id: string, statusKey?: string): Promise<{ status: string; hashIn?: string; hashOut?: string }>;
}
/** statusKey: the order's private lookup code, where the provider has one. Never shown on screen. */
export interface SwapOrder { id: string; depositAddress: string; receive: string; rate: string; provider: string; approximate: boolean; statusKey?: string }
export interface SwapRecord { id: string; from: Asset; to: Asset; amount: string; receive: string; rate: string; createdAt: number; providerId?: SwapProviderId; provider?: string; withdrawalAddress?: string; privacyId?: string; approximate?: boolean; statusKey?: string; status: string; hashIn?: string; hashOut?: string }

/** How an amount's unit reads to a person: the three USDTs are all USDT. */
const unit = (a: Asset): string => (a === 'USDTE' || a === 'USDTS' || a === 'USDTP' || a === 'USDTA' ? 'USDT' : a === 'ETHA' ? 'ETH' : a);

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
      ? (min && Number(amount) < Number(min) ? `The minimum amount is ${min} ${unit(from)}.`
        : max && Number(amount) > Number(max) ? `The maximum amount is ${max} ${unit(from)}.`
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
 * Partner keys put in at build time; see scripts/gen-keys.js. They stay out of the source, but anyone holding
 * a build can extract them. The ETZ Swap and CCECash keys can read the account's orders, addresses included,
 * so a build holding those must stay with the account's owner and never be distributed.
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
  LINK: { ticker: 'link', network: 'eth' },
  WLD: { ticker: 'wld', network: 'eth' },
  DASH: { ticker: 'dash', network: 'dash' },
  FIRO: { ticker: 'firo', network: 'firo' },
  SOL: { ticker: 'sol', network: 'sol' },
  USDTS: { ticker: 'usdt', network: 'sol' },
  POL: { ticker: 'pol', network: 'matic' },
  USDTP: { ticker: 'usdt', network: 'matic' },
  ARB: { ticker: 'arb', network: 'arbitrum' },
  ETHA: { ticker: 'eth', network: 'arbitrum' },
  USDTA: { ticker: 'usdt', network: 'arbitrum' },
  BCH: { ticker: 'bch', network: 'bch' },
  LTC: { ticker: 'ltc', network: 'ltc' },
  DOGE: { ticker: 'doge', network: 'doge' },
  ZEC: { ticker: 'zec', network: 'zec' },
  ZANO: { ticker: 'zano', network: 'zano' },
  ARRR: { ticker: 'arrr', network: 'arrr' },
  SCRT: { ticker: 'scrt', network: 'scrt' },
  SSCRT: { ticker: '', network: '' },
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
// Coins whose GhostSwap ticker depends on the chain: read from their list by coin and chain, never guessed.
type LookedUp = 'USDTE' | 'LINK' | 'WLD' | 'USDTS' | 'POL' | 'USDTP' | 'ARB' | 'ETHA' | 'USDTA';
const GHOST_LOOKUP: Record<LookedUp, { ticker: RegExp; chain: RegExp; label: string }> = {
  USDTE: { ticker: /^usdt/i, chain: /^(eth|ethereum|erc-?20)$/i, label: 'USDT (Eth)' },
  USDTS: { ticker: /^usdt/i, chain: /^(sol|solana|spl)$/i, label: 'USDT (Sol)' },
  LINK: { ticker: /^link/i, chain: /^(eth|ethereum|erc-?20)$/i, label: 'LINK' },
  WLD: { ticker: /^wld/i, chain: /^(eth|ethereum|erc-?20)$/i, label: 'WLD' },
  POL: { ticker: /^(pol|matic)/i, chain: /^(pol|polygon|matic)$/i, label: 'POL' },
  USDTP: { ticker: /^usdt/i, chain: /^(pol|polygon|matic)$/i, label: 'USDT (Pol)' },
  ARB: { ticker: /^arb/i, chain: /^(arb|arbitrum)$/i, label: 'ARB' },
  ETHA: { ticker: /^eth/i, chain: /^(arb|arbitrum)$/i, label: 'ETH (Arb)' },
  USDTA: { ticker: /^usdt/i, chain: /^(arb|arbitrum)$/i, label: 'USDT (Arb)' },
};
const GHOST_TICKER: Record<Exclude<Asset, LookedUp>, string> = { BTC: 'btc', XMR: 'xmr', ETH: 'eth', TRX: 'trx', USDT: 'usdtrx', DASH: 'dash', FIRO: 'firo', SOL: 'sol', BCH: 'bch', LTC: 'ltc', DOGE: 'doge', ZEC: 'zec', ZANO: 'zano', ARRR: 'arrr', SCRT: 'scrt', SSCRT: '' };

export class GhostSwapClient implements SwapProvider {
  constructor(private readonly base: string, private readonly bearer: string, private readonly agent?: Agent, private readonly timeoutMs = 30_000) {}

  private call(method: 'GET' | 'POST', path: string, body?: unknown, extra: Record<string, string> = {}) {
    return requestJson(this.base + path, { method, body, agent: this.agent, timeoutMs: this.timeoutMs, headers: { Authorization: `Bearer ${this.bearer}`, ...extra } });
  }

  private usdtTickers: Partial<Record<Asset, string>> = {};

  /** Their docs name only Tron's USDT ticker, so chain-specific ones are read from their list and never guessed. */
  private async ticker(asset: Asset): Promise<string> {
    if (!(asset in GHOST_LOOKUP)) return GHOST_TICKER[asset as Exclude<Asset, LookedUp>];
    const known = this.usdtTickers[asset];
    if (known) return known;
    const want = GHOST_LOOKUP[asset as LookedUp];
    const res = await this.call('GET', '/v1/currencies');
    const list: any[] = Array.isArray(res.body?.currencies) ? res.body.currencies : [];
    const row = list.find((c) => want.ticker.test(String(c?.ticker)) && want.chain.test(String(c?.blockchain)) && c?.enabled !== false);
    if (!row) throw new Error(`GhostSwap doesn't list ${want.label}.`);
    this.usdtTickers[asset] = String(row.ticker);
    return this.usdtTickers[asset]!;
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

// ---- ETZ Swap ----

/** Their JSON numbers can't always hold every decimal, so a difference this small is rounding and nothing else. */
function closeAmount(answer: unknown, amount: string): boolean {
  const a = Number(answer);
  const b = Number(amount);
  return Number.isFinite(a) && b > 0 && Math.abs(a - b) <= b * 1e-9;
}

export const ETZSWAP_BASE = 'https://api.etz-swap.com';
const ETZ_COIN: Partial<Record<Asset, { coin: string; network: string }>> = {
  BTC: { coin: 'BTC', network: 'BTC' },
  XMR: { coin: 'XMR', network: 'XMR' },
  ETH: { coin: 'ETH', network: 'ETH' },
  TRX: { coin: 'TRX', network: 'TRX' },
  USDT: { coin: 'USDT', network: 'TRX' },
  USDTE: { coin: 'USDT', network: 'ETH' },
  DASH: { coin: 'DASH', network: 'DASH' },
  SOL: { coin: 'SOL', network: 'SOL' },
  BCH: { coin: 'BCH', network: 'BCH' },
  LTC: { coin: 'LTC', network: 'LTC' },
  USDTS: { coin: 'USDT', network: 'SOL' },
  DOGE: { coin: 'DOGE', network: 'DOGE' },
  ZEC: { coin: 'ZEC', network: 'ZEC' },
  ZANO: { coin: 'ZANO', network: 'ZANO' },
};

/** Their errors come as { errors: { someName: { message, args } } }. */
function etzError(b: any): { name: string; message: string; args: any } | null {
  const [name, e] = Object.entries(b?.errors ?? {})[0] as [string, any] ?? [];
  return name ? { name, message: String(e?.message ?? name), args: e?.args ?? {} } : null;
}

export class EtzSwapClient implements SwapProvider {
  constructor(private readonly base: string, private readonly key: string, private readonly secret: string, private readonly agent?: Agent, private readonly timeoutMs = 30_000, private readonly version = '1') {}

  private call(method: 'GET' | 'POST', path: string, body?: unknown) {
    return requestJson(this.base + path, { method, body, agent: this.agent, timeoutMs: this.timeoutMs, headers: { 'X-API-KEY': this.key, 'X-API-SECRET-KEY': this.secret, 'X-API-KEY-VERSION': this.version } });
  }

  async quote(from: Asset, to: Asset, amount: string): Promise<SwapQuote> {
    const base = { from, to, amount, provider: 'ETZ Swap', providerId: 'etzswap' as const, approximate: true };
    const none = (problem: string, min: string | null = null, max: string | null = null) => ({ ...base, receive: '0', rate: '0', min, max, problem });
    const a = ETZ_COIN[from];
    const b = ETZ_COIN[to];
    if (!a || !b) return none('ETZ Swap doesn\'t offer this coin.');
    const q = new URLSearchParams({ coinFrom: a.coin, networkFrom: a.network, coinTo: b.coin, networkTo: b.network, amountFrom: amount, rateType: 'float' });
    const res = await this.call('GET', `/api/v1/deposit/public/rate?${q}`);
    if (res.status === 401 || res.status === 403 || /key version/i.test(String(res.body?.message ?? res.body?.error ?? ''))) return none('Check the ETZ Swap API key.');
    const d = res.body?.data;
    const e = etzError(res.body);
    if (e || !d) {
      const min = num(e?.args?.minAllowedAmount);
      const max = num(e?.args?.maxAllowedAmount);
      return none(e?.name === 'amountTooSmall' && min ? `The minimum amount is ${min} ${unit(from)}.` : e?.name === 'amountTooBig' && max ? `The maximum amount is ${max} ${unit(from)}.` : e?.message ?? 'No quote available for this swap right now.', min, max);
    }
    const receive = num(d.amountTo);
    if (!receive || Number(receive) <= 0) return none('No quote available for this swap right now.');
    return { ...base, receive, rate: num(d.rate) ?? String(Number(receive) / Number(amount)), min: num(d.minAmountFrom), max: num(d.maxAmountFrom), problem: null };
  }

  async create(from: Asset, to: Asset, amount: string, expectedReceive: string, withdrawalAddress: string, refundAddress: string): Promise<SwapOrder> {
    const a = ETZ_COIN[from];
    const c = ETZ_COIN[to];
    if (!a || !c) throw new Error('ETZ Swap doesn\'t offer this coin.');
    const res = await this.call('POST', '/api/v1/deposit/public/transaction', {
      coinFrom: a.coin, networkFrom: a.network, coinTo: c.coin, networkTo: c.network, amountFrom: Number(amount),
      withdrawalAddress, refundAddress, securityType: 'secureToken', rateType: 'float',
    });
    const b = res.body?.data;
    const e = etzError(res.body);
    if (res.status >= 400 || e || !b) throw new Error(`Swap order failed: ${e?.message ?? res.status}`);
    if (typeof b.transactionId !== 'string' || !ORDER_ID.test(b.transactionId)) stop('no order number');
    if (typeof b.deposit?.address !== 'string' || !b.deposit.address) stop('no deposit address');
    if (b.deposit.memo) stop('the deposit address needs an extra memo');
    if (!sameAddress(b.withdraw?.address, withdrawalAddress)) stop('the receiving address is not yours');
    if (b.refund?.address && !sameAddress(b.refund.address, refundAddress)) stop('the refund address is not yours');
    if (String(b.coinFrom?.coinCode).toUpperCase() !== a.coin) stop('the sent coin differs');
    if (String(b.coinTo?.coinCode).toUpperCase() !== c.coin) stop('the received coin differs');
    if (!COIN[from].network.test(String(b.coinFrom?.network))) stop('the sending network differs');
    if (!COIN[to].network.test(String(b.coinTo?.network))) stop('the receiving network differs');
    if (!closeAmount(b.amount, amount)) stop('the send amount differs');
    const receive = num(b.amountTo);
    if (!receive || Number(receive) < Number(expectedReceive) * 0.98) stop('the receive amount is less than quoted');
    const token = b.transactionSecurity?.secureToken;
    if (typeof token !== 'string' || !token) stop('no private order code');
    return { id: b.transactionId, depositAddress: b.deposit.address, receive: receive as string, rate: num(b.rate) ?? String(Number(receive) / Number(amount)), provider: 'ETZ Swap', approximate: true, statusKey: token };
  }

  async status(id: string, statusKey = ''): Promise<{ status: string; hashIn?: string; hashOut?: string }> {
    if (!ORDER_ID.test(id)) throw new Error('Invalid order number.');
    const res = await this.call('GET', `/api/v1/deposit/public/transactions/${id}?${new URLSearchParams({ secureToken: statusKey })}`);
    const e = etzError(res.body);
    if (res.status >= 400 || e) throw new Error(e?.message ?? `Could not read the swap status (${res.status}).`);
    const b = res.body?.data ?? {};
    return { status: String(b.status ?? 'unknown'), hashIn: b.inboundTransfer?.hash ?? undefined, hashOut: b.outboundTransfer?.hash ?? undefined };
  }
}

// ---- ChangeNOW ----

export const CHANGENOW_BASE = 'https://api.changenow.io';
// Their v2 names a coin by ticker plus network, e.g. USDT on Tron is usdt on trx.
const CN_COIN: Partial<Record<Asset, { ticker: string; network: string }>> = {
  BTC: { ticker: 'btc', network: 'btc' },
  XMR: { ticker: 'xmr', network: 'xmr' },
  ETH: { ticker: 'eth', network: 'eth' },
  TRX: { ticker: 'trx', network: 'trx' },
  USDT: { ticker: 'usdt', network: 'trx' },
  USDTE: { ticker: 'usdt', network: 'eth' },
  LINK: { ticker: 'link', network: 'eth' },
  WLD: { ticker: 'wld', network: 'eth' },
  USDTS: { ticker: 'usdt', network: 'sol' },
  // Names as their currency list has them; one they don't recognize gets no quote, and orders are checked anyway.
  POL: { ticker: 'pol', network: 'matic' },
  USDTP: { ticker: 'usdt', network: 'matic' },
  ARB: { ticker: 'arb', network: 'arbitrum' },
  ETHA: { ticker: 'eth', network: 'arbitrum' },
  USDTA: { ticker: 'usdt', network: 'arbitrum' },
  BCH: { ticker: 'bch', network: 'bch' },
  LTC: { ticker: 'ltc', network: 'ltc' },
  SOL: { ticker: 'sol', network: 'sol' },
  DOGE: { ticker: 'doge', network: 'doge' },
  DASH: { ticker: 'dash', network: 'dash' },
  FIRO: { ticker: 'firo', network: 'firo' },
  ZEC: { ticker: 'zec', network: 'zec' },
  ZANO: { ticker: 'zano', network: 'zano' },
  ARRR: { ticker: 'arrr', network: 'arrr' },
  // No SCRT: ChangeNOW doesn't list it.
};

export class ChangeNowClient implements SwapProvider {
  constructor(private readonly base: string, private readonly key: string, private readonly agent?: Agent, private readonly timeoutMs = 30_000) {}

  // No forwarded IP is sent: the example in their docs has one, but this wallet doesn't hand out where its user is.
  private call(method: 'GET' | 'POST', path: string, body?: unknown) {
    return requestJson(this.base + path, { method, body, agent: this.agent, timeoutMs: this.timeoutMs, headers: { 'x-changenow-api-key': this.key } });
  }

  private pair(from: Asset, to: Asset) {
    const a = CN_COIN[from];
    const b = CN_COIN[to];
    return a && b ? { fromCurrency: a.ticker, fromNetwork: a.network, toCurrency: b.ticker, toNetwork: b.network } : null;
  }

  async quote(from: Asset, to: Asset, amount: string): Promise<SwapQuote> {
    const base = { from, to, amount, provider: 'ChangeNOW', providerId: 'changenow' as const, approximate: true };
    const none = (problem: string, min: string | null = null) => ({ ...base, receive: '0', rate: '0', min, max: null, problem });
    const pair = this.pair(from, to);
    if (!pair) return none('ChangeNOW doesn\'t offer this coin.');
    const res = await this.call('GET', `/v2/exchange/estimated-amount?${new URLSearchParams({ ...pair, fromAmount: amount, flow: 'standard', type: 'direct' })}`);
    if (res.status === 401 || res.status === 403) return none('Check the ChangeNOW API key.');
    const b = res.body;
    const receive = num(b?.toAmount);
    if (res.status < 400 && receive && Number(receive) > 0 && b?.fromCurrency === pair.fromCurrency && b?.toCurrency === pair.toCurrency && b?.toNetwork === pair.toNetwork) {
      return { ...base, receive, rate: String(Number(receive) / Number(amount)), min: null, max: null, problem: null };
    }
    // A refused amount is usually under the minimum, which has its own question.
    const range = await this.call('GET', `/v2/exchange/min-amount?${new URLSearchParams({ ...pair, flow: 'standard' })}`).catch(() => null);
    const min = num(range?.body?.minAmount);
    if (min && Number(amount) < Number(min)) return none(`The minimum amount is ${min} ${from}.`, min);
    const message = typeof b?.message === 'string' && b.message ? b.message.slice(0, 200) : 'No quote available for this swap right now.';
    return none(message, min);
  }

  async create(from: Asset, to: Asset, amount: string, expectedReceive: string, withdrawalAddress: string, refundAddress: string): Promise<SwapOrder> {
    const pair = this.pair(from, to);
    if (!pair) throw new Error('ChangeNOW doesn\'t offer this coin.');
    const res = await this.call('POST', '/v2/exchange', { ...pair, fromAmount: amount, address: withdrawalAddress, refundAddress, flow: 'standard', type: 'direct' });
    const b = res.body;
    if (res.status >= 400 || !b || b.error) throw new Error(`Swap order failed: ${typeof b?.message === 'string' ? b.message.slice(0, 200) : res.status}`);
    if (typeof b.id !== 'string' || !ORDER_ID.test(b.id)) stop('no order number');
    if (typeof b.payinAddress !== 'string' || !b.payinAddress) stop('no deposit address');
    if (b.payinExtraId) stop('the deposit address needs an extra memo');
    if (!sameAddress(b.payoutAddress, withdrawalAddress)) stop('the receiving address is not yours');
    if (b.refundAddress && !sameAddress(b.refundAddress, refundAddress)) stop('the refund address is not yours');
    if (b.fromCurrency !== pair.fromCurrency) stop('the sent coin differs');
    if (b.toCurrency !== pair.toCurrency) stop('the received coin differs');
    if (b.fromNetwork !== pair.fromNetwork) stop('the sending network differs');
    if (b.toNetwork !== pair.toNetwork) stop('the receiving network differs');
    if (!closeAmount(b.fromAmount, amount)) stop('the send amount differs');
    const receive = num(b.toAmount);
    if (!receive || Number(receive) < Number(expectedReceive) * 0.98) stop('the receive amount is less than quoted');
    return { id: b.id, depositAddress: b.payinAddress, receive: receive as string, rate: String(Number(receive) / Number(amount)), provider: 'ChangeNOW', approximate: true };
  }

  async status(id: string): Promise<{ status: string; hashIn?: string; hashOut?: string }> {
    if (!ORDER_ID.test(id)) throw new Error('Invalid order number.');
    const res = await this.call('GET', `/v2/exchange/by-id?${new URLSearchParams({ id })}`);
    const b = res.body;
    if (res.status >= 400 || !b || b.error) throw new Error(typeof b?.message === 'string' ? b.message.slice(0, 200) : `Could not read the swap status (${res.status}).`);
    return { status: String(b.status ?? 'unknown'), hashIn: b.payinHash ?? undefined, hashOut: b.payoutHash ?? undefined };
  }
}

// ---- CCECash ----

export const CCECASH_BASE = 'https://cce.cash/api/v1';
const CCE_COIN: Partial<Record<Asset, { abbr: string; chain: string }>> = {
  BTC: { abbr: 'BTC', chain: 'Bitcoin' },
  XMR: { abbr: 'XMR', chain: 'Monero' },
  ETH: { abbr: 'ETH', chain: 'Ethereum' },
  TRX: { abbr: 'TRX', chain: 'TRON' },
  USDT: { abbr: 'USDT', chain: 'TRON' },
  USDTE: { abbr: 'USDT', chain: 'Ethereum' },
  LINK: { abbr: 'LINK', chain: 'Ethereum' },
  DASH: { abbr: 'DASH', chain: 'Dash' },
  SOL: { abbr: 'SOL', chain: 'Solana' },
  BCH: { abbr: 'BCH', chain: 'Bitcoin Cash' },
  LTC: { abbr: 'LTC', chain: 'Litecoin' },
  USDTS: { abbr: 'USDT', chain: 'Solana' },
  POL: { abbr: 'POL', chain: 'Polygon' },
  USDTP: { abbr: 'USDT', chain: 'Polygon' },
  ARB: { abbr: 'ARB', chain: 'Arbitrum' },
  ETHA: { abbr: 'ETH', chain: 'Arbitrum' },
  USDTA: { abbr: 'USDT', chain: 'Arbitrum' },
  DOGE: { abbr: 'DOGE', chain: 'Dogecoin' },
  ZEC: { abbr: 'ZEC', chain: 'Zcash' },
};
/** Their order states, as the words the rest of the wallet uses. */
const CCE_STATUS: Record<number, string> = { 1: 'wait', 2: 'confirming', 3: 'exchanging', 4: 'success', 5: 'refunded', 7: 'hold', 8: 'expired', 9: 'failed' };

export class CceCashClient implements SwapProvider {
  constructor(private readonly base: string, private readonly key: string, private readonly secret: string, private readonly refCode = '', private readonly agent?: Agent, private readonly timeoutMs = 30_000) {}

  private async once(method: 'GET' | 'POST', path: string, query: string, body: unknown, extra: Record<string, string>) {
    const nonce = randomUUID().replace(/-/g, '');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const text = body === undefined ? '' : JSON.stringify(body);
    const signature = computeHmac('sha256', toUtf8Bytes(this.secret), toUtf8Bytes(this.key + nonce + timestamp + query + text)).slice(2);
    return requestJson(`${this.base}${path}${query ? `?${query}` : ''}`, { method, body, agent: this.agent, timeoutMs: this.timeoutMs, headers: { 'X-Api-Key': this.key, 'X-Api-Nonce': nonce, 'X-Api-Timestamp': timestamp, 'X-Api-Signature': signature, 'Content-Type': 'application/json', ...extra } });
  }

  /** The signature only lives for 5 seconds, which Tor can use up. A request refused for that was never processed, so it's safe to sign again. */
  private async call(method: 'GET' | 'POST', path: string, query = '', body?: unknown, extra: Record<string, string> = {}) {
    let res = await this.once(method, path, query, body, extra);
    for (let i = 0; i < 2 && res.body?.code === 400003; i++) res = await this.once(method, path, query, body, extra);
    if (res.body?.code === 400003) throw new Error('CCECash refused the request\'s time. Check that this device\'s clock is correct, or try again.');
    return res;
  }

  private problem(res: { status: number; body: any }, fallback: string): string | null {
    if (res.status === 403 && res.body?.code === 700100) return 'CCECash refused this connection\'s IP address. With Tor on, try again shortly.';
    if (res.status === 403 || (res.status === 400 && Number(res.body?.code) >= 400000)) return 'Check the CCECash API key.';
    if (res.status >= 400 || res.body?.code !== 0) return typeof res.body?.msg === 'string' && res.body.msg ? res.body.msg : fallback;
    return null;
  }

  async quote(from: Asset, to: Asset, amount: string): Promise<SwapQuote> {
    const base = { from, to, amount, provider: 'CCECash', providerId: 'ccecash' as const, approximate: true };
    const none = (problem: string, min: string | null = null, max: string | null = null) => ({ ...base, receive: '0', rate: '0', min, max, problem });
    const a = CCE_COIN[from];
    const b = CCE_COIN[to];
    if (!a || !b) return none('CCECash doesn\'t offer this coin.');
    const res = await this.call('POST', '/openapi/order/calculate', '', {
      exchange_mode: 'float', from_abbr: a.abbr, from_chain: a.chain, from_quantity: Number(amount), to_address: [{ to_abbr: b.abbr, to_chain: b.chain, to_ratio: 1 }],
    });
    const d = res.body?.data;
    const min = num(d?.min_from_quantity);
    const max = num(d?.max_from_quantity);
    const problem = this.problem(res, 'No quote available for this swap right now.');
    if (problem) {
      const text = /too small/i.test(problem) && min ? `The minimum amount is ${min} ${unit(from)}.` : /too large/i.test(problem) && max ? `The maximum amount is ${max} ${unit(from)}.` : problem;
      return none(text, min, max);
    }
    const receive = num(d?.to?.[0]?.to_quantity);
    if (!receive || Number(receive) <= 0) return none('No quote available for this swap right now.', min, max);
    return { ...base, receive, rate: String(Number(receive) / Number(amount)), min, max, problem: null };
  }

  private async read(queryCode: string): Promise<any> {
    const res = await this.call('GET', '/openapi/order/query', new URLSearchParams({ query_code: queryCode }).toString());
    const problem = this.problem(res, 'Could not read the swap status.');
    if (problem) throw new Error(problem);
    return res.body?.data ?? {};
  }

  async create(from: Asset, to: Asset, amount: string, expectedReceive: string, withdrawalAddress: string, _refundAddress: string): Promise<SwapOrder> {
    const a = CCE_COIN[from];
    const c = CCE_COIN[to];
    if (!a || !c) throw new Error('CCECash doesn\'t offer this coin.');
    const res = await this.call('POST', '/openapi/order/place', '', {
      exchange_mode: 'float', from_abbr: a.abbr, from_chain: a.chain, from_quantity: Number(amount), to_address: [{ to_abbr: c.abbr, to_address: withdrawalAddress, to_chain: c.chain, to_ratio: 1 }],
    }, this.refCode ? { 'Ref-Code': this.refCode } : {});
    const problem = this.problem(res, 'Could not create the swap order.');
    if (problem) throw new Error(`Swap order failed: ${problem}`);
    const placed = res.body?.data ?? {};
    if (typeof placed.order_no !== 'string' || !ORDER_ID.test(placed.order_no)) stop('no order number');
    if (typeof placed.query_code !== 'string' || !ORDER_ID.test(placed.query_code)) stop('no private order code');
    if (typeof placed.address !== 'string' || !placed.address) stop('no deposit address');
    // Placing an order only answers with the deposit address, so the order is read back and checked before any coins move.
    const b = await this.read(placed.query_code);
    const out = Array.isArray(b.children) && b.children.length === 1 ? b.children[0] : null;
    if (!out) stop('the receiving address is not yours');
    if (b.address !== placed.address) stop('the deposit address differs');
    if (String(b.abbr).toUpperCase() !== a.abbr || b.chain !== a.chain) stop('the sent coin differs');
    if (String(out.abbr).toUpperCase() !== c.abbr || out.chain !== c.chain) stop('the received coin differs');
    if (!sameAddress(out.address, withdrawalAddress)) stop('the receiving address is not yours');
    if (!closeAmount(b.odr_volume, amount)) stop('the send amount differs');
    const receive = num(out.volume_origin);
    if (!receive || Number(receive) < Number(expectedReceive) * 0.98) stop('the receive amount is less than quoted');
    return { id: placed.order_no, depositAddress: placed.address, receive: receive as string, rate: String(Number(receive) / Number(amount)), provider: 'CCECash', approximate: true, statusKey: placed.query_code };
  }

  async status(id: string, statusKey = ''): Promise<{ status: string; hashIn?: string; hashOut?: string }> {
    if (!ORDER_ID.test(id) || !ORDER_ID.test(statusKey)) throw new Error('Invalid order number.');
    const b = await this.read(statusKey);
    return { status: CCE_STATUS[Number(b.status)] ?? 'unknown', hashIn: b.input?.[0]?.txid || undefined, hashOut: b.output?.[0]?.txid || undefined };
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
