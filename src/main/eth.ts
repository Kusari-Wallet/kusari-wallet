import type { Agent } from 'node:http';
import { HDNodeWallet, Transaction, isAddress } from 'ethers';
import { getJson, requestJson } from './request';
import { formatAmount } from './amount';

export const ETH_PATH = "m/44'/60'/0'/0/0";
const GWEI = 1_000_000_000n;
const BALANCE_CACHE_MS = 20_000;

export type EthAsset = 'ETH' | 'USDTE' | 'LINK' | 'WLD' | 'ETHP' | 'UNI' | 'PEPE' | 'AAVE' | 'NEARE' | 'POL' | 'USDTP' | 'ETHA' | 'ARB' | 'USDTA' | 'BNB' | 'USDTB' | 'ASTER' | 'CAKE';
export interface EvmToken { contract: string; decimals: number; symbol: string; label: string; dust: bigint }
/** One EVM chain. The same key and address serve all of them, so the chain id is what keeps them apart. */
export interface EvmChain {
  id: bigint; name: string; native: EthAsset; symbol: string; nativeLabel: string;
  tokens: Partial<Record<EthAsset, EvmToken>>;
  // A higher fee answer from a node is treated as broken.
  maxBaseFee: bigint; minTip: bigint; defaultTip: bigint; maxTip: bigint;
  gasToken: bigint; gasContract: bigint; dust: bigint;
}

export const ETHEREUM: EvmChain = {
  id: 1n, name: 'Ethereum', native: 'ETH', symbol: 'ETH', nativeLabel: 'ETH',
  tokens: {
    USDTE: { contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, symbol: 'USDT', label: 'USDT (Eth)', dust: 100_000n },
    LINK: { contract: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18, symbol: 'LINK', label: 'LINK', dust: 10_000_000_000_000_000n },
    WLD: { contract: '0x163f8C2467924be0ae7B5347228CABF260318753', decimals: 18, symbol: 'WLD', label: 'WLD', dust: 10_000_000_000_000_000n },
    // Contracts from Uniswap's default token list; NEAR's from MetaMask's contract metadata (Rainbow Bridge, 24 decimals).
    UNI: { contract: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18, symbol: 'UNI', label: 'UNI', dust: 1_000_000_000_000_000n },
    PEPE: { contract: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', decimals: 18, symbol: 'PEPE', label: 'PEPE', dust: 10_000_000_000_000_000_000_000n },
    AAVE: { contract: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', decimals: 18, symbol: 'AAVE', label: 'AAVE', dust: 100_000_000_000_000n },
    NEARE: { contract: '0x85F17Cf997934a597031b2E18a9aB6ebD4B9f6a4', decimals: 24, symbol: 'NEAR', label: 'NEAR', dust: 1_000_000_000_000_000_000_000n },
  },
  maxBaseFee: 500n * GWEI, minTip: GWEI / 10n, defaultTip: GWEI, maxTip: 5n * GWEI, gasToken: 200_000n, gasContract: 300_000n, dust: 100_000_000_000_000n,
};
// Polygon needs a priority fee of about 25 gwei or more, and its base fee can spike far above Ethereum's.
export const POLYGON: EvmChain = {
  id: 137n, name: 'Polygon', native: 'POL', symbol: 'POL', nativeLabel: 'POL',
  tokens: {
    USDTP: { contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, symbol: 'USDT', label: 'USDT (Pol)', dust: 100_000n },
    // Bridged ETH (WETH) on Polygon, as Aave's address book lists it.
    ETHP: { contract: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18, symbol: 'ETH', label: 'ETH (Pol)', dust: 10_000_000_000_000n },
  },
  maxBaseFee: 20_000n * GWEI, minTip: 30n * GWEI, defaultTip: 30n * GWEI, maxTip: 500n * GWEI, gasToken: 200_000n, gasContract: 300_000n, dust: 10_000_000_000_000_000n,
};
// Arbitrum pays in ETH, needs no tip, and folds its Ethereum data cost into the gas amount, so limits are higher.
export const ARBITRUM: EvmChain = {
  id: 42161n, name: 'Arbitrum', native: 'ETHA', symbol: 'ETH', nativeLabel: 'ETH (Arb)',
  tokens: {
    ARB: { contract: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18, symbol: 'ARB', label: 'ARB', dust: 10_000_000_000_000_000n },
    USDTA: { contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6, symbol: 'USDT', label: 'USDT (Arb)', dust: 100_000n },
  },
  maxBaseFee: 100n * GWEI, minTip: 0n, defaultTip: 0n, maxTip: GWEI, gasToken: 3_000_000n, gasContract: 3_000_000n, dust: 10_000_000_000_000n,
};
// BNB Smart Chain: no base fee, validators take a small fixed tip. USDT here has 18 decimals, unlike elsewhere.
// Contracts from PancakeSwap's token list; ASTER's from Trust Wallet's asset list.
export const BSC: EvmChain = {
  id: 56n, name: 'BNB Smart Chain', native: 'BNB', symbol: 'BNB', nativeLabel: 'BNB',
  tokens: {
    USDTB: { contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, symbol: 'USDT', label: 'USDT (BNB)', dust: 100_000_000_000_000_000n },
    ASTER: { contract: '0x000Ae314E2A2172a039B26378814C252734f556A', decimals: 18, symbol: 'ASTER', label: 'ASTER', dust: 10_000_000_000_000_000n },
    CAKE: { contract: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18, symbol: 'CAKE', label: 'CAKE', dust: 10_000_000_000_000_000n },
  },
  maxBaseFee: 10n * GWEI, minTip: GWEI / 10n, defaultTip: GWEI / 10n, maxTip: 10n * GWEI, gasToken: 200_000n, gasContract: 300_000n, dust: 10_000_000_000_000n,
};
export const EVM_CHAINS = [ETHEREUM, POLYGON, ARBITRUM, BSC];
export const chainOf = (asset: EthAsset): EvmChain => EVM_CHAINS.find((c) => c.native === asset || asset in c.tokens) as EvmChain;
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
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`The node gave an unexpected answer (${what}).`);
  return BigInt(value);
}

