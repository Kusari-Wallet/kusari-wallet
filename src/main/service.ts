import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { formatAmount, parseAmount } from './amount';
import { HYPE_EXPLORER_TX, HYPE_RPCS, HYPE_SCOUT, Asset, BTC_APIS, BTC_EXPLORER_TX, DECIMALS, FIRO_APIS, FIRO_EXPLORER_TX, SOL_RPCS, SOL_EXPLORER_TX, CHANGENOW_BUY_PAGE, CHANGENOW_LINK_ID, BCH_APIS, BCH_EXPLORER_TX, LTC_APIS, LTC_EXPLORER_TX, SCRT_LCDS, SCRT_EXPLORER_TX, NEAR_RPCS, NEAR_HISTORY, NEAR_EXPLORER_TX, DOGE_APIS, DOGE_PUSH_URLS, POL_RPCS, POL_SCOUT, POL_EXPLORER_TX, ARB_RPCS, ARB_SCOUT, ARB_EXPLORER_TX, BSC_RPCS, BSC_SCOUT, BSC_EXPLORER_TX, DOGE_EXPLORER_TX, DASH_APIS, DASH_EXPLORER_TX, DEFAULT_SETTINGS, ARRR_EXPLORER_TX, ARRR_SERVERS, ZANO_EXPLORER_TX, ZANO_NODE, ZEC_EXPLORER_TX, ZEC_SERVERS, ETH_EXPLORER_TX, ETH_RPCS, ETH_SCOUT, ETH_USDT, NETWORKS, NetworkId, Settings, estimateMainnetHeight } from './config';
import { MIN_PASSWORD, Secrets, Vault } from './vault';
import { TronClient, TronTransfer, deriveTronAccount, generateTronMnemonic, isTronAddress } from './tron';
import { socksAgent, getJson, requestJson, newTorRoute } from './request';
import { AAVE_MARKETS, aaveCall, readAave } from './aave';
import { WC_CHAINS, WalletConnectManager } from './walletconnect';
import { KusariIndex, kusariIndex } from './kindex';
import { HYPE_CORE_RESERVE, HYPE_SYSTEM, HL_BRIDGE, HL_MIN_DEPOSIT, HL_WITHDRAW_FEE, HlClient, HlMarket, KUSARI_FEE, OrderInput, builderFee, encodeDeposit, feePct, hlAgent, hlPrice, hlSize, liquidationPrice } from './hyperliquid';
import type { Wallet as EvmWallet } from 'ethers';
import { DexCall, DexId, DexQuote, NATIVE, UNISWAP_CHAINS, UniswapClient, approvalCalls, narrowPermit, pancakeQuote, pancakeSwapCall } from './dex';
import { NearClient, NearDraft, isNearAccount, nearPublicKey } from './near';
import { ScrtClient, ScrtDraft, isScrtAddress, scrtPrivacyKeys, scrtPublicKey } from './scrt';
import { BtcClient, BtcDraft, LITECOIN, btcAccountXpub, estimateVbytes, isBtcAddress, isLtcAddress, ltcAccountXpub } from './btc';
import { PRICE_SOURCES, PriceMap, PriceSource, coingecko, mirror } from './prices';
import { DEPOSIT_GAS, TORNADO_POOLS, TornadoNote, TornadoStore, WITHDRAW_GAS, abi as tornadoAbi, checkRelayerUrl, denomination, noteSecrets, noteText, relayerFee, relayerStatus, relayerSubmit, tornadoEngineCheck } from './tornado';
import { runTornado } from './tornado-run';
import { ArrrClient, ArrrDraft, isArrrAddress } from './arrr';
import { startArrrEngine, arrrEngineAvailable, arrrEngineInfo } from './arrr-process';
import { startMwebEngine, mwebEngineAvailable } from './mweb-process';
import { MwebClient, MwebDraft, PeginDraft, isMwebAddress } from './mweb';
import { startSparkEngine, sparkEngineAvailable } from './spark-process';
import { SparkClient, SparkDraft, MintDraft, isSparkAddress, sparkKey } from './spark';
import { ZanoClient, ZanoDraft, isZanoAddress, zanoKeys, ZANO_FEE } from './zano';
import { startZanoEngine, zanoEngineAvailable, zanoEngineInfo } from './zano-process';
import { ZecClient, ZecDraft, isZecAddress, zecHeightForDate } from './zec';
import { startZecEngine, zecEngineAvailable, zecEngineInfo } from './zec-process';
import { FiroClient, FiroDraft, firoAccountXpub, isFiroAddress, typicalFiroFee } from './firo';
import { DogeClient, DogeDraft, dogeAccountXpub, isDogeAddress, typicalDogeFee } from './doge';
import { BchClient, bchAccountXpub, isBchAddress, normalBchAddress, typicalBchFee } from './bch';
import { SOL_FEE, SPL_TOKENS, SolClient, SolDraft, SolUsdtDraft, SplAsset, isSolAddress, solAddress } from './sol';
import { DashClient, DashDraft, dashAccountXpub, isDashAddress, typicalDashFee } from './dash';
import { ARBITRUM, BSC, HYPEREVM, EvmChain, EthAsset, EthClient, EthDraft, POLYGON, chainOf, deriveEthAccount, isEthAddress } from './eth';
import { TorManager } from './tor';
import { BUILTIN_SWAP_KEYS, CCECASH_BASE, CHANGENOW_BASE, CceCashClient, ChangeNowClient, ETZSWAP_BASE, EtzSwapClient, GHOSTSWAP_BASE, GhostSwapClient, NOT_SWAPPABLE, PRIVACY_ASSETS, PrivacySwap, SIMPLESWAP_BASE, SWAP_BASE, SWAP_DEAD, SWAP_DONE, SimpleSwapClient, SwapClient, SwapProvider, SwapProviderId, SwapRecord } from './swap';
import { MoneroClient, MoneroDraft, MoneroOptions, generateMoneroSeed, validateMoneroSeed } from './monero';

const BALANCE_TTL_MS = 40_000;
const BALANCE_BACKOFF_MS = 30_000;
const QUICK_REFUSAL_MS = 15_000;
const QUOTE_DEADLINE_MS = 20_000;
const QUOTE_DEADLINE_TOR_MS = 40_000;
const QUOTE_EXTRAS_MS = 8_000;
// ChangeNOW's own names, checked against their currency list.
// Shown without its bitcoincash: prefix, as most wallets and exchanges show it; both forms are the same address.
const bareBch = (a: string) => a.replace(/^bitcoincash:/, '');
/** Typed-data requests come as [address, data]; some dApps send them the other way round, and the data as text. */
function typedRequest(params: any): { who: string; data: any } {
  const [a, b] = Array.isArray(params) ? params : [];
  const isAddr = (x: unknown) => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);
  const [who, raw] = isAddr(a) ? [a, b] : isAddr(b) ? [b, a] : ['', b];
  if (Array.isArray(raw)) throw new Error('The dApp asked for an old kind of signature this wallet doesn\'t make.');
  let data: any;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error('The dApp sent a message this wallet can\'t read.'); }
  if (!data || typeof data !== 'object' || !data.types || !data.primaryType) throw new Error('The dApp sent a message this wallet can\'t read.');
  return { who: String(who), data };
}

const BUY_TICKER: Record<Asset, string> = { HYPE: '', NEAR: 'near', BTC: 'btc', XMR: 'xmr', ETH: 'eth', ZEC: 'zec', SOL: 'sol', TRX: 'trx', USDTE: 'usdterc20', LINK: 'link', WLD: 'wlderc20', USDT: 'usdttrc20', USDTS: 'usdtsol', POL: 'maticmainnet', USDTP: 'usdtmatic', ARB: 'arb', ETHA: 'etharb', USDTA: 'usdtarb', BCH: 'bch', LTC: 'ltc', DOGE: 'doge', DASH: 'dash', FIRO: 'firo', ZANO: 'zano', ARRR: 'arrr', SCRT: '', SSCRT: '', ETHP: 'wethmatic', UNI: 'uni', PEPE: 'pepe', AAVE: '', BNB: 'bnbbsc', USDTB: 'usdtbsc', ASTER: 'asterbsc', CAKE: 'cake', JUP: 'jup', RAY: 'raysol', USDCE: 'usdc', USDCB: 'usdcbsc', USDCS: 'usdcsol', USDCP: 'usdcmatic', USDCA: 'usdcarb' }; // empty: ChangeNOW doesn't sell it (no SCRT or AAVE; its NEAR is the native coin). Checked against their list.
const SWAP_NAMES: Record<SwapProviderId, string> = { exolix: 'Exolix', simpleswap: 'SimpleSwap', ghostswap: 'GhostSwap', etzswap: 'ETZ Swap', ccecash: 'CCECash', changenow: 'ChangeNOW' };

function within<T, F>(ms: number, work: Promise<T>, late: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<F>((resolve) => { timer = setTimeout(() => resolve(late), ms); })]).finally(() => clearTimeout(timer));
}
/** Which Tor route each balance lookup uses. */
/** Coins and tokens on an EVM chain. They share one address. */
const EVM: Asset[] = ['ETH', 'USDTE', 'LINK', 'WLD', 'POL', 'USDTP', 'ARB', 'ETHA', 'USDTA', 'ETHP', 'UNI', 'PEPE', 'AAVE', 'BNB', 'USDTB', 'ASTER', 'CAKE', 'USDCE', 'USDCB', 'USDCP', 'USDCA', 'HYPE'];
/** Solana tokens. */
const SPL: Asset[] = ['USDTS', 'USDCS', 'JUP', 'RAY'];
const isSpl = (a: Asset): a is SplAsset => SPL.includes(a);
const EXTRA_ASSETS: Asset[] = ['ETHP', 'UNI', 'PEPE', 'AAVE', 'BNB', 'USDTB', 'ASTER', 'CAKE', 'JUP', 'RAY', 'USDCE', 'USDCB', 'USDCS', 'USDCP', 'USDCA', 'HYPE'];
const isEvm = (a: Asset): a is Asset & EthAsset => EVM.includes(a);
const EVM_EXPLORER: Record<string, string> = { '1': ETH_EXPLORER_TX, '137': POL_EXPLORER_TX, '42161': ARB_EXPLORER_TX, '56': BSC_EXPLORER_TX, '999': HYPE_EXPLORER_TX };

const ASSET_LABEL: Partial<Record<Asset, string>> = { USDTE: 'USDT (Eth)', USDT: 'USDT (Tron)', USDTS: 'USDT (Sol)', USDTP: 'USDT (Pol)', USDTA: 'USDT (Arb)', ETHA: 'ETH (Arb)', ETHP: 'ETH (Pol)', USDTB: 'USDT (BNB)', USDCE: 'USDC (Eth)', USDCB: 'USDC (BNB)', USDCS: 'USDC (Sol)', USDCP: 'USDC (Pol)', USDCA: 'USDC (Arb)' };

const LOOKUP_ROUTE: Record<string, string> = { NEAR: 'near', BTC: 'btc', ETH: 'eth', USDTE: 'eth', LINK: 'eth', WLD: 'eth', TRX: 'tron', USDT: 'tron', DASH: 'dash', FIRO: 'firo', SOL: 'sol', USDTS: 'sol', POL: 'pol', USDTP: 'pol', ARB: 'arb', ETHA: 'arb', USDTA: 'arb', BCH: 'bch', LTC: 'ltc', DOGE: 'doge', SCRT: 'scrt', ETHP: 'pol', UNI: 'eth', PEPE: 'eth', AAVE: 'eth', BNB: 'bsc', USDTB: 'bsc', ASTER: 'bsc', CAKE: 'bsc', JUP: 'sol', RAY: 'sol', USDCE: 'eth', USDCB: 'bsc', USDCS: 'sol', USDCP: 'pol', USDCA: 'arb', HYPE: 'hype' };

/** Waits longer each time, up to five minutes, so a server that's down isn't asked over and over. */
export function lookupRetryDelay(fails: number): number {
  return Math.min(BALANCE_BACKOFF_MS * 2 ** Math.max(fails - 1, 0), 300_000);
}
const BALANCE_STALE_MS = 30 * 60_000;
const PREVIEW_TTL_MS = 10 * 60_000;

interface Preview {
  id: string;
  asset: Asset;
  to: string;
  amount: bigint;
  fee: bigint;
  expires: number;
  tron?: TronTransfer;
  monero?: MoneroDraft;
  btc?: BtcDraft;
  ltc?: BtcDraft;
  mweb?: MwebDraft;
  pegin?: PeginDraft;
  spark?: SparkDraft;
  mint?: MintDraft;
  scrt?: ScrtDraft;
  near?: NearDraft;
  eth?: EthDraft;
  dash?: DashDraft;
  firo?: FiroDraft;
  doge?: DogeDraft;
  bch?: DogeDraft;
  sol?: SolDraft;
  solUsdt?: SolUsdtDraft;
  zec?: ZecDraft;
  zano?: ZanoDraft;
  arrr?: ArrrDraft;
  dex?: { quote: DexQuote; from: Asset; to: Asset; calls: DexCall[] };
  perpDeposit?: { calls: DexCall[] };
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


function withTimeoutValue<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

export class WalletService extends EventEmitter {
  private vault: Vault;
  private dir: string;
  private walletId = 'main';
  private pendingAdd: { id: string; name: string; previous: string } | null = null;
  private tron: TronClient | null = null;
  private monero: MoneroClient | null = null;
  private btc: BtcClient | null = null;
  private ltc: BtcClient | null = null;
  private sscrtNeedsKey = false;
  private scrt: ScrtClient | null = null;
  private near: NearClient | null = null;
  private eth: EthClient | null = null;
  private pol: EthClient | null = null;
  private arb: EthClient | null = null;
  private bsc: EthClient | null = null;
  private hype: EthClient | null = null;
  private wc: WalletConnectManager | null = null;
  /** Hyperliquid perps, in WalletConnect wallets: the client and the trading key, which can trade but never withdraw. */
  private hl: HlClient | null = null;
  private hlKey: EvmWallet | null = null;
  private hlStatus: { at: number; value: { ready: boolean; agent: boolean; builder: boolean; until: number } } | null = null;
  private perpMarkets: { at: number; list: HlMarket[] } | null = null;
  private readonly perpIndex = new Map<string, KusariIndex>();
  private readonly perpPreviews = new Map<string, { order?: OrderInput; leverage?: number; withdraw?: { amount: string }; hypeOut?: string; expires: number }>();
  /** Whether this session goes through Tor: the Tor setting is on and this is a maximum-privacy wallet. */
  private torActive = false;
  get torOn(): boolean { return this.torActive; }
  private dash: DashClient | null = null;
  private firo: FiroClient | null = null;
  private doge: DogeClient | null = null;
  private bch: BchClient | null = null;
  private sol: SolClient | null = null;
  private zec: ZecClient | null = null;
  private zano: ZanoClient | null = null;
  private arrr: ArrrClient | null = null;
  private mweb: MwebClient | null = null;
  private spark: SparkClient | null = null;
  private previews = new Map<string, Preview>();
  private privacyTargets = new Map<string, Asset>();
  private pendingSwaps = new Map<string, { id: string; from: Asset; to: Asset; amount: string; receive: string; rate: string; providerId: SwapProviderId; provider: string; approximate: boolean; statusKey?: string; withdrawalAddress: string; privacy?: { leg: 'first'; via: string; destination: string } | { leg: 'second'; id: string } }>();
  readonly tor: TorManager;
  private priceAgent: ReturnType<typeof socksAgent> | undefined;
  private torProxy: string | undefined;
  private lastNoted: { stamp: string; at: number } | undefined;
  private readonly routes = new Map<string, ReturnType<typeof socksAgent>>();
  private readonly balanceFails = new Map<string, number>();
  private readonly lookupFailures: string[] = [];
  private readonly lastLookupError = new Map<string, string>();
  private closing: Promise<void> = Promise.resolve();
  private draftSeeds: { tronMnemonic: string; moneroSeed: string } | null = null;
  private priceCache: { at: number; value: PriceMap } | null = null;
  private priceRetryAt = 0;
  private priceInFlight: Promise<PriceMap | null> | null = null;
  settings: Settings = { ...DEFAULT_SETTINGS };

