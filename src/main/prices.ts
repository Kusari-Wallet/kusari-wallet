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

function all(btc: Row, eth: Row, trx: Row, usdt: Row, xmr: Row, dcr?: Row, dash?: Row): PriceMap {
  // Stablecoin far from a dollar means the answer can't be trusted, or the market has bigger news than this screen.
  if (usdt.usd < 0.5 || usdt.usd > 1.5) throw new Error('bad price');
  // A smaller coin missing from one source shouldn't cost every other coin its price.
  return { BTC: btc, ETH: eth, TRX: trx, USDT: usdt, USDTE: usdt, XMR: xmr, ...(dcr ? { DCR: dcr } : {}), ...(dash ? { DASH: dash } : {}) } as PriceMap;
}

export const coingecko = (url: string): PriceSource => ({
  name: 'CoinGecko', url,
  parse: (j) => {
    const r = (id: string) => row(j[id]?.usd, j[id]?.usd_24h_change);
    return all(r('bitcoin'), r('ethereum'), r('tron'), r('tether'), r('monero'), optional(() => r('decred')), optional(() => r('dash')));
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
    return all(r('BTC'), r('ETH'), r('TRX'), r('USDT'), r('XMR'), optional(() => r('DCR')), optional(() => r('DASH')));
  },
});

export const PRICE_SOURCES: PriceSource[] = [
  coingecko('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,tron,tether,monero,decred,dash&vs_currencies=usd&include_24hr_change=true'),
  kraken('https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD,TRXUSD,USDTUSD,XMRUSD'),
  cryptocompare('https://min-api.cryptocompare.com/data/pricemultifull?fsyms=BTC,ETH,TRX,USDT,XMR,DCR,DASH&tsyms=USD'),
];
