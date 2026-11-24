// The wallet service, last layer (WalletService): swaps through services and on chain, and privacy swaps.
import { isTonAddress } from './ton';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { formatAmount, parseAmount } from './amount';
import { Asset, DECIMALS } from './config';
import { isTronAddress } from './tron';
import { socksAgent, newTorRoute } from './request';
import { DexCall, DexId, DexQuote, NATIVE, UNISWAP_CHAINS, UniswapClient, approvalCalls, narrowPermit, pancakeQuote, pancakeSwapCall } from './dex';
import { isBtcAddress, isLtcAddress } from './btc';
import { isArrrAddress } from './arrr';
import { isMwebAddress } from './mweb';
import { isSparkAddress } from './spark';
import { isZanoAddress } from './zano';
import { isZecAddress } from './zec';
import { isFiroAddress } from './firo';
import { isDogeAddress } from './doge';
import { isDcrAddress } from './dcr';
import { isBchAddress, normalBchAddress } from './bch';
import { isSolAddress } from './sol';
import { isDashAddress } from './dash';
import { BSC, EvmChain, EthAsset, chainOf, isEthAddress } from './eth';
import { BUILTIN_SWAP_KEYS, CCECASH_BASE, CHANGENOW_BASE, CceCashClient, ChangeNowClient, PEGASUS_BASE, PegasusClient, ETZSWAP_BASE, EtzSwapClient, GHOSTSWAP_BASE, GhostSwapClient, PRIVACY_ASSETS, PrivacySwap, SIMPLESWAP_BASE, SWAP_BASE, SWAP_DEAD, SWAP_DONE, SimpleSwapClient, SwapClient, SwapProvider, SwapProviderId, SwapRecord } from './swap';
import { QUOTE_DEADLINE_MS, QUOTE_DEADLINE_TOR_MS, QUOTE_EXTRAS_MS, SWAP_NAMES, within, isSpl, isEvm, ASSET_LABEL, swapCost } from './service-common';
import { SendService } from './service-send';
export { checkOwnServer, isLocalServer, lookupRetryDelay, swapCost } from './service-common';
export type { BalanceView } from './service-common';

export class WalletService extends SendService {
  // ---- swap ----

  /** Exolix needs no key. The others join once their key is in settings. */
  protected swapClients(): Partial<Record<SwapProviderId, SwapProvider>> {
    const timeout = this.torActive ? 60_000 : 30_000;
    const clients: Partial<Record<SwapProviderId, SwapProvider>> = {
      exolix: new SwapClient(this.dev.swapBase ?? SWAP_BASE, this.priceAgent, timeout),
    };
    // Test runs point at mock services and choose their own keys. Real runs use the keys shipped with the app.
    const keys = this.dev.swapBase ? { simpleswap: this.settings.simpleSwapKey, ghostswap: this.settings.ghostSwapKey } : BUILTIN_SWAP_KEYS;
    if (keys.simpleswap) clients.simpleswap = new SimpleSwapClient(this.dev.simpleSwapBase ?? SIMPLESWAP_BASE, keys.simpleswap, this.priceAgent, timeout);
    if (keys.ghostswap) clients.ghostswap = new GhostSwapClient(this.dev.ghostSwapBase ?? GHOSTSWAP_BASE, keys.ghostswap, this.priceAgent, timeout);
    // Reading orders needs these keys too, so a test run only gets them by asking for that service.
    const built = this.dev.swapBase ? null : BUILTIN_SWAP_KEYS;
    const etz = this.dev.etzSwapBase ? { key: 'etz-key', secret: 'etz-secret' } : built && { key: built.etzswapKey, secret: built.etzswapSecret, version: built.etzswapVersion };
    if (etz?.key && etz.secret) clients.etzswap = new EtzSwapClient(this.dev.etzSwapBase ?? ETZSWAP_BASE, etz.key, etz.secret, this.priceAgent, timeout, (etz as { version?: string }).version);
    const cce = this.dev.cceCashBase ? { key: 'cce-key', secret: 'cce-secret', ref: 'REF' } : built && { key: built.ccecashKey, secret: built.ccecashSecret, ref: built.ccecashRefCode };
    if (cce?.key && cce.secret) clients.ccecash = new CceCashClient(this.dev.cceCashBase ?? CCECASH_BASE, cce.key, cce.secret, cce.ref, this.priceAgent, timeout);
    const changenow = this.dev.changeNowBase ? 'cn-key' : built?.changenow;
    if (changenow) clients.changenow = new ChangeNowClient(this.dev.changeNowBase ?? CHANGENOW_BASE, changenow, this.priceAgent, timeout);
    const peg = this.dev.pegasusBase ? { key: 'peg-key', secret: 'peg-secret' } : built && { key: built.pegasusKey, secret: built.pegasusSecret };
    if (peg?.key && peg.secret) clients.pegasus = new PegasusClient(this.dev.pegasusBase ?? PEGASUS_BASE, peg.key, peg.secret, this.priceAgent, timeout);
    return clients;
  }
  // ---- swaps on the chain itself (Uniswap, PancakeSwap) ----

