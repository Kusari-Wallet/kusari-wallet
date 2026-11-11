import type { Agent } from 'node:http';
import { requestForm } from './request';
import { BaseWallet, Interface, Wallet, concat, getBytes, keccak256, toUtf8Bytes } from 'ethers';

/**
 * Aster perpetual futures (API v3), traded from inside the wallet.
 *
 * Two keys are involved. The wallet's own EVM key approves things that touch money: registering a trading key, the
 * Kusari fee cap, deposits and withdrawals. A separate trading key ("agent"), derived from the seed, places and
 * cancels orders; Aster lets it trade but never withdraw, so it can stay in memory while the wallet is unlocked.
 */

export const ASTER_API = 'https://fapi.asterdex.com';
export const ASTER_BAPI = 'https://www.asterdex.com';

/** Kusari's builder address and fees. Maker = post-only orders; every other order pays the taker rate. */
export const KUSARI_BUILDER = '0xDb0f1c2d5f3713051d1d5AB70D7359E6Daa6f87E';
export const KUSARI_FEE = { maker: '0.0001', taker: '0.00035', max: '0.00035' } as const;
export const AGENT_NAME = 'Kusari';
/** How long a trading key stays approved. Aster allows at most 180 days. */
export const AGENT_DAYS = 179;

/** Aster's deposit vaults, and the chain names its withdrawal signature uses. */
export const ASTER_VAULTS: Record<string, { vault: string; chainName: string }> = {
  '1': { vault: '0x604DD02d620633Ae427888d41bfd15e38483736E', chainName: 'ETH' },
  '56': { vault: '0x128463A60784c4D3f46c23Af3f65Ed859Ba87974', chainName: 'BSC' },
  '42161': { vault: '0x9E36CB86a159d479cEd94Fa05036f235Ac40E1d5', chainName: 'Arbitrum' },
};

const vaultAbi = new Interface(['function depositFor(address currency, address forAddress, uint256 amount, uint256 broker) payable']);
/** broker 0 credits the futures account (1000 would be spot). */
export function encodeDeposit(token: string, forAddress: string, amount: bigint): string {
  return vaultAbi.encodeFunctionData('depositFor', [token, forAddress, amount, 0n]);
}

const ZERO = '0x0000000000000000000000000000000000000000';
const domain = (name: string, chainId: number) => ({ name, version: '1', chainId, verifyingContract: ZERO });

/** The trading key for a wallet: the same seed always gives the same one, and it is no key the seed uses elsewhere. */
export function asterAgent(mainPrivateKey: string): Wallet {
  return new Wallet(keccak256(concat([getBytes(mainPrivateKey), toUtf8Bytes('kusari/aster-agent/1')])));
}

/** Signs a request string: trading requests use chain 1666, wallet registration uses 56. */
export function signAsterMessage(wallet: BaseWallet, msg: string, chainId = 1666): Promise<string> {
  return wallet.signTypedData(domain('AsterSignTransaction', chainId), { Message: [{ name: 'msg', type: 'string' }] }, { msg });
}

type Field = [string, string | bigint | boolean];
const fieldType = (v: Field[1]) => (typeof v === 'boolean' ? 'bool' : typeof v === 'bigint' ? 'uint256' : 'string');

/** Account management (approving a builder and the like) signs the fields themselves, first letters capitalised. */
export function signAsterAction(wallet: BaseWallet, primaryType: string, fields: Field[]): Promise<string> {
  const named = fields.map(([k, v]) => [k[0].toUpperCase() + k.slice(1), v] as const);
  return wallet.signTypedData(domain('AsterSignTransaction', 56), { [primaryType]: named.map(([name, v]) => ({ name, type: fieldType(v) })) }, Object.fromEntries(named));
}

export interface WithdrawAction { destination: string; chainId: number; token: string; amount: string; fee: string; nonce: bigint }

