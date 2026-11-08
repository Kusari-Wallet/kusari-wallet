import type { Agent } from 'node:http';
import { AbiCoder, Interface, getAddress, isAddress } from 'ethers';
import { requestJson } from './request';

/**
 * Swaps on the chain itself, inside one EVM network: Uniswap through its Trading API (which builds the transaction),
 * PancakeSwap through its V2 router, quoted and built here with no server at all. Every address the wallet signs
 * against is pinned below, and every answer is checked against the request before anything is signed.
 */
export type DexId = 'uniswap' | 'pancakeswap';
export const NATIVE = '0x0000000000000000000000000000000000000000';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
// Universal Router 2.0, from Uniswap's own deploy-addresses list (github.com/Uniswap/universal-router).
export const UNIVERSAL_ROUTER: Record<string, string> = {
  1: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
  137: '0x1095692a6237d83c6a72f3f5efedb9a670c49223',
  42161: '0xa51afafe0263b40edaef0df8781ea9aa03e381a3',
  56: '0x1906c1d672b88cd1b9ac7593301ca990f94eae07',
};
export const UNISWAP_CHAINS = Object.keys(UNIVERSAL_ROUTER).map(BigInt);
export const UNISWAP_API = 'https://trade-api.gateway.uniswap.org/v1';
// PancakeSwap V2 on BNB Smart Chain, from PancakeSwap's address list; its factory() and WETH() were read on-chain.
export const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
// Tether on Ethereum refuses to change a non-zero allowance to another non-zero one.
const RESET_FIRST = new Set(['0xdac17f958d2ee523a2206206994597c13d831ec7']);
const EXECUTE = '0x3593564c'; // Universal Router execute(bytes,bytes[],uint256)