  /** The chain both coins sit on, or null when a DEX can't swap them. */
  protected dexChain(from: Asset, to: Asset): EvmChain | null {
    if (from === to || !isEvm(from) || !isEvm(to)) return null;
    const a = chainOf(from as EthAsset);
    return a === chainOf(to as EthAsset) ? a : null;
  }

  protected tokenAddress(asset: Asset): string {
    const chain = chainOf(asset as EthAsset);
    return asset === chain.native ? NATIVE : chain.tokens[asset as EthAsset]!.contract;
  }

  protected uniswap(): UniswapClient | null {
    const key = this.dev.uniswapKey ?? BUILTIN_SWAP_KEYS.uniswap;
    return key ? new UniswapClient(key, this.priceAgent, this.torActive ? 40_000 : 20_000, this.dev.uniswapBase) : null;
  }

  protected async dexQuotes(from: Asset, to: Asset, amountIn: bigint, slippageBps: number): Promise<{ id: DexId; quote?: DexQuote; problem?: string }[]> {
    const chain = this.dexChain(from, to);
    if (!chain) return [];
    const client = this.evm(from);
    const tokenIn = this.tokenAddress(from);
    const tokenOut = this.tokenAddress(to);
    const asks: Promise<{ id: DexId; quote?: DexQuote; problem?: string }>[] = [];
    const uni = this.uniswap();
    if (uni && UNISWAP_CHAINS.includes(chain.id)) asks.push(uni.quote(chain.id, tokenIn, tokenOut, amountIn, client.address, slippageBps).then((quote) => ({ id: 'uniswap' as const, quote }), (e) => ({ id: 'uniswap' as const, problem: (e as Error).message })));
    if (chain.id === BSC.id) asks.push(pancakeQuote((to2, data) => client.call(to2, data), tokenIn, tokenOut, amountIn, slippageBps).then((quote) => ({ id: 'pancakeswap' as const, quote }), (e) => ({ id: 'pancakeswap' as const, problem: (e as Error).message })));
    return Promise.all(asks);
  }

  /** Same-chain swap quotes, in the shape the swap screen shows. Empty when the two coins aren't on one EVM chain. */
  async dexQuote(from: Asset, to: Asset, amountInput: string, slippageBps = 50) {
    this.session();
    if (!this.dexChain(from, to)) return [];
    const amountIn = parseAmount(amountInput, DECIMALS[from]);
    const chain = chainOf(from as EthAsset);
    const price = (await this.prices().catch(() => null))?.[chain.native as Asset]?.usd;
    const list = await this.dexQuotes(from, to, amountIn, slippageBps);
    return Promise.all(list.map(async ({ id, quote, problem }) => {
      const provider = id === 'uniswap' ? 'Uniswap' : 'PancakeSwap';
      const base = { from, to, amount: amountInput, provider, providerId: id, dex: true, approximate: false, min: null, max: null };
      if (!quote) return { ...base, receive: '0', rate: '0', problem: problem ?? 'No quote.' };
      const needsApproval = quote.tokenIn !== NATIVE && (await this.evm(from).allowance(quote.tokenIn, quote.spender).catch(() => 0n)) < amountIn;
      const gas = quote.gasUnits + (needsApproval ? 80_000n : 0n);
      const fee = await this.evm(from).costOf([{ value: 0n, gas }], gas).catch(() => null);
      const receive = formatAmount(quote.amountOut, DECIMALS[to]);
      return {
        ...base, receive, problem: null,
        rate: (Number(receive) / Number(amountInput)).toPrecision(6),
        minReceive: formatAmount(quote.minOut, DECIMALS[to]),
        priceImpact: quote.priceImpact, needsApproval,
        network: fee ? { fee: formatAmount(fee.likely, 18), asset: chain.symbol, usd: typeof price === 'number' ? Number(formatAmount(fee.likely, 18)) * price : null } : null,
      };
    }));
  }