/** The wallet's own approval of a withdrawal, which Aster checks besides the request signature. */
export function signAsterWithdraw(wallet: BaseWallet, w: WithdrawAction): Promise<string> {
  const chainName = ASTER_VAULTS[String(w.chainId)]?.chainName;
  if (!chainName) throw new Error('Aster does not pay out on this network.');
  const types = { Action: [
    { name: 'type', type: 'string' }, { name: 'destination', type: 'address' }, { name: 'destination Chain', type: 'string' },
    { name: 'token', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'fee', type: 'string' },
    { name: 'nonce', type: 'uint256' }, { name: 'aster chain', type: 'string' },
  ] };
  return wallet.signTypedData(domain('Aster', w.chainId), types, {
    type: 'Withdraw', destination: w.destination, 'destination Chain': chainName, token: w.token, amount: w.amount, fee: w.fee, nonce: w.nonce, 'aster chain': 'Mainnet',
  });
}

// ---- decimal strings, so prices and sizes never pass through floating point ----

function scaleOf(s: string): number { const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; }
function toUnits(s: string, scale: number): bigint {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!m) throw new Error(`Not a number: ${s}`);
  const frac = (m[3] ?? '').padEnd(scale, '0').slice(0, scale);
  const v = BigInt((m[2] || '0') + frac);
  return m[1] ? -v : v;
}
function fromUnits(v: bigint, scale: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(scale + 1, '0');
  const out = scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s;
  return (neg ? '-' : '') + out;
}
/** A step size like "0.0010" means three decimals, not four. */
export function stepDecimals(step: string): number { return scaleOf(step.replace(/0+$/, '').replace(/\.$/, '')); }
/** Rounds a value down to a multiple of the step. */
export function floorToStep(value: string, step: string): string {
  const scale = Math.max(scaleOf(value), scaleOf(step));
  const st = toUnits(step, scale);
  if (st <= 0n) return value;
  const v = toUnits(value, scale);
  return fromUnits((v / st) * st, scale).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
/** Rounds to the nearest multiple of the step. */
export function roundToStep(value: string, step: string): string {
  const scale = Math.max(scaleOf(value), scaleOf(step));
  const st = toUnits(step, scale);
  const v = toUnits(value, scale);
  return fromUnits(((v + st / 2n) / st) * st, scale).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
/** Decimal text for a number, without exponent notation. */
export function plain(n: number, digits = 12): string {
  if (!Number.isFinite(n)) throw new Error('Not a number.');
  return n.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// ---- market data ----

export interface AsterMarket {
  symbol: string; base: string; quote: string;
  tickSize: string; stepSize: string; minQty: string; marketStep: string; marketMinQty: string; marketMaxQty: string; minNotional: string;
  price: number; change: number; volume: number;
  /** Mark, index (Aster's oracle) and funding, from its premium index. */
  mark: number; oracle: number; mid: number; funding: number; openInterest: number;
  /** Highest leverage on this market, once known (0 before). */
  maxLeverage: number;
}
export interface AsterLevel { px: number; sz: number }
export interface AsterCandle { t: number; o: number; h: number; l: number; c: number; v: number }
/** Chart intervals Aster offers, as the trade screen names them. */
export const ASTER_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;

export interface AsterBracket { initialLeverage: number; notionalCap: number; notionalFloor: number; maintMarginRatio: number; cum: number }

export interface AsterPosition {
  symbol: string; side: 'long' | 'short'; size: string; entry: number; mark: number; pnl: number; liquidation: number; leverage: number; margin: number; isolated: boolean; notional: number;
}
export interface AsterOrder { orderId: number; symbol: string; side: 'BUY' | 'SELL'; type: string; price: string; qty: string; filled: string; reduceOnly: boolean; postOnly: boolean; time: number }
export interface AsterAccount { wallet: number; available: number; pnl: number; margin: number; positions: AsterPosition[]; orders: AsterOrder[] }

export interface OrderInput { symbol: string; side: 'BUY' | 'SELL'; type: 'MARKET' | 'LIMIT'; quantity: string; price?: string; postOnly?: boolean; reduceOnly?: boolean }

/** Isolated-margin liquidation price for one position, the way Binance-style futures compute it. */
export function liquidationPrice(side: 'long' | 'short', entry: number, qty: number, margin: number, b: AsterBracket | undefined): number {
  if (!b || qty <= 0 || entry <= 0) return 0;
  const dir = side === 'long' ? 1 : -1;
  const p = (margin + b.cum - dir * qty * entry) / (qty * b.maintMarginRatio - dir * qty);
  return p > 0 ? p : 0;
}

/** The bracket that applies to a position of this size. */
export function bracketFor(brackets: AsterBracket[], notional: number): AsterBracket | undefined {
  return brackets.find((b) => notional >= b.notionalFloor && notional < b.notionalCap) ?? brackets[brackets.length - 1];
}

export class AsterError extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

const FRIENDLY: Record<number, string> = {
  [-5050]: 'Aster opens your trading account after the first deposit. Deposit USDT or USDC first.',
  [-1022]: 'Aster did not accept the signature. Turn on trading again.',
  [-2019]: 'Not enough margin for this order.',
  [-4164]: 'This order is too small. Aster needs at least the minimum order value.',
  [-2031]: 'Aster did not accept the Kusari fee. Turn on trading again to approve it.',
};

export class AsterClient {
  private offsetMs = 0;
  private lastNonce = 0n;
  private synced = 0;

  constructor(readonly user: string, private readonly opts: { api?: string; bapi?: string; agent?: Agent; timeoutMs?: number } = {}) {}

  private get api() { return this.opts.api ?? ASTER_API; }
  private get bapi() { return this.opts.bapi ?? ASTER_BAPI; }

  private raw(method: 'GET' | 'POST' | 'DELETE', url: string, form?: string): Promise<{ status: number; body: any }> {
    return requestForm(url, { method, form, agent: this.opts.agent, timeoutMs: this.opts.timeoutMs ?? 20_000 });
  }

  private check(res: { status: number; body: any }): any {
    const b = res.body;
    const code = typeof b?.code === 'number' ? b.code : 0;
    if (res.status >= 400 || (code !== 0 && code !== 200)) {
      const text = typeof b?.msg === 'string' && b.msg ? b.msg : typeof b?.error === 'string' && b.error ? b.error : typeof b === 'string' && b && b.length < 300 ? b : '';
      const msg = FRIENDLY[code] ?? (/builder address.*balance less than/i.test(text)
        ? 'Kusari trading is not open yet: Aster has not activated Kusari\'s builder account. Try again later.'
        : text ? `Aster: ${text}` : `Aster answered with an error (${res.status}).`);
      throw new AsterError(msg, code);
    }
    return b;
  }

  async publicGet(path: string, query = ''): Promise<any> {
    return this.check(await this.raw('GET', `${this.api}${path}${query ? `?${query}` : ''}`));
  }

  /** Requests are dated by Aster's clock, so a computer whose clock is off still gets through. */
  private async syncTime(): Promise<void> {
    if (Date.now() - this.synced < 10 * 60_000) return;
    const t0 = Date.now();
    const r = await this.publicGet('/fapi/v3/time');
    const t1 = Date.now();
    if (Number.isFinite(Number(r?.serverTime))) this.offsetMs = Number(r.serverTime) - Math.round((t0 + t1) / 2);
    this.synced = t1;
  }

  /** Microseconds by Aster's clock; never the same twice. */
  async nonce(): Promise<bigint> {
    await this.syncTime();
    let n = BigInt(Date.now() + this.offsetMs) * 1000n;
    if (n <= this.lastNonce) n = this.lastNonce + 1n;
    this.lastNonce = n;
    return n;
  }

  /** A request signed by the trading key. The signed text is exactly the parameters sent, in order. */
  async signed(method: 'GET' | 'POST' | 'DELETE', path: string, params: [string, string][], agent: BaseWallet): Promise<any> {
    const all: [string, string][] = [...params, ['user', this.user], ['signer', agent.address], ['nonce', String(await this.nonce())]];
    const query = all.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const signature = await signAsterMessage(agent, query);
    const full = `${query}&signature=${signature}`;
    // GET and DELETE carry the parameters in the URL, POST in the body.
    return this.check(method === 'POST' ? await this.raw('POST', `${this.api}${path}`, full) : await this.raw(method, `${this.api}${path}?${full}`));
  }

  /** Approves the trading key: it may trade futures, never spot and never withdraw. */
  async registerAgent(main: BaseWallet, agent: BaseWallet, expiresMs: number): Promise<void> {
    if (main.address.toLowerCase() !== this.user.toLowerCase()) throw new Error('The wallet address does not match, so this was stopped.');
    const fields: [string, string][] = [
      ['user', this.user], ['nonce', String(await this.nonce())], ['agentName', AGENT_NAME], ['agentAddress', agent.address],
      ['expired', String(expiresMs)], ['signatureChainId', '56'], ['canSpotTrade', 'false'], ['canPerpTrade', 'true'], ['canWithdraw', 'false'],
      // Empty, but part of the signed text either way Aster rebuilds it.
      ['ipWhitelist', ''],
    ];
    const msg = fields.map(([k, v]) => `${k}=${v}`).join('&');
    const signature = await signAsterMessage(main, msg, 56);
    const form = [...fields, ['signature', signature]].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    this.check(await this.raw('POST', `${this.api}/fapi/v3/registerAndApproveAgent`, form));
  }

  /** Lets Kusari's builder charge at most KUSARI_FEE.max per order. Updates an earlier approval if there is one. */
  async approveBuilder(main: BaseWallet): Promise<void> {
    const send = async (path: string, primaryType: string, extra: [string, string][]) => {
      const fields: [string, string][] = [['builder', KUSARI_BUILDER], ['maxFeeRate', KUSARI_FEE.max], ...extra, ['asterChain', 'Mainnet'], ['user', this.user]];
      const nonce = await this.nonce();
      const signature = await signAsterAction(main, primaryType, [...fields, ['nonce', nonce]]);
      const form = [...fields, ['nonce', String(nonce)], ['signature', signature], ['signatureChainId', '56']].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      this.check(await this.raw('POST', `${this.api}${path}`, form));
    };
    try {
      await send('/fapi/v3/approveBuilder', 'ApproveBuilder', [['builderName', AGENT_NAME]]);
    } catch (e) {
      if (!/already|exist|bound/i.test((e as Error).message)) throw e;
      await send('/fapi/v3/updateBuilder', 'UpdateBuilder', []);
    }
  }

  /** The fee cap this account gave Kusari's builder, or null if none. */
  async builderCap(agent: BaseWallet): Promise<string | null> {
    const list = await this.signed('GET', '/fapi/v3/builder', [], agent);
    const mine = (Array.isArray(list) ? list : list?.data ?? []).find((b: any) => String(b.builderAddress ?? b.builder ?? '').toLowerCase() === KUSARI_BUILDER.toLowerCase());
    return mine ? String(mine.maxFeeRate) : null;
  }

  async markets(): Promise<AsterMarket[]> {
    const [info, tickers, premium] = await Promise.all([this.publicGet('/fapi/v3/exchangeInfo'), this.publicGet('/fapi/v3/ticker/24hr'), this.publicGet('/fapi/v3/premiumIndex').catch(() => [])]);
    const byS = new Map<string, any>((Array.isArray(tickers) ? tickers : []).map((t: any) => [t.symbol, t]));
    const prem = new Map<string, any>((Array.isArray(premium) ? premium : []).map((t: any) => [t.symbol, t]));
    const out: AsterMarket[] = [];
    for (const s of info?.symbols ?? []) {
      if (s.status !== 'TRADING' || s.contractType !== 'PERPETUAL') continue;
      const f = (type: string) => (s.filters ?? []).find((x: any) => x.filterType === type) ?? {};
      const t = byS.get(s.symbol) ?? {};
      out.push({
        symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset,
        tickSize: String(f('PRICE_FILTER').tickSize ?? '0.01'), stepSize: String(f('LOT_SIZE').stepSize ?? '0.001'), minQty: String(f('LOT_SIZE').minQty ?? '0'),
        marketStep: String(f('MARKET_LOT_SIZE').stepSize ?? f('LOT_SIZE').stepSize ?? '0.001'), marketMinQty: String(f('MARKET_LOT_SIZE').minQty ?? f('LOT_SIZE').minQty ?? '0'),
        marketMaxQty: String(f('MARKET_LOT_SIZE').maxQty ?? f('LOT_SIZE').maxQty ?? '0'), minNotional: String(f('MIN_NOTIONAL').notional ?? '0'),
        price: Number(t.lastPrice ?? 0), change: Number(t.priceChangePercent ?? 0), volume: Number(t.quoteVolume ?? 0),
        mark: Number(prem.get(s.symbol)?.markPrice ?? t.lastPrice ?? 0), oracle: Number(prem.get(s.symbol)?.indexPrice ?? 0),
        mid: Number(t.lastPrice ?? 0), funding: Number(prem.get(s.symbol)?.lastFundingRate ?? 0), openInterest: 0, maxLeverage: 0,
      });
    }
    return out.sort((a, b) => b.volume - a.volume);
  }

  /** The order book's best levels. */
  async book(symbol: string, depth = 8): Promise<{ bids: AsterLevel[]; asks: AsterLevel[] }> {
    const r = await this.publicGet('/fapi/v3/depth', `symbol=${encodeURIComponent(symbol)}&limit=10`);
    const side = (rows: any) => (Array.isArray(rows) ? rows : []).slice(0, depth).map((x: any) => ({ px: Number(x[0]), sz: Number(x[1]) }));
    return { bids: side(r?.bids), asks: side(r?.asks) };
  }

  async candles(symbol: string, interval: string, count = 300): Promise<AsterCandle[]> {
    if (!(ASTER_INTERVALS as readonly string[]).includes(interval)) throw new Error('Unknown chart interval.');
    const r = await this.publicGet('/fapi/v3/klines', `symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${Math.min(1000, count)}`);
    return (Array.isArray(r) ? r : []).map((k: any) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) }));
  }

  async openInterest(symbol: string): Promise<number> {
    const r = await this.publicGet('/fapi/v3/openInterest', `symbol=${encodeURIComponent(symbol)}`).catch(() => null);
    return Number(r?.openInterest ?? 0) || 0;
  }

  async mark(symbol: string): Promise<{ mark: number; oracle: number; funding: number; nextFunding: number }> {
    const r = await this.publicGet('/fapi/v3/premiumIndex', `symbol=${encodeURIComponent(symbol)}`);
    return { mark: Number(r.markPrice), oracle: Number(r.indexPrice ?? 0), funding: Number(r.lastFundingRate), nextFunding: Number(r.nextFundingTime) };
  }

  async brackets(symbol: string, agent: BaseWallet): Promise<AsterBracket[]> {
    const r = await this.signed('GET', '/fapi/v3/leverageBrackets', [['symbol', symbol]], agent);
    const one = Array.isArray(r) ? r.find((x: any) => x.symbol === symbol) ?? r[0] : r;
    return (one?.brackets ?? []).map((b: any) => ({ initialLeverage: Number(b.initialLeverage), notionalCap: Number(b.notionalCap), notionalFloor: Number(b.notionalFloor), maintMarginRatio: Number(b.maintMarginRatio), cum: Number(b.cum ?? 0) }));
  }

  /** Leverage brackets of every market in one call (needs an account that has deposited). */
  async allBrackets(agent: BaseWallet): Promise<Map<string, AsterBracket[]>> {
    const r = await this.signed('GET', '/fapi/v3/leverageBrackets', [], agent);
    const out = new Map<string, AsterBracket[]>();
    for (const one of Array.isArray(r) ? r : []) {
      out.set(String(one.symbol), (one.brackets ?? []).map((b: any) => ({ initialLeverage: Number(b.initialLeverage), notionalCap: Number(b.notionalCap), notionalFloor: Number(b.notionalFloor), maintMarginRatio: Number(b.maintMarginRatio), cum: Number(b.cum ?? 0) })));
    }
    return out;
  }

  /**
   * A market's highest leverage without an account: Aster answers -4028 for any leverage above it. The usual
   * values are searched first, then the gap above the best one is narrowed down, in case it is an unusual number.
   */
  async maxLeverage(symbol: string): Promise<number> {
    const ok = async (lev: number) => {
      try { await this.publicGet('/fapi/v3/remainingOpenableNotionalValue', `symbol=${encodeURIComponent(symbol)}&leverage=${lev}`); return true; } catch (e) {
        if (e instanceof AsterError && e.code === -4028) return false;
        throw e;
      }
    };
    // Each check costs 50 of Aster's 2400-per-minute weight, so the usual values are searched, not all tried.
    const steps = [1, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 500, 1000];
    let a = 0; let b = steps.length - 1;
    if (!(await ok(steps[0]))) return 0;
    while (a < b) { const mid = Math.ceil((a + b) / 2); if (await ok(steps[mid])) a = mid; else b = mid - 1; }
    let lo = steps[a];
    let hi = a + 1 < steps.length ? steps[a + 1] : steps[a];
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (await ok(mid)) lo = mid; else hi = mid; }
    return lo;
  }

  async commission(symbol: string, agent: BaseWallet): Promise<{ maker: number; taker: number }> {
    const r = await this.signed('GET', '/fapi/v3/commissionRate', [['symbol', symbol]], agent);
    return { maker: Number(r.makerCommissionRate), taker: Number(r.takerCommissionRate) };
  }

  async account(agent: BaseWallet): Promise<AsterAccount> {
    const [acct, risk, orders] = await Promise.all([
      this.signed('GET', '/fapi/v3/account', [], agent),
      this.signed('GET', '/fapi/v3/positionRisk', [], agent),
      this.signed('GET', '/fapi/v3/openOrders', [], agent),
    ]);
    const positions: AsterPosition[] = (Array.isArray(risk) ? risk : []).filter((p: any) => Number(p.positionAmt) !== 0).map((p: any) => {
      const amt = Number(p.positionAmt);
      return {
        symbol: p.symbol, side: amt > 0 ? 'long' : 'short', size: String(p.positionAmt).replace(/^-/, ''), entry: Number(p.entryPrice), mark: Number(p.markPrice),
        pnl: Number(p.unRealizedProfit), liquidation: Number(p.liquidationPrice), leverage: Number(p.leverage),
        margin: p.marginType === 'isolated' ? Number(p.isolatedWallet ?? p.isolatedMargin) : Math.abs(Number(p.notional)) / Math.max(1, Number(p.leverage)),
        isolated: p.marginType === 'isolated', notional: Math.abs(Number(p.notional)),
      };
    });
    return {
      wallet: Number(acct.totalWalletBalance ?? 0), available: Number(acct.availableBalance ?? 0), pnl: Number(acct.totalUnrealizedProfit ?? 0), margin: Number(acct.totalMarginBalance ?? 0),
      positions,
      orders: (Array.isArray(orders) ? orders : []).map((o: any) => ({
        orderId: Number(o.orderId), symbol: o.symbol, side: o.side, type: o.origType ?? o.type, price: String(o.price), qty: String(o.origQty), filled: String(o.executedQty),
        reduceOnly: Boolean(o.reduceOnly), postOnly: o.timeInForce === 'GTX', time: Number(o.time ?? o.updateTime ?? 0),
      })),
    };
  }

  /** Isolated margin keeps a loss to the margin put into that one position. "No need to change" is fine. */
  async prepareSymbol(symbol: string, leverage: number, agent: BaseWallet): Promise<void> {
    try { await this.signed('POST', '/fapi/v3/marginType', [['symbol', symbol], ['marginType', 'ISOLATED']], agent); } catch (e) {
      if (!(e instanceof AsterError) || (e.code !== -4046 && e.code !== -4048)) throw e;
    }
    await this.signed('POST', '/fapi/v3/leverage', [['symbol', symbol], ['leverage', String(leverage)]], agent);
  }

  /** Every order carries Kusari's builder address and fee: the maker rate for post-only, the taker rate otherwise. */
  async order(o: OrderInput, agent: BaseWallet): Promise<{ orderId: number; status: string }> {
    const p: [string, string][] = [['symbol', o.symbol], ['side', o.side], ['type', o.type]];
    if (o.type === 'LIMIT') {
      if (!o.price) throw new Error('A limit order needs a price.');
      p.push(['timeInForce', o.postOnly ? 'GTX' : 'GTC'], ['quantity', o.quantity], ['price', o.price]);
    } else {
      p.push(['quantity', o.quantity]);
    }
    if (o.reduceOnly) p.push(['reduceOnly', 'true']);
    p.push(['newOrderRespType', 'RESULT'], ['builder', KUSARI_BUILDER], ['feeRate', builderFee(o)]);
    const r = await this.signed('POST', '/fapi/v3/order', p, agent);
    return { orderId: Number(r.orderId ?? r.data?.orderId ?? 0), status: String(r.status ?? r.data?.status ?? '') };
  }

  async cancel(symbol: string, orderId: number, agent: BaseWallet): Promise<void> {
    await this.signed('DELETE', '/fapi/v3/order', [['symbol', symbol], ['orderId', String(orderId)]], agent);
  }

  // ---- deposits and withdrawals ----

  /** The coins Aster takes on one chain: name, contract and decimals. */
  async depositAssets(chainId: number): Promise<{ name: string; contract: string; decimals: number }[]> {
    const r = this.check(await this.raw('GET', `${this.bapi}/bapi/futures/v1/public/future/aster/deposit/assets?chainIds=${chainId}&networks=EVM&accountType=perp`));
    return (r?.data ?? []).map((a: any) => ({ name: String(a.name), contract: String(a.contractAddress), decimals: Number(a.decimals) }));
  }

  async withdrawFee(chainId: number, token: string): Promise<string> {
    const r = this.check(await this.raw('GET', `${this.bapi}/bapi/futures/v1/public/future/aster/estimate-withdraw-fee?chainId=${chainId}&network=EVM&currency=${encodeURIComponent(token)}&accountType=perp`));
    const fee = r?.data?.gasCost;
    if (fee === undefined || fee === null || !Number.isFinite(Number(fee))) throw new Error('Aster did not give a withdrawal fee right now. Try again later.');
    return plain(Number(fee), 8);
  }

  /** Sends futures balance back to the wallet's own address on a chain. */
  async withdraw(main: BaseWallet, agent: BaseWallet, w: { chainId: number; token: string; amount: string; fee: string }): Promise<{ id: string }> {
    const userNonce = BigInt(Date.now() + this.offsetMs) * 1000n;
    const userSignature = await signAsterWithdraw(main, { destination: main.address, chainId: w.chainId, token: w.token, amount: w.amount, fee: w.fee, nonce: userNonce });
    const r = await this.signed('POST', '/fapi/v3/aster/user-withdraw', [
      ['chainId', String(w.chainId)], ['asset', w.token], ['amount', w.amount], ['fee', w.fee], ['receiver', main.address], ['userNonce', String(userNonce)], ['userSignature', userSignature],
    ], agent);
    return { id: String(r.withdrawId ?? r.hash ?? '') };
  }
}

export function builderFee(o: Pick<OrderInput, 'type' | 'postOnly'>): string {
  return o.type === 'LIMIT' && o.postOnly ? KUSARI_FEE.maker : KUSARI_FEE.taker;
}