export const erc20 = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const pancake = new Interface([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);

export interface DexCall { label: 'reset' | 'approve' | 'swap'; to: string; data: string; value: bigint; gas?: bigint }
export interface DexQuote {
  provider: DexId; chainId: bigint; tokenIn: string; tokenOut: string;
  amountIn: bigint; amountOut: bigint; minOut: bigint;
  priceImpact: number | null; gasUnits: bigint; spender: string;
  path?: string[]; raw?: any;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const big = (v: unknown, what: string): bigint => {
  if ((typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) || typeof v === 'number') return BigInt(v);
  throw new Error(`The swap service gave an unexpected answer (${what}).`);
};
/** Slippage in basis points, 10 = 0.1%. Anything outside 0.05%–5% is refused. */
export function minAfterSlippage(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 5 || bps > 500) throw new Error('Slippage must be between 0.05% and 5%.');
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/** Approve exactly the amount being swapped, never an open-ended allowance. */
export function approvalCalls(token: string, spender: string, amount: bigint, current: bigint): DexCall[] {
  if (current >= amount) return [];
  const calls: DexCall[] = [];
  if (current > 0n && RESET_FIRST.has(token.toLowerCase())) calls.push({ label: 'reset', to: token, data: erc20.encodeFunctionData('approve', [spender, 0n]), value: 0n, gas: 70_000n });
  calls.push({ label: 'approve', to: token, data: erc20.encodeFunctionData('approve', [spender, amount]), value: 0n, gas: 80_000n });
  return calls;
}

// ---- Uniswap ----

export class UniswapClient {
  constructor(private readonly key: string, private readonly agent?: Agent, private readonly timeoutMs = 20_000, private readonly base = UNISWAP_API) {}

  private async post(path: string, body: unknown): Promise<any> {
    const res = await requestJson(this.base + path, { method: 'POST', body, agent: this.agent, timeoutMs: this.timeoutMs, headers: { 'x-api-key': this.key, 'x-universal-router-version': '2.0' } });
    if (res.status >= 400) {
      const why = String(res.body?.detail ?? res.body?.errorCode ?? `error ${res.status}`);
      throw new Error(/no quotes|no route|QuoteAmountTooLow/i.test(why) ? 'Uniswap has no route for this pair right now.' : `Uniswap: ${why.slice(0, 160)}`);
    }
    return res.body;
  }

  /** Classic pool routes only: UniswapX orders are filled by third parties later, which this wallet doesn't track. */
  async quote(chainId: bigint, tokenIn: string, tokenOut: string, amountIn: bigint, swapper: string, slippageBps: number): Promise<DexQuote> {
    if (!UNIVERSAL_ROUTER[String(chainId)]) throw new Error('Uniswap isn\'t offered on this network here.');
    const b = await this.post('/quote', {
      type: 'EXACT_INPUT', amount: amountIn.toString(), tokenInChainId: String(chainId), tokenOutChainId: String(chainId),
      tokenIn, tokenOut, swapper, slippageTolerance: slippageBps / 100, routingPreference: 'BEST_PRICE', protocols: ['V2', 'V3', 'V4'],
    });
    const q = b?.quote;
    if (b?.routing !== 'CLASSIC' || !q) throw new Error('Uniswap offered a kind of route this wallet doesn\'t use.');
    const stop = (why: string): never => { throw new Error(`Uniswap's answer differs from the request (${why}), so it was not used.`); };
    if (big(q.chainId, 'chain') !== chainId) stop('network');
    if (!same(String(q.swapper), swapper)) stop('wallet');
    if (!same(String(q.input?.token), tokenIn) || big(q.input?.amount, 'input') !== amountIn) stop('amount sent');
    if (!same(String(q.output?.token), tokenOut)) stop('coin received');
    if (q.output?.recipient && !same(String(q.output.recipient), swapper)) stop('receiver');
    const amountOut = big(q.output?.amount, 'output');
    const minOut = big(q.output?.minimumAmount ?? amountOut, 'minimum');
    if (amountOut <= 0n || minOut > amountOut || minOut < minAfterSlippage(amountOut, slippageBps) - 1n) stop('minimum received');
    const impact = Number(q.priceImpact);
    return {
      provider: 'uniswap', chainId, tokenIn, tokenOut, amountIn, amountOut, minOut,
      priceImpact: Number.isFinite(impact) ? impact : null,
      gasUnits: q.gasUseEstimate ? big(q.gasUseEstimate, 'gas') : 250_000n,
      spender: PERMIT2, raw: b,
    };
  }

  /** The swap transaction, with the Permit2 signature when a token is sold. */
  async swapTx(quote: DexQuote, signature?: string, permitData?: any): Promise<DexCall> {
    const { permitData: _p, permitTransaction: _t, ...clean } = quote.raw;
    const body: Record<string, unknown> = { ...clean };
    if (signature && permitData) { body.signature = signature; body.permitData = permitData; }
    const ready = !signature && quote.raw.swapTransaction ? { swap: quote.raw.swapTransaction } : await this.post('/swap', body);
    return checkRouterTx(ready?.swap, quote);
  }
}

/** The transaction Uniswap built must go to the pinned router, from this wallet, with the right value. */
export function checkRouterTx(tx: any, quote: DexQuote): DexCall {
  const stop = (why: string): never => { throw new Error(`Uniswap's transaction differs from the swap (${why}), so it was not signed.`); };
  if (!tx || typeof tx.data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(tx.data) || tx.data.length < 10) stop('no call data');
  if (!tx.data.startsWith(EXECUTE)) stop('not a router call');
  if (typeof tx.to !== 'string' || !isAddress(tx.to) || !same(tx.to, UNIVERSAL_ROUTER[String(quote.chainId)])) stop('unknown contract');
  if (tx.chainId !== undefined && BigInt(tx.chainId) !== quote.chainId) stop('network');
  const value = BigInt(tx.value ?? 0);
  if (value !== (quote.tokenIn === NATIVE ? quote.amountIn : 0n)) stop('amount');
  const gas = tx.gasLimit ? BigInt(tx.gasLimit) : undefined;
  return { label: 'swap', to: getAddress(tx.to), data: tx.data, value, gas };
}

/**
 * The Permit2 message Uniswap asks to sign, narrowed: only this swap's amount, for one hour, to the pinned router.
 * The API's own offer is for the largest possible amount for a month.
 */
export function narrowPermit(permitData: any, quote: DexQuote, nowSeconds: number): any {
  const stop = (why: string): never => { throw new Error(`Uniswap's signing request differs from the swap (${why}), so it was not signed.`); };
  if (!permitData?.domain || !permitData?.types?.PermitSingle || !permitData?.values?.details) stop('missing');
  if (!same(String(permitData.domain.verifyingContract), PERMIT2)) stop('not Permit2');
  if (BigInt(permitData.domain.chainId) !== quote.chainId) stop('network');
  if (!same(String(permitData.values.spender), UNIVERSAL_ROUTER[String(quote.chainId)])) stop('spender');
  if (!same(String(permitData.values.details.token), quote.tokenIn)) stop('coin');
  return {
    ...permitData,
    values: {
      ...permitData.values,
      details: { ...permitData.values.details, amount: quote.amountIn.toString(), expiration: String(nowSeconds + 3600) },
      sigDeadline: String(nowSeconds + 1800),
    },
  };
}

// ---- PancakeSwap V2 ----

/** Paths worth trying: straight, or through BNB or USDT, the pools with the most liquidity. */
export function pancakePaths(tokenIn: string, tokenOut: string): string[][] {
  const a = tokenIn === NATIVE ? WBNB : tokenIn;
  const b = tokenOut === NATIVE ? WBNB : tokenOut;
  const paths = [[a, b]];
  for (const hub of [WBNB, USDT_BSC]) if (!same(hub, a) && !same(hub, b)) paths.push([a, hub, b]);
  return paths;
}

export async function pancakeQuote(call: (to: string, data: string) => Promise<string>, tokenIn: string, tokenOut: string, amountIn: bigint, slippageBps: number): Promise<DexQuote> {
  let best: { out: bigint; path: string[] } | null = null;
  for (const path of pancakePaths(tokenIn, tokenOut)) {
    try {
      const amounts = pancake.decodeFunctionResult('getAmountsOut', await call(PANCAKE_ROUTER, pancake.encodeFunctionData('getAmountsOut', [amountIn, path])))[0] as bigint[];
      const out = amounts[amounts.length - 1];
      if (out > 0n && (!best || out > best.out)) best = { out, path };
    } catch { /* no such pool */ }
  }
  if (!best) throw new Error('PancakeSwap has no pool for this pair.');
  return {
    provider: 'pancakeswap', chainId: 56n, tokenIn, tokenOut, amountIn, amountOut: best.out, minOut: minAfterSlippage(best.out, slippageBps),
    priceImpact: null, gasUnits: best.path.length > 2 ? 220_000n : 160_000n, spender: PANCAKE_ROUTER, path: best.path,
  };
}

export function pancakeSwapCall(q: DexQuote, to: string, deadline: number): DexCall {
  const path = q.path!;
  const data = q.tokenIn === NATIVE ? pancake.encodeFunctionData('swapExactETHForTokens', [q.minOut, path, to, deadline])
    : q.tokenOut === NATIVE ? pancake.encodeFunctionData('swapExactTokensForETH', [q.amountIn, q.minOut, path, to, deadline])
      : pancake.encodeFunctionData('swapExactTokensForTokens', [q.amountIn, q.minOut, path, to, deadline]);
  return { label: 'swap', to: PANCAKE_ROUTER, data, value: q.tokenIn === NATIVE ? q.amountIn : 0n, gas: q.gasUnits + 60_000n };
}

export const abi = AbiCoder.defaultAbiCoder();