export function encodeUsdtTransfer(to: string, amount: bigint): string {
  return `0xa9059cbb${word(to.slice(2).toLowerCase())}${word(amount.toString(16))}`;
}

export class EthClient {
  private readonly checked = new Set<string>();
  private balances: { at: number; native: bigint; tokens: Map<EthAsset, bigint> } | null = null;
  private readonly tokens: Partial<Record<EthAsset, EvmToken>>;
  private readonly usdt: string;

  /** usdt replaces the chain's USDT contract, for test runs against a mock token. */
  constructor(
    private readonly rpcs: string[],
    private readonly scout: string,
    usdt: string,
    readonly address: string,
    private readonly agent?: Agent,
    private readonly timeoutMs = 15_000,
    readonly chain: EvmChain = ETHEREUM,
  ) {
    const usdtAsset = (Object.keys(chain.tokens) as EthAsset[]).find((a) => chain.tokens[a]!.symbol === 'USDT') as EthAsset;
    this.tokens = { ...chain.tokens, [usdtAsset]: { ...chain.tokens[usdtAsset]!, contract: usdt || chain.tokens[usdtAsset]!.contract } };
    this.usdt = this.tokens[usdtAsset]!.contract;
  }

  private token(asset: EthAsset): EvmToken | undefined { return this.tokens[asset]; }
  /** Every token contract on this chain: sending to one loses the coins. */
  isTokenContract(address: string): boolean { return Object.values(this.tokens).some((t) => same(t!.contract, address)); }

