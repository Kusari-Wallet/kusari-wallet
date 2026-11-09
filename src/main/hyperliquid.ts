import type { Agent } from 'node:http';
import { encode } from '@msgpack/msgpack';
import { BaseWallet, Interface, Signature, Wallet, concat, getBytes, keccak256, toUtf8Bytes } from 'ethers';
import { requestForm } from './request';

/**
 * Hyperliquid perpetual futures, traded from inside the wallet.
 *
 * Two keys are involved. The wallet's own EVM key signs what touches money: approving the trading key, the Kusari
 * builder fee cap, deposits and withdrawals. A separate trading key ("agent"), derived from the seed, places and
 * cancels orders. Hyperliquid lets an agent trade but never withdraw or transfer, so it can stay in memory while
 * the wallet is unlocked.
 */

export const HL_API = 'https://api.hyperliquid.xyz';

/** Kusari's builder address and fees. Maker = post-only orders; every other order pays the taker rate. */
export const KUSARI_BUILDER = '0xDb0f1c2d5f3713051d1d5AB70D7359E6Daa6f87E';
/** Builder fees are set in tenths of a basis point: 10 = 0.01%, 35 = 0.035%. */
export const KUSARI_FEE = { maker: 10, taker: 35, max: 35 } as const;
export const AGENT_NAME = 'Kusari';

/** Deposits: native USDC on Arbitrum sent to Hyperliquid's bridge. Less than 5 USDC is never credited. */
export const HL_BRIDGE = '0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7';
export const HL_MIN_DEPOSIT = 5;
/** Hyperliquid's fee for a withdrawal to Arbitrum, in USDC. */
export const HL_WITHDRAW_FEE = 1;

const ZERO = '0x0000000000000000000000000000000000000000';
/** User-signed actions name the chain the wallet signs on; any chain works, this is Arbitrum's. */
const SIGNATURE_CHAIN = '0xa4b1';

export const feePct = (tenthsBp: number) => tenthsBp / 100_000;
export const feeText = (tenthsBp: number) => `${tenthsBp / 1000}%`;

/** The trading key for a wallet: the same seed always gives the same one, and it is no key the seed uses elsewhere. */
export function hlAgent(mainPrivateKey: string): Wallet {
  return new Wallet(keccak256(concat([getBytes(mainPrivateKey), toUtf8Bytes('kusari/hyperliquid-agent/1')])));
}

export interface HlSignature { r: string; s: string; v: number }
const split = (sig: string): HlSignature => { const s = Signature.from(sig); return { r: s.r, s: s.s, v: s.v }; };

/** The hash an L1 action (order, cancel, leverage) is signed over: msgpack of the action, the nonce, no vault. */
export function actionHash(action: unknown, nonce: number): string {
  const n = new Uint8Array(8);
  new DataView(n.buffer).setBigUint64(0, BigInt(nonce));
  return keccak256(concat([encode(action), n, new Uint8Array([0])]));
}

/** Orders, cancels and leverage are signed by the trading key, through Hyperliquid's "phantom agent". */
export async function signL1(wallet: BaseWallet, action: unknown, nonce: number): Promise<HlSignature> {
  const sig = await wallet.signTypedData(
    { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO },
    { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    { source: 'a', connectionId: actionHash(action, nonce) },
  );
  return split(sig);
}

type Field = { name: string; type: string };
const USER_TYPES: Record<string, { primary: string; fields: Field[] }> = {
  approveAgent: { primary: 'HyperliquidTransaction:ApproveAgent', fields: [{ name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }] },
  approveBuilderFee: { primary: 'HyperliquidTransaction:ApproveBuilderFee', fields: [{ name: 'hyperliquidChain', type: 'string' }, { name: 'maxFeeRate', type: 'string' }, { name: 'builder', type: 'address' }, { name: 'nonce', type: 'uint64' }] },
  withdraw3: { primary: 'HyperliquidTransaction:Withdraw', fields: [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }] },
};

/** Actions that move money or grant rights are signed by the wallet's own key, as readable typed data. */
export async function signUser(wallet: BaseWallet, action: Record<string, any>): Promise<HlSignature> {
  const t = USER_TYPES[action.type];
  if (!t) throw new Error(`Unknown Hyperliquid action ${action.type}`);
  const sig = await wallet.signTypedData(
    { name: 'HyperliquidSignTransaction', version: '1', chainId: Number(action.signatureChainId), verifyingContract: ZERO },
    { [t.primary]: t.fields },
    action,
  );
  return split(sig);
}

// ---- prices and sizes ----

function trimZeros(s: string): string { return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s; }