  async dexPrepare(from: Asset, to: Asset, amountInput: string, providerId: DexId, slippageBps = 50) {
    this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    const chain = this.dexChain(from, to);
    if (!chain) throw new Error('These two coins aren\'t on the same network, so a DEX can\'t swap them.');
    const client = this.evm(from);
    const amountIn = parseAmount(amountInput, DECIMALS[from]);
    const held = await client.balanceOf(from as EthAsset, true);
    if (amountIn > held) throw new Error(`Not enough ${ASSET_LABEL[from] ?? from}.`);
    const found = (await this.dexQuotes(from, to, amountIn, slippageBps)).find((q) => q.id === providerId);
    if (!found?.quote) throw new Error(found?.problem ?? 'No quote from this exchange right now.');
    const quote = found.quote;
    const calls: DexCall[] = quote.tokenIn === NATIVE ? [] : approvalCalls(quote.tokenIn, quote.spender, amountIn, await client.allowance(quote.tokenIn, quote.spender));
    // The swap call itself is made after the password for Uniswap (it needs a signature), so its gas is the estimate.
    const swapGas = quote.gasUnits + 60_000n;
    const cost = await client.costOf([...calls, { value: quote.tokenIn === NATIVE ? amountIn : 0n, gas: swapGas }], swapGas);
    if (cost.value + cost.most > (await client.balanceOf(chain.native, true))) throw new Error(`Not enough ${chain.symbol} for the fee. Up to ${formatAmount(cost.most, 18)} ${chain.symbol} is needed${cost.value ? ' on top of the amount' : ''}.`);
    const preview = this.storePreview({ asset: from, to: client.address, amount: amountIn, fee: cost.likely, dex: { quote, from, to, calls } });
    const warnings = [
      'This swap happens on the public chain. Your address, the coins and the amounts are visible to anyone.',
      ...(calls.length ? [`${ASSET_LABEL[from] ?? from} needs a one-time permission for this exact amount first, so two transactions are sent.`] : []),
      ...(quote.priceImpact !== null && quote.priceImpact > 2 ? [`This trade moves the price by about ${quote.priceImpact.toFixed(1)}%. A smaller amount may get a better rate.`] : []),
    ];
    return {
      id: preview.id, from, to, provider: providerId === 'uniswap' ? 'Uniswap' : 'PancakeSwap',
      amount: formatAmount(amountIn, DECIMALS[from]), receive: formatAmount(quote.amountOut, DECIMALS[to]), minReceive: formatAmount(quote.minOut, DECIMALS[to]),
      slippage: slippageBps / 100, fee: formatAmount(cost.likely, 18), feeAsset: chain.symbol, steps: calls.length + 1, warnings,
    };
  }

  async dexConfirm(id: string, password: string) {
    this.session();
    const preview = this.previews.get(id);
    if (!preview?.dex || preview.expires < Date.now()) { this.previews.delete(id); throw new Error('The review expired. Try again.'); }
    const secrets = await this.vault.open(password);
    this.previews.delete(id);
    this.balanceMemo.clear();
    this.forgetViews();
    const { quote, from, calls } = preview.dex;
    const client = this.evm(from);
    const account = this.evmAccount(from, secrets.tronMnemonic);
    const now = Math.floor(Date.now() / 1000);
    let swap: DexCall;
    if (quote.provider === 'pancakeswap') {
      swap = pancakeSwapCall(quote, client.address, now + 1200);
    } else {
      const uni = this.uniswap();
      if (!uni) throw new Error('Uniswap isn\'t set up in this build.');
      const permit = quote.raw?.permitData ? narrowPermit(quote.raw.permitData, quote, now) : null;
      const signature = permit ? await account.wallet.signTypedData(permit.domain, { PermitSingle: permit.types.PermitSingle, PermitDetails: permit.types.PermitDetails }, permit.values) : undefined;
      swap = await uni.swapTx(quote, signature, permit ?? undefined);
    }
    const hashes = await client.sendCalls([...calls, swap], account.wallet, quote.gasUnits + 60_000n);
    return { hashes, explorer: hashes.map((h) => this.explorerUrl(from, h)) };
  }

