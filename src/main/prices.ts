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

/** The same coin under another name: sSCRT is SCRT, and ETH on Arbitrum or Polygon is ETH. */
export function mirror(p: Partial<Record<Asset, Row | undefined>>): void {
  if (p.SCRT) p.SSCRT = p.SCRT;
  if (p.ETH) p.ETHP = p.ETH;
  if (p.ETH) p.ETHA = p.ETH;
  // USDC is one coin on every chain.
  if (p.USDCE) for (const a of ['USDCB', 'USDCS', 'USDCP', 'USDCA'] as const) p[a] = p.USDCE;
  // The same tokens on other chains, pegged one to one.
}

function all(btc: Row, eth: Row, trx: Row, usdt: Row, xmr: Row, dash?: Row, zec?: Row, zano?: Row, arrr?: Row, firo?: Row, sol?: Row, doge?: Row, more: Partial<Record<Asset, Row | undefined>> = {}): PriceMap {
  // Stablecoin far from a dollar means the answer can't be trusted, or the market has bigger news than this screen.
  if (usdt.usd < 0.5 || usdt.usd > 1.5) throw new Error('bad price');
  // A smaller coin missing from one source shouldn't cost every other coin its price.
  const extra = Object.fromEntries(Object.entries(more).filter(([, v]) => v));
  // ETH on Arbitrum is the same coin as on Ethereum, and every USDT is a dollar token.
  mirror(extra);
  return { ...extra, BTC: btc, ETH: eth, ETHA: eth, ETHP: eth, TRX: trx, USDT: usdt, USDTE: usdt, USDTS: usdt, USDTP: usdt, USDTA: usdt, USDTB: usdt, XMR: xmr, ...(sol ? { SOL: sol } : {}), ...(doge ? { DOGE: doge } : {}), ...(dash ? { DASH: dash } : {}), ...(zec ? { ZEC: zec } : {}), ...(zano ? { ZANO: zano } : {}), ...(arrr ? { ARRR: arrr } : {}), ...(firo ? { FIRO: firo } : {}) } as PriceMap;
}

export const coingecko = (url: string): PriceSource => ({
  name: 'CoinGecko', url,
  parse: (j) => {
    const r = (id: string) => row(j[id]?.usd, j[id]?.usd_24h_change);
    return all(r('bitcoin'), r('ethereum'), r('tron'), r('tether'), r('monero'), optional(() => r('dash')), optional(() => r('zcash')), optional(() => r('zano')), optional(() => r('pirate-chain')), optional(() => r('zcoin')), optional(() => r('solana')), optional(() => r('dogecoin')), { LINK: optional(() => r('chainlink')), WLD: optional(() => r('worldcoin-wld')), POL: optional(() => r('polygon-ecosystem-token')), ARB: optional(() => r('arbitrum')), BCH: optional(() => r('bitcoin-cash')), LTC: optional(() => r('litecoin')), SCRT: optional(() => r('secret')), UNI: optional(() => r('uniswap')), PEPE: optional(() => r('pepe')), AAVE: optional(() => r('aave')), BNB: optional(() => r('binancecoin')), USDCE: optional(() => r('usd-coin')), SHIB: optional(() => r('shiba-inu')), ADA: optional(() => r('cardano')), ORCA: optional(() => r('orca')), PUMP: optional(() => r('pump-fun')) });
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
    return all(r('BTC'), r('ETH'), r('TRX'), r('USDT'), r('XMR'), optional(() => r('DASH')), optional(() => r('ZEC')), optional(() => r('ZANO')), optional(() => r('ARRR')), optional(() => r('FIRO')), optional(() => r('SOL')), optional(() => r('DOGE')), { LINK: optional(() => r('LINK')), WLD: optional(() => r('WLD')), POL: optional(() => r('POL')), ARB: optional(() => r('ARB')), BCH: optional(() => r('BCH')), LTC: optional(() => r('LTC')), SCRT: optional(() => r('SCRT')), UNI: optional(() => r('UNI')), PEPE: optional(() => r('PEPE')), AAVE: optional(() => r('AAVE')), BNB: optional(() => r('BNB')), SHIB: optional(() => r('SHIB')), ADA: optional(() => r('ADA')), ORCA: optional(() => r('ORCA')) });
  },
});

