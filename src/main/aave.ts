import { AbiCoder, id } from 'ethers';
import type { Asset } from './config';

/**
 * Aave's price oracles: on-chain USD prices from Chainlink feeds, read with a plain eth_call through the wallet's own
 * node connection. No API, no key, and under Tor it goes the same way as balances. Addresses are from Aave's address
 * book (bgd-labs/aave-address-book). They carry no 24-hour change, so they only fill what the price services left out.
 */
export interface AaveMarket { chain: 'eth' | 'bsc' | 'arb' | 'pol'; oracle: string; assets: [Asset, string][] }
export const AAVE_MARKETS: AaveMarket[] = [
  { chain: 'eth', oracle: '0x54586bE62E3c3580375aE3723C145253060Ca0C2', assets: [
    ['ETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'], // WETH
    ['BTC', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'], // WBTC, priced from BTC's feed
    ['USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7'],
    ['LINK', '0x514910771AF9Ca656af840dff83E8264EcF986CA'],
  ] },
  { chain: 'bsc', oracle: '0x39bc1bfDa2130d6Bb6DBEfd366939b4c7aa7C697', assets: [['BNB', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c']] }, // WBNB
  { chain: 'arb', oracle: '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7', assets: [['ARB', '0x912CE59144191C1204E64559FE8253a0e49E6548']] },
  { chain: 'pol', oracle: '0xb023e699F5a33916Ea823A16485e259257cA8Bd1', assets: [['POL', '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270']] }, // WPOL
];
const SELECTOR = id('getAssetsPrices(address[])').slice(0, 10);
const coder = AbiCoder.defaultAbiCoder();

export function aaveCall(market: AaveMarket): string {
  return SELECTOR + coder.encode(['address[]'], [market.assets.map(([, a]) => a)]).slice(2);
}

/** Prices have 8 decimals. A zero, a wrong-length answer or a dollar token far from a dollar throws the whole answer out. */
export function readAave(market: AaveMarket, hex: string): Partial<Record<Asset, { usd: number; change: null }>> {
  const [values] = coder.decode(['uint256[]'], hex) as unknown as [bigint[]];
  if (values.length !== market.assets.length) throw new Error('bad price');
  const out: Partial<Record<Asset, { usd: number; change: null }>> = {};
  market.assets.forEach(([asset], i) => {
    const usd = Number(values[i]) / 1e8;
    if (!(usd > 0) || !Number.isFinite(usd)) throw new Error('bad price');
    out[asset] = { usd, change: null };
  });
  if (out.USDT && (out.USDT.usd < 0.5 || out.USDT.usd > 1.5)) throw new Error('bad price');
  return out;
}