  protected get swapsPath() { return path.join(this.dir, 'swaps.json'); }

  async swapList(): Promise<SwapRecord[]> {
    const list = await this.records.read(this.swapsPath).catch(() => undefined);
    return Array.isArray(list) ? list : [];
  }

  /** Older records can name a coin the wallet no longer has, and the screen can't draw those. They stay on disk. */
  async swapHistory(): Promise<SwapRecord[]> {
    return (await this.swapList()).filter((r) => r.from in DECIMALS && r.to in DECIMALS);
  }

  protected async swapSave(list: SwapRecord[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await this.records.write(this.swapsPath, list.slice(0, 100));
  }

  async swapQuote(from: Asset, to: Asset, amountInput: string) {
    this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    if (from === to) throw new Error('Choose a different coin.');
    const amount = formatAmount(parseAmount(amountInput, DECIMALS[from]), DECIMALS[from]);
    const clients = Object.entries(this.swapClients()) as [SwapProviderId, SwapProvider][];
    // The slowest provider mustn't hold up the others, so each gets a deadline and the screen shows whoever answered.
    const deadline = this.dev.quoteDeadlineMs ?? (this.torActive ? QUOTE_DEADLINE_TOR_MS : QUOTE_DEADLINE_MS);
    const failed = (id: SwapProviderId, problem: string) => ({ from, to, amount, receive: '0', rate: '0', min: null, max: null, approximate: true, providerId: id, provider: SWAP_NAMES[id], problem });
    const results = await Promise.all(clients.map(async ([id, client]) => {
      // A connection that fails over Tor is usually that exit: one more try leaves through another.
      const ask = async () => {
        try { return await client.quote(from, to, amount); } catch (e) {
          if (!this.torActive || /\((4\d\d)\)/.test((e as Error).message)) throw e;
          newTorRoute(this.priceAgent as ReturnType<typeof socksAgent>);
          return client.quote(from, to, amount);
        }
      };
      try { return await within(deadline, ask(), failed(id, 'Too slow to answer right now.')); } catch (e) {
        return failed(id, `Connection failed: ${(e as Error).message}`);
      }
    }));
    const sorted = results.sort((a, b) => Number(!a.problem && b.problem ? -1 : !b.problem && a.problem ? 1 : Number(b.receive) - Number(a.receive)));
    // Prices and the fee only add detail, so they don't get to delay the quotes either.
    const extras = Math.min(deadline, QUOTE_EXTRAS_MS);
    const [price, network] = await Promise.all([within(extras, this.prices(), null).catch(() => null), within(extras, this.feeEstimate(from), null).catch(() => null)]);
    return sorted.map((q) => ({ ...q, network, cost: q.problem ? null : swapCost(amount, q.receive, price?.[from]?.usd, price?.[to]?.usd) }));
  }

  /** Gets a fresh rate, opens the order, checks it, and prepares the deposit like any other send. Nothing is signed yet. */
  /** Checked before any order exists, so a bad address costs nothing. */
  protected async checkDestination(asset: Asset, input: string): Promise<string> {
    const { monero } = this.session();
    const address = input.trim();
    const valid = asset === 'BTC' ? isBtcAddress(address)
      : asset === 'LTC' ? isLtcAddress(address) || isMwebAddress(address)
      : asset === 'DASH' ? isDashAddress(address)
      : asset === 'FIRO' ? isFiroAddress(address) || isSparkAddress(address)
      : asset === 'SOL' || isSpl(asset) ? isSolAddress(address)
      : asset === 'DOGE' ? isDogeAddress(address)
      : asset === 'GRAM' || asset === 'USDTT' ? isTonAddress(address)
      : asset === 'DCR' ? isDcrAddress(address)
      : asset === 'BCH' ? isBchAddress(address)
      : asset === 'ZEC' ? isZecAddress(address)
      : asset === 'ZANO' ? isZanoAddress(address)
      : asset === 'ARRR' ? isArrrAddress(address)
      : asset === 'XMR' ? await monero.isValidAddress(address)
        : isEvm(asset) ? isEthAddress(address)
          : isTronAddress(address);
    if (!valid) throw new Error(`The receiving address is not a ${ASSET_LABEL[asset] ?? asset} address.`);
    if (isEvm(asset) && Object.values(chainOf(asset).tokens).some((t) => t!.contract.toLowerCase() === address.toLowerCase())) throw new Error('You cannot receive at a token contract address. The coins would be lost.');
    return asset === 'BCH' ? normalBchAddress(address) : address;
  }

  protected async myAddress(asset: Asset): Promise<string> {
    const { tron, monero, btc, dash } = this.session();
    if (asset === 'ARRR') {
      if (!this.arrr?.receive) throw new Error('The Pirate Chain wallet is getting ready. Try again shortly.');
      return this.arrr.receive;
    }
    if (asset === 'ZANO') {
      if (!this.zano?.receive) throw new Error('The Zano wallet is getting ready. Try again shortly.');
      return this.zano.receive;
    }
    if (asset === 'ZEC') {
      // Swap services pay transparent addresses. The coins get shielded on arrival.
      if (!this.zec?.transparentAddress) throw new Error('The Zcash wallet is getting ready. Try again shortly.');
      return this.zec.transparentAddress;
    }
    await (asset === 'LTC' ? this.ltc!.refresh().catch(() => undefined) : asset === 'BCH' ? this.bch!.refresh().catch(() => undefined) : asset === 'DOGE' ? this.doge!.refresh().catch(() => undefined) : asset === 'FIRO' ? this.firo!.refresh().catch(() => undefined) : asset === 'DASH' ? dash.refresh().catch(() => undefined) : asset === 'BTC' ? btc.refresh().catch(() => undefined) : undefined);
    if (isEvm(asset)) return this.evm(asset).address; // each chain's own address
    if (this.accounts.has(asset)) return this.accounts.get(asset)!.receiveAddress;
    return asset === 'SOL' || isSpl(asset) ? this.sol!.receiveAddress : asset === 'BCH' ? this.bch!.receiveAddress : asset === 'LTC' ? this.ltc!.receiveAddress : asset === 'DOGE' ? this.doge!.receiveAddress : asset === 'DCR' ? this.dcr!.receiveAddress : asset === 'FIRO' ? this.firo!.receiveAddress : asset === 'DASH' ? dash.receiveAddress : asset === 'BTC' ? btc.receiveAddress : asset === 'XMR' ? this.swapSubaddress(monero) : tron.address;
  }

  /**
   * A new Monero subaddress for each order (and each refund), never the primary address: a provider would otherwise
   * see the same address on every swap and tie them all to one person. Waits for a wallet busy syncing rather than
   * falling back to an address used before.
   */
  protected async swapSubaddress(monero: { createSubaddress(): Promise<string> }): Promise<string> {
    const late = Symbol('late');
    const sub = await within(90_000, monero.createSubaddress(), late);
    if (sub === late) throw new Error('The Monero wallet is busy syncing and couldn\'t make a new address for this swap yet. Try again in a minute.');
    return sub as string;
  }

  protected async openOrder(from: Asset, to: Asset, amount: string, providerId: SwapProviderId, withdrawal: string, refund: string, external: boolean, privacy?: { leg: 'first'; via: string; destination: string } | { leg: 'second'; id: string }) {
    const client = this.swapClients()[providerId];
    if (!client) throw new Error('This provider is not available right now.');
    const quote = await client.quote(from, to, amount);
    if (quote.problem) throw new Error(quote.problem);
    const order = await client.create(from, to, amount, quote.receive, withdrawal, refund);
    const preview = await this.prepareSend(from, order.depositAddress, amount);
    if (preview.amount !== amount) throw new Error('The send amount differs, so this was stopped.');
    const swap = { id: order.id, from, to, amount, receive: order.receive, rate: order.rate, providerId, provider: order.provider, approximate: order.approximate, statusKey: order.statusKey, receiveAddress: withdrawal, withdrawalAddress: withdrawal, external, privacy };
    this.pendingSwaps.set(preview.id, swap);
    return { ...preview, swap: { ...swap, statusKey: undefined } }; // The private code stays on this side.
  }

  /** Gets a fresh rate, opens the order, checks it, and prepares the deposit like any other send. Nothing is signed yet. */
  async swapPrepare(from: Asset, to: Asset, amountInput: string, providerId: SwapProviderId = 'exolix', destination = '') {
    this.session();
    if (from === to) throw new Error('Choose a different coin.');
    const amount = formatAmount(parseAmount(amountInput, DECIMALS[from]), DECIMALS[from]);
    const external = destination.trim() !== '';
    const withdrawal = external ? await this.checkDestination(to, destination) : await this.myAddress(to);
    return this.openOrder(from, to, amount, providerId, withdrawal, await this.myAddress(from), external);
  }

  // ---- privacy swap: coin -> fresh XMR subaddress -> outside address, as two unrelated orders ----

  protected get privacyPath() { return path.join(this.dir, 'privacy-swaps.json'); }

  async privacyList(): Promise<PrivacySwap[]> {
    const list = await this.records.read(this.privacyPath).catch(() => undefined);
    return Array.isArray(list) ? list : [];
  }

  protected async privacySave(list: PrivacySwap[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await this.records.write(this.privacyPath, list.slice(0, 50));
  }

  protected assertPrivacyPair(from: Asset, to: Asset): void {
    if (!PRIVACY_ASSETS.includes(from) || !PRIVACY_ASSETS.includes(to)) throw new Error('This coin can\'t go through a privacy swap.');
  }

  async privacyQuote(from: Asset, to: Asset, amountInput: string) {
    this.assertPrivacyPair(from, to);
    const firsts = await this.swapQuote(from, 'XMR', amountInput);
    const good = firsts.filter((q) => !q.problem);
    if (!good.length) return { first: null, second: null, sameProvider: false, problem: firsts[0]?.problem ?? 'No quote available right now.' };
    const xmr = formatAmount(parseAmount(Number(good[0].receive).toFixed(12), 12), 12);
    const seconds = (await this.swapQuote('XMR', to, xmr)).filter((q) => !q.problem);
    if (!seconds.length) return { first: good[0], second: null, sameProvider: false, problem: 'No quote available for step 2. Try a different amount.' };
    // A different service on each side, so neither one sees both ends.
    let first = good[0];
    let second = seconds.find((q) => q.providerId !== first.providerId);
    if (!second) {
      const other = good.find((q) => q.providerId !== seconds[0].providerId);
      if (other) { first = other; second = seconds[0]; }
    }
    return { first, second: second ?? seconds[0], sameProvider: !second, problem: null };
  }

  async privacyPrepare(from: Asset, to: Asset, amountInput: string, providerId: SwapProviderId, destinationInput: string) {
    this.assertPrivacyPair(from, to);
    if (!destinationInput.trim()) throw new Error('A privacy swap requires a final receiving address.');
    const destination = await this.checkDestination(to, destinationInput);
    const { eth, monero } = this.session();
    // Any address of this wallet links both ends again, not only the one that sent.
    const mine = new Set(Object.values(await this.addresses().catch(() => ({}))).filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()));
    if (mine.has(destination.toLowerCase()) || destination.toLowerCase() === eth.address.toLowerCase()) {
      throw new Error('This address belongs to this wallet, which gives no privacy benefit. Enter an address from another wallet.');
    }
    const amount = formatAmount(parseAmount(amountInput, DECIMALS[from]), DECIMALS[from]);
    const via = await monero.createSubaddress();
    this.privacyTargets.set(via, to);
    return this.openOrder(from, 'XMR', amount, providerId, via, await this.myAddress(from), false, { leg: 'first', via, destination });
  }

  async privacyRefresh(id: string): Promise<PrivacySwap> {
    const { monero } = this.session();
    const list = await this.privacyList();
    const p = list.find((x) => x.id === id);
    if (!p) throw new Error('No such privacy swap.');
    if (p.stage === 'first') {
      const record = await this.swapRefresh(p.firstId).catch(() => null);
      if (record && SWAP_DEAD.includes(record.status)) {
        p.stage = 'failed';
        p.note = `Step 1 ended as ${record.status}. Any refund returns to the address that sent the coins.`;
      }
    }
    if (p.stage === 'first' || p.stage === 'ready') {
      const got = await monero.receivedBy(p.via);
      if (got) {
        p.received = formatAmount(got.total, 12);
        p.unlocked = formatAmount(got.unlocked, 12);
        if (got.unlocked > 0n) { p.stage = 'ready'; p.note = undefined; }
      }
    } else if (p.stage === 'second' && p.secondId) {
      const record = await this.swapRefresh(p.secondId).catch(() => null);
      if (record && SWAP_DONE.includes(record.status)) p.stage = 'done';
      else if (record && SWAP_DEAD.includes(record.status)) {
        p.stage = 'failed';
        p.note = `Step 2 ended as ${record.status}. A refund returns to your XMR balance, so continue with a normal swap.`;
      }
    }
    await this.privacySave(list);
    return p;
  }

  async privacySecondQuote(id: string, amountInput: string) {
    const p = (await this.privacyList()).find((x) => x.id === id);
    if (!p) throw new Error('No such privacy swap.');
    const list = await this.swapQuote('XMR', p.to, amountInput);
    // Offer a different service from step one first.
    return list.sort((a, b) => Number(a.providerId === p.firstProviderId) - Number(b.providerId === p.firstProviderId));
  }

  async privacySecond(id: string, amountInput: string, providerId: SwapProviderId) {
    this.session();
    const p = (await this.privacyList()).find((x) => x.id === id);
    if (!p) throw new Error('No such privacy swap.');
    if (p.stage !== 'ready') throw new Error('You can continue after the XMR arrives and unlocks.');
    const value = parseAmount(amountInput, 12);
    if (value > parseAmount(p.unlocked === '0' ? '0.000000000001' : p.unlocked, 12)) throw new Error(`You can send up to ${p.unlocked} XMR from this swap.`);
    return this.openOrder('XMR', p.to, formatAmount(value, 12), providerId, p.destination, p.via, true, { leg: 'second', id });
  }

  async swapConfirm(previewId: string, password: string) {
    const swap = this.pendingSwaps.get(previewId);
    if (!swap) throw new Error('The review expired. Try again.');
    const res = await this.confirmSend(previewId, password);
    this.pendingSwaps.delete(previewId);
    const record: SwapRecord = { id: swap.id, from: swap.from, to: swap.to, amount: swap.amount, receive: swap.receive, rate: swap.rate, createdAt: Date.now(), providerId: swap.providerId, provider: swap.provider, approximate: swap.approximate, statusKey: swap.statusKey, status: 'wait', hashIn: res.hashes[0], withdrawalAddress: swap.withdrawalAddress };
    await this.swapSave([record, ...(await this.swapList())]);
    let privacy: PrivacySwap | undefined;
    if (swap.privacy) {
      const list = await this.privacyList();
      if (swap.privacy.leg === 'first') {
        privacy = { id: randomUUID(), from: swap.from, to: swap.privacy.destination ? this.privacyTargets.get(swap.privacy.via) ?? swap.to : swap.to, amount: swap.amount, destination: swap.privacy.destination, via: swap.privacy.via, stage: 'first', firstId: swap.id, firstProviderId: swap.providerId, expectedXmr: swap.receive, received: '0', unlocked: '0', createdAt: Date.now() };
        list.unshift(privacy);
      } else {
        const id = swap.privacy.id;
        privacy = list.find((x) => x.id === id);
        if (privacy) { privacy.stage = 'second'; privacy.secondId = swap.id; privacy.secondProviderId = swap.providerId; }
      }
      await this.privacySave(list);
    }
    return { record, hashes: res.hashes, privacy };
  }

  async swapRefresh(id: string): Promise<SwapRecord> {
    this.session();
    const list = await this.swapList();
    const record = list.find((r) => r.id === id);
    if (!record) throw new Error('No such swap.');
    const client = this.swapClients()[record.providerId ?? 'exolix'];
    if (!client) throw new Error(`${record.provider ?? 'This provider'} can't show the status right now.`);
    const st = await client.status(id, record.statusKey);
    record.status = st.status;
    record.hashOut = st.hashOut ?? record.hashOut;
    await this.swapSave(list);
    return record;
  }

}
