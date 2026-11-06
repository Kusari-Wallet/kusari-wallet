import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { formatAmount, parseAmount } from './amount';
import { Asset, BTC_APIS, BTC_EXPLORER_TX, DECIMALS, DASH_APIS, DASH_EXPLORER_TX, DCR_APIS, DCR_EXPLORER_TX, DEFAULT_SETTINGS, ZANO_EXPLORER_TX, ZANO_NODE, ZEC_EXPLORER_TX, ZEC_SERVERS, ETH_EXPLORER_TX, ETH_RPCS, ETH_SCOUT, ETH_USDT, NETWORKS, NetworkId, Settings, estimateMainnetHeight } from './config';
import { MIN_PASSWORD, Secrets, Vault } from './vault';
import { TronClient, TronTransfer, deriveTronAccount, generateTronMnemonic, isTronAddress } from './tron';
import { socksAgent, getJson, requestJson } from './request';
import { BtcClient, BtcDraft, btcAccountXpub, estimateVbytes, isBtcAddress } from './btc';
import { PRICE_SOURCES, PriceMap, PriceSource, coingecko } from './prices';
import { DEPOSIT_GAS, TORNADO_POOLS, TornadoNote, TornadoStore, WITHDRAW_GAS, abi as tornadoAbi, checkRelayerUrl, denomination, noteSecrets, noteText, relayerFee, relayerStatus, relayerSubmit, tornadoEngineCheck } from './tornado';
import { runTornado } from './tornado-run';
import { ZanoClient, ZanoDraft, isZanoAddress, zanoKeys, ZANO_FEE } from './zano';
import { startZanoEngine, zanoEngineAvailable, zanoEngineInfo } from './zano-process';
import { ZecClient, ZecDraft, isZecAddress, zecHeightForDate } from './zec';
import { startZecEngine, zecEngineAvailable, zecEngineInfo } from './zec-process';
import { DashClient, DashDraft, dashAccountXpub, isDashAddress, typicalDashFee } from './dash';
import { DcrClient, DcrDraft, dcrAccount, isDcrAddress, typicalDcrFee } from './dcr';
import { EthClient, EthDraft, deriveEthAccount, isEthAddress } from './eth';
import { TorManager } from './tor';
import { BUILTIN_SWAP_KEYS, GHOSTSWAP_BASE, GhostSwapClient, PRIVACY_ASSETS, PrivacySwap, SIMPLESWAP_BASE, SWAP_BASE, SWAP_DEAD, SWAP_DONE, SimpleSwapClient, SwapClient, SwapProvider, SwapProviderId, SwapRecord } from './swap';
import { MoneroClient, MoneroDraft, MoneroOptions, generateMoneroSeed, validateMoneroSeed } from './monero';

