import type { Agent } from 'node:http';
import { HDNodeWallet, Transaction, isAddress } from 'ethers';
import { getJson, requestJson } from './request';
import { formatAmount } from './amount';

export const ETH_PATH = "m/44'/60'/0'/0/0";
const GWEI = 1_000_000_000n;
const MAX_BASE_FEE = 500n * GWEI; // a higher answer from a node is treated as broken
const MAX_TIP = 5n * GWEI;
const MIN_TIP = GWEI / 10n;
const DEFAULT_TIP = GWEI;
const MAX_GAS_TOKEN = 200_000n;
const MAX_GAS_CONTRACT = 300_000n;
const BALANCE_CACHE_MS = 20_000;
const FEE_NOTE = 'Not enough ETH to cover the amount and fee.';

export type EthAsset = 'ETH' | 'USDTE';
export interface EthDraft { asset: EthAsset; to: string; amount: bigint; gas: bigint; maxFee: bigint; tip: bigint; expectedFee: bigint; maxCost: bigint; data?: string }
export interface EthHistoryItem { asset: EthAsset; hash: string; direction: 'in' | 'out' | 'self'; amount: string; counterparty: string; timestamp: number; status: 'confirmed' | 'failed' | 'pending'; dust: boolean }

export function deriveEthAccount(mnemonic: string): { address: string; wallet: HDNodeWallet } {
  const normalized = mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
  const wallet = HDNodeWallet.fromPhrase(normalized, undefined, ETH_PATH);
  return { address: wallet.address, wallet };
}

/** Plain 0x form with a good checksum when mixed case. Also excludes ICAP, which isAddress accepts. */
export function isEthAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address) && isAddress(address) && !/^0x0{40}$/.test(address);
}

