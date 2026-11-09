import type { Agent } from 'node:http';
import { requestJson } from './request';

/**
 * Kusari's own index for a perp market: the weighted median of spot mid prices on big exchanges, read directly
 * from each exchange. Hyperliquid's index (its oracle) decides marks, funding and liquidations; this one is for
 * comparison only. The weights follow Hyperliquid's own (Binance 3, OKX 2, Bybit 2, the rest 1).
 */

export interface IndexQuote { name: string; price: number; weight: number }
export interface KusariIndex { price: number; quotes: IndexQuote[]; failed: string[]; at: number }

interface Source { name: string; weight: number; url: (base: string) => string; read: (j: any) => [unknown, unknown] | undefined }

const SOURCES: Source[] = [
  { name: 'Binance', weight: 3, url: (b) => `https://data-api.binance.vision/api/v3/ticker/bookTicker?symbol=${b}USDT`, read: (j) => [j?.bidPrice, j?.askPrice] },
  { name: 'OKX', weight: 2, url: (b) => `https://www.okx.com/api/v5/market/ticker?instId=${b}-USDT`, read: (j) => j?.data?.[0] && [j.data[0].bidPx, j.data[0].askPx] },
  { name: 'Bybit', weight: 2, url: (b) => `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${b}USDT`, read: (j) => j?.result?.list?.[0] && [j.result.list[0].bid1Price, j.result.list[0].ask1Price] },
  { name: 'Kraken', weight: 1, url: (b) => `https://api.kraken.com/0/public/Ticker?pair=${b === 'BTC' ? 'XBT' : b}USD`, read: (j) => { const t: any = Object.values(j?.result ?? {})[0]; return t && [t.b?.[0], t.a?.[0]]; } },
  { name: 'KuCoin', weight: 1, url: (b) => `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${b}-USDT`, read: (j) => j?.data && [j.data.bestBid, j.data.bestAsk] },
  { name: 'Gate', weight: 1, url: (b) => `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${b}_USDT`, read: (j) => Array.isArray(j) && j[0] && [j[0].highest_bid, j[0].lowest_ask] },
  { name: 'MEXC', weight: 1, url: (b) => `https://api.mexc.com/api/v3/ticker/bookTicker?symbol=${b}USDT`, read: (j) => [j?.bidPrice, j?.askPrice] },
];

/** Hyperliquid lists some small-priced coins per thousand: kPEPE is 1000 PEPE. */
export function spotOf(symbol: string): { base: string; scale: number } | null {
  const k = /^k([A-Z0-9]{2,})$/.exec(symbol);
  if (k) return { base: k[1], scale: 1000 };
  return /^[A-Z0-9]{2,12}$/.test(symbol) ? { base: symbol, scale: 1 } : null;
}

/** The weighted median: the price at which half of the total weight lies on each side. */
export function weightedMedian(quotes: { price: number; weight: number }[]): number {
  const q = [...quotes].sort((a, b) => a.price - b.price);
  const total = q.reduce((s, x) => s + x.weight, 0);
  if (!total) return 0;
  let acc = 0;
  for (let i = 0; i < q.length; i++) {
    acc += q[i].weight;
    if (acc * 2 > total) return q[i].price;
    if (acc * 2 === total) return (q[i].price + q[i + 1].price) / 2;
  }
  return q[q.length - 1].price;
}

export async function kusariIndex(symbol: string, opts: { agent?: Agent; timeoutMs?: number; base?: Record<string, string> } = {}): Promise<KusariIndex> {
  const spot = spotOf(symbol);
  if (!spot) return { price: 0, quotes: [], failed: SOURCES.map((s) => s.name), at: Date.now() };
  const got = await Promise.all(SOURCES.map(async (s) => {
    try {
      const url = opts.base?.[s.name] ? s.url(spot.base).replace(/^https:\/\/[^/]+/, opts.base[s.name]) : s.url(spot.base);
      const r = await requestJson(url, { method: 'GET', agent: opts.agent, timeoutMs: opts.timeoutMs ?? 8000 });
      if (r.status >= 400) return null;
      const pair = s.read(r.body);
      const bid = Number(pair?.[0]);
      const ask = Number(pair?.[1]);
      if (!(bid > 0) || !(ask > 0) || ask < bid || ask / bid > 1.05) return null; // a stale or broken book is left out
      return { name: s.name, price: ((bid + ask) / 2) * spot.scale, weight: s.weight };
    } catch { return null; }
  }));
  const quotes = got.filter((q): q is IndexQuote => q !== null);
  const failed = SOURCES.filter((s, i) => !got[i]).map((s) => s.name);
  // One exchange alone is just that exchange's price, not an index.
  return { price: quotes.length >= 2 ? weightedMedian(quotes) : 0, quotes, failed, at: Date.now() };
}