const BALANCE_TTL_MS = 40_000;
const BALANCE_BACKOFF_MS = 30_000;
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
  eth?: EthDraft;
  dcr?: DcrDraft;
  dash?: DashDraft;
  zec?: ZecDraft;
  zano?: ZanoDraft;
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
  private eth: EthClient | null = null;
  private dcr: DcrClient | null = null;
  private dash: DashClient | null = null;
  private zec: ZecClient | null = null;
  private zano: ZanoClient | null = null;
  private previews = new Map<string, Preview>();
  private privacyTargets = new Map<string, Asset>();
  private pendingSwaps = new Map<string, { id: string; from: Asset; to: Asset; amount: string; receive: string; rate: string; providerId: SwapProviderId; provider: string; approximate: boolean; withdrawalAddress: string; privacy?: { leg: 'first'; via: string; destination: string } | { leg: 'second'; id: string } }>();
  readonly tor: TorManager;
  private priceAgent: ReturnType<typeof socksAgent> | undefined;
  private closing: Promise<void> = Promise.resolve();
  private draftSeeds: { tronMnemonic: string; moneroSeed: string } | null = null;
  private priceCache: { at: number; value: PriceMap } | null = null;
  private priceRetryAt = 0;
  private priceInFlight: Promise<PriceMap | null> | null = null;
  settings: Settings = { ...DEFAULT_SETTINGS };

  constructor(private readonly baseDir: string, private readonly kdf?: { N: number; r: number; p: number }, private readonly dev: {
    tronHost?: string; priceUrl?: string; priceSources?: PriceSource[]; torBin?: string; socks?: string; ethRpc?: string; ethScout?: string; dcrApi?: string; dashApi?: string; zecBin?: string; zecServers?: string[]; zanoBin?: string; zanoNode?: string; tornadoPools?: Record<string, string>; tornadoLocalRelayer?: boolean; swapBase?: string; simpleSwapBase?: string; ghostSwapBase?: string; btcApi?: string;
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
    return { active: 'main', list: [{ id: 'main', name: '내 지갑' }] };
  }

  private async walletRegistrySave(r: { active: string; list: { id: string; name: string }[] }): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(this.registryPath, JSON.stringify(r), { mode: 0o600 });
  }

  private static walletName(input: string): string {
    const name = String(input).trim();
    if (!name || [...name].length > 20) throw new Error('지갑 이름은 1자에서 20자까지 돼.');
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
    if (!w) throw new Error('없는 지갑이야.');
    w.name = name;
    await this.walletRegistrySave(r);
  }

  async walletSwitch(id: string): Promise<void> {
    const r = await this.walletRegistry();
    if (!r.list.some((w) => w.id === id)) throw new Error('없는 지갑이야.');
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
    if (!this.draftSeeds) throw new Error('먼저 시드를 생성해.');
    if (await this.vault.exists()) throw new Error('이미 지갑이 있어.');
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
    if (await this.vault.exists()) throw new Error('이미 지갑이 있어.');
    if (password.length < MIN_PASSWORD) throw new Error(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 해.`);
    deriveTronAccount(tronMnemonic); // throws on a bad phrase
    const seed = await validateMoneroSeed(moneroSeed);
    let height = 0;
    const from = restoreFrom.trim();
    if (/^\d+$/.test(from)) height = Number(from);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      const date = new Date(from + 'T00:00:00Z');
      if (Number.isNaN(date.getTime())) throw new Error('날짜 형식이 올바르지 않아.');
      height = Math.max(0, estimateMainnetHeight(date) - 21_600); // 30 days of margin
    } else if (from) throw new Error('복구 시점은 블록 높이나 YYYY-MM-DD로 입력해.');
    const heights = { mainnet: height, testnet: /^\d+$/.test(from) ? height : 0 };
    const secrets = this.newSecrets(tronMnemonic.trim().toLowerCase().split(/\s+/).join(' '), seed, heights);
    // A Monero block height says nothing about Zcash, so only a date carries over.
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) secrets.zecBirthday = zecHeightForDate(new Date(from + 'T00:00:00Z'));
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
    return this.settings.torEnabled ? monero.onionNodes : monero.nodes;
  }

  private async startSession(secrets: Secrets): Promise<void> {
    await this.closing;
    this.priceAgent = undefined;
    let proxyUri: string | undefined;
    if (this.settings.torEnabled) {
      const socks = await this.tor.allocate();
      if (!this.dev.nativeTor) {
        proxyUri = socks;
        this.priceAgent = socksAgent(socks);
      }
    } else {
      this.tor.useDirect();
    }
    if (this.settings.torEnabled) this.tor.start(); // Before anything tries to use it.
    const net = NETWORKS[this.settings.network];
    const account = deriveTronAccount(secrets.tronMnemonic);
    const route = this.dev.route ?? ((u: string) => u);
    const tronNet = this.dev.tronHost
      ? { ...net.tron, host: route(this.dev.tronHost), usdt: NETWORKS.mainnet.tron.usdt }
      : { ...net.tron, host: route(net.tron.host) };
    this.tron = new TronClient(tronNet, this.settings.tronApiKey, account.address, this.priceAgent, this.settings.torEnabled);

    const slow = this.settings.torEnabled;
    this.btc = new BtcClient(btcAccountXpub(secrets.tronMnemonic), this.dev.btcApi ? [this.dev.btcApi] : BTC_APIS, this.priceAgent, slow ? 60_000 : 30_000);
    if (this.dev.btcApi) this.btc.spacingMs = 0;
    const scanFile = path.join(this.dir, 'btc-scan.json');
    try { this.btc.importHints(JSON.parse(await fs.readFile(scanFile, 'utf8') as unknown as string)); } catch { /* first time */ }
    this.btc.onHints = (hints) => { void fs.mkdir(this.dir, { recursive: true }).then(() => fs.writeFile(scanFile, JSON.stringify(hints), { mode: 0o600 })).catch(() => undefined); };
    if (!this.torNotReady) void this.btc.refresh().catch(() => undefined);
    this.dash = new DashClient(dashAccountXpub(secrets.tronMnemonic), this.dev.dashApi ? [this.dev.dashApi] : DASH_APIS, this.priceAgent, slow ? 60_000 : 20_000);
    this.dcr = new DcrClient(dcrAccount(secrets.tronMnemonic), this.dev.dcrApi ? [this.dev.dcrApi] : DCR_APIS, this.priceAgent, slow ? 60_000 : 20_000);
    this.eth = new EthClient(this.dev.ethRpc ? [this.dev.ethRpc] : ETH_RPCS, this.dev.ethScout ?? ETH_SCOUT, ETH_USDT, deriveEthAccount(secrets.tronMnemonic).address, this.priceAgent, slow ? 60_000 : 15_000);
    const monero = new MoneroClient({
      type: net.monero.type,
      dir: this.moneroDir(net.id),
      filePassword: secrets.moneroFilePasswords[net.id],
      seed: secrets.moneroSeed,
      restoreHeight: secrets.restoreHeights[net.id],
      nodes: this.moneroNodes().map(route),
      proxyUri,
      overTor: this.settings.torEnabled,
      store: this.dev.moneroStore?.(net.id, this.walletId),
      allowFakechain: this.dev.allowFakechain,
    });
    monero.on('state', (s) => this.emit('monero-state', s));
    monero.on('balance', () => this.emit('balance-changed'));
    await monero.open();
    this.monero = monero;
    await this.startZec(secrets);
    await this.startZano(secrets);
  }

  private get zanoAvailable(): boolean { return zanoEngineAvailable(this.dev.zanoBin); }

  private async startZano(secrets: Secrets): Promise<void> {
    if (!this.zanoAvailable) return;
    const torPort = this.settings.torEnabled ? Number((await this.tor.allocate()).match(/:(\d+)$/)?.[1]) : undefined;
    if (this.settings.torEnabled && !torPort) return; // Never fall back to a direct connection.
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
    const torPort = this.settings.torEnabled ? Number((await this.tor.allocate()).match(/:(\d+)$/)?.[1]) : undefined;
    if (this.settings.torEnabled && !torPort) return; // Never fall back to a direct connection.
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
    this.previews.clear();
    this.pendingSwaps.clear();
    this.balanceMemo.clear();
    this.balanceRetryAt.clear();
    this.tron = null;
    this.btc = null;
    this.eth = null;
    this.dcr = null;
    this.dash = null;
    void this.zec?.stop();
    this.zec = null;
    void this.zano?.stop();
    this.zano = null;
    this.priceCache = null;
    const monero = this.monero;
    this.monero = null;
    this.emit('locked'); // Closing can wait for a sync step, so the screen locks first.
    this.closing = this.closing.then(() => monero?.close()).catch(() => undefined);
    await this.closing;
    await this.tor.stop();
  }

  private session() {
    if (!this.tron || !this.monero || !this.btc || !this.eth || !this.dcr || !this.dash) throw new Error('지갑이 잠겨 있어.');
    return { tron: this.tron, monero: this.monero, btc: this.btc, eth: this.eth, dcr: this.dcr, dash: this.dash };
  }

  // ---- reads ----

  /** While true, every outside request is bound to fail, so none are made. */
  private get torNotReady(): boolean { return this.settings.torEnabled && this.tor.state.phase !== 'ready'; }

  private friendlyError(e: Error): string {
    return this.settings.torEnabled && /ECONNREFUSED 127\.0\.0\.1|socks/i.test(e.message) ? 'Tor에 연결되지 않았어. 연결되면 자동으로 다시 조회해.' : e.message;
  }

  private balanceMemo = new Map<string, { at: number; total: bigint; spendable: bigint; decimals: number }>();
  private balanceRetryAt = new Map<string, number>();

  /**
   * Public servers refuse now and then, more so over Tor where an exit IP is shared. One refusal shouldn't
   * blank a balance: it retries once, backs off, and meanwhile shows the last value marked as not the latest.
   * Sending never relies on this; it reads fresh balances.
   */
  private async readBalance(key: string, fn: () => Promise<[bigint, bigint]>, decimals: number, ttl: number): Promise<BalanceView> {
    const view = (m: { total: bigint; spendable: bigint }, stale = false): BalanceView => ({ ok: true, total: formatAmount(m.total, decimals), spendable: formatAmount(m.spendable, decimals), ...(stale ? { stale: true } : {}) });
    const memo = this.balanceMemo.get(key);
    if (memo && Date.now() - memo.at < ttl) return view(memo);
    if (key !== 'XMR' && this.torNotReady) return { ok: false, pending: true, total: '', spendable: '' };
    let failure: Error | undefined;
    if (Date.now() >= (this.balanceRetryAt.get(key) ?? 0)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const [total, spendable] = await fn();
          this.balanceMemo.set(key, { at: Date.now(), total, spendable, decimals });
          this.balanceRetryAt.delete(key);
          return view({ total, spendable });
        } catch (e) {
          failure = e as Error;
          if (attempt === 0) await new Promise((r) => setTimeout(r, this.dev.tronHost ? 50 : 1500));
        }
      }
      this.balanceRetryAt.set(key, Date.now() + (this.dev.tronHost ? 0 : BALANCE_BACKOFF_MS));
    }
    // With Tor down, an old number would hide that the connection is gone.
    const torDown = this.settings.torEnabled && this.tor.state.phase !== 'ready';
    if (memo && !torDown && Date.now() - memo.at < BALANCE_STALE_MS) return view(memo, true);
    return { ok: false, total: '', spendable: '', error: failure ? this.friendlyError(failure) : '잠시 뒤 다시 시도할게.' };
  }

  async overview() {
    const { tron, monero, btc } = this.session();
    const settle = (key: string, fn: () => Promise<[bigint, bigint]>, decimals: number, ttl = 0) => this.readBalance(key, fn, decimals, ttl);
    const btcSettle = async (): Promise<BalanceView> => {
      if (this.torNotReady) return { ok: false, pending: true, total: '', spendable: '' };
      try {
        const b = await btc.getBalance();
        return b ? { ok: true, total: formatAmount(b.total, 8), spendable: formatAmount(b.spendable, 8) } : { ok: false, pending: true, total: '', spendable: '' };
      } catch (e) {
        const message = (e as Error).message;
        // Being rate limited with nothing known yet is "still loading": it clears up by itself.
        return /제한 중/.test(message) ? { ok: false, pending: true, total: '', spendable: '' } : { ok: false, total: '', spendable: '', error: this.friendlyError(e as Error) };
      }
    };
    const { eth, dcr, dash } = this.session();
    const zec = this.zec;
    const zano = this.zano;
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
    const [BTC, XMR, ETH, TRX, USDTE, USDT, DCR, DASH] = await Promise.all([
      btcSettle(),
      settle('XMR', async () => { const b = await monero.getBalance(); return [b.total, b.unlocked]; }, 12),
      settle('ETH', async () => { const b = await eth.getEthBalance(); return [b, b]; }, 18),
      settle('TRX', async () => { const b = await tron.getTrxBalance(); return [b, b]; }, 6, BALANCE_TTL_MS),
      settle('USDTE', async () => { const b = await eth.getUsdtBalance(); return [b, b]; }, 6),
      settle('USDT', async () => { const b = await tron.getUsdtBalance(); return [b, b]; }, 6, BALANCE_TTL_MS),
      settle('DCR', async () => { const b = await dcr.getBalance(); return [b.total, b.spendable]; }, 8),
      settle('DASH', async () => { const b = await dash.getBalance(); return [b.total, b.spendable]; }, 8),
    ]);
    return {
      network: this.settings.network,
      tor: this.settings.torEnabled ? this.tor.state : null,
      balances: { XMR, BTC, ETH, TRX, USDTE, USDT, DCR, DASH, ...(zec ? { ZEC: zecView() } : {}), ...(zano ? { ZANO: zanoView() } : {}) },
      zec: zec ? { ...zec.state(), address: zec.receive?.unified ?? '', transparentAddress: zec.transparentAddress } : null,
      addresses: { BTC: btc.receiveAddress, XMR: await monero.getPrimaryAddress(), ETH: eth.address, TRX: tron.address, USDTE: eth.address, USDT: tron.address, DCR: dcr.receiveAddress, DASH: dash.receiveAddress, ...(zec ? { ZEC: zec.receive?.unified ?? '' } : {}), ...(zano ? { ZANO: zano.receive } : {}) },
      monero: monero.state,
    };
  }

  /** Answers without any network, so the receive screen never waits on a slow connection. */
  async addresses() {
    const { tron, monero, btc, eth, dcr, dash } = this.session();
    return { DASH: dash.receiveAddress, BTC: btc.receiveAddress, XMR: await monero.getPrimaryAddress(), ETH: eth.address, TRX: tron.address, USDTE: eth.address, USDT: tron.address, DCR: dcr.receiveAddress, ...(this.zec ? { ZEC: this.zec.receive?.unified ?? '', ZEC_T: this.zec.transparentAddress } : {}), ...(this.zano ? { ZANO: this.zano.receive } : {}) };
  }

  async torInfo() {
    return { updatable: !this.dev.nativeTor, enabled: this.settings.torEnabled, installed: this.tor.isInstalled(), state: this.tor.state };
  }

  async installTor() {
    return this.tor.install((message) => this.emit('tor-install', message));
  }

  async history(asset: Asset) {
    const { tron, monero, btc, eth, dcr, dash } = this.session();
    if (asset === 'DASH') return dash.getHistory();
    if (asset === 'ZEC') return this.zec ? this.zec.getHistory() : [];
    if (asset === 'ZANO') return this.zano ? this.zano.getHistory() : [];
    if (asset === 'BTC') return btc.getHistory();
    if (asset === 'DCR') return dcr.getHistory();
    if (asset === 'ETH' || asset === 'USDTE') return eth.getHistory(asset);
    return asset === 'XMR' ? monero.getHistory() : tron.getHistory(asset);
  }

  // ---- swap ----

  /** Exolix needs no key. The others join once their key is in settings. */
  private swapClients(): Partial<Record<SwapProviderId, SwapProvider>> {
    const timeout = this.settings.torEnabled ? 60_000 : 30_000;
    const clients: Partial<Record<SwapProviderId, SwapProvider>> = {
      exolix: new SwapClient(this.dev.swapBase ?? SWAP_BASE, this.priceAgent, timeout),
    };
    // Test runs point at mock services and choose their own keys. Real runs use the keys shipped with the app.
    const keys = this.dev.swapBase ? { simpleswap: this.settings.simpleSwapKey, ghostswap: this.settings.ghostSwapKey } : BUILTIN_SWAP_KEYS;
    if (keys.simpleswap) clients.simpleswap = new SimpleSwapClient(this.dev.simpleSwapBase ?? SIMPLESWAP_BASE, keys.simpleswap, this.priceAgent, timeout);
    if (keys.ghostswap) clients.ghostswap = new GhostSwapClient(this.dev.ghostSwapBase ?? GHOSTSWAP_BASE, keys.ghostswap, this.priceAgent, timeout);
    return clients;
  }
  private get swapsPath() { return path.join(this.dir, 'swaps.json'); }

  async swapList(): Promise<SwapRecord[]> {
    try { return JSON.parse(await fs.readFile(this.swapsPath, 'utf8') as unknown as string); } catch { return []; }
  }

  private async swapSave(list: SwapRecord[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.swapsPath, JSON.stringify(list.slice(0, 100)), { mode: 0o600 });
  }

  async swapQuote(from: Asset, to: Asset, amountInput: string) {
    this.session();
    if (this.torNotReady) throw new Error('Tor 연결 중이야. 연결되면 다시 해봐.');
    if (from === to) throw new Error('다른 코인을 골라줘.');
    const amount = formatAmount(parseAmount(amountInput, DECIMALS[from]), DECIMALS[from]);
    const clients = Object.entries(this.swapClients()) as [SwapProviderId, SwapProvider][];
    const results = await Promise.all(clients.map(async ([id, client]) => {
      try { return await client.quote(from, to, amount); } catch (e) {
        return { from, to, amount, receive: '0', rate: '0', min: null, max: null, approximate: true, providerId: id, provider: id, problem: `연결 실패: ${(e as Error).message}` };
      }
    }));
    const sorted = results.sort((a, b) => Number(!a.problem && b.problem ? -1 : !b.problem && a.problem ? 1 : Number(b.receive) - Number(a.receive)));
    const [price, network] = await Promise.all([this.prices(), this.feeEstimate(from)]);
    return sorted.map((q) => ({ ...q, network, cost: q.problem ? null : swapCost(amount, q.receive, price?.[from]?.usd, price?.[to]?.usd) }));
  }

  /** Gets a fresh rate, opens the order, checks it, and prepares the deposit like any other send. Nothing is signed yet. */
  /** Checked before any order exists, so a bad address costs nothing. */
  private async checkDestination(asset: Asset, input: string): Promise<string> {
    const { monero } = this.session();
    const address = input.trim();
    const valid = asset === 'BTC' ? isBtcAddress(address)
      : asset === 'DCR' ? isDcrAddress(address)
      : asset === 'DASH' ? isDashAddress(address)
      : asset === 'ZEC' ? isZecAddress(address)
      : asset === 'ZANO' ? isZanoAddress(address)
      : asset === 'XMR' ? await monero.isValidAddress(address)
        : asset === 'ETH' || asset === 'USDTE' ? isEthAddress(address)
          : isTronAddress(address);
    if (!valid) throw new Error(`받을 주소가 ${asset === 'USDTE' ? 'USDT (Eth)' : asset === 'USDT' ? 'USDT (Tron)' : asset} 주소가 아니야.`);
    if ((asset === 'ETH' || asset === 'USDTE') && address.toLowerCase() === ETH_USDT.toLowerCase()) throw new Error('USDT 컨트랙트 주소로는 받을 수 없어. 코인을 잃어버려.');
    return address;
  }

  private async myAddress(asset: Asset): Promise<string> {
    const { tron, monero, btc, eth, dcr, dash } = this.session();
    if (asset === 'ZANO') {
      if (!this.zano?.receive) throw new Error('Zano 지갑을 준비하는 중이야. 조금 뒤에 다시 해봐.');
      return this.zano.receive;
    }
    if (asset === 'ZEC') {
      // Swap services pay transparent addresses. The coins get shielded on arrival.
      if (!this.zec?.transparentAddress) throw new Error('Zcash 지갑을 준비하는 중이야. 조금 뒤에 다시 해봐.');
      return this.zec.transparentAddress;
    }
    await (asset === 'DASH' ? dash.refresh().catch(() => undefined) : asset === 'BTC' ? btc.refresh().catch(() => undefined) : asset === 'DCR' ? dcr.refresh().catch(() => undefined) : undefined);
    return asset === 'DASH' ? dash.receiveAddress : asset === 'DCR' ? dcr.receiveAddress : asset === 'BTC' ? btc.receiveAddress : asset === 'XMR' ? monero.getPrimaryAddress() : asset === 'ETH' || asset === 'USDTE' ? eth.address : tron.address;
  }

  private async openOrder(from: Asset, to: Asset, amount: string, providerId: SwapProviderId, withdrawal: string, refund: string, external: boolean, privacy?: { leg: 'first'; via: string; destination: string } | { leg: 'second'; id: string }) {
    const client = this.swapClients()[providerId];
    if (!client) throw new Error('이 업체는 지금 쓸 수 없어.');
    const quote = await client.quote(from, to, amount);
    if (quote.problem) throw new Error(quote.problem);
    const order = await client.create(from, to, amount, quote.receive, withdrawal, refund);
    const preview = await this.prepareSend(from, order.depositAddress, amount);
    if (preview.amount !== amount) throw new Error('보낼 금액이 달라서 중단했어.');
    const swap = { id: order.id, from, to, amount, receive: order.receive, rate: order.rate, providerId, provider: order.provider, approximate: order.approximate, receiveAddress: withdrawal, withdrawalAddress: withdrawal, external, privacy };
    this.pendingSwaps.set(preview.id, swap);
    return { ...preview, swap };
  }

  /** Gets a fresh rate, opens the order, checks it, and prepares the deposit like any other send. Nothing is signed yet. */
  async swapPrepare(from: Asset, to: Asset, amountInput: string, providerId: SwapProviderId = 'exolix', destination = '') {
    this.session();
    if (from === to) throw new Error('다른 코인을 골라줘.');
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
    if (!PRIVACY_ASSETS.includes(from) || !PRIVACY_ASSETS.includes(to)) throw new Error('프라이버시 스왑은 BTC, ETH, USDT (Eth)만 돼.');
  }

  async privacyQuote(from: Asset, to: Asset, amountInput: string) {
    this.assertPrivacyPair(from, to);
    const firsts = await this.swapQuote(from, 'XMR', amountInput);
    const good = firsts.filter((q) => !q.problem);
    if (!good.length) return { first: null, second: null, sameProvider: false, problem: firsts[0]?.problem ?? '지금은 견적을 받을 수 없어.' };
    const xmr = formatAmount(parseAmount(Number(good[0].receive).toFixed(12), 12), 12);
    const seconds = (await this.swapQuote('XMR', to, xmr)).filter((q) => !q.problem);
    if (!seconds.length) return { first: good[0], second: null, sameProvider: false, problem: '2단계 견적을 받을 수 없어. 금액을 바꿔봐.' };
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
    if (!destinationInput.trim()) throw new Error('프라이버시 스왑은 최종으로 받을 주소가 꼭 필요해.');
    const destination = await this.checkDestination(to, destinationInput);
    const { eth, monero } = this.session();
    if ((from === 'ETH' || from === 'USDTE') && destination.toLowerCase() === eth.address.toLowerCase()) {
      throw new Error('보내는 주소와 받는 주소가 같으면 프라이버시 효과가 없어. 새 주소를 넣어줘.');
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
    if (!p) throw new Error('프라이버시 스왑 기록이 없어.');
    if (p.stage === 'first') {
      const record = await this.swapRefresh(p.firstId).catch(() => null);
      if (record && SWAP_DEAD.includes(record.status)) {
        p.stage = 'failed';
        p.note = `1단계가 ${record.status} 상태로 끝났어. 환불은 보낸 코인 주소로 돌아와.`;
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
        p.note = `2단계가 ${record.status} 상태로 끝났어. 환불되면 XMR 잔액으로 돌아오니까 일반 스왑으로 다시 진행해.`;
      }
    }
    await this.privacySave(list);
    return p;
  }

  async privacySecondQuote(id: string, amountInput: string) {
    const p = (await this.privacyList()).find((x) => x.id === id);
    if (!p) throw new Error('프라이버시 스왑 기록이 없어.');
    const list = await this.swapQuote('XMR', p.to, amountInput);
    // Offer a different service from step one first.
    return list.sort((a, b) => Number(a.providerId === p.firstProviderId) - Number(b.providerId === p.firstProviderId));
  }

  async privacySecond(id: string, amountInput: string, providerId: SwapProviderId) {
    this.session();
    const p = (await this.privacyList()).find((x) => x.id === id);
    if (!p) throw new Error('프라이버시 스왑 기록이 없어.');
    if (p.stage !== 'ready') throw new Error('XMR이 도착하고 잠금이 풀린 뒤에 진행할 수 있어.');
    const value = parseAmount(amountInput, 12);
    if (value > parseAmount(p.unlocked === '0' ? '0.000000000001' : p.unlocked, 12)) throw new Error(`이 스왑으로 받은 ${p.unlocked} XMR까지만 보낼 수 있어.`);
    return this.openOrder('XMR', p.to, formatAmount(value, 12), providerId, p.destination, p.via, true, { leg: 'second', id });
  }

  async swapConfirm(previewId: string, password: string) {
    const swap = this.pendingSwaps.get(previewId);
    if (!swap) throw new Error('확인 시간이 지났어. 다시 진행해.');
    const res = await this.confirmSend(previewId, password);
    this.pendingSwaps.delete(previewId);
    const record: SwapRecord = { id: swap.id, from: swap.from, to: swap.to, amount: swap.amount, receive: swap.receive, rate: swap.rate, createdAt: Date.now(), providerId: swap.providerId, provider: swap.provider, approximate: swap.approximate, status: 'wait', hashIn: res.hashes[0], withdrawalAddress: swap.withdrawalAddress };
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
    if (!record) throw new Error('스왑 기록이 없어.');
    const client = this.swapClients()[record.providerId ?? 'exolix'];
    if (!client) throw new Error(`${record.provider ?? '이 업체'}는 지금 상태를 볼 수 없어.`);
    const st = await client.status(id);
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
    for (const source of sources) {
      try {
        const json = await getJson(source.url, { agent: this.priceAgent, timeoutMs: this.settings.torEnabled ? 45_000 : 10_000 });
        const value = source.parse(json);
        this.priceCache = { at: Date.now(), value };
        return value;
      } catch { /* next source */ }
    }
    this.priceRetryAt = Date.now() + 60_000;
    return this.priceCache?.value ?? null;
  }

  async flush(): Promise<void> { await this.monero?.flush(); }

  async moneroAddresses() { return this.session().monero.listAddresses(); }
  async newSubaddress() { return this.session().monero.createSubaddress(); }

  async qr(text: string): Promise<string> {
    // A Zcash unified address runs past 200 characters.
    if (text.length > 500) throw new Error('QR로 만들 수 없는 값이야.');
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
      if (asset === 'DCR') return [typicalDcrFee(), 8, 'DCR'];
      if (asset === 'DASH') return [typicalDashFee(), 8, 'DASH'];
      if (asset === 'ZEC') return [15_000n, 8, 'ZEC']; // ZIP-317, a typical transfer
      if (asset === 'ZANO') return [ZANO_FEE, 12, 'ZANO'];
      if (asset === 'ETH') return [await eth.typicalFee(21_000n), 18, 'ETH'];
      if (asset === 'USDTE') return [await eth.typicalFee(65_000n), 18, 'ETH'];
      if (asset === 'USDT') return [await tron.typicalUsdtFee(), 6, 'TRX'];
      if (asset === 'TRX') return [(await tron.estimateFee({ asset, to: tron.address, amount: 1n })).feeSun, 6, 'TRX'];
      for (const node of this.moneroNodes()) {
        try {
          const res = await requestJson(`${node}/json_rpc`, { method: 'POST', body: { jsonrpc: '2.0', id: '0', method: 'get_fee_estimate' }, agent: this.priceAgent, timeoutMs: this.settings.torEnabled ? 60_000 : 10_000 });
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
    if (!address) throw new Error('없는 풀이야.');
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
    if (!preview?.eth || preview.expires < Date.now() || preview.to !== this.poolAddress(pool)) throw new Error('확인 시간이 지났어. 다시 진행해.');
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
    if (!note) throw new Error('입금 기록이 없어.');
    const secrets = await this.vault.open(password);
    return noteText(note.pool, noteSecrets(secrets.tronMnemonic, note.index));
  }

  /** Fee and amounts for the review screen. Nothing heavy, nothing sent. */
  async tornadoWithdrawQuote(noteId: string, recipientInput: string, relayerInput: string) {
    const { eth } = this.session();
    const store = await this.tornadoStore.read();
    const note = store.notes.find((n) => n.id === noteId);
    if (!note) throw new Error('입금 기록이 없어.');
    const recipient = recipientInput.trim();
    if (!isEthAddress(recipient)) throw new Error('받을 주소가 Ethereum 주소가 아니야.');
    if (recipient.toLowerCase() === eth.address.toLowerCase()) throw new Error('입금한 주소로 받으면 프라이버시 효과가 없어. 새 주소를 넣어줘.');
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
    if (!note) throw new Error('입금 기록이 없어.');
    const secrets = await this.vault.open(password);
    const quote = await this.tornadoWithdrawQuote(noteId, recipientInput, relayerInput);
    const address = this.poolAddress(note.pool);
    const keys = noteSecrets(secrets.tronMnemonic, note.index);
    const [{ commitment, nullifierHash }] = await runTornado('commit', { notes: [keys] });
    if (commitment !== note.commitment) throw new Error('이 시드의 입금이 아니야.');
    const spent = tornadoAbi.decodeFunctionResult('isSpent', await eth.call(address, tornadoAbi.encodeFunctionData('isSpent', [nullifierHash])));
    if (spent[0]) { note.status = 'withdrawn'; await tor.write(store); throw new Error('이미 출금된 입금이야.'); }

    const leaves = await tor.leaves(note.pool, address, eth, { seed: !this.dev.tornadoPools, agent: this.priceAgent, progress: say });
    const leafIndex = leaves.findIndex((l) => l.toLowerCase() === commitment.toLowerCase());
    if (leafIndex < 0) throw new Error('입금이 아직 체인에서 확인되지 않았어. 컨펌 뒤에 다시 해봐.');
    const relayer = quote.mode === 'relayer' ? quote.relayer as string : `0x${'0'.repeat(40)}`;
    const fee = quote.mode === 'relayer' ? parseAmount(quote.fee, 18) : 0n;
    const { proof, args } = await runTornado('prove', { leaves, leafIndex, ...keys, recipient: quote.recipient, relayer, fee: fee.toString() }, (stage) => {
      say(stage === 'tree' ? `머클 트리 만드는 중… ${leaves.length}건이라 몇 분 걸릴 수 있어.` : '영지식 증명 만드는 중… 화면이 잠깐 멈춰 보일 수 있어. 앱을 닫지 마.');
    });
    const known = tornadoAbi.decodeFunctionResult('isKnownRoot', await eth.call(address, tornadoAbi.encodeFunctionData('isKnownRoot', [args[0]])));
    if (!known[0]) throw new Error('입금 기록이 체인과 맞지 않아서 중단했어. 코인은 그대로야. 다시 시도해줘.');

    note.status = 'withdrawing';
    note.recipient = quote.recipient;
    await tor.write(store);
    say('출금 전송 중…');
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
    const { tron, monero, btc, eth, dcr, dash } = this.session();
    if (this.torNotReady) throw new Error('Tor 연결 중이야. 연결되면 다시 해봐.');
    const address = to.trim();
    const isMax = amountInput.trim().toLowerCase() === 'max';
    const decimals = DECIMALS[asset];
    const warnings: string[] = [];
    let preview: Preview;

    if (asset === 'ZANO') {
      if (!this.zano) throw new Error('이 기기에서는 Zano를 쓸 수 없어.');
      if (!isZanoAddress(address)) throw new Error('Zano 주소가 아니야.');
      if (address === this.zano.receive) throw new Error('내 주소로는 보낼 수 없어.');
      const draft = await this.zano.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.value, fee: draft.fee, zano: draft });
    } else if (asset === 'ZEC') {
      if (!this.zec) throw new Error('이 기기에서는 Zcash를 쓸 수 없어.');
      if (!isZecAddress(address)) throw new Error('Zcash 주소가 아니야. u1, zs1, t1로 시작하는 주소만 보낼 수 있어.');
      const receive = this.zec.receive;
      if (address === receive?.unified || address === receive?.transparent) throw new Error('내 주소로는 보낼 수 없어.');
      const draft = await this.zec.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      if (/^t/.test(address)) warnings.push('투명 주소로 보내면 받는 쪽 주소와 금액이 체인에 공개돼.');
      preview = this.storePreview({ asset, to: address, amount: draft.value, fee: draft.fee, zec: draft });
    } else if (asset === 'DASH') {
      if (!isDashAddress(address)) throw new Error('Dash 주소가 아니야. X로 시작하는 주소만 보낼 수 있어.');
      if (address === dash.receiveAddress) throw new Error('내 주소로는 보낼 수 없어.');
      const draft = await dash.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, dash: draft });
    } else if (asset === 'DCR') {
      if (!isDcrAddress(address)) throw new Error('Decred 주소가 아니야. Ds로 시작하는 주소만 보낼 수 있어.');
      if (address === dcr.receiveAddress) throw new Error('내 주소로는 보낼 수 없어.');
      const draft = await dcr.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, dcr: draft });
    } else if (asset === 'BTC') {
      if (!isBtcAddress(address)) throw new Error('Bitcoin 주소가 아니야.');
      const draft = await btc.draft(address, isMax ? 'max' : parseAmount(amountInput, decimals));
      if (draft.fee * 2n > draft.amount) warnings.push('수수료가 보내는 금액의 절반을 넘어.');
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, btc: draft });
    } else if (asset === 'ETH' || asset === 'USDTE') {
      if (!isEthAddress(address)) throw new Error('Ethereum 주소가 아니야. 0x로 시작하는 주소만 보낼 수 있어.');
      if (address.toLowerCase() === eth.address.toLowerCase()) throw new Error('내 주소로는 보낼 수 없어.');
      const draft = await eth.draft(asset, address, isMax ? 'max' : parseAmount(amountInput, decimals));
      if (asset === 'ETH' && isMax) warnings.push('실제 수수료가 예상보다 적으면 차액은 ETH로 조금 남아.');
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.expectedFee, eth: draft });
    } else if (asset === 'XMR') {
      if (!(await monero.isValidAddress(address))) throw new Error('이 네트워크의 Monero 주소가 아니야.');
      const amount = isMax ? 'max' as const : parseAmount(amountInput, decimals);
      const draft = await monero.draft(address, amount);
      preview = this.storePreview({ asset, to: address, amount: draft.amount, fee: draft.fee, monero: draft });
    } else {
      if (!isTronAddress(address)) throw new Error('Tron 주소가 아니야. T로 시작하는 주소만 보낼 수 있어.');
      if (address === tron.address) throw new Error('내 주소로는 보낼 수 없어.');
      const trx = await tron.getTrxBalance();
      if (asset === 'USDT') {
        const usdt = await tron.getUsdtBalance();
        const amount = isMax ? usdt : parseAmount(amountInput, decimals);
        if (amount <= 0n) throw new Error('보낼 USDT가 없어.');
        if (amount > usdt) throw new Error('USDT 잔액이 부족해.');
        const fee = await tron.estimateFee({ asset, to: address, amount });
        if (fee.feeSun > trx) {
          throw new Error(`수수료용 TRX가 부족해. 약 ${formatAmount(fee.feeSun, 6)} TRX가 필요한데 ${formatAmount(trx, 6)} TRX만 있어.`);
        }
        if (fee.recipientIsNew) warnings.push('받는 주소가 아직 활성화되지 않아서 수수료가 더 나올 수 있어.');
        preview = this.storePreview({
          asset, to: address, amount, fee: fee.feeSun,
          tron: { asset, to: address, amount, feeLimit: fee.feeLimitSun },
        });
      } else {
        const probe = await tron.estimateFee({ asset, to: address, amount: 1n });
        const amount = isMax ? trx - probe.feeSun : parseAmount(amountInput, decimals);
        if (amount <= 0n) throw new Error('수수료를 빼면 보낼 TRX가 없어.');
        if (amount + probe.feeSun > trx) throw new Error('수수료까지 합치면 TRX 잔액이 부족해.');
        if (probe.recipientIsNew) warnings.push('처음 쓰는 주소라서 활성화 수수료가 포함됐어.');
        preview = this.storePreview({ asset, to: address, amount, fee: probe.feeSun, tron: { asset, to: address, amount } });
      }
    }
    return {
      id: preview.id, asset, to: address,
      amount: formatAmount(preview.amount, decimals),
      fee: formatAmount(preview.fee, preview.eth ? 18 : asset === 'XMR' ? 12 : asset === 'ZANO' ? 12 : asset === 'BTC' || asset === 'DCR' || asset === 'DASH' || asset === 'ZEC' ? 8 : 6),
      feeAsset: preview.eth ? 'ETH' : asset === 'XMR' || asset === 'BTC' || asset === 'DCR' || asset === 'DASH' || asset === 'ZEC' || asset === 'ZANO' ? asset : 'TRX',
      feeIsEstimate: asset !== 'XMR' && asset !== 'BTC' && asset !== 'DCR' && asset !== 'DASH' && asset !== 'ZEC' && asset !== 'ZANO',
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
    const { tron, monero, btc, eth, dcr, dash } = this.session();
    const preview = this.previews.get(id);
    if (!preview || preview.expires < Date.now()) {
      this.previews.delete(id);
      throw new Error('확인 시간이 지났어. 다시 진행해.');
    }
    const secrets = await this.vault.open(password);
    this.previews.delete(id); // one shot: a retry must go through a fresh preview
    this.balanceMemo.clear(); // money is about to move

    if (preview.zano) {
      if (!this.zano) throw new Error('Zano 엔진이 꺼져 있어.');
      return { hashes: [await this.zano.send(preview.zano)] };
    }
    if (preview.zec) {
      if (!this.zec) throw new Error('Zcash 엔진이 꺼져 있어.');
      return { hashes: await this.zec.send(preview.zec, secrets.tronMnemonic) };
    }
    if (preview.dash) return { hashes: [await dash.send(preview.dash, secrets.tronMnemonic)] };
    if (preview.dcr) return { hashes: [await dcr.send(preview.dcr, secrets.tronMnemonic)] };
    if (preview.btc) {
      return { hashes: [await btc.send(preview.btc, secrets.tronMnemonic)] };
    }
    if (preview.eth) {
      return { hashes: [await eth.send(preview.eth, deriveEthAccount(secrets.tronMnemonic).wallet)] };
    }
    if (preview.monero) {
      const hashes = await monero.relay(preview.monero);
      return { hashes };
    }
    const account = deriveTronAccount(secrets.tronMnemonic);
    if (account.address !== tron.address) throw new Error('지갑 주소가 일치하지 않아서 중단했어.');
    const txid = await tron.send(preview.tron as TronTransfer, account.privateKey);
    void tron.waitForResult(txid).then((status) => this.emit('tron-tx', { txid, status, asset: preview.asset }));
    return { hashes: [txid] };
  }

  // ---- Zcash ----

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

  async zecShield(password: string) {
    if (!this.zec) throw new Error('이 기기에서는 Zcash를 쓸 수 없어.');
    if (this.torNotReady) throw new Error('Tor 연결 중이야. 연결되면 다시 해봐.');
    const secrets = await this.vault.open(password);
    return { hashes: await this.zec.shield(secrets.tronMnemonic) };
  }

  /** date: YYYY-MM-DD. The earlier the date, the longer the scan. */
  async zecRescan(date: string, password: string): Promise<void> {
    if (!this.zec) throw new Error('이 기기에서는 Zcash를 쓸 수 없어.');
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) ? new Date(date.trim() + 'T00:00:00Z') : null;
    if (!parsed || Number.isNaN(parsed.getTime())) throw new Error('날짜는 YYYY-MM-DD로 입력해.');
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
      if (node && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(node)) throw new Error('노드 주소는 http://host:port 형식으로 입력해.');
      next.customMoneroNode = node;
    }
    if (typeof patch.showPrices === 'boolean') next.showPrices = patch.showPrices;
    if (typeof patch.tornadoRelayer === 'string') next.tornadoRelayer = patch.tornadoRelayer.trim();
    if (typeof patch.simpleSwapKey === 'string') next.simpleSwapKey = patch.simpleSwapKey.trim();
    if (typeof patch.ghostSwapKey === 'string') next.ghostSwapKey = patch.ghostSwapKey.trim();
    if (typeof patch.torEnabled === 'boolean') {
      if (patch.torEnabled && !this.tor.isInstalled()) throw new Error('Tor를 먼저 설치해.');
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
      for (const f of ['swaps.json', 'privacy-swaps.json', 'tornado.json', 'zec-state.json']) await fs.rm(path.join(this.dir, f), { force: true });
    } else {
      await fs.rm(this.dir, { recursive: true, force: true });
    }
    const r = await this.walletRegistry();
    const left = r.list.filter((w) => w.id !== id);
    const next = left.length ? { active: left[0].id, list: left } : { active: 'main', list: [{ id: 'main', name: '내 지갑' }] };
    await this.walletRegistrySave(next);
    this.activate(next.active);
    return id;
  }

  explorerUrl(asset: Asset, hash: string): string {
    if (asset === 'ETH' || asset === 'USDTE') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('잘못된 거래 해시야.');
      return ETH_EXPLORER_TX + hash;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw new Error('잘못된 거래 해시야.');
    const net = NETWORKS[this.settings.network];
    if (asset === 'DCR') return DCR_EXPLORER_TX + hash;
    if (asset === 'DASH') return DASH_EXPLORER_TX + hash;
    if (asset === 'ZEC') return ZEC_EXPLORER_TX + hash;
    if (asset === 'ZANO') return ZANO_EXPLORER_TX + hash;
    if (asset === 'BTC') return BTC_EXPLORER_TX + hash;
    return (asset === 'XMR' ? net.monero.explorerTx : net.tron.explorerTx) + hash;
  }
}