  constructor(private readonly baseDir: string, private readonly kdf?: { N: number; r: number; p: number }, private readonly dev: {
    tronHost?: string; priceUrl?: string; priceSources?: PriceSource[]; torBin?: string; socks?: string; ethRpc?: string; ethScout?: string; bchApi?: string; ltcApi?: string; scrtLcd?: string; nearRpc?: string; nearHistory?: string; polRpc?: string; polScout?: string; polUsdt?: string; arbRpc?: string; arbScout?: string; arbUsdt?: string; bscRpc?: string; bscScout?: string; hypeRpc?: string; kindexBase?: string; uniswapKey?: string; uniswapBase?: string; wcProjectId?: string; dashApi?: string; firoApi?: string; solRpc?: string; dogeApi?: string; zecBin?: string; hlApi?: string; zecServers?: string[]; zanoBin?: string; zanoNode?: string; arrrBin?: string; arrrServers?: string[]; mwebBin?: string; mwebConnect?: string; sparkBin?: string; sparkServer?: string; sparkConnect?: string; tornadoPools?: Record<string, string>; tornadoLocalRelayer?: boolean; swapBase?: string; simpleSwapBase?: string; ghostSwapBase?: string; etzSwapBase?: string; cceCashBase?: string; changeNowBase?: string; quoteDeadlineMs?: number; btcApi?: string;
    /** Android: every outside address goes through the app's local forwarder. */
    route?: (url: string) => string;
    moneroStore?: (net: NetworkId, walletId: string) => MoneroOptions['store'];
    allowFakechain?: boolean;
    /** Android: the Tor process and its routing live on the native side. */
    nativeTor?: boolean;
  } = {}) {
    super();
    this.dir = baseDir;
    this.vault = new Vault(path.join(baseDir, 'vault.json'), kdf);
    this.tor = new TorManager(path.join(baseDir, 'tor'), { binPath: dev.torBin, socksOverride: dev.socks, sources: dev.socks ? { bundleBases: [], keyUrls: [], fingerprint: '' } : undefined });
    this.tor.on('state', (s) => this.emit('tor-state', s));
  }

  private get settingsPath() { return path.join(this.baseDir, 'settings.json'); }
  private moneroDir(net: NetworkId) { return path.join(this.dir, 'xmr', net); }

  async init(): Promise<void> {
    try {
      this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(await fs.readFile(this.settingsPath, 'utf8')) };
    } catch { /* first run */ }
    this.settings.network = 'mainnet'; // The app is mainnet only, including for older settings files.
    await this.tor.loadInstalledVersion();
    this.activate((await this.walletRegistry()).active);
  }

  // ---- several wallets: each has its own seed, password and records. Settings and Tor are shared. ----

  get activeWallet(): string { return this.walletId; }

  private get registryPath() { return path.join(this.baseDir, 'wallets.json'); }

  private walletDir(id: string) { return id === 'main' ? this.baseDir : path.join(this.baseDir, 'wallets', id); }

  private activate(id: string): void {
    this.walletId = id;
    this.dir = this.walletDir(id);
    this.vault = new Vault(path.join(this.dir, 'vault.json'), this.kdf);
    this.draftSeeds = null;
  }

  private async walletRegistry(): Promise<{ active: string; list: { id: string; name: string }[] }> {
    try {
      const r = JSON.parse(await fs.readFile(this.registryPath, 'utf8') as unknown as string);
      if (Array.isArray(r.list) && r.list.length && r.list.some((w: any) => w.id === r.active)) return r;
    } catch { /* first run: the wallet made before this feature, if any, is the first one */ }
    return { active: 'main', list: [{ id: 'main', name: 'My wallet' }] };
  }