  private async post(url: string, method: string, params: unknown[]): Promise<any> {
    const res = await requestJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, agent: this.agent, timeoutMs: this.timeoutMs });
    if (res.body?.error) throw new Error(String(res.body.error.message ?? `${this.chain.name} node error`));
    if (res.status >= 400 || !res.body || !('result' in res.body)) throw new Error(`${this.chain.name} node error (${res.status}).`);
    return res.body.result;
  }

  /** Only talks to nodes that say they are on this chain. */
  private async rpc(method: string, params: unknown[]): Promise<any> {
    let last: unknown;
    for (const url of this.rpcs) {
      try {
        if (!this.checked.has(url)) {
          if (quantity(await this.post(url, 'eth_chainId', []), 'chain') !== this.chain.id) throw new Error(`This node is not on ${this.chain.name} mainnet.`);
          this.checked.add(url);
        }
        return await this.post(url, method, params);
      } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error(`Could not reach a ${this.chain.name} node.`);
  }

  private async readBalances(force = false): Promise<{ native: bigint; tokens: Map<EthAsset, bigint> }> {
    if (!force && this.balances && Date.now() - this.balances.at < BALANCE_CACHE_MS) return this.balances;
    const list = Object.entries(this.tokens) as [EthAsset, EvmToken][];
    const [native, ...held] = await Promise.all([
      this.rpc('eth_getBalance', [this.address, 'latest']),
      ...list.map(([, t]) => this.rpc('eth_call', [{ to: t.contract, data: `0x70a08231${word(this.address.slice(2).toLowerCase())}` }, 'latest'])),
    ]);
    this.balances = { at: Date.now(), native: quantity(native, `${this.chain.symbol} balance`), tokens: new Map(list.map(([a, t], i) => [a, quantity(held[i], `${t.symbol} balance`)])) };
    return this.balances;
  }

  async getEthBalance(force = false): Promise<bigint> { return (await this.readBalances(force)).native; }
  async getUsdtBalance(force = false): Promise<bigint> { return (await this.readBalances(force)).tokens.get((Object.keys(this.tokens) as EthAsset[]).find((a) => same(this.tokens[a]!.contract, this.usdt))!) ?? 0n; }
  /** The balance of this chain's coin or one of its tokens. */
  async balanceOf(asset: EthAsset, force = false): Promise<bigint> {
    const b = await this.readBalances(force);
    return asset === this.chain.native ? b.native : b.tokens.get(asset) ?? 0n;
  }

  private async fees(): Promise<{ maxFee: bigint; tip: bigint; base: bigint }> {
    const block = await this.rpc('eth_getBlockByNumber', ['latest', false]);
    const base = quantity(block?.baseFeePerGas, 'base fee');
    const c = this.chain;
    if (base > c.maxBaseFee) throw new Error('The fee is abnormally high, so this was stopped.');
    let tip = c.defaultTip;
    try { tip = quantity(await this.rpc('eth_maxPriorityFeePerGas', []), 'priority fee'); } catch { /* not every node has this */ }
    tip = tip > c.maxTip ? c.maxTip : tip < c.minTip ? c.minTip : tip;
    return { maxFee: base * 2n + tip, tip, base };
  }

  private async estimate(tx: Record<string, string>, cap: bigint): Promise<bigint> {
    const gas = quantity(await this.rpc('eth_estimateGas', [{ from: this.address, ...tx }]), 'gas');
    const padded = (gas * 13n) / 10n;
    if (padded > cap) throw new Error('This send needs an abnormal amount of gas, so it was stopped.');
    return padded;
  }

  async draft(asset: EthAsset, to: string, amount: bigint | 'max'): Promise<EthDraft> {
    const c = this.chain;
    if (this.isTokenContract(to)) throw new Error('You cannot send to a token contract address. The coins would be lost.');
    const { native, tokens } = await this.readBalances(true);
    const { maxFee, tip, base } = await this.fees();
    const token = this.token(asset);
    let gas: bigint;
    let value: bigint;
    if (token) {
      const held = tokens.get(asset) ?? 0n;
      value = amount === 'max' ? held : amount;
      if (value <= 0n) throw new Error(`No ${token.symbol} to send.`);
      if (value > held) throw new Error(`Not enough ${token.symbol}.`);
      if (native === 0n) throw new Error(`No ${c.symbol} for the fee. Sending ${token.label} needs ${c.nativeLabel} at this address.`);
      gas = await this.estimate({ to: token.contract, data: encodeUsdtTransfer(to, value), value: '0x0' }, c.gasToken);
      if (gas * maxFee > native) throw new Error(`Not enough ${c.symbol} for the fee. Up to ${formatAmount(gas * maxFee, 18)} ${c.symbol} is needed, and there is ${formatAmount(native, 18)} ${c.symbol}.`);
    } else {
      if (asset !== c.native) throw new Error('This coin is not on this network.');
      const code = await this.rpc('eth_getCode', [to, 'latest']);
      // Arbitrum's gas amount includes its data cost, so even a plain transfer is estimated there.
      gas = (code === '0x' || code === '0x0') && c.id !== ARBITRUM.id ? 21_000n : await this.estimate({ to, value: '0x0' }, c.gasContract);
      value = amount === 'max' ? native - gas * maxFee : amount;
      if (value <= 0n) throw new Error(`No ${c.symbol} left to send after the fee.`);
      if (value + gas * maxFee > native) throw new Error(`Not enough ${c.symbol} to cover the amount and fee.`);
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
    const eth = quantity(await this.rpc('eth_getBalance', [this.address, 'latest']), `${this.chain.symbol} balance`);
    const { maxFee, tip, base } = await this.fees();
    if (value + gas * maxFee > eth) throw new Error(`Not enough ETH to cover the fee. Up to ${formatAmount(value + gas * maxFee, 18)} ETH is needed.`);
    return { asset: this.chain.native, to, amount: value, gas, maxFee, tip, expectedFee: gas * (base + tip), maxCost: gas * maxFee };
  }

  /** How much of a token a contract may take from this wallet. */
  async allowance(token: string, spender: string): Promise<bigint> {
    const hex = await this.call(token, `0xdd62ed3e${word(this.address.slice(2).toLowerCase())}${word(spender.slice(2).toLowerCase())}`);
    return quantity(hex === '0x' ? '0x0' : hex, 'allowance');
  }

  /** What a run of contract calls costs at today's fees: the most it can cost, and what it will likely cost. */
  async costOf(calls: { value: bigint; gas?: bigint }[], fallbackGas: bigint): Promise<{ maxFee: bigint; tip: bigint; most: bigint; likely: bigint; value: bigint }> {
    const { maxFee, tip, base } = await this.fees();
    const gas = calls.reduce((s, c) => s + (c.gas ?? fallbackGas), 0n);
    return { maxFee, tip, most: gas * maxFee, likely: gas * (base + tip), value: calls.reduce((s, c) => s + c.value, 0n) };
  }

  /**
   * Contract calls in order, signed with consecutive nonces and sent one after the other, so an approval is in the
   * queue before the swap that needs it. Returns each hash.
   */
  async sendCalls(calls: { to: string; data: string; value: bigint; gas?: bigint }[], wallet: HDNodeWallet, fallbackGas: bigint): Promise<string[]> {
    if (wallet.address !== this.address) throw new Error('The wallet address does not match, so this was stopped.');
    const { maxFee, tip } = await this.fees();
    const balance = quantity(await this.rpc('eth_getBalance', [this.address, 'latest']), `${this.chain.symbol} balance`);
    const need = calls.reduce((s, c) => s + c.value + (c.gas ?? fallbackGas) * maxFee, 0n);
    if (need > balance) throw new Error(`Not enough ${this.chain.symbol} for the amount and fees. Up to ${formatAmount(need, 18)} ${this.chain.symbol} is needed.`);
    let nonce = quantity(await this.rpc('eth_getTransactionCount', [this.address, 'pending']), 'nonce');
    const hashes: string[] = [];
    for (const c of calls) {
      const tx = { type: 2, chainId: Number(this.chain.id), nonce: Number(nonce), to: c.to, value: c.value, data: c.data, gasLimit: c.gas ?? fallbackGas, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
      const raw = await wallet.signTransaction(tx);
      const parsed = Transaction.from(raw);
      if (parsed.chainId !== this.chain.id || parsed.from !== this.address || !same(parsed.to ?? '', c.to) || parsed.value !== c.value || parsed.data !== c.data) {
        throw new Error('The signed transaction differs from the request, so this was stopped.');
      }
      try {
        await this.rpc('eth_sendRawTransaction', [raw]);
      } catch (e) {
        if (!/already known|known transaction/i.test((e as Error).message)) throw new Error(`${hashes.length ? `${hashes.length} of ${calls.length} sent (${hashes.join(', ')}), then: ` : ''}${(e as Error).message}`);
      }
      hashes.push(parsed.hash as string);
      nonce += 1n;
    }
    this.balances = null;
    return hashes;
  }

  async typicalFee(gas: bigint): Promise<bigint> {
    const { base, tip } = await this.fees();
    return gas * (base + tip);
  }

  async gasPrice(): Promise<bigint> { return (await this.fees()).maxFee; }

  async send(draft: EthDraft, wallet: HDNodeWallet): Promise<string> {
    if (wallet.address !== this.address) throw new Error('The wallet address does not match, so this was stopped.');
    const token = this.token(draft.asset);
    if (!token && draft.asset !== this.chain.native) throw new Error('This coin is not on this network.');
    const nonce = quantity(await this.rpc('eth_getTransactionCount', [this.address, 'pending']), 'nonce');
    const tx = {
      type: 2, chainId: Number(this.chain.id), nonce: Number(nonce),
      to: token ? token.contract : draft.to,
      value: token ? 0n : draft.amount,
      data: token ? encodeUsdtTransfer(draft.to, draft.amount) : draft.data ?? '0x',
      gasLimit: draft.gas, maxFeePerGas: draft.maxFee, maxPriorityFeePerGas: draft.tip,
    };
    const raw = await wallet.signTransaction(tx);
    const parsed = Transaction.from(raw);
    if (parsed.chainId !== this.chain.id || parsed.from !== this.address || !same(parsed.to ?? '', tx.to) || parsed.value !== tx.value || parsed.data !== tx.data) {
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

  /** Etherscan's API shape, as Routescan serves it without a key, for chains Blockscout doesn't run. */
  private async historyEtherscan(asset: EthAsset, token: EvmToken | undefined, limit: number): Promise<EthHistoryItem[]> {
    const q = new URLSearchParams({ module: 'account', action: token ? 'tokentx' : 'txlist', address: this.address, page: '1', offset: String(limit * 2), sort: 'desc', ...(token ? { contractaddress: token.contract } : {}) });
    const body = await getJson(`${this.scout}?${q}`, { agent: this.agent, timeoutMs: this.timeoutMs });
    // "No transactions found" comes back as status 0 with an empty list.
    const rows: any[] = Array.isArray(body?.result) ? body.result : [];
    if (!Array.isArray(body?.result) && !/no transactions/i.test(String(body?.message))) throw new Error('The history server gave an unexpected answer.');
    const out: EthHistoryItem[] = [];
    for (const r of rows) {
      const { hash, from, to } = r ?? {};
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash) || typeof from !== 'string' || typeof to !== 'string') continue;
      const mineFrom = same(from, this.address);
      const mineTo = same(to, this.address);
      if (!mineFrom && !mineTo) continue;
      if (token && (typeof r.contractAddress !== 'string' || !same(r.contractAddress, token.contract))) continue; // look-alike tokens are not the real one
      let value: bigint;
      try { value = BigInt(r.value); } catch { continue; }
      if (value === 0n) continue;
      const direction = mineFrom && mineTo ? 'self' : mineFrom ? 'out' : 'in';
      out.push({
        asset, hash, direction,
        dust: direction === 'in' && value < (token ? token.dust : this.chain.dust),
        amount: formatAmount(value, token ? token.decimals : 18),
        counterparty: mineFrom ? to : from,
        timestamp: Number(r.timeStamp) * 1000 || Date.now(),
        status: r.isError === '1' || r.txreceipt_status === '0' ? 'failed' : 'confirmed',
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Blockscout: the one public EVM history API that needs no key. */
  async getHistory(asset: EthAsset, limit = 30): Promise<EthHistoryItem[]> {
    const token = this.token(asset);
    const native = !token;
    const path = native
      ? `/addresses/${this.address}/transactions`
      : `/addresses/${this.address}/token-transfers?type=ERC-20&token=${token.contract}`;
    if (!this.scout) return [];
    if (this.scout.includes('/etherscan/api')) return this.historyEtherscan(asset, token, limit);
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
      try { value = BigInt(native ? r.value : r.total?.value); } catch { continue; }
      if (token) {
        const contract = r.token?.address_hash ?? r.token?.address;
        if (typeof contract !== 'string' || !same(contract, token.contract)) continue; // look-alike tokens are not the real one
      }
      if (value === 0n) continue; // zero transfers are address poisoning or contract calls
      const decimals = token ? token.decimals : 18;
      const direction = mineFrom && mineTo ? 'self' : mineFrom ? 'out' : 'in';
      const dust = direction === 'in' && value < (token ? token.dust : this.chain.dust);
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