const word = (hex: string) => hex.padStart(64, '0');
const toHex = (n: bigint) => `0x${n.toString(16)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function quantity(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`The Ethereum node gave an unexpected answer (${what}).`);
  return BigInt(value);
}

export function encodeUsdtTransfer(to: string, amount: bigint): string {
  return `0xa9059cbb${word(to.slice(2).toLowerCase())}${word(amount.toString(16))}`;
}

export class EthClient {
  private readonly checked = new Set<string>();
  private balances: { at: number; eth: bigint; usdt: bigint } | null = null;

  constructor(
    private readonly rpcs: string[],
    private readonly scout: string,
    private readonly usdt: string,
    readonly address: string,
    private readonly agent?: Agent,
    private readonly timeoutMs = 15_000,
  ) {}

  private async post(url: string, method: string, params: unknown[]): Promise<any> {
    const res = await requestJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, agent: this.agent, timeoutMs: this.timeoutMs });
    if (res.body?.error) throw new Error(String(res.body.error.message ?? 'Ethereum node error'));
    if (res.status >= 400 || !res.body || !('result' in res.body)) throw new Error(`Ethereum node error (${res.status}).`);
    return res.body.result;
  }

  /** Only talks to nodes that say they are on Ethereum mainnet. */
  private async rpc(method: string, params: unknown[]): Promise<any> {
    let last: unknown;
    for (const url of this.rpcs) {
      try {
        if (!this.checked.has(url)) {
          if (quantity(await this.post(url, 'eth_chainId', []), 'chain') !== 1n) throw new Error('This is not an Ethereum mainnet node.');
          this.checked.add(url);
        }
        return await this.post(url, method, params);
      } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach an Ethereum node.');
  }

  private async readBalances(force = false): Promise<{ eth: bigint; usdt: bigint }> {
    if (!force && this.balances && Date.now() - this.balances.at < BALANCE_CACHE_MS) return this.balances;
    const [eth, usdt] = await Promise.all([
      this.rpc('eth_getBalance', [this.address, 'latest']),
      this.rpc('eth_call', [{ to: this.usdt, data: `0x70a08231${word(this.address.slice(2).toLowerCase())}` }, 'latest']),
    ]);
    this.balances = { at: Date.now(), eth: quantity(eth, 'ETH balance'), usdt: quantity(usdt, 'USDT balance') };
    return this.balances;
  }

  async getEthBalance(force = false): Promise<bigint> { return (await this.readBalances(force)).eth; }
  async getUsdtBalance(force = false): Promise<bigint> { return (await this.readBalances(force)).usdt; }

  private async fees(): Promise<{ maxFee: bigint; tip: bigint; base: bigint }> {
    const block = await this.rpc('eth_getBlockByNumber', ['latest', false]);
    const base = quantity(block?.baseFeePerGas, 'base fee');
    if (base > MAX_BASE_FEE) throw new Error('The fee is abnormally high, so this was stopped.');
    let tip = DEFAULT_TIP;
    try { tip = quantity(await this.rpc('eth_maxPriorityFeePerGas', []), 'priority fee'); } catch { /* not every node has this */ }
    tip = tip > MAX_TIP ? MAX_TIP : tip < MIN_TIP ? MIN_TIP : tip;
    return { maxFee: base * 2n + tip, tip, base };
  }

  private async estimate(tx: Record<string, string>, cap: bigint): Promise<bigint> {
    const gas = quantity(await this.rpc('eth_estimateGas', [{ from: this.address, ...tx }]), 'gas');
    const padded = (gas * 13n) / 10n;
    if (padded > cap) throw new Error('This send needs an abnormal amount of gas, so it was stopped.');
    return padded;
  }

  async draft(asset: EthAsset, to: string, amount: bigint | 'max'): Promise<EthDraft> {
    if (same(to, this.usdt)) throw new Error('You cannot send to the USDT contract address. The coins would be lost.');
    const { eth, usdt } = await this.readBalances(true);
    const { maxFee, tip, base } = await this.fees();
    let gas: bigint;
    let value: bigint;
    if (asset === 'USDTE') {
      value = amount === 'max' ? usdt : amount;
      if (value <= 0n) throw new Error('No USDT to send.');
      if (value > usdt) throw new Error('Not enough USDT.');
      if (eth === 0n) throw new Error('No ETH for the fee. Sending USDT (Eth) needs ETH at this address.');
      gas = await this.estimate({ to: this.usdt, data: encodeUsdtTransfer(to, value), value: '0x0' }, MAX_GAS_TOKEN);
      if (gas * maxFee > eth) throw new Error(`Not enough ETH for the fee. Up to ${formatAmount(gas * maxFee, 18)} ETH is needed, and there is ${formatAmount(eth, 18)} ETH.`);
    } else {
      const code = await this.rpc('eth_getCode', [to, 'latest']);
      gas = code === '0x' || code === '0x0' ? 21_000n : await this.estimate({ to, value: '0x0' }, MAX_GAS_CONTRACT);
      value = amount === 'max' ? eth - gas * maxFee : amount;
      if (value <= 0n) throw new Error('No ETH left to send after the fee.');
      if (value + gas * maxFee > eth) throw new Error(FEE_NOTE);
    }
    return { asset, to, amount: value, gas, maxFee, tip, expectedFee: gas * (base + tip), maxCost: gas * maxFee };
  }

  async blockNumber(): Promise<number> { return Number(quantity(await this.rpc('eth_blockNumber', []), 'block')); }
  async call(to: string, data: string): Promise<string> { return this.rpc('eth_call', [{ to, data }, 'latest']); }
  async logs(address: string, topic: string, from: number, to: number): Promise<any[]> {
    const res = await this.rpc('eth_getLogs', [{ address, topics: [topic], fromBlock: toHex(BigInt(from)), toBlock: toHex(BigInt(to)) }]);
    if (!Array.isArray(res)) throw new Error('The Ethereum node gave an unexpected answer (logs).');
    return res;
  }

  /** A contract call with a set gas limit, for when the final call data only exists after the password. */
  async draftCall(to: string, value: bigint, gas: bigint): Promise<EthDraft> {
    const eth = quantity(await this.rpc('eth_getBalance', [this.address, 'latest']), 'ETH balance');
    const { maxFee, tip, base } = await this.fees();
    if (value + gas * maxFee > eth) throw new Error(`Not enough ETH to cover the fee. Up to ${formatAmount(value + gas * maxFee, 18)} ETH is needed.`);
    return { asset: 'ETH', to, amount: value, gas, maxFee, tip, expectedFee: gas * (base + tip), maxCost: gas * maxFee };
  }

  async typicalFee(gas: bigint): Promise<bigint> {
    const { base, tip } = await this.fees();
    return gas * (base + tip);
  }

  async gasPrice(): Promise<bigint> { return (await this.fees()).maxFee; }

  async send(draft: EthDraft, wallet: HDNodeWallet): Promise<string> {
    if (wallet.address !== this.address) throw new Error('The wallet address does not match, so this was stopped.');
    const token = draft.asset === 'USDTE';
    const nonce = quantity(await this.rpc('eth_getTransactionCount', [this.address, 'pending']), 'nonce');
    const tx = {
      type: 2, chainId: 1, nonce: Number(nonce),
      to: token ? this.usdt : draft.to,
      value: token ? 0n : draft.amount,
      data: token ? encodeUsdtTransfer(draft.to, draft.amount) : draft.data ?? '0x',
      gasLimit: draft.gas, maxFeePerGas: draft.maxFee, maxPriorityFeePerGas: draft.tip,
    };
    const raw = await wallet.signTransaction(tx);
    const parsed = Transaction.from(raw);
    if (parsed.chainId !== 1n || parsed.from !== this.address || !same(parsed.to ?? '', tx.to) || parsed.value !== tx.value || parsed.data !== tx.data) {
      throw new Error('The signed transaction differs from the request, so this was stopped.');
    }
    try {
      await this.rpc('eth_sendRawTransaction', [raw]);
    } catch (e) {
      // The fallback node may already have it from the first attempt.
      if (!/already known|known transaction/i.test((e as Error).message)) throw e;
    }
    this.balances = null;
    return parsed.hash as string;
  }

  /** Blockscout: the one public Ethereum history API that needs no key. */
  async getHistory(asset: EthAsset, limit = 30): Promise<EthHistoryItem[]> {
    const path = asset === 'ETH'
      ? `/addresses/${this.address}/transactions`
      : `/addresses/${this.address}/token-transfers?type=ERC-20&token=${this.usdt}`;
    const body = await getJson(this.scout + path, { agent: this.agent, timeoutMs: this.timeoutMs });
    const rows: any[] = Array.isArray(body?.items) ? body.items : [];
    const out: EthHistoryItem[] = [];
    for (const r of rows) {
      const hash = r.hash ?? r.transaction_hash ?? r.tx_hash;
      const from = r.from?.hash;
      const to = r.to?.hash;
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash) || typeof from !== 'string' || typeof to !== 'string') continue;
      const mineFrom = same(from, this.address);
      const mineTo = same(to, this.address);
      if (!mineFrom && !mineTo) continue;
      let value: bigint;
      try { value = BigInt(asset === 'ETH' ? r.value : r.total?.value); } catch { continue; }
      if (asset === 'USDTE') {
        const token = r.token?.address_hash ?? r.token?.address;
        if (typeof token !== 'string' || !same(token, this.usdt)) continue; // look-alike tokens are not USDT
      }
      if (value === 0n) continue; // zero transfers are address poisoning or contract calls
      const decimals = asset === 'ETH' ? 18 : 6;
      const direction = mineFrom && mineTo ? 'self' : mineFrom ? 'out' : 'in';
      const dust = direction === 'in' && value < (asset === 'ETH' ? 100_000_000_000_000n : 100_000n);
      const failed = r.status === 'error' || (typeof r.result === 'string' && r.result !== 'success' && r.result !== 'pending' && r.result !== '');
      const pending = r.result === 'pending' || r.status === null;
      out.push({
        asset, hash, direction, dust,
        amount: formatAmount(value, decimals),
        counterparty: mineFrom ? to : from,
        timestamp: Date.parse(r.timestamp) || Date.now(),
        status: failed ? 'failed' : pending ? 'pending' : 'confirmed',
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}