/** Hyperliquid takes at most 5 significant figures and 6 - szDecimals decimals for a perp price; whole numbers always. */
export function hlPrice(px: number, szDecimals: number, mode: 'round' | 'down' | 'up' = 'round'): string {
  if (!(px > 0)) throw new Error('Not a price.');
  const maxDec = Math.max(0, 6 - szDecimals);
  const mag = Math.floor(Math.log10(px));
  const dec = Math.min(maxDec, Math.max(0, 4 - mag));
  const f = 10 ** dec;
  const fn = mode === 'down' ? Math.floor : mode === 'up' ? Math.ceil : Math.round;
  let v = fn(px * f) / f;
  // Five significant figures, unless the price is a whole number.
  if (mag >= 5) v = fn(px);
  return trimZeros(v.toFixed(dec));
}

/** A size rounded down to the market's size decimals. */
export function hlSize(sz: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  return trimZeros((Math.floor(sz * f + 1e-9) / f).toFixed(szDecimals));
}

// ---- market data ----

export interface HlMarket {
  symbol: string; base: string; quote: string; asset: number; szDecimals: number; maxLeverage: number; onlyIsolated: boolean;
  price: number; mark: number; mid: number; oracle: number; change: number; volume: number; funding: number; openInterest: number;
}
export interface HlLevel { px: number; sz: number }
export interface HlCandle { t: number; o: number; h: number; l: number; c: number; v: number }
export interface HlPosition {
  symbol: string; side: 'long' | 'short'; size: string; entry: number; mark: number; pnl: number; liquidation: number; leverage: number; margin: number; isolated: boolean; notional: number;
}
export interface HlOrder { orderId: number; symbol: string; side: 'BUY' | 'SELL'; type: string; price: string; qty: string; filled: string; reduceOnly: boolean; postOnly: boolean; time: number }
export interface HlAccount { wallet: number; available: number; pnl: number; margin: number; positions: HlPosition[]; orders: HlOrder[] }

export interface OrderInput { asset: number; buy: boolean; price: string; size: string; tif: 'Gtc' | 'Ioc' | 'Alo'; reduceOnly?: boolean }

/**
 * Estimated liquidation price of an isolated position: margin above maintenance, spread over the size.
 * Maintenance margin is half the initial margin at the market's highest leverage.
 */
export function liquidationPrice(side: 'long' | 'short', entry: number, size: number, margin: number, maxLeverage: number): number {
  if (!(size > 0) || !(entry > 0) || !(maxLeverage > 0)) return 0;
  const s = side === 'long' ? 1 : -1;
  const l = 1 / (2 * maxLeverage);
  const available = margin - size * entry * l;
  const p = entry - (s * available) / size / (1 - l * s);
  return p > 0 ? p : 0;
}

export class HlError extends Error {}

const FRIENDLY: [RegExp, string][] = [
  [/must deposit before performing actions/i, 'Your perps account opens after the first deposit. Deposit USDC first.'],
  [/builder fee has not been approved|builder.*not approved/i, 'The Kusari fee is not approved. Turn on trading again.'],
  [/insufficient margin/i, 'Not enough margin for this order.'],
  [/minimum value of \$?10/i, 'Too small. The smallest order is 10 USDC (margin × leverage).'],
  [/does not exist|user or api wallet .* does not exist/i, 'The exchange does not know the trading key. Turn on trading again.'],
  [/post only order would have immediately matched/i, 'A post-only order would have traded at once, so it was cancelled. Choose a price further from the market.'],
  [/could not immediately match/i, 'Nothing on the order book matched this market order. Try again.'],
  [/builder.*(insufficient|balance|account value)/i, 'Kusari trading is not open yet: Kusari\'s builder account is not active. Try again later.'],
];
function friendly(msg: string): string {
  for (const [re, text] of FRIENDLY) if (re.test(msg)) return text;
  return `Exchange: ${msg}`;
}

export class HlClient {
  private lastNonce = 0;
  constructor(readonly user: string, private readonly opts: { api?: string; agent?: Agent; timeoutMs?: number } = {}) {}

  private get api() { return this.opts.api ?? HL_API; }

