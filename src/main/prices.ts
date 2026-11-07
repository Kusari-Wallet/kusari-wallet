import type { Asset } from './config';

export type PriceMap = Record<Asset, { usd: number; change: number | null }>;
type Row = { usd: number; change: number | null };

export interface PriceSource { name: string; url: string; parse: (json: any) => PriceMap }

function row(usd: unknown, change: unknown): Row {
  const n = typeof usd === 'string' ? Number(usd) : usd;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw new Error('bad price');
  return { usd: n, change: typeof change === 'number' && Number.isFinite(change) ? change : null };
}

function optional(read: () => Row): Row | undefined { try { return read(); } catch { return undefined; } }

function all(btc: Row, eth: Row, trx: Row, usdt: Row, xmr: Row, dash?: Row, zec?: Row, zano?: Row, arrr?: Row, firo?: Row, sol?: Row, doge?: Row): PriceMap {
  // Stablecoin far from a dollar means the answer can't be trusted, or the market has bigger news than this screen.
  if (usdt.usd < 0.5 || usdt.usd > 1.5) throw new Error('bad price');
  // A smaller coin missing from one source shouldn't cost every other coin its price.
  return { BTC: btc, ETH: eth, TRX: trx, USDT: usdt, USDTE: usdt, USDTS: usdt, XMR: xmr, ...(sol ? { SOL: sol } : {}), ...(doge ? { DOGE: doge } : {}), ...(dash ? { DASH: dash } : {}), ...(zec ? { ZEC: zec } : {}), ...(zano ? { ZANO: zano } : {}), ...(arrr ? { ARRR: arrr } : {}), ...(firo ? { FIRO: firo } : {}) } as PriceMap;
}

export const coingecko = (url: string): PriceSource => ({
  name: 'CoinGecko', url,
  parse: (j) => {
    const r = (id: string) => row(j[id]?.usd, j[id]?.usd_24h_change);
    return all(r('bitcoin'), r('ethereum'), r('tron'), r('tether'), r('monero'), optional(() => r('dash')), optional(() => r('zcash')), optional(() => r('zano')), optional(() => r('pirate-chain')), optional(() => r('zcoin')), optional(() => r('solana')), optional(() => r('dogecoin')));
  },
});

export const kraken = (url: string): PriceSource => ({
  name: 'Kraken', url,
  parse: (j) => {
    if (j?.error?.length) throw new Error('bad price');
    const r = (...names: string[]) => {
      const t = names.map((n) => j?.result?.[n]).find(Boolean);
      const last = Number(t?.c?.[0]);
      const open = Number(t?.o);
      return row(last, open > 0 ? ((last - open) / open) * 100 : null);
    };
    return all(r('XXBTZUSD', 'XBTUSD'), r('XETHZUSD', 'ETHUSD'), r('TRXUSD'), r('USDTZUSD', 'USDTUSD'), r('XXMRZUSD', 'XMRUSD'));
  },
});

export const cryptocompare = (url: string): PriceSource => ({
  name: 'CryptoCompare', url,
  parse: (j) => {
    const r = (s: string) => row(j?.RAW?.[s]?.USD?.PRICE, j?.RAW?.[s]?.USD?.CHANGEPCT24HOUR);
    return all(r('BTC'), r('ETH'), r('TRX'), r('USDT'), r('XMR'), optional(() => r('DASH')), optional(() => r('ZEC')), optional(() => r('ZANO')), optional(() => r('ARRR')), optional(() => r('FIRO')), optional(() => r('SOL')), optional(() => r('DOGE')));
  },
});

const EXCHANGE_COINS: Asset[] = ['BTC', 'ETH', 'TRX', 'XMR', 'SOL', 'DOGE', 'DASH', 'ZEC', 'FIRO', 'ZANO', 'ARRR'];

/**
 * An exchange lists only some of the coins, which is fine: it fills in what the others left out. Its prices are in
 * USDT, so it says nothing about USDT itself.
 */
function exchange(name: string, url: string, read: (json: any, coin: Asset) => { last: unknown; change?: unknown } | undefined): PriceSource {
  return {
    name, url,
    parse: (j) => {
      const prices: Partial<PriceMap> = {};
      for (const coin of EXCHANGE_COINS) {
        const got = optional(() => { const t = read(j, coin); return row(t?.last, t?.change); });
        if (got) prices[coin] = got;
      }
      if (!Object.keys(prices).length) throw new Error('bad price');
      return prices as PriceMap;
    },
  };
}

const percent = (v: unknown, scale = 1) => { const n = Number(v) * scale; return Number.isFinite(n) ? n : null; };
const listed = (rows: unknown, field: string, symbol: string): any => (Array.isArray(rows) ? rows.find((r) => r?.[field] === symbol) : undefined);

export const mexc = (url: string) => exchange('MEXC', url, (j, coin) => {
  const t = listed(j, 'symbol', `${coin}USDT`);
  return t && { last: t.lastPrice, change: Number(t.openPrice) > 0 ? ((Number(t.lastPrice) - Number(t.openPrice)) / Number(t.openPrice)) * 100 : null };
});

export const gate = (url: string) => exchange('Gate', url, (j, coin) => {
  const t = listed(j, 'currency_pair', `${coin}_USDT`);
  return t && { last: t.last, change: percent(t.change_percentage) };
});

export const binance = (url: string) => exchange('Binance', url, (j, coin) => {
  const t = listed(j, 'symbol', `${coin}USDT`);
  return t && { last: t.lastPrice, change: percent(t.priceChangePercent) };
});

export const okx = (url: string) => exchange('OKX', url, (j, coin) => {
  const t = listed(j?.data, 'instId', `${coin}-USDT`);
  return t && { last: t.last, change: Number(t.open24h) > 0 ? ((Number(t.last) - Number(t.open24h)) / Number(t.open24h)) * 100 : null };
});

export const bybit = (url: string) => exchange('Bybit', url, (j, coin) => {
  const t = listed(j?.result?.list, 'symbol', `${coin}USDT`);
  return t && { last: t.lastPrice, change: percent(t.price24hPcnt, 100) };
});

/** Rates here are how much of a coin one dollar buys, and there is no 24-hour change. */
export const coinbase = (url: string) => exchange('Coinbase', url, (j, coin) => {
  const rate = Number(j?.data?.rates?.[coin]);
  return rate > 0 ? { last: 1 / rate } : undefined;
});

export const PRICE_SOURCES: PriceSource[] = [
  coingecko('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,tron,tether,monero,dash,zcash,zano,pirate-chain,zcoin,solana,dogecoin&vs_currencies=usd&include_24hr_change=true'),
  kraken('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,TRXUSD,USDTUSD,XMRUSD'),
  cryptocompare('https://min-api.cryptocompare.com/data/pricemultifull?fsyms=BTC,ETH,TRX,USDT,XMR,DASH,ZEC,ZANO,ARRR,FIRO,SOL,DOGE&tsyms=USD'),
  mexc('https://api.mexc.com/api/v3/ticker/24hr'),
  gate('https://api.gateio.ws/api/v4/spot/tickers'),
  binance('https://data-api.binance.vision/api/v3/ticker/24hr'),
  okx('https://www.okx.com/api/v5/market/tickers?instType=SPOT'),
  bybit('https://api.bybit.com/v5/market/tickers?category=spot'),
  coinbase('https://api.coinbase.com/v2/exchange-rates?currency=USD'),
];