const EXCHANGE_COINS: Asset[] = ['BTC', 'ETH', 'TRX', 'XMR', 'SOL', 'LINK', 'WLD', 'POL', 'ARB', 'BCH', 'LTC', 'DOGE', 'DASH', 'ZEC', 'FIRO', 'ZANO', 'ARRR', 'SCRT', 'UNI', 'PEPE', 'AAVE', 'BNB', 'USDCE', 'SHIB', 'ORCA', 'PUMP', 'ADA'];
// Where the wallet's name for a coin isn't the market's.
const MARKET_SYMBOL: Partial<Record<Asset, string>> = { USDCE: 'USDC' };

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
        const got = optional(() => { const t = read(j, (MARKET_SYMBOL[coin] ?? coin) as Asset); return row(t?.last, t?.change); });
        if (got) prices[coin] = got;
      }
      if (!Object.keys(prices).length) throw new Error('bad price');
      if (prices.ETH) { prices.ETHA = prices.ETH; prices.ETHP = prices.ETH; }
      mirror(prices);
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

/** Kraken's USD pairs for every coin it lists. An unknown pair fails the whole request, so only listed ones. */
const KRAKEN_PAIRS: [Asset, string][] = [
  ['BTC', 'XXBTZUSD'], ['ETH', 'XETHZUSD'], ['TRX', 'TRXUSD'], ['XMR', 'XXMRZUSD'], ['SOL', 'SOLUSD'], ['DOGE', 'XDGUSD'],
  ['LTC', 'XLTCZUSD'], ['BCH', 'BCHUSD'], ['LINK', 'LINKUSD'], ['DASH', 'DASHUSD'], ['ZEC', 'XZECZUSD'], ['ADA', 'ADAUSD'],
  ['POL', 'POLUSD'], ['ARB', 'ARBUSD'], ['UNI', 'UNIUSD'], ['AAVE', 'AAVEUSD'], ['PEPE', 'PEPEUSD'], ['SHIB', 'SHIBUSD'],
  ['WLD', 'WLDUSD'], ['SCRT', 'SCRTUSD'], ['USDCE', 'USDCUSD'], 
  ['BNB', 'BNBUSD'], ['ORCA', 'ORCAUSD'], ['PUMP', 'PUMPUSD'], ['USDT', 'USDTZUSD'],
];

/** Every coin Kraken lists, in one small answer (a few KB). */
export const krakenAll = (url: string): PriceSource => ({
  name: 'Kraken', url,
  parse: (j) => {
    if (j?.error?.length) throw new Error('bad price');
    const prices: Partial<PriceMap> = {};
    for (const [asset, pair] of KRAKEN_PAIRS) {
      const got = optional(() => {
        const t = j?.result?.[pair];
        const last = Number(t?.c?.[0]);
        const open = Number(t?.o);
        return row(last, open > 0 ? ((last - open) / open) * 100 : null);
      });
      if (got) prices[asset] = got;
    }
    if (!Object.keys(prices).length) throw new Error('bad price');
    if (prices.USDT) for (const a of ['USDTE', 'USDTS', 'USDTP', 'USDTA', 'USDTB'] as Asset[]) prices[a] = prices.USDT;
    if (prices.ETH) { prices.ETHA = prices.ETH; prices.ETHP = prices.ETH; }
    mirror(prices);
    return prices as PriceMap;
  },
});

/** One coin from MEXC: the small per-pair answer, for coins few others list (FIRO, ZANO, ARRR). */
export const mexcOne = (coin: Asset, url: string): PriceSource => ({
  name: 'MEXC', url,
  parse: (j) => {
    const last = Number(j?.lastPrice);
    // MEXC gives the change as a fraction.
    const change = Number(j?.priceChangePercent);
    return { [coin]: row(last, Number.isFinite(change) ? change * 100 : null) } as PriceMap;
  },
});

/**
 * Asked in tiers, each only for what the earlier ones left out. All are small (a few KB), so a slow Tor route still
 * gets an answer; the large all-market lists that used to time out over Tor are gone, except OKX as a last resort.
 */
export const PRICE_TIERS: PriceSource[][] = [
  [coingecko('https://api.coingecko.com/api/v3/simple/price?ids=usd-coin,bitcoin,ethereum,tron,tether,monero,dash,zcash,zano,pirate-chain,zcoin,solana,dogecoin,polygon-ecosystem-token,arbitrum,bitcoin-cash,chainlink,worldcoin-wld,litecoin,secret,uniswap,pepe,aave,binancecoin,shiba-inu,orca,pump-fun,cardano&vs_currencies=usd&include_24hr_change=true')],
  [
    krakenAll(`https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIRS.map(([, p]) => p).join(',')}`),
    ...(['FIRO', 'ZANO', 'ARRR'] as Asset[]).map((c) => mexcOne(c, `https://api.mexc.com/api/v3/ticker/24hr?symbol=${c}USDT`)),
    coinbase('https://api.coinbase.com/v2/exchange-rates?currency=USD'),
  ],
  [okx('https://www.okx.com/api/v5/market/tickers?instType=SPOT')],
];
/** Kept for anything that lists the sources flat. */
export const PRICE_SOURCES: PriceSource[] = PRICE_TIERS.flat();