  private async post(path: string, body: unknown): Promise<any> {
    const send = () => requestForm(`${this.api}${path}`, { method: 'POST', json: JSON.stringify(body), agent: this.opts.agent, timeoutMs: this.opts.timeoutMs ?? 20_000 });
    let r = await send();
    // Hyperliquid limits requests per address; one short wait usually clears it.
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); r = await send(); }
    if (r.status === 429) throw new HlError('The exchange is busy. Try again in a moment.');
    if (r.status >= 400) throw new HlError(friendly(typeof r.body === 'string' && r.body ? r.body.slice(0, 200) : `error ${r.status}`));
    return r.body;
  }

  info(body: Record<string, unknown>): Promise<any> { return this.post('/info', body); }

  /** Milliseconds, never the same twice. */
  nonce(): number {
    const n = Math.max(Date.now(), this.lastNonce + 1);
    this.lastNonce = n;
    return n;
  }

  private async exchange(action: Record<string, any>, signature: HlSignature, nonce: number): Promise<any> {
    const r = await this.post('/exchange', { action, nonce, signature, vaultAddress: null, expiresAfter: null });
    if (r?.status !== 'ok') throw new HlError(friendly(typeof r?.response === 'string' ? r.response : JSON.stringify(r).slice(0, 200)));
    return r.response;
  }

  async l1(action: Record<string, any>, agent: BaseWallet): Promise<any> {
    const nonce = this.nonce();
    return this.exchange(action, await signL1(agent, action, nonce), nonce);
  }

  private async userAction(action: Record<string, any>, main: BaseWallet): Promise<any> {
    if (main.address.toLowerCase() !== this.user.toLowerCase()) throw new Error('The wallet address does not match, so this was stopped.');
    const full: Record<string, any> = { ...action, signatureChainId: SIGNATURE_CHAIN, hyperliquidChain: 'Mainnet' };
    return this.exchange(full, await signUser(main, full), full.nonce ?? full.time);
  }

  /** Approves the trading key (trade only; agents can never withdraw) and the Kusari fee cap. */
  async enable(main: BaseWallet, agent: BaseWallet): Promise<void> {
    await this.userAction({ type: 'approveAgent', agentAddress: agent.address.toLowerCase(), agentName: AGENT_NAME, nonce: this.nonce() }, main);
    await this.userAction({ type: 'approveBuilderFee', maxFeeRate: feeText(KUSARI_FEE.max), builder: KUSARI_BUILDER.toLowerCase(), nonce: this.nonce() }, main);
  }

  /** Whether this account's trading key and the Kusari fee are both in place. */
  async status(agent: BaseWallet): Promise<{ agent: boolean; builder: boolean; until: number }> {
    const [agents, fee] = await Promise.all([
      this.info({ type: 'extraAgents', user: this.user }).catch(() => []),
      this.info({ type: 'maxBuilderFee', user: this.user, builder: KUSARI_BUILDER.toLowerCase() }).catch(() => 0),
    ]);
    const mine = (Array.isArray(agents) ? agents : []).find((a: any) => String(a.address).toLowerCase() === agent.address.toLowerCase());
    const until = Number(mine?.validUntil ?? 0);
    return { agent: Boolean(mine) && (!until || until > Date.now()), builder: Number(fee) >= KUSARI_FEE.max, until };
  }

  async markets(): Promise<HlMarket[]> {
    const [meta, ctxs] = await this.info({ type: 'metaAndAssetCtxs' });
    const out: HlMarket[] = [];
    (meta?.universe ?? []).forEach((u: any, asset: number) => {
      const c = ctxs?.[asset] ?? {};
      if (u.isDelisted) return;
      const mark = Number(c.markPx ?? 0);
      const prev = Number(c.prevDayPx ?? 0);
      out.push({
        symbol: u.name, base: u.name, quote: 'USDC', asset, szDecimals: Number(u.szDecimals), maxLeverage: Number(u.maxLeverage), onlyIsolated: Boolean(u.onlyIsolated),
        price: mark, mark, mid: Number(c.midPx ?? mark), oracle: Number(c.oraclePx ?? mark), change: prev ? ((mark - prev) / prev) * 100 : 0,
        volume: Number(c.dayNtlVlm ?? 0), funding: Number(c.funding ?? 0), openInterest: Number(c.openInterest ?? 0) * mark,
      });
    });
    return out.sort((a, b) => b.volume - a.volume);
  }

  async book(coin: string, depth = 8): Promise<{ bids: HlLevel[]; asks: HlLevel[] }> {
    const r = await this.info({ type: 'l2Book', coin });
    const side = (l: any[]) => (l ?? []).slice(0, depth).map((x: any) => ({ px: Number(x.px), sz: Number(x.sz) }));
    return { bids: side(r?.levels?.[0]), asks: side(r?.levels?.[1]) };
  }

  async candles(coin: string, interval: string, count = 60): Promise<HlCandle[]> {
    const ms: Record<string, number> = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
    if (!ms[interval]) throw new Error('Unknown chart interval.');
    const end = Date.now();
    const r = await this.info({ type: 'candleSnapshot', req: { coin, interval, startTime: end - ms[interval] * count, endTime: end } });
    return (Array.isArray(r) ? r : []).map((c: any) => ({ t: Number(c.t), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) }));
  }

  async fees(): Promise<{ maker: number; taker: number } | null> {
    const r = await this.info({ type: 'userFees', user: this.user }).catch(() => null);
    if (!r || r.userAddRate === undefined) return null;
    return { maker: Number(r.userAddRate), taker: Number(r.userCrossRate) };
  }

  async account(): Promise<HlAccount> {
    const [st, orders] = await Promise.all([this.info({ type: 'clearinghouseState', user: this.user }), this.info({ type: 'frontendOpenOrders', user: this.user })]);
    const positions: HlPosition[] = (st?.assetPositions ?? []).map((ap: any) => ap.position).filter((p: any) => p && Number(p.szi) !== 0).map((p: any) => {
      const szi = Number(p.szi);
      const notional = Math.abs(Number(p.positionValue));
      return {
        symbol: p.coin, side: szi > 0 ? 'long' : 'short', size: String(p.szi).replace(/^-/, ''), entry: Number(p.entryPx), mark: notional / Math.abs(szi),
        pnl: Number(p.unrealizedPnl), liquidation: Number(p.liquidationPx ?? 0), leverage: Number(p.leverage?.value ?? 1), margin: Number(p.marginUsed),
        isolated: p.leverage?.type === 'isolated', notional,
      };
    });
    const ms = st?.marginSummary ?? {};
    return {
      wallet: Number(ms.totalRawUsd ?? 0), available: Number(st?.withdrawable ?? 0), pnl: positions.reduce((a, p) => a + p.pnl, 0), margin: Number(ms.accountValue ?? 0),
      positions,
      orders: (Array.isArray(orders) ? orders : []).map((o: any) => ({
        orderId: Number(o.oid), symbol: o.coin, side: o.side === 'B' ? 'BUY' : 'SELL', type: String(o.orderType ?? 'Limit'), price: String(o.limitPx), qty: String(o.sz),
        filled: String(Number(o.origSz ?? o.sz) - Number(o.sz)), reduceOnly: Boolean(o.reduceOnly), postOnly: o.tif === 'Alo', time: Number(o.timestamp ?? 0),
      })),
    };
  }

  /** Isolated margin keeps a loss to the margin put into that one position. */
  async setLeverage(asset: number, leverage: number, agent: BaseWallet): Promise<void> {
    await this.l1({ type: 'updateLeverage', asset, isCross: false, leverage }, agent);
  }

  /** Every order carries Kusari's builder code: the maker rate for post-only, the taker rate otherwise. */
  async order(o: OrderInput, agent: BaseWallet): Promise<{ orderId: number; status: 'FILLED' | 'NEW'; avgPx?: number }> {
    const action = {
      type: 'order',
      orders: [{ a: o.asset, b: o.buy, p: o.price, s: o.size, r: Boolean(o.reduceOnly), t: { limit: { tif: o.tif } } }],
      grouping: 'na',
      builder: { b: KUSARI_BUILDER.toLowerCase(), f: builderFee(o.tif) },
    };
    const r = await this.l1(action, agent);
    const st = r?.data?.statuses?.[0];
    if (st?.error) throw new HlError(friendly(String(st.error)));
    if (st?.filled) return { orderId: Number(st.filled.oid), status: 'FILLED', avgPx: Number(st.filled.avgPx) };
    if (st?.resting) return { orderId: Number(st.resting.oid), status: 'NEW' };
    throw new HlError('The exchange did not confirm the order. Check open orders before trying again.');
  }

  async cancel(asset: number, orderId: number, agent: BaseWallet): Promise<void> {
    const r = await this.l1({ type: 'cancel', cancels: [{ a: asset, o: orderId }] }, agent);
    const st = r?.data?.statuses?.[0];
    if (st && typeof st === 'object' && st.error) throw new HlError(friendly(String(st.error)));
  }

  /** Back to this wallet's own address on Arbitrum. Hyperliquid takes HL_WITHDRAW_FEE from the amount. */
  async withdraw(main: BaseWallet, amount: string): Promise<void> {
    await this.userAction({ type: 'withdraw3', destination: main.address.toLowerCase(), amount, time: this.nonce() }, main);
  }
}

export function builderFee(tif: OrderInput['tif']): number {
  return tif === 'Alo' ? KUSARI_FEE.maker : KUSARI_FEE.taker;
}

const erc20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);
/** A deposit is a plain USDC transfer to the bridge, credited to the sending address. */
export function encodeDeposit(amount: bigint): string {
  return erc20.encodeFunctionData('transfer', [HL_BRIDGE, amount]);
}
