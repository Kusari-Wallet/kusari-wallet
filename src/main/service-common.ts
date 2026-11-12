// Shared pieces of the wallet service: constants, small helpers and types used by its layers.
import { Asset, POL_EXPLORER_TX, ARB_EXPLORER_TX, BSC_EXPLORER_TX, ETH_EXPLORER_TX } from './config';
import { TronTransfer } from './tron';
import { DexCall, DexQuote } from './dex';
import { ScrtDraft } from './scrt';
import { BtcDraft } from './btc';
import { ArrrDraft } from './arrr';
import { MwebDraft, PeginDraft } from './mweb';
import { SparkDraft, MintDraft } from './spark';
import { ZanoDraft } from './zano';
import { ZecDraft } from './zec';
import { FiroDraft } from './firo';
import { DogeDraft } from './doge';
import { AdaDraft } from './ada';
import { SolDraft, SolUsdtDraft, SplAsset } from './sol';
import { DashDraft } from './dash';
import { DashMixer, SplitPlan } from './dash-mix';
import type { InsightUtxo } from './insight';
import { EthAsset, EthDraft } from './eth';
import { SwapProviderId } from './swap';
import { MoneroDraft } from './monero';

export const BALANCE_TTL_MS = 40_000;
export const BALANCE_BACKOFF_MS = 30_000;
/** How long the overview waits for each balance before showing its last value instead. */
export const OVERVIEW_WAIT_MS = 4_000;
export const QUICK_REFUSAL_MS = 15_000;
export const QUOTE_DEADLINE_MS = 20_000;
export const QUOTE_DEADLINE_TOR_MS = 40_000;
export const QUOTE_EXTRAS_MS = 8_000;
// Shown without its bitcoincash: prefix, as most wallets and exchanges show it; both forms are the same address.
export const bareBch = (a: string) => a.replace(/^bitcoincash:/, '');

export const SWAP_NAMES: Record<SwapProviderId, string> = { exolix: 'Exolix', simpleswap: 'SimpleSwap', ghostswap: 'GhostSwap', etzswap: 'ETZ Swap', ccecash: 'CCECash', changenow: 'ChangeNOW' };

/** A host on the person's own network or machine, which is reached directly rather than through Tor. */
export function isLocalServer(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return false; }
  return host === 'localhost' || host === '::1' || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/**
 * A BTC server of the person's own: an Esplora or mempool API address. Plain http only where nobody in between
 * could read or change it: an .onion address, or the person's own network.
 */
export const COIN_ID = /^[0-9a-f]{64}:\d{1,6}$/;
export const btcScript = (address: string): Uint8Array => { const b = require('@scure/btc-signer'); return b.OutScript.encode(b.Address().decode(address)); };
export const btcScriptOfKey = (pub: Uint8Array): string => { const b = require('@scure/btc-signer'); return Buffer.from(b.p2tr(pub.slice(1)).script).toString('hex'); };

export function checkOwnServer(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  if (!v) return '';
  let u: URL;
  try { u = new URL(v); } catch { throw new Error('Enter the server as a full address, for example https://mempool.example/api.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Enter the server as a full address, for example https://mempool.example/api.');
  if (u.username || u.password || u.search || u.hash) throw new Error('Leave out any login, ? or # part of the address.');
  if (u.protocol === 'http:' && !u.hostname.endsWith('.onion') && !isLocalServer(v)) throw new Error('Use https://, an .onion address, or a server on your own network.');
  return v;
}

export function within<T, F>(ms: number, work: Promise<T>, late: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<F>((resolve) => { timer = setTimeout(() => resolve(late), ms); })]).finally(() => clearTimeout(timer));
}
/** Which Tor route each balance lookup uses. */
/** Coins and tokens on an EVM chain. They share one address. */
export const EVM: Asset[] = ['ETH', 'USDTE', 'LINK', 'WLD', 'POL', 'USDTP', 'ARB', 'ETHA', 'USDTA', 'ETHP', 'UNI', 'PEPE', 'AAVE', 'BNB', 'USDTB', 'USDCE', 'USDCB', 'USDCP', 'USDCA', 'SHIB'];
/** Solana tokens. */
export const SPL: Asset[] = ['USDTS', 'USDCS', 'ORCA', 'PUMP'];
export const isSpl = (a: Asset): a is SplAsset => SPL.includes(a);
export const EXTRA_ASSETS: Asset[] = ['ETHP', 'UNI', 'PEPE', 'AAVE', 'BNB', 'USDTB', 'USDCE', 'USDCB', 'USDCS', 'USDCP', 'USDCA', 'SHIB', 'ORCA', 'PUMP'];
export const isEvm = (a: Asset): a is Asset & EthAsset => EVM.includes(a);
export const EVM_EXPLORER: Record<string, string> = { '1': ETH_EXPLORER_TX, '137': POL_EXPLORER_TX, '42161': ARB_EXPLORER_TX, '56': BSC_EXPLORER_TX };

