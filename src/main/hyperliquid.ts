import type { Agent } from 'node:http';
import { BaseWallet, Signature } from 'ethers';
import { requestForm } from './request';

/**
 * HYPE lives in two places on the same addresses: HyperCore (Hyperliquid's own ledger) and HyperEVM (chain
 * 999, where this wallet holds it). This file only moves HYPE between them; the wallet does no trading.
 */

export const HL_API = 'https://api.hyperliquid.xyz';
/** User-signed actions name the chain the wallet signs on; any chain works, this is Arbitrum's. */
const SIGNATURE_CHAIN = '0xa4b1';
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * This system address moves HYPE between the two: native HYPE sent to it on HyperEVM lands on HyperCore, and HYPE
 * spot-sent to it on HyperCore lands on HyperEVM.
 */
export const HYPE_SYSTEM = '0x2222222222222222222222222222222222222222';
/** HyperCore takes the HyperEVM gas for a move (200k gas, a tiny amount of HYPE) from the HYPE left there. */
export const HYPE_CORE_RESERVE = 0.001;

export interface HlSignature { r: string; s: string; v: number }
const split = (sig: string): HlSignature => { const s = Signature.from(sig); return { r: s.r, s: s.s, v: s.v }; };

const SPOT_SEND = [{ name: 'hyperliquidChain', type: 'string' }, { name: 'destination', type: 'string' }, { name: 'token', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'time', type: 'uint64' }];

/** A spot send, signed by the wallet's own key as readable typed data. */
export async function signSpotSend(wallet: BaseWallet, action: Record<string, any>): Promise<HlSignature> {
  if (action.type !== 'spotSend') throw new Error(`Unknown Hyperliquid action ${action.type}`);
  const sig = await wallet.signTypedData(
    { name: 'HyperliquidSignTransaction', version: '1', chainId: Number(action.signatureChainId), verifyingContract: ZERO },
    { 'HyperliquidTransaction:SpotSend': SPOT_SEND },
    action,
  );
  return split(sig);
}

export class HlError extends Error {}

export class HlClient {
  private lastNonce = 0;
  constructor(readonly user: string, private readonly opts: { api?: string; agent?: Agent; timeoutMs?: number } = {}) {}

  private get api() { return this.opts.api ?? HL_API; }

  private async post(path: string, body: unknown): Promise<any> {
    const send = () => requestForm(`${this.api}${path}`, { method: 'POST', json: JSON.stringify(body), agent: this.opts.agent, timeoutMs: this.opts.timeoutMs ?? 20_000 });
    let r = await send();
    // Hyperliquid limits requests per address; one short wait usually clears it.
    if (r.status === 429) { await new Promise((ok) => setTimeout(ok, 1500)); r = await send(); }
    if (r.status === 429) throw new HlError('Hyperliquid is busy. Try again in a moment.');
    if (r.status >= 400) throw new HlError(`Hyperliquid: ${typeof r.body === 'string' && r.body ? r.body.slice(0, 200) : `error ${r.status}`}`);
    return r.body;
  }

  private info(body: Record<string, unknown>): Promise<any> { return this.post('/info', body); }

  /** Milliseconds, never the same twice. */
  private nonce(): number {
    const n = Math.max(Date.now(), this.lastNonce + 1);
    this.lastNonce = n;
    return n;
  }

  /** HYPE on HyperCore's spot side for this address. */
  async hypeOnCore(): Promise<{ total: number; hold: number; available: number }> {
    const r = await this.info({ type: 'spotClearinghouseState', user: this.user });
    const b = (r?.balances ?? []).find((x: any) => x.coin === 'HYPE');
    const total = Number(b?.total ?? 0);
    const hold = Number(b?.hold ?? 0);
    return { total, hold, available: Math.max(0, total - hold) };
  }

  /** HyperCore's name for HYPE, read from its token list rather than written in. */
  private async hypeToken(): Promise<string> {
    const meta = await this.info({ type: 'spotMeta' });
    const t = (meta?.tokens ?? []).find((x: any) => x.name === 'HYPE');
    if (!t?.tokenId) throw new HlError('HyperCore did not list HYPE right now. Try again.');
    return `HYPE:${t.tokenId}`;
  }

  /** HyperCore to HyperEVM: a spot send to the system address, signed by the wallet's own key. */
  async hypeToEvm(main: BaseWallet, amount: string): Promise<void> {
    if (main.address.toLowerCase() !== this.user.toLowerCase()) throw new Error('The wallet address does not match, so this was stopped.');
    const action = { type: 'spotSend', signatureChainId: SIGNATURE_CHAIN, hyperliquidChain: 'Mainnet', destination: HYPE_SYSTEM, token: await this.hypeToken(), amount, time: this.nonce() };
    const r = await this.post('/exchange', { action, nonce: action.time, signature: await signSpotSend(main, action), vaultAddress: null, expiresAfter: null });
    if (r?.status !== 'ok') throw new HlError(`Hyperliquid: ${typeof r?.response === 'string' ? r.response : JSON.stringify(r).slice(0, 200)}`);
  }
}