  private async walletRegistrySave(r: { active: string; list: { id: string; name: string }[] }): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(this.registryPath, JSON.stringify(r), { mode: 0o600 });
  }

  private static walletName(input: string): string {
    const name = String(input).trim();
    if (!name || [...name].length > 20) throw new Error('Wallet names can be 1 to 20 characters.');
    return name;
  }

  async walletsList() {
    const r = await this.walletRegistry();
    return { active: this.pendingAdd ? this.pendingAdd.previous : r.active, list: r.list, adding: Boolean(this.pendingAdd) };
  }

  async walletRename(id: string, input: string): Promise<void> {
    const name = WalletService.walletName(input);
    const r = await this.walletRegistry();
    const w = r.list.find((x) => x.id === id);
    if (!w) throw new Error('No such wallet.');
    w.name = name;
    await this.walletRegistrySave(r);
  }

  async walletSwitch(id: string): Promise<void> {
    const r = await this.walletRegistry();
    if (!r.list.some((w) => w.id === id)) throw new Error('No such wallet.');
    await this.lock();
    r.active = id;
    await this.walletRegistrySave(r);
    this.pendingAdd = null;
    this.activate(id);
  }

  /** The new wallet joins the list only once it really exists, so giving up leaves nothing behind. */
  async walletBeginAdd(input: string): Promise<void> {
    const name = WalletService.walletName(input);
    const r = await this.walletRegistry();
    await this.lock();
    const id = randomUUID().replace(/-/g, '').slice(0, 16);
    this.pendingAdd = { id, name, previous: r.active };
    this.activate(id);
  }

  async walletCancelAdd(): Promise<void> {
    if (!this.pendingAdd) return;
    const { previous } = this.pendingAdd;
    this.pendingAdd = null;
    this.activate(previous);
  }

  private async commitPendingWallet(): Promise<void> {
    if (!this.pendingAdd) return;
    const r = await this.walletRegistry();
    r.list.push({ id: this.pendingAdd.id, name: this.pendingAdd.name });
    r.active = this.pendingAdd.id;
    await this.walletRegistrySave(r);
    this.pendingAdd = null;
  }

  async status() {
    return { hasWallet: await this.vault.exists(), unlocked: this.tron !== null, network: this.settings.network };
  }

  // ---- wallet creation ----

  async generateSeeds() {
    this.draftSeeds = { tronMnemonic: generateTronMnemonic(), moneroSeed: await generateMoneroSeed('mainnet') };
    return this.draftSeeds;
  }

  private newSecrets(tronMnemonic: string, moneroSeed: string, heights: Secrets['restoreHeights']): Secrets {
    return {
      tronMnemonic, moneroSeed,
      moneroFilePasswords: { mainnet: randomBytes(32).toString('hex'), testnet: randomBytes(32).toString('hex') },
      restoreHeights: heights,
    };
  }

  /** Commits the generated seeds once the user has confirmed the backup. */
  async finishCreate(password: string): Promise<void> {
    if (!this.draftSeeds) throw new Error('Create the seeds first.');
    if (await this.vault.exists()) throw new Error('A wallet already exists.');
    // Nothing can have been sent to a brand new seed before today, so start near the tip.
    const heights = { mainnet: Math.max(0, estimateMainnetHeight(new Date()) - 5040), testnet: -1 };
    const secrets = this.newSecrets(this.draftSeeds.tronMnemonic, this.draftSeeds.moneroSeed, heights);
    await this.vault.save(password, secrets);
    await this.commitPendingWallet();
    this.draftSeeds = null;
    await this.startSession(secrets);
  }

  /** restoreFrom: a block height, a YYYY-MM-DD date, or empty for a full scan. */
  async restore(password: string, tronMnemonic: string, moneroSeed: string, restoreFrom: string): Promise<void> {
    if (await this.vault.exists()) throw new Error('A wallet already exists.');
    if (password.length < MIN_PASSWORD) throw new Error(`The password must be at least ${MIN_PASSWORD} characters.`);
    deriveTronAccount(tronMnemonic); // throws on a bad phrase
    const seed = await validateMoneroSeed(moneroSeed);
    let height = 0;
    const from = restoreFrom.trim();
    if (/^\d+$/.test(from)) height = Number(from);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      const date = new Date(from + 'T00:00:00Z');
      if (Number.isNaN(date.getTime())) throw new Error('The date format is not valid.');
      height = Math.max(0, estimateMainnetHeight(date) - 21_600); // 30 days of margin
    } else if (from) throw new Error('Enter the restore point as a block height or YYYY-MM-DD.');
    const heights = { mainnet: height, testnet: /^\d+$/.test(from) ? height : 0 };
    const secrets = this.newSecrets(tronMnemonic.trim().toLowerCase().split(/\s+/).join(' '), seed, heights);
    // A Monero block height says nothing about Zcash, so only a date carries over.
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      secrets.zecBirthday = zecHeightForDate(new Date(from + 'T00:00:00Z'));
      secrets.restoreDate = from;
    }
    await this.vault.save(password, secrets);
    await this.commitPendingWallet();
    await this.startSession(secrets);
  }

  // ---- session ----

  private moneroNodes(): string[] {
    const custom = this.settings.customMoneroNode.trim();
    if (custom) return [custom];
    const monero = NETWORKS[this.settings.network].monero;
    // Plain HTTP through a Tor exit could be read or altered there, so Tor mode uses onion nodes only.
    return this.torActive ? monero.onionNodes : monero.nodes;
  }

  private async startSession(secrets: Secrets): Promise<void> {
    await this.closing;
    this.priceAgent = undefined;
    this.torProxy = undefined;
    this.routes.clear();
    let proxyUri: string | undefined;
    // Tor belongs to maximum-privacy wallets only: a WalletConnect wallet never starts or uses it.
    this.torActive = this.settings.torEnabled && (await this.walletMode()) === 'private';
    if (this.torActive) {
      const socks = await this.tor.allocate();
      if (!this.dev.nativeTor) {
        proxyUri = socks;
        this.torProxy = socks;
        this.priceAgent = this.torRoute('general');
      }
    } else {
      this.tor.useDirect();
    }
    if (this.torActive) this.tor.start(); // Before anything tries to use it.
    const net = NETWORKS[this.settings.network];
    const account = deriveTronAccount(secrets.tronMnemonic);
    const route = this.dev.route ?? ((u: string) => u);
    const tronNet = this.dev.tronHost
      ? { ...net.tron, host: route(this.dev.tronHost), usdt: NETWORKS.mainnet.tron.usdt }
      : { ...net.tron, host: route(net.tron.host) };
    this.tron = new TronClient(tronNet, this.settings.tronApiKey, account.address, this.torRoute('tron'), this.torActive);

    const slow = this.torActive;
    this.btc = new BtcClient(btcAccountXpub(secrets.tronMnemonic), this.dev.btcApi ? [this.dev.btcApi] : BTC_APIS, this.torRoute('btc'), slow ? 60_000 : 30_000);
    if (this.dev.btcApi) this.btc.spacingMs = 0;
    const scanFile = path.join(this.dir, 'btc-scan.json');
    try { this.btc.importHints(JSON.parse(await fs.readFile(scanFile, 'utf8') as unknown as string)); } catch { /* first time */ }
    this.btc.onHints = (hints) => { void fs.mkdir(this.dir, { recursive: true }).then(() => fs.writeFile(scanFile, JSON.stringify(hints), { mode: 0o600 })).catch(() => undefined); };
    if (!this.torNotReady) void this.btc.refresh().catch(() => undefined);
    this.ltc = new BtcClient(ltcAccountXpub(secrets.tronMnemonic), this.dev.ltcApi ? [this.dev.ltcApi] : LTC_APIS, this.torRoute('ltc'), slow ? 60_000 : 30_000, LITECOIN);
    if (this.dev.ltcApi) this.ltc.spacingMs = 0;
    this.near = new NearClient(nearPublicKey(secrets.tronMnemonic), this.dev.nearRpc ? [this.dev.nearRpc] : NEAR_RPCS, this.dev.nearHistory ?? NEAR_HISTORY, this.torRoute('near'), slow ? 60_000 : 20_000);
    this.scrt = new ScrtClient(scrtPublicKey(secrets.tronMnemonic), this.dev.scrtLcd ? this.dev.scrtLcd.split(',') : SCRT_LCDS, this.torRoute('scrt'), slow ? 60_000 : 20_000, scrtPrivacyKeys(secrets.tronMnemonic));
    this.firo = new FiroClient(firoAccountXpub(secrets.tronMnemonic), this.dev.firoApi ? [this.dev.firoApi] : FIRO_APIS, this.torRoute('firo'), slow ? 60_000 : 20_000);
    this.doge = new DogeClient(dogeAccountXpub(secrets.tronMnemonic), this.dev.dogeApi ? [this.dev.dogeApi] : DOGE_APIS, this.torRoute('doge'), slow ? 60_000 : 20_000, this.dev.dogeApi ? {} : { pushUrls: DOGE_PUSH_URLS });
    this.bch = new BchClient(bchAccountXpub(secrets.tronMnemonic), this.dev.bchApi ? [this.dev.bchApi] : BCH_APIS, this.torRoute('bch'), slow ? 60_000 : 20_000);
    this.sol = new SolClient(solAddress(secrets.tronMnemonic), this.dev.solRpc ? [this.dev.solRpc] : SOL_RPCS, this.torRoute('sol'), slow ? 60_000 : 20_000);
    this.dash = new DashClient(dashAccountXpub(secrets.tronMnemonic), this.dev.dashApi ? [this.dev.dashApi] : DASH_APIS, this.torRoute('dash'), slow ? 60_000 : 20_000);
    this.eth = new EthClient(this.dev.ethRpc ? [this.dev.ethRpc] : ETH_RPCS, this.dev.ethScout ?? ETH_SCOUT, ETH_USDT, deriveEthAccount(secrets.tronMnemonic).address, this.torRoute('eth'), slow ? 60_000 : 15_000);
    const evmAddress = deriveEthAccount(secrets.tronMnemonic).address;
    this.pol = new EthClient(this.dev.polRpc ? [this.dev.polRpc] : POL_RPCS, this.dev.polScout ?? POL_SCOUT, this.dev.polUsdt ?? '', evmAddress, this.torRoute('pol'), slow ? 60_000 : 15_000, POLYGON);
    this.arb = new EthClient(this.dev.arbRpc ? [this.dev.arbRpc] : ARB_RPCS, this.dev.arbScout ?? ARB_SCOUT, this.dev.arbUsdt ?? '', evmAddress, this.torRoute('arb'), slow ? 60_000 : 15_000, ARBITRUM);
    this.bsc = new EthClient(this.dev.bscRpc ? [this.dev.bscRpc] : BSC_RPCS, this.dev.bscScout ?? BSC_SCOUT, '', evmAddress, this.torRoute('bsc'), slow ? 60_000 : 15_000, BSC);
    this.hype = new EthClient(this.dev.hypeRpc ? [this.dev.hypeRpc] : HYPE_RPCS, HYPE_SCOUT, '', evmAddress, this.torRoute('hype'), slow ? 60_000 : 15_000, HYPEREVM);
    void this.startWalletConnect(evmAddress);
    if ((await this.walletMode()) === 'walletconnect') {
      this.hl = new HlClient(evmAddress, { api: route(this.dev.hlApi ?? 'https://api.hyperliquid.xyz') });
      this.hlKey = hlAgent(deriveEthAccount(secrets.tronMnemonic).wallet.privateKey);
    }
    const monero = new MoneroClient({
      type: net.monero.type,
      dir: this.moneroDir(net.id),
      filePassword: secrets.moneroFilePasswords[net.id],
      seed: secrets.moneroSeed,
      restoreHeight: secrets.restoreHeights[net.id],
      nodes: this.moneroNodes().map(route),
      proxyUri,
      overTor: this.torActive,
      store: this.dev.moneroStore?.(net.id, this.walletId),
      allowFakechain: this.dev.allowFakechain,
    });
    monero.on('state', (s) => this.emit('monero-state', s));
    monero.on('balance', () => this.emit('balance-changed'));
    await monero.open();
    this.monero = monero;
    await this.startZec(secrets);
    await this.startZano(secrets);
    await this.startArrr(secrets);
    await this.startMweb(secrets);
    await this.startSpark(secrets);
  }

  /** Firo Spark: the engine syncs the anonymity sets itself. Without it, FIRO is transparent only. */
  private async startSpark(secrets: Secrets): Promise<void> {
    if (!sparkEngineAvailable(this.dev.sparkBin)) return;
    const torPort = this.torActive ? Number((await this.tor.allocate()).match(/:(\d+)$/)?.[1]) : undefined;
    if (this.torActive && !torPort) return; // Never fall back to a direct connection.
    const pinFile = path.join(this.dir, 'spark-servers.json');
    let pins: Record<string, string> = {};
    try { pins = JSON.parse(await fs.readFile(pinFile, 'utf8')); } catch { pins = {}; }
    const dev = this.dev.sparkServer?.match(/^(.+):(\d+)$/);
    const client = new SparkClient({
      engine: () => startSparkEngine(this.dev.sparkBin),
      dir: this.dir,
      socks: torPort,
      connect: this.dev.sparkConnect,
      servers: dev ? [{ host: dev[1], port: Number(dev[2]) }] : undefined,
      pins: () => pins,
      // Certificates are pinned on first use, as Electrum wallets do with these servers.
      savePin: (host, fingerprint) => { pins = { ...pins, [host]: fingerprint }; void fs.writeFile(pinFile, JSON.stringify(pins)).catch(() => undefined); },
      canConnect: () => !this.torNotReady,
      onChange: () => this.emit('balance-changed'),
    }, sparkKey(secrets.tronMnemonic));
    this.spark = client;
    try { await client.start(); } catch (e) { client.lastError = (e as Error).message; }
  }

  /** Litecoin MWEB: a light client of its own. Without its engine, LTC simply has no private balance. */
  private async startMweb(secrets: Secrets): Promise<void> {
    if (!mwebEngineAvailable(this.dev.mwebBin)) return;
    const torPort = this.torActive ? Number((await this.tor.allocate()).match(/:(\d+)$/)?.[1]) : undefined;
    if (this.torActive && !torPort) return; // Never fall back to a direct connection.
    const client = new MwebClient({
      engine: () => startMwebEngine(this.dev.mwebBin),
      dir: this.dir,
      socks: torPort,
      connect: this.dev.mwebConnect,
      canConnect: () => !this.torNotReady,
      onChange: () => this.emit('balance-changed'),
    }, secrets.tronMnemonic);
    this.mweb = client;
    try { await client.start(); } catch (e) { client.lastError = (e as Error).message; }
  }

  private get arrrAvailable(): boolean { return arrrEngineAvailable(this.dev.arrrBin); }

  private async startArrr(secrets: Secrets): Promise<void> {
    if (!this.arrrAvailable) return;
    const torPort = this.torActive ? Number((await this.tor.allocate()).match(/:(\d+)$/)?.[1]) : undefined;
    if (this.torActive && !torPort) return; // Never fall back to a direct connection.
    const client = new ArrrClient({
      engine: () => startArrrEngine(this.dev.arrrBin),
      dir: this.dir,
      secret: secrets.moneroFilePasswords.mainnet,
      servers: this.dev.arrrServers ?? ARRR_SERVERS,
      socks: torPort,
      canConnect: () => !this.torNotReady,
      onChange: () => this.emit('balance-changed'),
    }, secrets.tronMnemonic, secrets.restoreDate);
    this.arrr = client;
    try { await client.start(); } catch (e) { client.lastError = (e as Error).message; }
  }

  private get zanoAvailable(): boolean { return zanoEngineAvailable(this.dev.zanoBin); }

  private async startZano(secrets: Secrets): Promise<void> {
    if (!this.zanoAvailable) return;
    const torPort = this.torActive ? Number((await this.tor.allocate()).match(/:(\d+)$/)?.[1]) : undefined;
    if (this.torActive && !torPort) return; // Never fall back to a direct connection.
    const client = new ZanoClient({
      engine: () => startZanoEngine(this.dev.zanoBin, this.dir),
      node: this.dev.zanoNode ?? ZANO_NODE,
      socks: torPort,
      canConnect: () => !this.torNotReady,
      onChange: () => this.emit('balance-changed'),
    }, zanoKeys(secrets.tronMnemonic, secrets.moneroFilePasswords.mainnet));
    this.zano = client;
    try { await client.start(); } catch (e) { client.lastError = (e as Error).message; }
  }

  private get zecAvailable(): boolean { return zecEngineAvailable(this.dev.zecBin); }

  /** Every other coin works without this, so a problem here stays on the Zcash row. */
  private async startZec(secrets: Secrets): Promise<void> {
    if (!this.zecAvailable) return;
    const torPort = this.torActive ? Number((await this.tor.allocate()).match(/:(\d+)$/)?.[1]) : undefined;
    if (this.torActive && !torPort) return; // Never fall back to a direct connection.
    const client = new ZecClient({
      engine: () => startZecEngine(this.dev.zecBin),
      dir: this.dir,
      secret: secrets.moneroFilePasswords.mainnet,
      servers: this.dev.zecServers ?? ZEC_SERVERS,
      socks: torPort,
      canConnect: () => !this.torNotReady,
      onChange: () => this.emit('balance-changed'),
    }, secrets.tronMnemonic, secrets.zecBirthday);
    this.zec = client;
    try { await client.start(); } catch (e) { client.lastError = (e as Error).message; }
  }

  async unlock(password: string): Promise<void> {
    if (this.tron) return;
    await this.startSession(await this.vault.open(password));
  }

  async lock(): Promise<void> {
    this.torActive = false;
    this.previews.clear();
    this.pendingSwaps.clear();
    this.balanceMemo.clear();
    this.balanceRetryAt.clear();
    this.lookupFailures.length = 0;
    this.balanceFails.clear();
    this.routes.clear();
    this.lastLookupError.clear();
    this.tron = null;
    this.btc = null;
    this.ltc = null;
    this.scrt = null;
    this.near = null;
    this.eth = null;
    this.pol = null;
    this.arb = null;
    this.bsc = null;
    this.hype = null;
    void this.wc?.stop();
    this.wc = null;
    this.hl = null;
    this.hlKey = null;
    this.hlStatus = null;
    this.perpPreviews.clear();
    this.dash = null;
    this.firo = null;
    this.doge = null;
    this.bch = null;
    this.sol = null;
    void this.zec?.stop();
    this.zec = null;
    void this.zano?.stop();
    this.zano = null;
    void this.arrr?.stop();
    this.arrr = null;
    this.mweb?.close();
    this.mweb = null;
    this.spark?.close();
    this.spark = null;
    this.priceCache = null;
    const monero = this.monero;
    this.monero = null;
    this.emit('locked'); // Closing can wait for a sync step, so the screen locks first.
    this.closing = this.closing.then(() => monero?.close()).catch(() => undefined);
    await this.closing;
    await this.tor.stop();
    this.tor.clearLog();
  }

  private session() {
    if (!this.tron || !this.monero || !this.btc || !this.eth || !this.dash || !this.firo) throw new Error('The wallet is locked.');
    return { tron: this.tron, monero: this.monero, btc: this.btc, eth: this.eth, dash: this.dash, firo: this.firo };
  }

  // ---- reads ----

  /** While true, every outside request is bound to fail, so none are made. */
  private get torNotReady(): boolean { return this.torActive && this.tor.state.phase !== 'ready'; }

  private friendlyError(e: Error): string {
    return this.torActive && /ECONNREFUSED 127\.0\.0\.1|socks/i.test(e.message) ? 'Not connected to Tor. Balances load once it connects.' : e.message;
  }

  private balanceMemo = new Map<string, { at: number; total: bigint; spendable: bigint; decimals: number }>();
  private balanceRetryAt = new Map<string, number>();

  /**
   * Public servers refuse now and then, more so over Tor where an exit IP is shared. One refusal shouldn't
   * blank a balance: it retries once, backs off, and meanwhile shows the last value marked as not the latest.
   * Sending never relies on this; it reads fresh balances.
   */
  /** What went wrong lately, kept in memory only. No addresses, amounts or links, so it can be shared to get help. */
  connectionLog(): string {
    const tor = this.tor.recentLog();
    return [
      `Kusari Wallet connection log, ${new Date().toISOString()}`,
      `Tor: ${this.torActive ? `on, ${this.tor.state.phase} ${this.tor.state.percent}%` : 'off'}`,
      '', 'Failed lookups:',
      ...(this.lookupFailures.length ? this.lookupFailures : ['none']),
      ...(tor.length ? ['', 'Tor messages:', ...tor] : []),
    ].join('\n');
  }

  /** Each coin leaves Tor on its own route, so one exit neither sees them together nor takes them down together. */
  private torRoute(name: string): ReturnType<typeof socksAgent> | undefined {
    if (!this.torProxy) return undefined;
    const agent = socksAgent(this.torProxy);
    newTorRoute(agent);
    this.routes.set(name, agent);
    return agent;
  }

  private renewTorRoute(key: string): void {
    if (!this.torActive || key === 'XMR') return;
    newTorRoute(this.routes.get(LOOKUP_ROUTE[key]));
  }

  private noteFailure(key: string, startedAt: number, e: Error): void {
    const message = e.message.replace(/https?:\/\/\S+/g, '[link]').replace(/\b[1-9A-HJ-NP-Za-km-z]{25,}\b/g, '[address]').slice(0, 160);
    this.lastLookupError.set(key, message);
    // Everything waiting on one failed lookup hears about it at once. That's still one failure.
    const stamp = `${key} ${message}`;
    if (this.lastNoted?.stamp === stamp && Date.now() - this.lastNoted.at < 1000) return;
    this.lastNoted = { stamp, at: Date.now() };
    this.lookupFailures.push(`${new Date().toISOString()} ${key} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${message}`);
    this.lookupFailures.splice(0, Math.max(0, this.lookupFailures.length - 100));
  }

  private async readBalance(key: string, fn: () => Promise<[bigint, bigint]>, decimals: number, ttl: number): Promise<BalanceView> {
    const view = (m: { total: bigint; spendable: bigint }, stale = false): BalanceView => ({ ok: true, total: formatAmount(m.total, decimals), spendable: formatAmount(m.spendable, decimals), ...(stale ? { stale: true } : {}) });
    const memo = this.balanceMemo.get(key);
    if (memo && Date.now() - memo.at < ttl) return view(memo);
    if (key !== 'XMR' && this.torNotReady) return { ok: false, pending: true, total: '', spendable: '' };
    let failure: Error | undefined;
    if (Date.now() >= (this.balanceRetryAt.get(key) ?? 0)) {
      // A quick refusal over Tor usually means that exit is blocked, so a few more routes are worth a try. A timeout already took minutes.
      for (let attempt = 0, tries = 2; attempt < tries; attempt++) {
        const startedAt = Date.now();
        try {
          const [total, spendable] = await fn();
          this.lastLookupError.delete(key);
          this.balanceFails.delete(key);
          this.balanceMemo.set(key, { at: Date.now(), total, spendable, decimals });
          this.balanceRetryAt.delete(key);
          return view({ total, spendable });
        } catch (e) {
          failure = e as Error;
          this.noteFailure(key, startedAt, failure);
          this.renewTorRoute(key);
          if (this.torActive && Date.now() - startedAt < QUICK_REFUSAL_MS) tries = 4;
          if (attempt + 1 < tries) await new Promise((r) => setTimeout(r, this.dev.tronHost ? 50 : 1500));
        }
      }
      const fails = (this.balanceFails.get(key) ?? 0) + 1;
      this.balanceFails.set(key, fails);
      this.balanceRetryAt.set(key, Date.now() + (this.dev.tronHost ? 0 : lookupRetryDelay(fails)));
    }
    // With Tor down, an old number would hide that the connection is gone.
    const torDown = this.torActive && this.tor.state.phase !== 'ready';
    if (memo && !torDown && Date.now() - memo.at < BALANCE_STALE_MS) return view(memo, true);
    if (this.torActive && (this.balanceFails.get(key) ?? 0) >= 3) return { ok: false, total: '', spendable: '', error: 'This server isn\'t answering over Tor right now. The wallet keeps trying.' };
    return { ok: false, total: '', spendable: '', error: failure ? this.friendlyError(failure) : this.lastLookupError.get(key) ?? 'Retrying shortly.' };
  }

  async overview() {
    const { tron, monero, btc } = this.session();
    const settle = (key: string, fn: () => Promise<[bigint, bigint]>, decimals: number, ttl = 0) => this.readBalance(key, fn, decimals, ttl);
    const btcSettle = async (client: BtcClient = btc): Promise<BalanceView> => {
      const symbol = client.coin?.symbol ?? 'BTC';
      if (this.torNotReady) return { ok: false, pending: true, total: '', spendable: '' };
      try {
        const b = await client.getBalance();
        return b ? { ok: true, total: formatAmount(b.total, 8), spendable: formatAmount(b.spendable, 8) } : { ok: false, pending: true, total: '', spendable: '' };
      } catch (e) {
        const message = (e as Error).message;
        this.noteFailure(symbol, Date.now(), e as Error);
        this.renewTorRoute(symbol);
        // Being rate limited with nothing known yet is "still loading": it clears up by itself.
        return /limiting requests/.test(message) ? { ok: false, pending: true, total: '', spendable: '' } : { ok: false, total: '', spendable: '', error: this.friendlyError(e as Error) };
      }
    };
    const { eth, dash, firo } = this.session();
    const zec = this.zec;
    const zano = this.zano;
    const arrr = this.arrr;
    const arrrView = (): BalanceView => {
      const b = arrr?.balance();
      if (b) return { ok: true, total: formatAmount(b[0], 8), spendable: formatAmount(b[1], 8) };
      if (arrr?.lastError && !this.torNotReady) return { ok: false, total: '', spendable: '', error: this.friendlyError(new Error(arrr.lastError)) };
      return { ok: false, pending: true, total: '', spendable: '' };
    };
    const zanoView = (): BalanceView => {
      const b = zano?.balance();
      if (b) return { ok: true, total: formatAmount(b[0], 12), spendable: formatAmount(b[1], 12) };
      if (zano?.lastError && !this.torNotReady) return { ok: false, total: '', spendable: '', error: this.friendlyError(new Error(zano.lastError)) };
      return { ok: false, pending: true, total: '', spendable: '' };
    };
    const zecView = (): BalanceView => {
      const b = zec?.balance();
      if (b) return { ok: true, total: formatAmount(b[0], 8), spendable: formatAmount(b[1], 8) };
      if (zec?.lastError && !this.torNotReady) return { ok: false, total: '', spendable: '', error: this.friendlyError(new Error(zec.lastError)) };
      return { ok: false, pending: true, total: '', spendable: '' };
    };
    const [BTC, XMR, ETH, TRX, USDTE, USDT, SOL, USDTS, LINK, WLD, POL, USDTP, ARB, ETHA, USDTA, BCH, LTC, DOGE, DASH, FIRO, SCRT, NEAR, SSCRT, ...EXTRA] = await Promise.all([
      btcSettle(),
      settle('XMR', async () => { const b = await monero.getBalance(); return [b.total, b.unlocked]; }, 12),
      settle('ETH', async () => { const b = await eth.getEthBalance(); return [b, b]; }, 18),
      settle('TRX', async () => { const b = await tron.getTrxBalance(); return [b, b]; }, 6, BALANCE_TTL_MS),
      settle('USDTE', async () => { const b = await eth.getUsdtBalance(); return [b, b]; }, 6),
      settle('USDT', async () => { const b = await tron.getUsdtBalance(); return [b, b]; }, 6, BALANCE_TTL_MS),
      settle('SOL', async () => { const b = await this.sol!.getBalance(); return [b.total, b.spendable]; }, 9),
      settle('USDTS', async () => { const b = await this.sol!.getUsdtBalance(); return [b, b]; }, 6),
      ...(['LINK', 'WLD'] as const).map((a) => settle(a, async () => { const b = await this.evm(a).balanceOf(a); return [b, b]; }, DECIMALS[a])),
      ...(['POL', 'USDTP', 'ARB', 'ETHA', 'USDTA'] as const).map((a) => settle(a, async () => { const b = await this.evm(a).balanceOf(a); return [b, b]; }, DECIMALS[a])),
      settle('BCH', async () => { const b = await this.bch!.getBalance(); return [b.total, b.spendable]; }, 8),
      // LTC is the public coins plus the private (MWEB) ones, once MWEB has synced.
      btcSettle(this.ltc!).then((view) => {
        const m = this.mweb?.balance();
        if (!view.ok || !m) return view;
        const units = (v: string) => (/^0(\.0*)?$/.test(v) ? 0n : parseAmount(v, 8)); // parseAmount refuses zero
        return { ...view, total: formatAmount(units(view.total) + m.total, 8), spendable: formatAmount(units(view.spendable) + m.spendable, 8) };
      }),
      settle('DOGE', async () => { const b = await this.doge!.getBalance(); return [b.total, b.spendable]; }, 8),
      settle('DASH', async () => { const b = await dash.getBalance(); return [b.total, b.spendable]; }, 8),
      // FIRO is the public coins plus the private (Spark) ones, once Spark has synced.
      settle('FIRO', async () => { const b = await firo.getBalance(); const p = this.spark?.balance(); return [b.total + (p?.total ?? 0n), b.spendable + (p?.spendable ?? 0n)]; }, 8),
      settle('SCRT', async () => { const b = await this.scrt!.getBalance(); return [b, b]; }, 6),
      settle('NEAR', async () => { const b = await this.near!.getBalance(); return [b.total, b.spendable]; }, 24),
      // Until the viewing key is set on the contract, the private balance can't be read; the sSCRT screen offers to set it.
      settle('SSCRT', async () => { const b = await this.scrt!.getPrivateBalance(); this.sscrtNeedsKey = b === null; return [b ?? 0n, b ?? 0n]; }, 6),
      // Added later: every further token, on its chain's client. Keep in step with EXTRA_ASSETS.
      ...EXTRA_ASSETS.map((a) => settle(a, async () => { const b = isSpl(a) ? await this.sol!.getUsdtBalance(a) : await this.evm(a).balanceOf(a as EthAsset); return [b, b]; }, DECIMALS[a])),
    ]);
    return {
      network: this.settings.network,
      tor: this.torActive ? this.tor.state : null,
      balances: { XMR, BTC, ETH, TRX, USDTE, USDT, SOL, USDTS, LINK, WLD, POL, USDTP, ARB, ETHA, USDTA, BCH, LTC, DOGE, DASH, FIRO, SCRT, NEAR, SSCRT, ...Object.fromEntries(EXTRA_ASSETS.map((a, i) => [a, EXTRA[i]])), ...(zec ? { ZEC: zecView() } : {}), ...(zano ? { ZANO: zanoView() } : {}), ...(arrr ? { ARRR: arrrView() } : {}) },
      sscrt: { needsKey: this.sscrtNeedsKey },
      spark: this.spark ? { ...this.spark.info(), balance: this.spark.balance() ? { total: formatAmount(this.spark.balance()!.total, 8), spendable: formatAmount(this.spark.balance()!.spendable, 8) } : null } : null,
      mweb: this.mweb ? { ...this.mweb.info(), balance: this.mweb.balance() ? { total: formatAmount(this.mweb.balance()!.total, 8), spendable: formatAmount(this.mweb.balance()!.spendable, 8) } : null } : null,
      arrr: arrr ? { scanning: arrr.isScanning, percent: arrr.percent } : null,
      zec: zec ? { ...zec.state(), address: zec.receive?.unified ?? '', transparentAddress: zec.transparentAddress } : null,
      addresses: { ...Object.fromEntries(EVM.map((a) => [a, eth.address])), BTC: btc.receiveAddress, XMR: await monero.getPrimaryAddress(), ETH: eth.address, TRX: tron.address, USDTE: eth.address, USDT: tron.address, DASH: dash.receiveAddress, FIRO: firo.receiveAddress, SOL: this.sol!.receiveAddress, USDTS: this.sol!.receiveAddress, JUP: this.sol!.receiveAddress, RAY: this.sol!.receiveAddress, USDCS: this.sol!.receiveAddress, BCH: bareBch(this.bch!.receiveAddress), LTC: this.ltc!.receiveAddress, SCRT: this.scrt!.address, SSCRT: this.scrt!.address, NEAR: this.near!.receiveAddress, DOGE: this.doge!.receiveAddress, ...(zec ? { ZEC: zec.receive?.unified ?? '' } : {}), ...(zano ? { ZANO: zano.receive } : {}), ...(arrr ? { ARRR: arrr.receive } : {}) },
      monero: monero.state,
    };
  }

  /** Answers without any network, so the receive screen never waits on a slow connection. */
  async addresses() {
    const { tron, monero, btc, eth, dash } = this.session();
    // Every Ethereum, Polygon and Arbitrum coin and token lives on the one 0x address.
    return { ...Object.fromEntries(EVM.map((a) => [a, eth.address])), DASH: dash.receiveAddress, FIRO: this.firo!.receiveAddress, SOL: this.sol!.receiveAddress, USDTS: this.sol!.receiveAddress, JUP: this.sol!.receiveAddress, RAY: this.sol!.receiveAddress, USDCS: this.sol!.receiveAddress, BCH: bareBch(this.bch!.receiveAddress), LTC: this.ltc!.receiveAddress, SCRT: this.scrt!.address, SSCRT: this.scrt!.address, NEAR: this.near!.receiveAddress, DOGE: this.doge!.receiveAddress, BTC: btc.receiveAddress, XMR: await monero.getPrimaryAddress(), ETH: eth.address, TRX: tron.address, USDTE: eth.address, USDT: tron.address, ...(this.zec ? { ZEC: this.zec.receive?.unified ?? '', ZEC_T: this.zec.transparentAddress } : {}), ...(this.zano ? { ZANO: this.zano.receive } : {}), ...(this.arrr ? { ARRR: this.arrr.receive } : {}) };
  }

  async torInfo() {
    return { updatable: !this.dev.nativeTor, enabled: this.torActive, setting: this.settings.torEnabled, allowed: (await this.walletMode()) === 'private', installed: this.tor.isInstalled(), state: this.tor.state };
  }

  async installTor() {
    return this.tor.install((message) => this.emit('tor-install', message));
  }

  async history(asset: Asset) {
    const { tron, monero, btc, eth, dash } = this.session();
    if (asset === 'DASH') return dash.getHistory();
    if (asset === 'FIRO') {
      const pub = await this.firo!.getHistory();
      const priv = this.spark?.history() ?? [];
      // A move between the two balances shows once, as a move to self.
      const both = new Set(pub.map((h) => h.hash).filter((h) => priv.some((p) => p.hash === h)));
      return [...pub.map((h) => (both.has(h.hash) ? { ...h, direction: 'self' as const } : h)), ...priv.filter((p) => !both.has(p.hash))].sort((a, b) => b.timestamp - a.timestamp);
    }
    if (asset === 'SOL') return this.sol!.getHistory();
    if (isSpl(asset)) return this.sol!.getUsdtHistory(asset);
    if (asset === 'DOGE') return this.doge!.getHistory();
    if (asset === 'BCH') return this.bch!.getHistory();
    if (asset === 'ZEC') return this.zec ? this.zec.getHistory() : [];
    if (asset === 'ZANO') return this.zano ? this.zano.getHistory() : [];
    if (asset === 'ARRR') return this.arrr ? this.arrr.getHistory() : [];
    if (asset === 'BTC') return btc.getHistory();
    if (asset === 'LTC') return this.ltc!.getHistory();
    if (asset === 'SCRT') return this.scrt!.getHistory();
    if (asset === 'NEAR') return this.near!.getHistory();
    if (asset === 'SSCRT') return this.scrt!.getPrivateHistory();
    if (isEvm(asset)) return this.evm(asset).getHistory(asset);
    return asset === 'XMR' ? monero.getHistory() : tron.getHistory(asset);
  }

  // ---- swap ----

  /** Exolix needs no key. The others join once their key is in settings. */
  private swapClients(): Partial<Record<SwapProviderId, SwapProvider>> {
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
    return clients;
  }
  // ---- swaps on the chain itself (Uniswap, PancakeSwap) ----

  /** The chain both coins sit on, or null when a DEX can't swap them. */
  private dexChain(from: Asset, to: Asset): EvmChain | null {
    if (from === to || !isEvm(from) || !isEvm(to)) return null;
    const a = chainOf(from as EthAsset);
    return a === chainOf(to as EthAsset) ? a : null;
  }

  private tokenAddress(asset: Asset): string {
    const chain = chainOf(asset as EthAsset);
    return asset === chain.native ? NATIVE : chain.tokens[asset as EthAsset]!.contract;
  }

  private uniswap(): UniswapClient | null {
    const key = this.dev.uniswapKey ?? BUILTIN_SWAP_KEYS.uniswap;
    return key ? new UniswapClient(key, this.priceAgent, this.torActive ? 40_000 : 20_000, this.dev.uniswapBase) : null;
  }

  private async dexQuotes(from: Asset, to: Asset, amountIn: bigint, slippageBps: number): Promise<{ id: DexId; quote?: DexQuote; problem?: string }[]> {
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
    const { quote, from, calls } = preview.dex;
    const client = this.evm(from);
    const account = deriveEthAccount(secrets.tronMnemonic);
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

  // ---- Hyperliquid perpetual futures: WalletConnect wallets only ----

  private perps() {
    if (!this.hl || !this.hlKey) throw new Error('Perps are only in WalletConnect wallets.');
    return { hl: this.hl, agent: this.hlKey };
  }

  /** The trading key and the Kusari fee are approved on Hyperliquid itself; checked there, kept a minute. */
  private async hlReady(fresh = false): Promise<{ ready: boolean; agent: boolean; builder: boolean; until: number }> {
    const { hl, agent } = this.perps();
    if (!fresh && this.hlStatus && Date.now() - this.hlStatus.at < 60_000) return this.hlStatus.value;
    const s = await hl.status(agent);
    const value = { ready: s.agent && s.builder, ...s };
    this.hlStatus = { at: Date.now(), value };
    return value;
  }

  private async needTrading() {
    const p = this.perps();
    if (!(await this.hlReady()).ready) throw new Error('Turn on trading first.');
    return p;
  }

  async perpsInfo() {
    const { hl } = this.perps();
    const st = await this.hlReady().catch(() => ({ ready: false, agent: false, builder: false, until: 0 }));
    return { ...st, address: hl.user, fee: { maker: feePct(KUSARI_FEE.maker), taker: feePct(KUSARI_FEE.taker) }, minDeposit: HL_MIN_DEPOSIT, withdrawFee: HL_WITHDRAW_FEE };
  }

  async perpsMarkets(): Promise<HlMarket[]> {
    const { hl } = this.perps();
    if (this.perpMarkets && Date.now() - this.perpMarkets.at < 10_000) return this.perpMarkets.list;
    const list = await hl.markets();
    this.perpMarkets = { at: Date.now(), list };
    return list;
  }

  private async hlMarket(symbol: string): Promise<HlMarket> {
    const m = (await this.perpsMarkets()).find((x) => x.symbol === symbol);
    if (!m) throw new Error('This market is not listed.');
    return m;
  }

  async perpsAccount() {
    const { hl } = this.perps();
    return hl.account();
  }

  /** Everything the trade screen shows for one market. */
  async perpsMarket(symbol: string) {
    const { hl } = this.perps();
    const m = await this.hlMarket(symbol);
    const fees = await hl.fees();
    return { market: m, mark: m.mark, funding: m.funding, maxLeverage: m.maxLeverage, openInterest: m.openInterest, venueFee: fees, kusariFee: { maker: feePct(KUSARI_FEE.maker), taker: feePct(KUSARI_FEE.taker) } };
  }

  async perpsBook(symbol: string) {
    return this.perps().hl.book(symbol, 8);
  }

  /** Kusari's own index from exchange spot prices, beside Hyperliquid's: for comparison only. Kept 10 seconds. */
  async perpsIndex(symbol: string) {
    this.perps();
    const hit = this.perpIndex.get(symbol);
    if (hit && Date.now() - hit.at < 10_000) return hit;
    const base = this.dev.kindexBase ? Object.fromEntries(['Binance', 'OKX', 'Bybit', 'Kraken', 'KuCoin', 'Gate', 'MEXC'].map((n) => [n, `${this.dev.kindexBase}/${n}`])) : undefined;
    const value = await kusariIndex(symbol, { base });
    this.perpIndex.set(symbol, value);
    return value;
  }

  async perpsCandles(symbol: string, interval: string) {
    return this.perps().hl.candles(symbol, interval, 300);
  }

  /** Approves the trading key and the Kusari fee cap, both signed by this wallet's own key. */
  async perpsEnable(password: string) {
    const { hl, agent } = this.perps();
    const secrets = await this.vault.open(password);
    await hl.enable(deriveEthAccount(secrets.tronMnemonic).wallet, agent);
    this.hlStatus = null;
    return this.hlReady(true);
  }

  /**
   * A new position: margin in USDC times leverage gives its size. Isolated margin, so a loss stops at that margin.
   * Returns what the order will be, for review; nothing is sent yet.
   */
  async perpsPrepareOrder(input: { symbol: string; side: 'long' | 'short'; type: 'MARKET' | 'LIMIT'; margin: string; leverage: number; price?: string; postOnly?: boolean }) {
    const { hl } = await this.needTrading();
    this.perpMarkets = null;
    const m = await this.hlMarket(input.symbol);
    const margin = Number(input.margin);
    if (!(margin > 0)) throw new Error('Enter how much USDC to put in.');
    const lev = Math.floor(Number(input.leverage));
    if (!(lev >= 1 && lev <= m.maxLeverage)) throw new Error(`Leverage can be 1x to ${m.maxLeverage}x on this market.`);
    const limit = input.type === 'LIMIT';
    const buy = input.side === 'long';
    const ref = limit ? Number(input.price) : m.mid || m.mark;
    if (!(ref > 0)) throw new Error(limit ? 'Enter a price.' : 'No price for this market right now.');
    // A market order is an immediate-or-cancel limit 5% past the market, so it can't fill at a runaway price.
    const price = limit ? hlPrice(ref, m.szDecimals) : hlPrice(buy ? ref * 1.05 : ref * 0.95, m.szDecimals, buy ? 'up' : 'down');
    if (limit && input.postOnly && ((buy && Number(price) >= m.mark) || (!buy && Number(price) <= m.mark))) {
      throw new Error(buy
        ? 'A post-only buy must be below the current price, or it would trade at once and be cancelled.'
        : 'A post-only sell must be above the current price, or it would trade at once and be cancelled.');
    }
    const fillPx = limit ? Number(price) : ref;
    const size = hlSize((margin * lev) / fillPx, m.szDecimals);
    const notional = Number(size) * fillPx;
    if (!(Number(size) > 0) || notional < 10) throw new Error('Too small. The smallest order is 10 USDC (margin × leverage).');
    const tif = limit ? (input.postOnly ? 'Alo' : 'Gtc') : 'Ioc';
    const kusariRate = feePct(builderFee(tif));
    const fees = await hl.fees();
    const venueRate = fees ? (tif === 'Alo' ? fees.maker : fees.taker) : null;
    const acct = await hl.account();
    const cost = notional / lev + notional * (kusariRate + (venueRate ?? 0));
    if (cost > acct.available + 1e-9) throw new Error(`Not enough in your futures account: ${acct.available.toFixed(2)} USDC is free. Deposit more or use less.`);
    const order: OrderInput = { asset: m.asset, buy, price, size, tif };
    const id = randomUUID();
    this.perpPreviews.set(id, { order, leverage: lev, expires: Date.now() + 60_000 });
    return {
      id, symbol: m.symbol, base: m.base, side: input.side, type: input.type, postOnly: tif === 'Alo', quantity: size, price: fillPx, limitPrice: Number(price), notional, margin: notional / lev, leverage: lev,
      liquidation: liquidationPrice(input.side, fillPx, Number(size), notional / lev, m.maxLeverage),
      venueFee: venueRate === null ? null : notional * venueRate, venueRate, kusariFee: notional * kusariRate, kusariRate,
      warnings: [
        'Leverage multiplies losses as much as gains. If the price reaches the liquidation price, the margin in this position is lost.',
        ...(limit ? [] : ['A market order fills at the best prices on the order book, at most 5% away from the price shown.']),
        ...(m.funding ? [m.funding > 0
          ? `Funding: ${(m.funding * 100).toFixed(4)}% every hour, paid by longs to shorts.`
          : `Funding: ${(Math.abs(m.funding) * 100).toFixed(4)}% every hour, paid by shorts to longs.`] : []),
      ],
    };
  }

  /** Closing a whole position: an order the other way that can only reduce it. */
  async perpsPrepareClose(symbol: string) {
    const { hl } = await this.needTrading();
    this.perpMarkets = null;
    const [acct, m] = await Promise.all([hl.account(), this.hlMarket(symbol)]);
    const p = acct.positions.find((x) => x.symbol === symbol);
    if (!p) throw new Error('There is no open position on this market.');
    const buy = p.side === 'short';
    const ref = m.mid || m.mark;
    const fees = await hl.fees();
    const notional = Number(p.size) * ref;
    const id = randomUUID();
    this.perpPreviews.set(id, { order: { asset: m.asset, buy, price: hlPrice(buy ? ref * 1.05 : ref * 0.95, m.szDecimals, buy ? 'up' : 'down'), size: p.size, tif: 'Ioc', reduceOnly: true }, leverage: 0, expires: Date.now() + 60_000 });
    const kusariRate = feePct(KUSARI_FEE.taker);
    return { id, symbol, base: m.base, side: p.side, quantity: p.size, price: ref, notional, pnl: p.pnl, venueFee: fees ? notional * fees.taker : null, venueRate: fees?.taker ?? null, kusariFee: notional * kusariRate, kusariRate };
  }

  async perpsPlace(id: string) {
    const { hl, agent } = await this.needTrading();
    const p = this.perpPreviews.get(id);
    this.perpPreviews.delete(id);
    if (!p?.order || p.expires < Date.now()) throw new Error('Prices moved on. Review the order again.');
    if (p.leverage) await hl.setLeverage(p.order.asset, p.leverage, agent);
    return hl.order(p.order, agent);
  }

  async perpsCancel(symbol: string, orderId: number) {
    const { hl, agent } = await this.needTrading();
    await hl.cancel((await this.hlMarket(symbol)).asset, orderId, agent);
  }

  /** Native USDC on Arbitrum into the Hyperliquid account, through its bridge. Under 5 USDC would be lost, so it is refused. */
  async perpsDepositPrepare(amountInput: string) {
    this.perps();
    const asset: Asset = 'USDCA';
    const client = this.evm(asset);
    const amount = parseAmount(amountInput, DECIMALS[asset]);
    if (amount < BigInt(HL_MIN_DEPOSIT) * 10n ** BigInt(DECIMALS[asset])) throw new Error(`A deposit needs at least ${HL_MIN_DEPOSIT} USDC. Less would be lost.`);
    if (amount > (await client.balanceOf('USDCA' as EthAsset, true))) throw new Error('Not enough USDC on Arbitrum.');
    const token = chainOf('USDCA' as EthAsset).tokens.USDCA!;
    const calls: DexCall[] = [{ label: 'swap', to: token.contract, data: encodeDeposit(amount), value: 0n, gas: 120_000n }];
    const cost = await client.costOf(calls, 120_000n);
    if (cost.most > (await client.balanceOf('ETHA' as EthAsset, true))) throw new Error(`Not enough ETH on Arbitrum for the network fee. Up to ${formatAmount(cost.most, 18)} is needed.`);
    const preview = this.storePreview({ asset, to: HL_BRIDGE, amount, fee: cost.likely, perpDeposit: { calls } });
    return { id: preview.id, asset, amount: formatAmount(amount, DECIMALS[asset]), fee: formatAmount(cost.likely, 18), feeAsset: 'ETH', steps: 1 };
  }

  async perpsDepositConfirm(id: string, password: string) {
    const preview = this.previews.get(id);
    if (!preview?.perpDeposit || preview.expires < Date.now()) { this.previews.delete(id); throw new Error('The review expired. Try again.'); }
    const secrets = await this.vault.open(password);
    this.previews.delete(id);
    this.balanceMemo.clear();
    const hashes = await this.evm(preview.asset).sendCalls(preview.perpDeposit.calls, deriveEthAccount(secrets.tronMnemonic).wallet, 120_000n);
    return { hashes, explorer: hashes.map((h) => this.explorerUrl(preview.asset, h)) };
  }

  // ---- HYPE between HyperEVM (this wallet) and HyperCore (the trading engine) ----

  async hypeCore() {
    const { hl } = this.perps();
    return { ...(await hl.hypeOnCore()), reserve: HYPE_CORE_RESERVE };
  }

  /** HyperEVM to HyperCore: native HYPE sent to the system address, with HyperEVM's usual fee. */
  async hypeToCorePrepare(amountInput: string) {
    this.perps();
    const client = this.evm('HYPE');
    const amount = parseAmount(amountInput, 18);
    if (amount <= 0n) throw new Error('Enter an amount.');
    const calls: DexCall[] = [{ label: 'swap', to: HYPE_SYSTEM, data: '0x', value: amount, gas: 60_000n }];
    const cost = await client.costOf(calls, 60_000n);
    const have = await client.balanceOf('HYPE' as EthAsset, true);
    if (amount + cost.most > have) throw new Error(`Not enough HYPE. Up to ${formatAmount(cost.most, 18)} HYPE is needed for the fee on top of the amount.`);
    const preview = this.storePreview({ asset: 'HYPE', to: HYPE_SYSTEM, amount, fee: cost.likely, perpDeposit: { calls } });
    return { id: preview.id, amount: formatAmount(amount, 18), fee: formatAmount(cost.likely, 18), direction: 'core' as const };
  }

  async hypeToCoreConfirm(id: string, password: string) {
    return this.perpsDepositConfirm(id, password);
  }

  /** HyperCore to HyperEVM: a spot send signed by this wallet's key; HyperCore keeps a little HYPE for the gas. */
  async hypeToEvmPrepare(amountInput: string) {
    const { hl } = this.perps();
    const amount = Math.floor(Number(amountInput) * 1e8) / 1e8;
    if (!(amount > 0)) throw new Error('Enter an amount.');
    const core = await hl.hypeOnCore();
    if (amount > core.available - HYPE_CORE_RESERVE + 1e-12) throw new Error(`Only ${Math.max(0, core.available - HYPE_CORE_RESERVE).toFixed(4)} HYPE can be moved: ${HYPE_CORE_RESERVE} HYPE stays on HyperCore for the move's gas.`);
    const id = randomUUID();
    const value = amount.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
    this.perpPreviews.set(id, { hypeOut: value, expires: Date.now() + 5 * 60_000 });
    return { id, amount: value, direction: 'evm' as const };
  }

  async hypeToEvmConfirm(id: string, password: string) {
    const { hl } = this.perps();
    const p = this.perpPreviews.get(id);
    if (!p?.hypeOut || p.expires < Date.now()) { this.perpPreviews.delete(id); throw new Error('The review expired. Try again.'); }
    const secrets = await this.vault.open(password);
    this.perpPreviews.delete(id);
    await hl.hypeToEvm(deriveEthAccount(secrets.tronMnemonic).wallet, p.hypeOut);
    this.balanceMemo.clear();
    return { ok: true };
  }

  /** Back to this wallet's own address on Arbitrum: Hyperliquid pays out only to the account's address. */
  async perpsWithdrawPrepare(amountInput: string) {
    const { hl } = this.perps();
    const amount = Number(amountInput);
    if (!(amount > 0)) throw new Error('Enter an amount.');
    const acct = await hl.account();
    if (amount > acct.available + 1e-9) throw new Error(`Only ${acct.available.toFixed(2)} USDC can be taken out right now. Margin in open positions and orders stays until they close.`);
    if (amount <= HL_WITHDRAW_FEE) throw new Error(`The amount must be more than the withdrawal fee of ${HL_WITHDRAW_FEE} USDC.`);
    const id = randomUUID();
    const value = (Math.floor(amount * 1e6) / 1e6).toString();
    this.perpPreviews.set(id, { withdraw: { amount: value }, expires: Date.now() + 5 * 60_000 });
    return { id, amount: value, fee: String(HL_WITHDRAW_FEE), receive: (Math.floor((amount - HL_WITHDRAW_FEE) * 1e6) / 1e6).toString(), to: hl.user, token: 'USDC', network: 'Arbitrum' };
  }

  async perpsWithdrawConfirm(id: string, password: string) {
    const { hl } = this.perps();
    const p = this.perpPreviews.get(id);
    if (!p?.withdraw || p.expires < Date.now()) { this.perpPreviews.delete(id); throw new Error('The review expired. Try again.'); }
    const secrets = await this.vault.open(password);
    this.perpPreviews.delete(id);
    await hl.withdraw(deriveEthAccount(secrets.tronMnemonic).wallet, p.withdraw.amount);
    return { ok: true };
  }

  // ---- WalletConnect: only in wallets made for it ----

  private get modePath() { return path.join(this.dir, 'mode.json'); }

  /** 'private' (the default, and every wallet made before this choice existed) or 'walletconnect'. */
  async walletMode(): Promise<'private' | 'walletconnect'> {
    try { return JSON.parse(await fs.readFile(this.modePath, 'utf8') as unknown as string).mode === 'walletconnect' ? 'walletconnect' : 'private'; } catch { return 'private'; }
  }

  async setWalletMode(mode: 'private' | 'walletconnect'): Promise<void> {
    if (mode !== 'private' && mode !== 'walletconnect') throw new Error('Unknown mode.');
    // A wallet's mode is chosen when it is made and never changes: a WalletConnect wallet's address has been shown to
    // dApps, and a maximum-privacy wallet must never start talking to them.
    if (await this.vault.exists()) throw new Error('A wallet\'s mode is chosen when it is made and can\'t be changed.');
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.modePath, JSON.stringify({ mode }), { mode: 0o600 });
    if (mode === 'private') {
      await this.wc?.stop();
      this.wc = null;
      await fs.rm(path.join(this.dir, 'walletconnect.json'), { force: true }); // the dApp sessions go with it
    } else if (this.eth) {
      await this.startWalletConnect(this.eth.address);
    }
  }

  private wcProjectId(): string { return this.dev.wcProjectId ?? (BUILTIN_SWAP_KEYS as { walletconnect?: string }).walletconnect ?? ''; }

  private async startWalletConnect(address: string): Promise<void> {
    if (this.wc || (await this.walletMode()) !== 'walletconnect' || this.torActive || !this.wcProjectId()) return;
    this.wc = new WalletConnectManager(this.wcProjectId(), path.join(this.dir, 'walletconnect.json'), address, (event, data) => this.emit(event, data));
    await this.wc.resume().catch(() => undefined);
  }

  private walletConnect(): WalletConnectManager {
    this.session();
    if (this.torActive) throw new Error('WalletConnect can\'t go through Tor, so it is off while Tor is on.');
    if (!this.wc) throw new Error(this.wcProjectId() ? 'WalletConnect is only in wallets made for it. Choose it when adding a wallet.' : 'WalletConnect isn\'t set up in this build.');
    return this.wc;
  }

  async wcInfo() {
    return { mode: await this.walletMode(), tor: this.torActive, available: Boolean(this.wcProjectId()), sessions: this.wc?.sessions() ?? [] };
  }
  async wcPair(uri: string) { await this.walletConnect().pair(uri); }
  async wcApprove(id: number) { await this.walletConnect().approve(id); }
  async wcReject(id: number) { await this.walletConnect().reject(id); }
  async wcDisconnect(topic: string) { await this.walletConnect().disconnect(topic); }
  /** Ends every dApp connection; the wallet stays a WalletConnect wallet. */
  async wcDisconnectAll() {
    const wc = this.walletConnect();
    for (const s of wc.sessions()) await wc.disconnect(s.topic).catch(() => undefined);
  }
  async wcDecline(id: number) { await this.wc?.decline(id); }

  private evmByChain(id: bigint): EthClient {
    const c = id === POLYGON.id ? this.pol : id === ARBITRUM.id ? this.arb : id === BSC.id ? this.bsc : id === HYPEREVM.id ? this.hype : id === 1n ? this.eth : null;
    if (!c) throw new Error('This wallet doesn\'t support that network.');
    return c;
  }

  /** What a dApp asks for, spelled out: who, which network, and what signing it would do. */
  async wcRequestInfo(id: number) {
    const r = this.walletConnect().request(id);
    const chain = WC_CHAINS.find((c) => c.id === r.chainId)!;
    const me = this.session().eth.address.toLowerCase();
    const warnings: string[] = [];
    const base = { id, dapp: r.dapp, url: r.url, network: chain.name, method: r.method };
    if (r.method === 'personal_sign') {
      const [msg, who] = r.params ?? [];
      if (String(who ?? '').toLowerCase() !== me) warnings.push('The dApp named a different address.');
      const bytes = /^0x[0-9a-fA-F]*$/.test(String(msg)) ? Buffer.from(String(msg).slice(2), 'hex') : Buffer.from(String(msg), 'utf8');
      const text = bytes.toString('utf8');
      return { ...base, kind: 'message', message: /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(text) ? text : `0x${bytes.toString('hex')}`, warnings };
    }
    if (r.method.startsWith('eth_signTypedData')) {
      const { who, data } = typedRequest(r.params);
      if (who.toLowerCase() !== me) warnings.push('The dApp named a different address.');
      if (/permit/i.test(String(data?.primaryType))) warnings.push('This is a permit: signing it lets the dApp move your tokens without another confirmation.');
      if (data?.domain?.chainId !== undefined && BigInt(data.domain.chainId) !== r.chainId) warnings.push('The message names a different network.');
      return { ...base, kind: 'typed', type: String(data?.primaryType ?? ''), domain: String(data?.domain?.name ?? ''), contract: String(data?.domain?.verifyingContract ?? ''), message: JSON.stringify(data?.message ?? {}, null, 1).slice(0, 2000), warnings };
    }
    const tx = r.params?.[0] ?? {};
    if (String(tx.from ?? '').toLowerCase() !== me) throw new Error('The dApp asked to send from a different address.');
    const client = this.evmByChain(r.chainId);
    const value = BigInt(tx.value ?? 0);
    const data = String(tx.data ?? tx.input ?? '0x');
    let action = value ? `Send ${formatAmount(value, 18)} ${client.chain.symbol}` : 'Contract call';
    if (data.startsWith('0x095ea7b3') && data.length >= 138) {
      const amount = BigInt('0x' + data.slice(74, 138));
      action = `Allow ${'0x' + data.slice(34, 74)} to spend a token`;
      if (amount >= 2n ** 255n) warnings.push('This approval has no limit: the contract could take all of this token, now or later.');
    }
    const gas = tx.gas ? BigInt(tx.gas) : await client.estimateCall({ to: tx.to, data, value }).catch(() => 300_000n);
    const cost = await client.costOf([{ value, gas }], gas);
    return { ...base, kind: 'transaction', to: String(tx.to ?? ''), value: formatAmount(value, 18), symbol: client.chain.symbol, action, data: data.slice(0, 74), fee: formatAmount(cost.likely, 18), warnings };
  }

  async wcConfirm(id: number, password: string): Promise<{ result: string }> {
    const wc = this.walletConnect();
    const r = wc.request(id);
    const secrets = await this.vault.open(password);
    const account = deriveEthAccount(secrets.tronMnemonic);
    let result: string;
    if (r.method === 'personal_sign') {
      const msg = String(r.params?.[0] ?? '');
      result = await account.wallet.signMessage(/^0x[0-9a-fA-F]*$/.test(msg) ? Buffer.from(msg.slice(2), 'hex') : msg);
    } else if (r.method.startsWith('eth_signTypedData')) {
      const { data } = typedRequest(r.params);
      const { EIP712Domain: _d, ...types } = data.types ?? {};
      result = await account.wallet.signTypedData(data.domain ?? {}, types, data.message ?? {});
    } else {
      const tx = r.params?.[0] ?? {};
      const client = this.evmByChain(r.chainId);
      const value = BigInt(tx.value ?? 0);
      const data = String(tx.data ?? tx.input ?? '0x');
      const gas = tx.gas ? BigInt(tx.gas) : await client.estimateCall({ to: tx.to, data, value });
      if (gas > 3_000_000n) throw new Error('This transaction asks for an abnormal amount of gas, so it was stopped.');
      [result] = await client.sendCalls([{ to: String(tx.to), data, value, gas }], account.wallet, gas);
      this.balanceMemo.clear();
    }
    await wc.respond(id, result);
    return { result };
  }

  /** The client for the chain an EVM coin or token lives on. */
  private evm(asset: Asset): EthClient {
    const id = chainOf(asset as EthAsset).id;
    const client = id === POLYGON.id ? this.pol : id === ARBITRUM.id ? this.arb : id === BSC.id ? this.bsc : id === HYPEREVM.id ? this.hype : this.session().eth;
    if (!client) throw new Error('The wallet is locked.');
    return client;
  }

  private get swapsPath() { return path.join(this.dir, 'swaps.json'); }

  async swapList(): Promise<SwapRecord[]> {
    try { return JSON.parse(await fs.readFile(this.swapsPath, 'utf8') as unknown as string); } catch { return []; }
  }

  /** Older records can name a coin the wallet no longer has, and the screen can't draw those. They stay on disk. */
  async swapHistory(): Promise<SwapRecord[]> {
    return (await this.swapList()).filter((r) => r.from in DECIMALS && r.to in DECIMALS);
  }

  private async swapSave(list: SwapRecord[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.swapsPath, JSON.stringify(list.slice(0, 100)), { mode: 0o600 });
  }

  async swapQuote(from: Asset, to: Asset, amountInput: string) {
    this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    if (from === to) throw new Error('Choose a different coin.');
    if (NOT_SWAPPABLE.has(from) || NOT_SWAPPABLE.has(to)) throw new Error('sSCRT can\'t be swapped. Make it public as SCRT first.');
    const amount = formatAmount(parseAmount(amountInput, DECIMALS[from]), DECIMALS[from]);
    const clients = Object.entries(this.swapClients()) as [SwapProviderId, SwapProvider][];
    // The slowest provider mustn't hold up the others, so each gets a deadline and the screen shows whoever answered.
    const deadline = this.dev.quoteDeadlineMs ?? (this.torActive ? QUOTE_DEADLINE_TOR_MS : QUOTE_DEADLINE_MS);
    const failed = (id: SwapProviderId, problem: string) => ({ from, to, amount, receive: '0', rate: '0', min: null, max: null, approximate: true, providerId: id, provider: SWAP_NAMES[id], problem });
    const results = await Promise.all(clients.map(async ([id, client]) => {
      try { return await within(deadline, client.quote(from, to, amount), failed(id, 'Too slow to answer right now.')); } catch (e) {
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
  private async checkDestination(asset: Asset, input: string): Promise<string> {
    const { monero } = this.session();
    const address = input.trim();
    const valid = asset === 'BTC' ? isBtcAddress(address)
      : asset === 'LTC' ? isLtcAddress(address) || isMwebAddress(address)
      : asset === 'SCRT' || asset === 'SSCRT' ? isScrtAddress(address)
      : asset === 'NEAR' ? isNearAccount(address)
      : asset === 'DASH' ? isDashAddress(address)
      : asset === 'FIRO' ? isFiroAddress(address) || isSparkAddress(address)
      : asset === 'SOL' || isSpl(asset) ? isSolAddress(address)
      : asset === 'DOGE' ? isDogeAddress(address)
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

  private async myAddress(asset: Asset): Promise<string> {
    const { tron, monero, btc, eth, dash } = this.session();
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
    if (isEvm(asset)) return eth.address;
    return asset === 'SOL' || isSpl(asset) ? this.sol!.receiveAddress : asset === 'BCH' ? this.bch!.receiveAddress : asset === 'LTC' ? this.ltc!.receiveAddress : asset === 'SCRT' || asset === 'SSCRT' ? this.scrt!.address : asset === 'NEAR' ? this.near!.receiveAddress : asset === 'DOGE' ? this.doge!.receiveAddress : asset === 'FIRO' ? this.firo!.receiveAddress : asset === 'DASH' ? dash.receiveAddress : asset === 'BTC' ? btc.receiveAddress : asset === 'XMR' ? monero.getPrimaryAddress() : tron.address;
  }

  private async openOrder(from: Asset, to: Asset, amount: string, providerId: SwapProviderId, withdrawal: string, refund: string, external: boolean, privacy?: { leg: 'first'; via: string; destination: string } | { leg: 'second'; id: string }) {
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
    if (NOT_SWAPPABLE.has(from) || NOT_SWAPPABLE.has(to)) throw new Error('sSCRT can\'t be swapped. Make it public as SCRT first.');
    this.session();
    if (from === to) throw new Error('Choose a different coin.');
    const amount = formatAmount(parseAmount(amountInput, DECIMALS[from]), DECIMALS[from]);
    const external = destination.trim() !== '';
    const withdrawal = external ? await this.checkDestination(to, destination) : await this.myAddress(to);
    return this.openOrder(from, to, amount, providerId, withdrawal, await this.myAddress(from), external);
  }

  // ---- privacy swap: coin -> fresh XMR subaddress -> outside address, as two unrelated orders ----

  private get privacyPath() { return path.join(this.dir, 'privacy-swaps.json'); }

  async privacyList(): Promise<PrivacySwap[]> {
    try { return JSON.parse(await fs.readFile(this.privacyPath, 'utf8') as unknown as string); } catch { return []; }
  }

  private async privacySave(list: PrivacySwap[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.privacyPath, JSON.stringify(list.slice(0, 50)), { mode: 0o600 });
  }

  private assertPrivacyPair(from: Asset, to: Asset): void {
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

  /** USD prices. Sends no address or balance, only asks for these three coins. Cached for 5 minutes. */
  async prices(): Promise<PriceMap | null> {
    if (!this.settings.showPrices) return null;
    if (this.priceCache && Date.now() - this.priceCache.at < 300_000) return this.priceCache.value;
    // After every source has failed, wait a little: asking again only prolongs a rate limit.
    if (Date.now() < this.priceRetryAt) return this.priceCache?.value ?? null;
    if (!this.priceInFlight) this.priceInFlight = this.fetchPrices().finally(() => { this.priceInFlight = null; });
    return this.priceInFlight;
  }

  private async fetchPrices(): Promise<PriceMap | null> {
    const sources = this.dev.priceSources ?? (this.dev.priceUrl ? [coingecko(this.dev.priceUrl)] : PRICE_SOURCES);
    // Not every source lists every coin, so the rest are only asked when the first left something out, and all at
    // once because a blocked one would otherwise hold up the others. Earlier sources win where they overlap.
    const ask = async (source: PriceSource, timeoutMs: number) => source.parse(await getJson(source.url, { agent: this.priceAgent, timeoutMs, headers: { Accept: 'application/json', 'User-Agent': 'KusariWallet' } }));
    const tor = this.torActive;
    const [first, ...rest] = sources;
    let value = first ? await ask(first, tor ? 45_000 : 10_000).catch(() => null) : null;
    if (rest.length && !(value && Object.keys(DECIMALS).every((a) => value![a as Asset]))) {
      const more = await Promise.allSettled(rest.map((source) => ask(source, tor ? 30_000 : 10_000)));
      for (const r of more) if (r.status === 'fulfilled') value = { ...r.value, ...(value ?? {}) } as PriceMap;
    }
    // Aave's on-chain oracles, through the wallet's own nodes, for whatever is still missing.
    if (!this.dev.priceSources && !(value && AAVE_MARKETS.every((m) => m.assets.every(([a]) => value![a])))) {
      const found = await this.aavePrices().catch(() => ({}));
      if (Object.keys(found).length) {
        const filled = { ...found, ...(value ?? {}) } as PriceMap;
        if (filled.USDT) for (const a of ['USDTE', 'USDTS', 'USDTP', 'USDTA', 'USDTB'] as Asset[]) filled[a] ??= filled.USDT;
        mirror(filled);
        value = filled;
      }
    }
    if (value) this.priceCache = { at: Date.now(), value };
    if (value) return value;
    this.priceRetryAt = Date.now() + 60_000;
    return this.priceCache?.value ?? null;
  }

  private async aavePrices(): Promise<Partial<PriceMap>> {
    const client = { eth: this.eth, bsc: this.bsc, arb: this.arb, pol: this.pol };
    const answers = await Promise.allSettled(AAVE_MARKETS.map(async (m) => {
      const c = client[m.chain];
      if (!c) return {};
      const hex = await within(15_000, c.call(m.oracle, aaveCall(m)), null);
      return hex ? readAave(m, hex) : {};
    }));
    return Object.assign({}, ...answers.map((a) => (a.status === 'fulfilled' ? a.value : {})));
  }

  async flush(): Promise<void> { await this.monero?.flush(); }

  async moneroAddresses() { return this.session().monero.listAddresses(); }
  async newSubaddress() { return this.session().monero.createSubaddress(); }

  async qr(text: string): Promise<string> {
    // A Zcash unified address runs past 200 characters.
    if (text.length > 500) throw new Error('This value can\'t be made into a QR code.');
    return QRCode.toDataURL(text, { margin: 1, width: 320, errorCorrectionLevel: 'M', color: { dark: '#16302b', light: '#ffffff' } });
  }

  // ---- what a transfer costs right now ----

  private feeCache = new Map<Asset, { at: number; value: { fee: string; asset: string; usd: number | null } }>();

  /** A typical transfer of this coin. Null when it can't be told, never a made-up number. */
  async feeEstimate(asset: Asset): Promise<{ fee: string; asset: string; usd: number | null } | null> {
    const cached = this.feeCache.get(asset);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const { tron, btc, eth } = this.session();
    const read = async (): Promise<[bigint, number, string]> => {
      if (asset === 'BTC') return [estimateVbytes(1, 2) * (await btc.feeRate()), 8, 'BTC'];
      if (asset === 'LTC') return [estimateVbytes(1, 2, LITECOIN.inputVb, LITECOIN.outputVb) * (await this.ltc!.feeRate()), 8, 'LTC'];
      if (asset === 'DASH') return [typicalDashFee(), 8, 'DASH'];
      if (asset === 'FIRO') return [typicalFiroFee(), 8, 'FIRO'];
      if (asset === 'SOL' || isSpl(asset)) return [SOL_FEE, 9, 'SOL'];
      if (asset === 'DOGE') return [typicalDogeFee(), 8, 'DOGE'];
      if (asset === 'BCH') return [typicalBchFee(), 8, 'BCH'];
      if (asset === 'SCRT') return [25_000n, 6, 'SCRT']; // about 100k gas at 0.25 uscrt
      if (asset === 'NEAR') return [90_000_000_000_000_000_000n, 24, 'NEAR']; // 0.45 Tgas at 0.0001 NEAR/Tgas, doubled
      if (asset === 'SSCRT') return [50_000n, 6, 'SCRT']; // a contract call, about 200k gas
      if (asset === 'ZEC') return [15_000n, 8, 'ZEC']; // ZIP-317, a typical transfer
      if (asset === 'ZANO') return [ZANO_FEE, 12, 'ZANO'];
      if (asset === 'ARRR') return [10_000n, 8, 'ARRR'];
      if (isEvm(asset)) {
        const chain = chainOf(asset);
        return [await this.evm(asset).typicalFee(asset === chain.native ? 21_000n : 65_000n), 18, chain.native];
      }
      if (asset === 'USDT') return [await tron.typicalUsdtFee(), 6, 'TRX'];
      if (asset === 'TRX') return [(await tron.estimateFee({ asset, to: tron.address, amount: 1n })).feeSun, 6, 'TRX'];
      for (const node of this.moneroNodes()) {
        try {
          const res = await requestJson(`${node}/json_rpc`, { method: 'POST', body: { jsonrpc: '2.0', id: '0', method: 'get_fee_estimate' }, agent: this.priceAgent, timeoutMs: this.torActive ? 60_000 : 10_000 });
          const perByte = res.body?.result?.fee;
          if (Number.isSafeInteger(perByte) && perByte > 0) return [BigInt(perByte) * 2200n, 12, 'XMR'];
        } catch { /* next node */ }
      }
      throw new Error('no node');
    };
    try {
      const [fee, decimals, feeAsset] = await withTimeoutValue(read(), 15_000);
      const key = feeAsset as Asset;
      const price = (await this.prices())?.[key]?.usd;
      const fmt = formatAmount(fee, decimals);
      const value = { fee: fmt, asset: feeAsset, usd: typeof price === 'number' ? Number(fmt) * price : null };
      this.feeCache.set(asset, { at: Date.now(), value });
      return value;
    } catch {
      return null;
    }
  }

  // ---- Tornado Cash: fixed ETH pools on mainnet ----

  private get tornadoStore() { return new TornadoStore(this.dir, this.baseDir); }
  private get tornadoPoolMap(): Record<string, string> { return this.dev.tornadoPools ?? TORNADO_POOLS; }
  private poolAddress(pool: string): string {
    const address = this.tornadoPoolMap[pool];
    if (!address) throw new Error('No such pool.');
    return address;
  }

  async tornadoInfo() {
    const store = await this.tornadoStore.read();
    return { pools: Object.keys(this.tornadoPoolMap).sort((a, b) => Number(a) - Number(b)), notes: store.notes, relayer: this.settings.tornadoRelayer };
  }

  /** Fails early and visibly if the proof engine can't start on this device. */
  async tornadoCheck(): Promise<boolean> { await tornadoEngineCheck(); return true; }

  async tornadoDepositPrepare(pool: string) {
    const { eth } = this.session();
    const to = this.poolAddress(pool);
    const draft = await eth.draftCall(to, denomination(pool), DEPOSIT_GAS);
    const preview = this.storePreview({ asset: 'ETH', to, amount: draft.amount, fee: draft.expectedFee, eth: draft });
    return { id: preview.id, pool, to, amount: formatAmount(draft.amount, 18), fee: formatAmount(draft.expectedFee, 18), feeAsset: 'ETH' };
  }

  async tornadoDepositConfirm(id: string, pool: string, password: string): Promise<TornadoNote> {
    const { eth } = this.session();
    const preview = this.previews.get(id);
    if (!preview?.eth || preview.expires < Date.now() || preview.to !== this.poolAddress(pool)) throw new Error('The review expired. Try again.');
    const secrets = await this.vault.open(password);
    this.previews.delete(id);
    const store = await this.tornadoStore.read();
    // After restoring from the seed the counter may be behind what's on chain. A used secret would waste the gas.
    let index = store.next;
    let commitment = '';
    for (;; index++) {
      [{ commitment }] = await runTornado('commit', { notes: [noteSecrets(secrets.tronMnemonic, index)] });
      const used = tornadoAbi.decodeFunctionResult('commitments', await eth.call(preview.to, tornadoAbi.encodeFunctionData('commitments', [commitment])));
      if (!used[0]) break;
    }
    // Saved before anything is sent: a crash can never leave money without its record.
    const note: TornadoNote = { id: randomUUID(), pool, index, commitment, status: 'sending', createdAt: Date.now() };
    store.next = index + 1;
    store.notes.unshift(note);
    await this.tornadoStore.write(store);
    try {
      note.txHash = await eth.send({ ...preview.eth, data: tornadoAbi.encodeFunctionData('deposit', [commitment]) }, deriveEthAccount(secrets.tronMnemonic).wallet);
      note.status = 'deposited';
    } catch (e) {
      store.notes = store.notes.filter((n) => n.id !== note.id);
      await this.tornadoStore.write(store);
      throw e;
    }
    await this.tornadoStore.write(store);
    this.emit('balance-changed');
    return note;
  }

  async tornadoExport(noteId: string, password: string): Promise<string> {
    const store = await this.tornadoStore.read();
    const note = store.notes.find((n) => n.id === noteId);
    if (!note) throw new Error('No such deposit.');
    const secrets = await this.vault.open(password);
    return noteText(note.pool, noteSecrets(secrets.tronMnemonic, note.index));
  }

  /** Fee and amounts for the review screen. Nothing heavy, nothing sent. */
  async tornadoWithdrawQuote(noteId: string, recipientInput: string, relayerInput: string) {
    const { eth } = this.session();
    const store = await this.tornadoStore.read();
    const note = store.notes.find((n) => n.id === noteId);
    if (!note) throw new Error('No such deposit.');
    const recipient = recipientInput.trim();
    if (!isEthAddress(recipient)) throw new Error('The receiving address is not an Ethereum address.');
    if (recipient.toLowerCase() === eth.address.toLowerCase()) throw new Error('Receiving at the deposit address gives no privacy benefit. Enter a new address.');
    const total = denomination(note.pool);
    if (!relayerInput.trim()) {
      const gas = (await eth.gasPrice()) * WITHDRAW_GAS;
      return { mode: 'self' as const, pool: note.pool, recipient, fee: formatAmount(gas, 18), feeFrom: 'wallet' as const, receive: formatAmount(total, 18) };
    }
    const url = checkRelayerUrl(relayerInput, Boolean(this.dev.tornadoLocalRelayer));
    const info = await relayerStatus(url, this.priceAgent);
    const fee = relayerFee(note.pool, info.feePercent, await eth.gasPrice());
    return { mode: 'relayer' as const, pool: note.pool, recipient, relayer: info.rewardAccount, fee: formatAmount(fee, 18), feeFrom: 'note' as const, receive: formatAmount(total - fee, 18) };
  }

  async tornadoWithdraw(noteId: string, recipientInput: string, relayerInput: string, password: string) {
    const { eth } = this.session();
    const say = (m: string) => this.emit('tornado-progress', m);
    const tor = this.tornadoStore;
    const store = await tor.read();
    const note = store.notes.find((n) => n.id === noteId);
    if (!note) throw new Error('No such deposit.');
    const secrets = await this.vault.open(password);
    const quote = await this.tornadoWithdrawQuote(noteId, recipientInput, relayerInput);
    const address = this.poolAddress(note.pool);
    const keys = noteSecrets(secrets.tronMnemonic, note.index);
    const [{ commitment, nullifierHash }] = await runTornado('commit', { notes: [keys] });
    if (commitment !== note.commitment) throw new Error('This deposit is not from this seed.');
    const spent = tornadoAbi.decodeFunctionResult('isSpent', await eth.call(address, tornadoAbi.encodeFunctionData('isSpent', [nullifierHash])));
    if (spent[0]) { note.status = 'withdrawn'; await tor.write(store); throw new Error('This deposit was already withdrawn.'); }

    const leaves = await tor.leaves(note.pool, address, eth, { seed: !this.dev.tornadoPools, agent: this.priceAgent, progress: say });
    const leafIndex = leaves.findIndex((l) => l.toLowerCase() === commitment.toLowerCase());
    if (leafIndex < 0) throw new Error('The deposit isn\'t confirmed on the chain yet. Try again after it confirms.');
    const relayer = quote.mode === 'relayer' ? quote.relayer as string : `0x${'0'.repeat(40)}`;
    const fee = quote.mode === 'relayer' ? parseAmount(quote.fee, 18) : 0n;
    const { proof, args } = await runTornado('prove', { leaves, leafIndex, ...keys, recipient: quote.recipient, relayer, fee: fee.toString() }, (stage) => {
      say(stage === 'tree' ? `Building the Merkle tree… ${leaves.length} deposits, so this can take a few minutes.` : 'Making the zero-knowledge proof… The screen may seem to freeze. Don\'t close the app.');
    });
    const known = tornadoAbi.decodeFunctionResult('isKnownRoot', await eth.call(address, tornadoAbi.encodeFunctionData('isKnownRoot', [args[0]])));
    if (!known[0]) throw new Error('The deposit records don\'t match the chain, so this was stopped. Your coins are safe. Try again.');

    note.status = 'withdrawing';
    note.recipient = quote.recipient;
    await tor.write(store);
    say('Sending the withdrawal…');
    try {
      let txHash: string;
      if (quote.mode === 'relayer') {
        txHash = await relayerSubmit(await relayerStatus(checkRelayerUrl(relayerInput, Boolean(this.dev.tornadoLocalRelayer)), this.priceAgent), address, proof, args, this.priceAgent, this.dev.tornadoLocalRelayer ? 200 : 5000);
      } else {
        const draft = await eth.draftCall(address, 0n, WITHDRAW_GAS);
        const data = tornadoAbi.encodeFunctionData('withdraw', [proof, args[0], args[1], quote.recipient, relayer, 0n, 0n]);
        txHash = await eth.send({ ...draft, data }, deriveEthAccount(secrets.tronMnemonic).wallet);
      }
      note.status = 'withdrawn';
      note.withdrawTx = txHash;
    } catch (e) {
      note.status = 'deposited';
      await tor.write(store);
      throw e;
    }
    await tor.write(store);
    this.emit('balance-changed');
    return note;
  }

  /** After restoring from the seed: looks through the pools for this seed's deposits. */
  async tornadoRecover(password: string) {
    const { eth } = this.session();
    const say = (m: string) => this.emit('tornado-progress', m);
    const secrets = await this.vault.open(password);
    const tor = this.tornadoStore;
    const store = await tor.read();
    const limit = store.next + 30;
    const keys = Array.from({ length: limit }, (_, i) => noteSecrets(secrets.tronMnemonic, i));
    const commits: { commitment: string; nullifierHash: string }[] = await runTornado('commit', { notes: keys });
    let found = 0;
    for (const [pool, address] of Object.entries(this.tornadoPoolMap)) {
      const leaves = new Set((await tor.leaves(pool, address, eth, { seed: !this.dev.tornadoPools, agent: this.priceAgent, progress: say })).map((l) => l.toLowerCase()));
      for (let index = 0; index < limit; index++) {
        const c = commits[index];
        if (!leaves.has(c.commitment.toLowerCase()) || store.notes.some((n) => n.commitment === c.commitment)) continue;
        const spent = tornadoAbi.decodeFunctionResult('isSpent', await eth.call(address, tornadoAbi.encodeFunctionData('isSpent', [c.nullifierHash])));
        store.notes.push({ id: randomUUID(), pool, index, commitment: c.commitment, status: spent[0] ? 'withdrawn' : 'deposited', createdAt: Date.now() });
        store.next = Math.max(store.next, index + 1);
        found++;
      }
    }
    await tor.write(store);
    return { found };
  }

  // ---- sending ----

  async prepareSend(asset: Asset, to: string, amountInput: string) {
    const { tron, monero, btc, eth, dash } = this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    const address = to.trim();
    const isMax = amountInput.trim().toLowerCase() === 'max';
    const decimals = DECIMALS[asset];
    const warnings: string[] = [];
    let preview: Preview;

    if (asset === 'ARRR') {
      if (!this.arrr) throw new Error('Pirate Chain is not available on this device.');
      if (!isArrrAddress(address)) throw new Error('Not a Pirate Chain address. It should start with zs1 or pirate1.');
      if (address === this.arrr.receive) throw new Error('You cannot send to your own address.');
      const draft = await this.arrr.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.value, fee: draft.fee, arrr: draft });
    } else if (asset === 'ZANO') {
      if (!this.zano) throw new Error('Zano is not available on this device.');
      if (!isZanoAddress(address)) throw new Error('Not a Zano address.');
      if (address === this.zano.receive) throw new Error('You cannot send to your own address.');
      const draft = await this.zano.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.value, fee: draft.fee, zano: draft });
    } else if (asset === 'ZEC') {
      if (!this.zec) throw new Error('Zcash is not available on this device.');
      if (!isZecAddress(address)) throw new Error('Not a Zcash address. Only addresses starting with u1, zs1 or t1 can be used.');
      const receive = this.zec.receive;
      if (address === receive?.unified || address === receive?.transparent) throw new Error('You cannot send to your own address.');
      const draft = await this.zec.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      if (/^t/.test(address)) warnings.push('Sending to a transparent address makes the recipient and amount public on the chain.');
      preview = this.storePreview({ asset, to: address, amount: draft.value, fee: draft.fee, zec: draft });
    } else if (asset === 'SOL') {
      if (!isSolAddress(address)) throw new Error('Not a Solana address.');
      if (address === this.sol!.receiveAddress) throw new Error('You cannot send to your own address.');
      const draft = await this.sol!.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, sol: draft });
    } else if (isSpl(asset)) {
      if (!isSolAddress(address)) throw new Error('Not a Solana address.');
      const draft = await this.sol!.draftUsdt(address, isMax ? 'max' : parseAmount(amountInput, decimals), asset);
      if (draft.create) warnings.push(`The receiver has no ${SPL_TOKENS[asset].symbol} account on Solana yet, so the fee includes a deposit of about 0.002 SOL to open one.`);
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, solUsdt: draft });
    } else if (asset === 'BCH') {
      if (!isBchAddress(address)) throw new Error('Not a Bitcoin Cash address. Use the CashAddr form, starting with bitcoincash:q or q. Old-style addresses look like Bitcoin ones, so they are refused.');
      const to = normalBchAddress(address);
      if (to === this.bch!.receiveAddress) throw new Error('You cannot send to your own address.');
      const draft = await this.bch!.draft(to, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to, amount: draft.amount, fee: draft.fee, bch: draft });
    } else if (asset === 'DOGE') {
      if (!isDogeAddress(address)) throw new Error('Not a Dogecoin address.');
      if (address === this.doge!.receiveAddress) throw new Error('You cannot send to your own address.');
      const draft = await this.doge!.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, doge: draft });
    } else if (asset === 'FIRO' && isSparkAddress(address)) {
      // To a Spark address: paid from the private balance, so the amount and both addresses stay hidden.
      if (!this.spark) throw new Error('Private (Spark) FIRO isn\'t available on this device.');
      const draft = await this.spark.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, spark: draft });
    } else if (asset === 'FIRO') {
      if (!isFiroAddress(address)) throw new Error('Not a Firo address. Use a transparent address starting with a, or a Spark address starting with sm1.');
      const want = isMax ? 'max' as const : parseAmount(amountInput, decimals);
      const pub = await this.firo!.getBalance().catch(() => null);
      const priv = this.spark?.balance();
      // Public coins pay first. Only when they can't cover it does the private balance pay, which makes it public.
      if (want !== 'max' && pub && pub.spendable < want && priv && priv.spendable >= want) {
        const draft = await this.spark!.draft(address, want);
        warnings.push('This is paid from your private (Spark) balance. Sending to a transparent address makes this amount and the receiving address public.');
        preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, spark: draft });
      } else {
        if (address === this.firo!.receiveAddress) throw new Error('You cannot send to your own address.');
        const draft = await this.firo!.draft(address, want);
        warnings.push('This is paid from your public FIRO: the addresses and the amount are visible on the chain. Payments to a Spark address (sm1…) come from the private balance and stay hidden.');
        preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, firo: draft });
      }
    } else if (asset === 'DASH') {
      if (!isDashAddress(address)) throw new Error('Not a Dash address. Only addresses starting with X can be used.');
      if (address === dash.receiveAddress) throw new Error('You cannot send to your own address.');
      const draft = await dash.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, dash: draft });
    } else if (asset === 'SCRT') {
      if (!isScrtAddress(address)) throw new Error('Not a Secret Network address. Only addresses starting with secret1 can be used.');
      const draft = await this.scrt!.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, scrt: draft });
    } else if (asset === 'NEAR') {
      const draft = await this.near!.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: draft.to, amount: draft.amount, fee: draft.fee, near: draft });
    } else if (asset === 'SSCRT') {
      const draft = await this.scrt!.draftPrivate('transfer', address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, scrt: draft });
    } else if (asset === 'LTC' && isMwebAddress(address)) {
      // To an MWEB address: paid from the private balance, so amount and both addresses stay hidden.
      if (!this.mweb) throw new Error('Private (MWEB) Litecoin isn\'t available on this device.');
      const draft = await this.mweb.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals), Number(await this.ltc!.feeRate()) * 1000);
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, mweb: draft });
    } else if (asset === 'LTC') {
      if (!isLtcAddress(address)) throw new Error('Not a Litecoin address. Use one starting with ltc1, L or M. Addresses starting with 3 look like Bitcoin ones, so they are refused.');
      if (address === this.ltc!.receiveAddress) throw new Error('You cannot send to your own address.');
      const want = isMax ? 'max' as const : parseAmount(amountInput, decimals);
      const pub = await this.ltc!.getBalance().catch(() => null);
      const priv = this.mweb?.balance();
      // Public coins pay first. Only when they can't cover it does the private balance pay, as a peg-out.
      if (want !== 'max' && pub && pub.spendable < want && priv && priv.spendable >= want) {
        const draft = await this.mweb!.draft(address, want, Number(await this.ltc!.feeRate()) * 1000);
        warnings.push('This is paid from your private (MWEB) balance. Sending to an ordinary address makes this amount and the receiving address public.');
        preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, mweb: draft });
      } else {
        const draft = await this.ltc!.draft(address, want);
        preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, ltc: draft });
      }
    } else if (asset === 'BTC') {
      if (!isBtcAddress(address)) throw new Error('Not a Bitcoin address.');
      const draft = await btc.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      if (draft.fee * 2n > draft.amount) warnings.push('The fee is more than half of the amount being sent.');
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, btc: draft });
    } else if (isEvm(asset)) {
      if (!isEthAddress(address)) throw new Error('Not an Ethereum address. Only addresses starting with 0x can be used.');
      if (address.toLowerCase() === eth.address.toLowerCase()) throw new Error('You cannot send to your own address.');
      const chain = chainOf(asset);
      const draft = await this.evm(asset).draft(asset, address, isMax ? 'max' : parseAmount(amountInput, decimals));
      if (asset === chain.native && isMax) warnings.push(`If the actual fee is lower than expected, a little ${chain.symbol} stays behind.`);
      if (chain.id !== 1n) warnings.push(`This sends on ${chain.name}. Make sure the receiver accepts ${chain.name}: the same 0x address on another network won't show it.`);
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.expectedFee, eth: draft });
    } else if (asset === 'XMR') {
      if (!(await monero.isValidAddress(address))) throw new Error('Not a Monero address on this network.');
      const amount = isMax ? 'max' as const : parseAmount(amountInput, decimals);
      const draft = await monero.draft(address, amount);
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, monero: draft });
    } else {
      if (!isTronAddress(address)) throw new Error('Not a Tron address. Only addresses starting with T can be used.');
      if (address === tron.address) throw new Error('You cannot send to your own address.');
      const trx = await tron.getTrxBalance();
      if (asset === 'USDT') {
        const usdt = await tron.getUsdtBalance();
        const amount = isMax ? usdt : parseAmount(amountInput, decimals);
        if (amount <= 0n) throw new Error('No USDT to send.');
        if (amount > usdt) throw new Error('Not enough USDT.');
        const fee = await tron.estimateFee({ asset, to: address, amount });
        if (fee.feeSun > trx) {
          throw new Error(`Not enough TRX for the fee. About ${formatAmount(fee.feeSun, 6)} TRX is needed, and there is ${formatAmount(trx, 6)} TRX.`);
        }
        if (fee.recipientIsNew) warnings.push('The receiving address isn\'t activated yet, so the fee may be higher.');
        preview = this.storePreview({
          asset, to: address, amount, fee: fee.feeSun,
          tron: { asset, to: address, amount, feeLimit: fee.feeLimitSun },
        });
      } else {
        const probe = await tron.estimateFee({ asset, to: address, amount: 1n });
        const amount = isMax ? trx - probe.feeSun : parseAmount(amountInput, decimals);
        if (amount <= 0n) throw new Error('No TRX left to send after the fee.');
        if (amount + probe.feeSun > trx) throw new Error('Not enough TRX to cover the amount and fee.');
        if (probe.recipientIsNew) warnings.push('This is a new address, so an activation fee is included.');
        preview = this.storePreview({ asset, to: address, amount, fee: probe.feeSun, tron: { asset, to: address, amount } });
      }
    }
    return {
      id: preview.id, asset, to: address,
      amount: formatAmount(preview.amount, decimals),
      fee: formatAmount(preview.fee, preview.eth ? 18 : asset === 'XMR' ? 12 : asset === 'ZANO' ? 12 : asset === 'SCRT' || asset === 'SSCRT' ? 6 : asset === 'NEAR' ? 24 : asset === 'SOL' || isSpl(asset) ? 9 : asset === 'DOGE' || asset === 'BCH' || asset === 'LTC' || asset === 'BTC' || asset === 'DASH' || asset === 'FIRO' || asset === 'ZEC' || asset === 'ARRR' ? 8 : 6),
      feeAsset: preview.eth ? chainOf(preview.eth.asset).native : isSpl(asset) ? 'SOL' : asset === 'SSCRT' ? 'SCRT' : asset === 'SOL' || asset === 'DOGE' || asset === 'BCH' || asset === 'LTC' || asset === 'SCRT' || asset === 'NEAR' || asset === 'XMR' || asset === 'BTC' || asset === 'DASH' || asset === 'FIRO' || asset === 'ZEC' || asset === 'ZANO' || asset === 'ARRR' ? asset : 'TRX',
      feeIsEstimate: asset !== 'SOL' && !isSpl(asset) && asset !== 'DOGE' && asset !== 'BCH' && asset !== 'LTC' && asset !== 'SCRT' && asset !== 'SSCRT' && asset !== 'NEAR' && asset !== 'XMR' && asset !== 'BTC' && asset !== 'DASH' && asset !== 'FIRO' && asset !== 'ZEC' && asset !== 'ZANO' && asset !== 'ARRR',
      warnings,
    };
  }

  private storePreview(p: Omit<Preview, 'id' | 'expires'>): Preview {
    const preview = { ...p, id: randomUUID(), expires: Date.now() + PREVIEW_TTL_MS };
    this.previews.set(preview.id, preview);
    return preview;
  }

  cancelSend(id: string): void { this.previews.delete(id); this.pendingSwaps.delete(id); }

  /** Password is checked here so an unattended unlocked app can't move funds. */
  async confirmSend(id: string, password: string) {
    const { tron, monero, btc, eth, dash } = this.session();
    const preview = this.previews.get(id);
    if (!preview || preview.expires < Date.now()) {
      this.previews.delete(id);
      throw new Error('The review expired. Try again.');
    }
    const secrets = await this.vault.open(password);
    this.previews.delete(id); // one shot: a retry must go through a fresh preview
    this.balanceMemo.clear(); // money is about to move

    if (preview.arrr) {
      if (!this.arrr) throw new Error('The Pirate Chain engine is off.');
      return { hashes: [await this.arrr.send(preview.arrr)] };
    }
    if (preview.zano) {
      if (!this.zano) throw new Error('The Zano engine is off.');
      return { hashes: [await this.zano.send(preview.zano)] };
    }
    if (preview.zec) {
      if (!this.zec) throw new Error('The Zcash engine is off.');
      return { hashes: await this.zec.send(preview.zec, secrets.tronMnemonic) };
    }
    if (preview.sol) return { hashes: [await this.sol!.send(preview.sol, secrets.tronMnemonic)] };
    if (preview.solUsdt) return { hashes: [await this.sol!.sendUsdt(preview.solUsdt, secrets.tronMnemonic)] };
    if (preview.doge) return { hashes: [await this.doge!.send(preview.doge, secrets.tronMnemonic)] };
    if (preview.bch) return { hashes: [await this.bch!.send(preview.bch, secrets.tronMnemonic)] };
    if (preview.firo) return { hashes: [await this.firo!.send(preview.firo, secrets.tronMnemonic)] };
    if (preview.dash) return { hashes: [await dash.send(preview.dash, secrets.tronMnemonic)] };
    if (preview.near) return { hashes: [await this.near!.send(preview.near, secrets.tronMnemonic)] };
    if (preview.scrt) return { hashes: [await this.scrt!.send(preview.scrt, secrets.tronMnemonic)] };
    if (preview.ltc) return { hashes: [await this.ltc!.send(preview.ltc, secrets.tronMnemonic)] };
    if (preview.mweb) return { hashes: [await this.mweb!.send(preview.mweb, secrets.tronMnemonic)] };
    if (preview.pegin) return { hashes: [await this.mweb!.pegin(preview.pegin, secrets.tronMnemonic)] };
    if (preview.spark) return { hashes: [await this.spark!.send(preview.spark)] };
    if (preview.mint) return { hashes: [await this.spark!.mint(preview.mint, secrets.tronMnemonic, (hex, id) => this.firo!.broadcastSigned(hex, id))] };
    if (preview.btc) {
      return { hashes: [await btc.send(preview.btc, secrets.tronMnemonic)] };
    }
    if (preview.eth) {
      return { hashes: [await this.evm(preview.eth.asset).send(preview.eth, deriveEthAccount(secrets.tronMnemonic).wallet)] };
    }
    if (preview.monero) {
      const hashes = await monero.relay(preview.monero);
      return { hashes };
    }
    const account = deriveTronAccount(secrets.tronMnemonic);
    if (account.address !== tron.address) throw new Error('The wallet address does not match, so this was stopped.');
    const txid = await tron.send(preview.tron as TronTransfer, account.privateKey);
    void tron.waitForResult(txid).then((status) => this.emit('tron-tx', { txid, status, asset: preview.asset }));
    return { hashes: [txid] };
  }

  // ---- Zcash ----

  arrrInfo() {
    return { available: this.arrrAvailable, started: this.arrr !== null, error: this.arrr?.lastError ?? null, phase: this.arrr?.phase ?? null, detail: arrrEngineInfo(this.dev.arrrBin) };
  }

  /** date: YYYY-MM-DD. The earlier the date, the longer the scan. */
  async arrrRescan(date: string, password: string): Promise<void> {
    if (!this.arrr) throw new Error('Pirate Chain is not available on this device.');
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? new Date(date.trim() + 'T00:00:00Z') : null;
    if (!parsed || Number.isNaN(parsed.getTime())) throw new Error('Enter the date as YYYY-MM-DD.');
    await this.vault.open(password);
    await this.arrr.rescan(date.trim());
  }

  zanoInfo() {
    return { available: this.zanoAvailable, started: this.zano !== null, error: this.zano?.lastError ?? null, phase: this.zano?.phase ?? null, detail: zanoEngineInfo(this.dev.zanoBin) };
  }

  /** For a screenshot when ZEC doesn't show up: holds no addresses, balances or keys. */
  zecInfo() {
    return {
      available: this.zecAvailable,
      started: this.zec !== null,
      error: this.zec?.lastError ?? null,
      phase: this.zec?.phase ?? null,
      detail: zecEngineInfo(this.dev.zecBin),
    };
  }

  /**
   * wrap: SCRT into private sSCRT. unwrap: back to plain SCRT. key: sets the viewing key once, so the private balance
   * can be read. Each is a transaction, confirmed with confirmSend like any other.
   */
  async prepareScrtPrivate(kind: 'wrap' | 'unwrap' | 'key', amountInput: string) {
    this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    const isMax = amountInput.trim().toLowerCase() === 'max';
    const amount = kind === 'key' ? 0n : isMax ? 'max' as const : parseAmount(amountInput, 6);
    const draft = await this.scrt!.draftPrivate(kind, this.scrt!.address, amount);
    const asset: Asset = kind === 'unwrap' ? 'SCRT' : 'SSCRT';
    const preview = this.storePreview({ asset, to: draft.to, amount: draft.amount, fee: draft.fee, scrt: draft });
    return {
      id: preview.id, asset, to: draft.to, kind,
      amount: formatAmount(draft.amount, 6), fee: formatAmount(draft.fee, 6), feeAsset: 'SCRT', feeIsEstimate: false,
      warnings: kind === 'wrap' ? ['How much you make private is visible on the chain. What you do with sSCRT afterwards is not.']
        : kind === 'unwrap' ? ['How much you make public is visible on the chain.']
        : ['If another wallet set a viewing key for this address, this replaces it there.'],
    };
  }

  /** Moves every confirmed public LTC coin into the private (MWEB) balance. Confirmed with confirmSend. */
  async prepareLtcPrivate() {
    this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    if (!this.mweb) throw new Error('Private (MWEB) Litecoin isn\'t available on this device.');
    const [inputs, rate] = await Promise.all([this.ltc!.confirmedUtxos(), this.ltc!.feeRate()]);
    const draft = await this.mweb.peginDraft(inputs, Number(rate) * 1000);
    const preview = this.storePreview({ asset: 'LTC', to: draft.to, amount: draft.amount, fee: draft.fee, pegin: draft });
    return {
      id: preview.id, asset: 'LTC' as Asset, to: draft.to, amount: formatAmount(draft.amount, 8), fee: formatAmount(draft.fee, 8), feeAsset: 'LTC', feeIsEstimate: false,
      warnings: ['How much you make private is visible on the chain. Where it goes from the private balance is not.'],
    };
  }

  /** Moves every confirmed public FIRO coin into the private (Spark) balance. Confirmed with confirmSend. */
  async prepareFiroPrivate() {
    this.session();
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    if (!this.spark) throw new Error('Private (Spark) FIRO isn\'t available on this device.');
    const draft = await this.spark.mintDraft(await this.firo!.confirmedUtxos());
    const preview = this.storePreview({ asset: 'FIRO', to: draft.to, amount: draft.amount, fee: draft.fee, mint: draft });
    return {
      id: preview.id, asset: 'FIRO' as Asset, to: draft.to, amount: formatAmount(draft.amount, 8), fee: formatAmount(draft.fee, 8), feeAsset: 'FIRO', feeIsEstimate: false,
      warnings: ['How much you make private is visible on the chain. Where it goes from the private balance is not.'],
    };
  }

  async zecShield(password: string) {
    if (!this.zec) throw new Error('Zcash is not available on this device.');
    if (this.torNotReady) throw new Error('Tor is connecting. Try again once it connects.');
    const secrets = await this.vault.open(password);
    return { hashes: await this.zec.shield(secrets.tronMnemonic) };
  }

  /** date: YYYY-MM-DD. The earlier the date, the longer the scan. */
  async zecRescan(date: string, password: string): Promise<void> {
    if (!this.zec) throw new Error('Zcash is not available on this device.');
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? new Date(date.trim() + 'T00:00:00Z') : null;
    if (!parsed || Number.isNaN(parsed.getTime())) throw new Error('Enter the date as YYYY-MM-DD.');
    const secrets = await this.vault.open(password);
    await this.zec.rescan(secrets.tronMnemonic, zecHeightForDate(parsed));
  }

  // ---- security & settings ----

  async revealSeeds(password: string) {
    const s = await this.vault.open(password);
    return { tronMnemonic: s.tronMnemonic, moneroSeed: s.moneroSeed };
  }

  async changePassword(current: string, next: string): Promise<void> {
    const secrets = await this.vault.open(current);
    await this.vault.save(next, secrets);
  }

  /** Locks if anything that affects connections changed. Returns whether it did. */
  async updateSettings(patch: Partial<Settings>): Promise<boolean> {
    const next: Settings = { ...this.settings };
    if (typeof patch.customMoneroNode === 'string') {
      const node = patch.customMoneroNode.trim();
      if (node && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(node)) throw new Error('Enter the node address as http://host:port.');
      next.customMoneroNode = node;
    }
    if (typeof patch.showPrices === 'boolean') next.showPrices = patch.showPrices;
    if (typeof patch.tornadoRelayer === 'string') next.tornadoRelayer = patch.tornadoRelayer.trim();
    if (typeof patch.simpleSwapKey === 'string') next.simpleSwapKey = patch.simpleSwapKey.trim();
    if (typeof patch.ghostSwapKey === 'string') next.ghostSwapKey = patch.ghostSwapKey.trim();
    if (typeof patch.torEnabled === 'boolean') {
      if (patch.torEnabled !== this.settings.torEnabled && (await this.walletMode()) !== 'private') throw new Error('Tor is only in maximum-privacy wallets.');
      if (patch.torEnabled && !this.tor.isInstalled()) throw new Error('Install Tor first.');
      next.torEnabled = patch.torEnabled;
    }
    if (typeof patch.tronApiKey === 'string') next.tronApiKey = patch.tronApiKey.trim();
    if (typeof patch.autoLockMinutes === 'number' && patch.autoLockMinutes >= 1 && patch.autoLockMinutes <= 240) {
      next.autoLockMinutes = Math.floor(patch.autoLockMinutes);
    }
    const reconnect = next.network !== this.settings.network
      || next.customMoneroNode !== this.settings.customMoneroNode
      || next.tronApiKey !== this.settings.tronApiKey
      || next.torEnabled !== this.settings.torEnabled;
    this.settings = next;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.settingsPath, JSON.stringify(next, null, 2), { mode: 0o600 });
    if (reconnect && this.tron) await this.lock();
    return reconnect;
  }

  /** Removes the wallet from this PC. Funds stay on chain and need the seeds to recover. */
  /** Returns which wallet was removed, so the Android side can clear what it keeps elsewhere. */
  async deleteWallet(password: string): Promise<string> {
    await this.vault.open(password);
    await this.lock();
    const id = this.walletId;
    await this.vault.destroy();
    if (id === 'main') {
      // The app's shared files live next to this wallet's, so only its own are removed.
      await fs.rm(path.join(this.dir, 'xmr'), { recursive: true, force: true });
      for (const f of ['swaps.json', 'privacy-swaps.json', 'tornado.json', 'zec-state.json', 'mode.json', 'walletconnect.json']) await fs.rm(path.join(this.dir, f), { force: true });
    } else {
      await fs.rm(this.dir, { recursive: true, force: true });
    }
    const r = await this.walletRegistry();
    const left = r.list.filter((w) => w.id !== id);
    const next = left.length ? { active: left[0].id, list: left } : { active: 'main', list: [{ id: 'main', name: 'My wallet' }] };
    await this.walletRegistrySave(next);
    this.activate(next.active);
    return id;
  }

  /**
   * ChangeNOW's purchase page for one coin, paid by card. The wallet only opens it: payment, KYC and the receiving
   * address are entered on their page, and nothing about this wallet is put in the link.
   */
  buyUrl(asset: Asset, fiat = 'usd'): string {
    const ticker = BUY_TICKER[asset];
    if (!ticker) throw new Error('This coin can\'t be bought here.');
    if (!/^[a-z]{3}$/.test(fiat)) throw new Error('Unknown currency.');
    const q = new URLSearchParams({ amountFiat: '100', backgroundColor: '111111', darkMode: 'true', from: fiat, fromFiat: fiat, horizontal: 'false', isFiat: '', lang: 'en-US', link_id: CHANGENOW_LINK_ID, locales: 'true', logo: 'true', primaryColor: 'FF6A00', to: ticker, toFiat: ticker, toTheMoon: 'false' });
    return `${CHANGENOW_BUY_PAGE}?${q}`;
  }

  explorerUrl(asset: Asset, hash: string): string {
    if (isEvm(asset)) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid transaction hash.');
      return EVM_EXPLORER[String(chainOf(asset).id)] + hash;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid transaction hash.');
    const net = NETWORKS[this.settings.network];
    if (asset === 'DASH') return DASH_EXPLORER_TX + hash;
    if (asset === 'FIRO') return FIRO_EXPLORER_TX + hash;
    if (asset === 'SOL' || isSpl(asset)) return SOL_EXPLORER_TX + hash;
    if (asset === 'DOGE') return DOGE_EXPLORER_TX + hash;
    if (asset === 'BCH') return BCH_EXPLORER_TX + hash;
    if (asset === 'ZEC') return ZEC_EXPLORER_TX + hash;
    if (asset === 'ZANO') return ZANO_EXPLORER_TX + hash;
    if (asset === 'ARRR') return ARRR_EXPLORER_TX + hash;
    if (asset === 'BTC') return BTC_EXPLORER_TX + hash;
    if (asset === 'LTC') return LTC_EXPLORER_TX + hash;
    if (asset === 'NEAR') return NEAR_EXPLORER_TX + hash;
    if (asset === 'SCRT' || asset === 'SSCRT') {
      if (!/^[0-9A-F]{64}$/i.test(hash)) throw new Error('Private transfers have no public page. Only the sender and receiver can see them.');
      return SCRT_EXPLORER_TX + hash;
    }
    return (asset === 'XMR' ? net.monero.explorerTx : net.tron.explorerTx) + hash;
  }
}