export const ASSET_LABEL: Partial<Record<Asset, string>> = { USDTE: 'USDT (Eth)', USDT: 'USDT (Tron)', USDTS: 'USDT (Sol)', USDTP: 'USDT (Pol)', USDTA: 'USDT (Arb)', ETHA: 'ETH (Arb)', ETHP: 'ETH (Pol)', USDTB: 'USDT (BNB)', USDCE: 'USDC (Eth)', USDCB: 'USDC (BNB)', USDCS: 'USDC (Sol)', USDCP: 'USDC (Pol)', USDCA: 'USDC (Arb)' };

export const LOOKUP_ROUTE: Record<string, string> = { ADA: 'ada', SHIB: 'eth', ORCA: 'sol', PUMP: 'sol', BTC: 'btc', ETH: 'eth', USDTE: 'eth', LINK: 'eth', WLD: 'eth', TRX: 'tron', USDT: 'tron', DASH: 'dash', FIRO: 'firo', SOL: 'sol', USDTS: 'sol', POL: 'pol', USDTP: 'pol', ARB: 'arb', ETHA: 'arb', USDTA: 'arb', BCH: 'bch', LTC: 'ltc', DOGE: 'doge', SCRT: 'scrt', ETHP: 'pol', UNI: 'eth', PEPE: 'eth', AAVE: 'eth', BNB: 'bsc', USDTB: 'bsc', USDCE: 'eth', USDCB: 'bsc', USDCS: 'sol', USDCP: 'pol', USDCA: 'arb', HYPE: 'hype' };

/** Waits longer each time, up to five minutes, so a server that's down isn't asked over and over. */
export function lookupRetryDelay(fails: number): number {
  return Math.min(BALANCE_BACKOFF_MS * 2 ** Math.max(fails - 1, 0), 300_000);
}
export const BALANCE_STALE_MS = 6 * 3600_000;
export const PREVIEW_TTL_MS = 10 * 60_000;

export interface Preview {
  id: string;
  asset: Asset;
  to: string;
  amount: bigint;
  fee: bigint;
  expires: number;
  tron?: TronTransfer;
  monero?: MoneroDraft;
  btc?: BtcDraft;
  btcMixed?: BtcDraft;
  ltc?: BtcDraft;
  mweb?: MwebDraft;
  pegin?: PeginDraft;
  spark?: SparkDraft;
  mint?: MintDraft;
  scrt?: ScrtDraft;
  eth?: EthDraft;
  dash?: DashDraft;
  dashMix?: { plan: SplitPlan; inputs: InsightUtxo[]; change: { address: string; index: number; value: bigint } | null; fee: bigint };
  dashPrivate?: Awaited<ReturnType<DashMixer['draftPrivate']>>;
  firo?: FiroDraft;
  doge?: DogeDraft;
  ada?: AdaDraft;
  bch?: DogeDraft;
  sol?: SolDraft;
  solUsdt?: SolUsdtDraft;
  zec?: ZecDraft;
  zano?: ZanoDraft;
  arrr?: ArrrDraft;
  dex?: { quote: DexQuote; from: Asset; to: Asset; calls: DexCall[] };
}

export interface BalanceView { ok: boolean; stale?: boolean; pending?: boolean; total: string; spendable: string; error?: string }

/** What a service keeps: the gap between market value in and out. Services build this into their rate. */
export function swapCost(amount: string, receive: string, fromUsd?: number, toUsd?: number): { usd: number; percent: number; receiveUsd: number } | null {
  if (typeof fromUsd !== 'number' || typeof toUsd !== 'number' || fromUsd <= 0 || toUsd <= 0) return null;
  const inUsd = Number(amount) * fromUsd;
  const receiveUsd = Number(receive) * toUsd;
  const usd = inUsd - receiveUsd;
  return Number.isFinite(usd) && inUsd > 0 ? { usd, percent: (usd / inUsd) * 100, receiveUsd } : null;
}


export function withTimeoutValue<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}
