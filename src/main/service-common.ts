// Shared pieces of the wallet service: constants, small helpers and types used by its layers.
import { Asset, POL_EXPLORER_TX, ARB_EXPLORER_TX, BSC_EXPLORER_TX, ETH_EXPLORER_TX } from './config';
import type { PayjoinTarget } from './payjoin';
import { TronTransfer } from './tron';
import { DexCall, DexQuote } from './dex';
import { BtcDraft } from './btc';
import { ArrrDraft } from './arrr';
import { MwebDraft, PeginDraft } from './mweb';
import { SparkDraft, MintDraft } from './spark';
import { ZanoDraft } from './zano';
import { ZecDraft } from './zec';
import { FiroDraft } from './firo';
import { DogeDraft } from './doge';
import { DcrDraft } from './dcr';
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
/** A balance lookup out longer than this (several Tor timeouts) is left behind and asked again. */
export const STUCK_LOOKUP_MS = 5 * 60_000;
export const QUICK_REFUSAL_MS = 15_000;
export const QUOTE_DEADLINE_MS = 20_000;
export const QUOTE_DEADLINE_TOR_MS = 40_000;
export const QUOTE_EXTRAS_MS = 8_000;
// Shown without its bitcoincash: prefix, as most wallets and exchanges show it; both forms are the same address.
export const bareBch = (a: string) => a.replace(/^bitcoincash:/, '');

export const SWAP_NAMES: Record<SwapProviderId, string> = { exolix: 'Exolix', simpleswap: 'SimpleSwap', ghostswap: 'GhostSwap', etzswap: 'ETZ Swap', ccecash: 'CCECash', changenow: 'ChangeNOW', pegasus: 'PegasusSwap' };

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
export const EVM: Asset[] = ['ETH', 'USDTE', 'LINK', 'POL', 'USDTP', 'ARB', 'ETHA', 'USDTA', 'ETHP', 'PEPE', 'BNB', 'USDTB', 'USDCE', 'USDCB', 'USDCP', 'USDCA', 'SHIB'];
/** Solana tokens. */
export const SPL: Asset[] = ['USDTS', 'USDCS', 'ORCA', 'PUMP'];
export const isSpl = (a: Asset): a is SplAsset => SPL.includes(a);
export const EXTRA_ASSETS: Asset[] = ['ETHP', 'PEPE', 'BNB', 'USDTB', 'USDCE', 'USDCB', 'USDCS', 'USDCP', 'USDCA', 'SHIB', 'ORCA', 'PUMP'];
export const isEvm = (a: Asset): a is Asset & EthAsset => EVM.includes(a);
export const EVM_EXPLORER: Record<string, string> = { '1': ETH_EXPLORER_TX, '137': POL_EXPLORER_TX, '42161': ARB_EXPLORER_TX, '56': BSC_EXPLORER_TX };

export const ASSET_LABEL: Partial<Record<Asset, string>> = { USDTE: 'USDT (Eth)', USDT: 'USDT (Tron)', USDTS: 'USDT (Sol)', USDTP: 'USDT (Pol)', USDTA: 'USDT (Arb)', ETHA: 'ETH (Arb)', ETHP: 'ETH (Pol)', USDTB: 'USDT (BNB)', USDCE: 'USDC (Eth)', USDCB: 'USDC (BNB)', USDCS: 'USDC (Sol)', USDCP: 'USDC (Pol)', USDCA: 'USDC (Arb)' };

export const LOOKUP_ROUTE: Record<string, string> = { DCR: 'dcr', SHIB: 'eth', ORCA: 'sol', PUMP: 'sol', BTC: 'btc', ETH: 'eth', USDTE: 'eth', LINK: 'eth', TRX: 'tron', USDT: 'tron', DASH: 'dash', FIRO: 'firo', SOL: 'sol', USDTS: 'sol', POL: 'pol', USDTP: 'pol', ARB: 'arb', ETHA: 'arb', USDTA: 'arb', BCH: 'bch', LTC: 'ltc', DOGE: 'doge', ETHP: 'pol', PEPE: 'eth', BNB: 'bsc', USDTB: 'bsc', USDCE: 'eth', USDCB: 'bsc', USDCS: 'sol', USDCP: 'pol', USDCA: 'arb', HYPE: 'hype', GRAM: 'ton', USDTT: 'ton' };

/** Waits longer each time, up to five minutes, so a server that's down isn't asked over and over. */
export function lookupRetryDelay(fails: number): number {
  return Math.min(BALANCE_BACKOFF_MS * 2 ** Math.max(fails - 1, 0), 300_000);
}
export const BALANCE_STALE_MS = 6 * 3600_000;
export const PREVIEW_TTL_MS = 10 * 60_000;

/**
 * Coins on account-based chains with their own client (TON): one balance, one address,
 * a draft to review and a send. `memo`: what their sends can carry for an exchange's deposit (
 * TON's comment).
 */
export interface AccountCoin {
  receiveAddress: string;
  getBalance(): Promise<{ total: bigint; spendable: bigint }>;
  draft(to: string, amount: bigint | 'max', memo?: string): Promise<{ to: string; amount: bigint; fee: bigint }>;
  send(draft: any, mnemonic: string): Promise<string>;
  getHistory(): Promise<any[]>;
}
export const ACCOUNT_COINS: Partial<Record<Asset, { feeAsset: Asset; explorerTx: string; typicalFee: bigint; memo?: 'comment'; label: string }>> = {
  GRAM: { feeAsset: 'GRAM', explorerTx: 'https://tonviewer.com/transaction/', typicalFee: 10_000_000n, memo: 'comment', label: 'TON' },
  USDTT: { feeAsset: 'GRAM', explorerTx: 'https://tonviewer.com/transaction/', typicalFee: 60_000_000n, memo: 'comment', label: 'TON' },
};
export const isAccountCoin = (a: string): boolean => Object.prototype.hasOwnProperty.call(ACCOUNT_COINS, a);

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
  /** A Bitcoin send to a Payjoin link: the recipient may add a coin of theirs. */
  payjoin?: PayjoinTarget;
  btcMixed?: BtcDraft;
  ltc?: BtcDraft;
  mweb?: MwebDraft;
  pegin?: PeginDraft;
  spark?: SparkDraft;
  mint?: MintDraft;
  eth?: EthDraft;
  /** An Ethereum send from one of the extra addresses (its number), not the main one. */
  ethFrom?: number;
  /** Tornado deposits for an amount made of the pools' fixed amounts. */
  tornadoSplit?: { pools: string[]; spread: boolean };
  dash?: DashDraft;
  dashMix?: { plan: SplitPlan; inputs: InsightUtxo[]; change: { address: string; index: number; value: bigint } | null; fee: bigint };
  dashPrivate?: Awaited<ReturnType<DashMixer['draftPrivate']>>;
  firo?: FiroDraft;
  doge?: DogeDraft;
  dcr?: DcrDraft;
  /** A DCR send from the mixed account. */
  dcrMixed?: DcrDraft;
  bch?: DogeDraft;
  sol?: SolDraft;
  solUsdt?: SolUsdtDraft;
  zec?: ZecDraft;
  zano?: ZanoDraft;
  ksr?: ZanoDraft;
  arrr?: ArrrDraft;
  /** A send on one of ACCOUNT_COINS. */
  account?: { asset: Asset; draft: any };
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
