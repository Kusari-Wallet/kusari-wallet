// The wallet service, first layer: wallets, sessions, engines, Tor routes, balances and prices.
import { bip39Seed } from './seed';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { Records, lockedRecords, plainRecords, recordsKey, sealedRecords } from './records';
import { balanceCacheKey, readBalanceCache, writeBalanceCache, SavedBalance, SAVED_BALANCE_MAX_AGE_MS } from './balance-cache';
import path from 'node:path';
const { wordlist: BIP39_WORDS } = require('@scure/bip39/wordlists/english');
import { formatAmount, parseAmount } from './amount';
import { Asset, BTC_APIS, BTC_ONION_APIS, DECIMALS, FIRO_APIS, SOL_RPCS, BCH_APIS, LTC_APIS, SCRT_LCDS, DOGE_APIS, DOGE_PUSH_URLS, DOGE_BACKUP, DOGE_RAW_URLS, POL_RPCS, POL_SCOUT, ARB_RPCS, ARB_SCOUT, BSC_RPCS, BSC_SCOUT, DASH_APIS, DEFAULT_SETTINGS, ARRR_SERVERS, ZANO_NODE, KSR_NODE, ZEC_SERVERS, ETH_RPCS, ETH_SCOUT, ETH_USDT, NETWORKS, NetworkId, Settings, estimateMainnetHeight } from './config';
import { MIN_PASSWORD, Secrets, Vault } from './vault';
import { TronClient, deriveTronAccount, generateTronMnemonic } from './tron';
import { socksAgent, getJson, newTorRoute } from './request';
import type { Agent } from 'node:http';
import { AAVE_MARKETS, aaveCall, readAave } from './aave';
import { ScrtClient, scrtPrivacyKeys, scrtPublicKey } from './scrt';
import { BITCOIN, BITCOIN_MIXED, BTC_MIXED_PATH, BTC_PATH, BtcClient, LITECOIN, btcAccountXpub, coinId, ltcAccountXpub } from './btc';
import { FilterSync, TAPROOT_HEIGHT, estimateBtcHeight } from './btc-filter-sync';
import { clearPassphrases, setPassphrase } from './seed';
import { PRICE_TIERS, PriceMap, PriceSource, coingecko, mirror, NO_MARKET } from './prices';
import { ArrrClient } from './arrr';
import { startArrrEngine, arrrEngineAvailable } from './arrr-process';
import { startMwebEngine, mwebEngineAvailable } from './mweb-process';
import { MwebClient } from './mweb';
import { startSparkEngine, sparkEngineAvailable } from './spark-process';
import { SparkClient, sparkKey } from './spark';
import { ZanoClient, zanoKeys, ksrKeys, KSR_CHAIN } from './zano';
import { startZanoEngine, zanoEngineAvailable, startKsrEngine, ksrEngineAvailable } from './zano-process';
import { ZecClient, zecHeightForDate } from './zec';
import { startZecEngine, zecEngineAvailable } from './zec-process';
import { FiroClient, firoAccountXpub } from './firo';
import { DogeClient, dogeAccountXpub } from './doge';
import { ADA_API, AdaClient, adaAddress } from './ada';
import { BchClient, bchAccountXpub } from './bch';
import { SolClient, solAddress } from './sol';
import { DashClient, dashAccountXpub } from './dash';
import { DashMixer, MIX_ROUNDS } from './dash-mix';
import { tcpDial } from './dash-net';
import { BtcMixer, COINJOIN_COORDINATORS, DEFAULT_MIX_TARGET, MAX_COINS_PER_ROUND } from './btc-mix';
import { identificationKey } from './wabisabi/round';
import { ARBITRUM, BSC, EthAsset, EthClient, POLYGON, chainOf, deriveEthAccount } from './eth';
import { TorManager } from './tor';
import { parseCustomBridges } from './tor-bridges';
import { SwapProviderId } from './swap';
import { MoneroClient, MoneroOptions, generateMoneroSeed, validateMoneroSeed } from './monero';
import { BALANCE_TTL_MS, OVERVIEW_WAIT_MS, STUCK_LOOKUP_MS, QUICK_REFUSAL_MS, bareBch, isLocalServer, COIN_ID, btcScript, btcScriptOfKey, within, EVM, isSpl, EXTRA_ASSETS, isEvm, LOOKUP_ROUTE, lookupRetryDelay, BALANCE_STALE_MS, Preview, BalanceView } from './service-common';
import { DEVELOPER_BUILD } from './flavor';

export class ServiceCore extends EventEmitter {
  protected vault: Vault;
  protected dir: string;
  protected walletId = 'main';
  protected pendingAdd: { id: string; name: string; previous: string } | null = null;
  protected tron: TronClient | null = null;
  protected monero: MoneroClient | null = null;
  protected btc: BtcClient | null = null;
  /** The CoinJoin account and the mixer that fills it. */
  protected btcMixed: BtcClient | null = null;
  protected btcMixer: BtcMixer | null = null;
  protected btcMixedBalance: { total: bigint; spendable: bigint } | null = null;
  protected ltc: BtcClient | null = null;
  protected sscrtNeedsKey = false;
  protected scrt: ScrtClient | null = null;
  protected eth: EthClient | null = null;
  protected pol: EthClient | null = null;
  protected arb: EthClient | null = null;
  protected bsc: EthClient | null = null;
  /** Whether this session goes through Tor. */
  protected torActive = false;
  get torOn(): boolean { return this.torActive; }
  protected dash: DashClient | null = null;
  protected mixer: DashMixer | null = null;
  protected firo: FiroClient | null = null;
  protected doge: DogeClient | null = null;
  protected ada: AdaClient | null = null;
  protected bch: BchClient | null = null;
  protected sol: SolClient | null = null;
  protected zec: ZecClient | null = null;
  protected zano: ZanoClient | null = null;
  /** Kusari (KSR): the Zano client on its own engine, chain and keys. */
  protected ksr: ZanoClient | null = null;
  protected arrr: ArrrClient | null = null;
  protected mweb: MwebClient | null = null;
  protected spark: SparkClient | null = null;
  protected engineStops: Promise<void> = Promise.resolve();
  /** Goes up on every lock, so an engine still starting from the last session shuts itself down. */
  protected sessionGen = 0;
  protected previews = new Map<string, Preview>();
  protected privacyTargets = new Map<string, Asset>();
  protected pendingSwaps = new Map<string, { id: string; from: Asset; to: Asset; amount: string; receive: string; rate: string; providerId: SwapProviderId; provider: string; approximate: boolean; statusKey?: string; withdrawalAddress: string; privacy?: { leg: 'first'; via: string; destination: string } | { leg: 'second'; id: string } }>();
  readonly tor: TorManager;
  protected priceAgent: ReturnType<typeof socksAgent> | undefined;
  protected torProxy: string | undefined;
  protected lastNoted: { stamp: string; at: number } | undefined;
  protected readonly routes = new Map<string, ReturnType<typeof socksAgent>>();
  protected readonly balanceFails = new Map<string, number>();
  protected readonly lookupFailures: string[] = [];
  protected readonly lastLookupError = new Map<string, string>();
  protected closing: Promise<void> = Promise.resolve();
  protected draftSeeds: { tronMnemonic: string; moneroSeed: string } | null = null;
  protected priceCache: { at: number; value: PriceMap } | null = null;
  protected priceRetryAt = 0;
  protected priceInFlight: Promise<PriceMap | null> | null = null;
  settings: Settings = { ...DEFAULT_SETTINGS };

  constructor(protected readonly baseDir: string, protected readonly kdf?: { N: number; r: number; p: number }, protected readonly dev: {
    tronHost?: string; priceUrl?: string; priceSources?: PriceSource[]; torBin?: string; socks?: string; ethRpc?: string; ethScout?: string; bchApi?: string; ltcApi?: string; scrtLcd?: string; polRpc?: string; polScout?: string; polUsdt?: string; arbRpc?: string; arbScout?: string; arbUsdt?: string; bscRpc?: string; bscScout?: string; uniswapKey?: string; uniswapBase?: string; dashApi?: string; dashSeeds?: string[]; dashConnect?: string; firoApi?: string; solRpc?: string; dogeApi?: string; dogeBackup?: string; adaApi?: string; zecBin?: string; zecServers?: string[]; zanoBin?: string; zanoNode?: string; ksrBin?: string; ksrNode?: string; arrrBin?: string; arrrServers?: string[]; mwebBin?: string; mwebConnect?: string; sparkBin?: string; sparkServer?: string; sparkConnect?: string; tornadoPools?: Record<string, string>; tornadoLocalRelayer?: boolean; swapBase?: string; simpleSwapBase?: string; ghostSwapBase?: string; etzSwapBase?: string; cceCashBase?: string; changeNowBase?: string; quoteDeadlineMs?: number; btcApi?: string; coinjoinCoordinator?: string; coinjoinTest?: { pollMs?: number; registrationMarginMs?: number; minInputs?: number };
    /** Android: every outside address goes through the app's local forwarder. */
    route?: (url: string) => string;
    moneroStore?: (net: NetworkId, walletId: string) => MoneroOptions['store'];
    allowFakechain?: boolean;
    /** Android: the Tor process and its routing live on the native side. */
    nativeTor?: boolean;
  } = {}) {
    super();
    // The test harness's stand-in servers aren't reachable over Tor, so its wallets start with Tor off.
    if (dev.tronHost) this.settings.torEnabled = false;
    this.dir = baseDir;
    this.vault = new Vault(path.join(baseDir, 'vault.json'), kdf);
    this.tor = new TorManager(path.join(baseDir, 'tor'), { binPath: dev.torBin, socksOverride: dev.socks, sources: dev.socks ? { bundleBases: [], keyUrls: [], fingerprint: '' } : undefined });
    this.tor.on('state', (s) => this.emit('tor-state', s));
  }

  protected get settingsPath() { return path.join(this.baseDir, 'settings.json'); }
  protected moneroDir(net: NetworkId) { return path.join(this.dir, 'xmr', net); }

  async init(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.readFile(this.settingsPath, 'utf8'));
      this.settings = { ...DEFAULT_SETTINGS, ...saved };
      // Tor is on by default from 0.57. Settings saved before then had it off by default, so it is turned on once;
      // anyone who wants it off can still switch it off, and that choice stays.
      if (!saved.torDefaultOn && !this.dev.tronHost) { this.settings.torEnabled = true; this.settings.torDefaultOn = true; await fs.writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), { mode: 0o600 }).catch(() => undefined); }
    } catch { /* first run */ }
    this.settings.network = 'mainnet'; // The app is mainnet only, including for older settings files.
    await this.tor.loadInstalledVersion();
    this.activate((await this.walletRegistry()).active);
  }

  // ---- several wallets: each has its own seed, password and records. Settings and Tor are shared. ----

  get activeWallet(): string { return this.walletId; }

  protected get registryPath() { return path.join(this.baseDir, 'wallets.json'); }

  protected walletDir(id: string) { return id === 'main' ? this.baseDir : path.join(this.baseDir, 'wallets', id); }

  protected activate(id: string): void {
    this.walletId = id;
    this.dir = this.walletDir(id);
    this.vault = new Vault(path.join(this.dir, 'vault.json'), this.kdf);
    this.draftSeeds = null;
  }

  protected async walletRegistry(): Promise<{ active: string; list: { id: string; name: string }[] }> {
    try {
      const r = JSON.parse(await fs.readFile(this.registryPath, 'utf8') as unknown as string);
      if (Array.isArray(r.list) && r.list.length && r.list.some((w: any) => w.id === r.active)) return r;
    } catch { /* first run: the wallet made before this feature, if any, is the first one */ }
    return { active: 'main', list: [{ id: 'main', name: 'My wallet' }] };
  }

  protected async walletRegistrySave(r: { active: string; list: { id: string; name: string }[] }): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(this.registryPath, JSON.stringify(r), { mode: 0o600 });
  }

  protected static walletName(input: string): string {
    const name = String(input).trim();
    if (!name || [...name].length > 20) throw new Error('Wallet names can be 1 to 20 characters.');
    return name;
  }

  async walletsList() {
    const r = await this.walletRegistry();
    return { active: this.pendingAdd ? this.pendingAdd.previous : r.active, list: r.list, adding: Boolean(this.pendingAdd) };
  }

  async walletRename(id: string, input: string): Promise<void> {
    const name = ServiceCore.walletName(input);
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
    const name = ServiceCore.walletName(input);
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

  protected async commitPendingWallet(): Promise<void> {
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

  protected newSecrets(tronMnemonic: string, moneroSeed: string, heights: Secrets['restoreHeights']): Secrets {
    return {
      tronMnemonic, moneroSeed,
      moneroFilePasswords: { mainnet: randomBytes(32).toString('hex'), testnet: randomBytes(32).toString('hex') },
      restoreHeights: heights,
    };
  }

  /** Commits the generated seeds once the user has confirmed the backup. */
  async finishCreate(password: string, passphrase = ''): Promise<void> {
    if (!this.draftSeeds) throw new Error('Create the seeds first.');
    checkPassphrase(passphrase);
    if (await this.vault.exists()) throw new Error('A wallet already exists.');
    // Nothing can have been sent to a brand new seed before today, so start near the tip.
    const heights = { mainnet: Math.max(0, estimateMainnetHeight(new Date()) - 5040), testnet: -1 };
    const secrets = this.newSecrets(this.draftSeeds.tronMnemonic, this.draftSeeds.moneroSeed, heights);
    if (passphrase) secrets.passphrase = passphrase;
    await this.vault.save(password, secrets);
    await this.commitPendingWallet();
    this.draftSeeds = null;
    await this.writeEvmLayout(true);
    // A new wallet syncs Bitcoin privately from the start: there are only days of filters to fetch.
    this.newBtcSync = { filters: true, birthday: btcBirthdayFor(new Date()), from: new Date().toISOString().slice(0, 10) };
    await this.startSession(secrets);
    this.keepHiddenSlot();
  }

  /** restoreFrom: a block height, a YYYY-MM-DD date, or empty for a full scan. */
  async restore(password: string, tronMnemonic: string, moneroSeed: string, restoreFrom: string, passphrase = ''): Promise<void> {
    if (await this.vault.exists()) throw new Error('A wallet already exists.');
    checkPassphrase(passphrase);
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
    if (passphrase) secrets.passphrase = passphrase;
    // A Monero block height says nothing about Zcash, so only a date carries over.
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      secrets.zecBirthday = zecHeightForDate(new Date(from + 'T00:00:00Z'));
      secrets.restoreDate = from;
      // Recent enough that the filters since then are a modest download: private sync from the start.
      const date = new Date(from + 'T00:00:00Z');
      if (Date.now() - date.getTime() < 92 * 24 * 3600_000) this.newBtcSync = { filters: true, birthday: btcBirthdayFor(date), from };
    }
    await this.vault.save(password, secrets);
    await this.commitPendingWallet();
    await this.startSession(secrets);
    this.keepHiddenSlot();
  }

  // ---- session ----

  protected moneroNodes(): string[] {
    const custom = this.settings.customMoneroNode.trim();
    if (custom) return [custom];
    const monero = NETWORKS[this.settings.network].monero;
    // Plain HTTP through a Tor exit could be read or altered there, so Tor mode uses onion nodes only.
    return this.torActive ? monero.onionNodes : monero.nodes;
  }

  protected async startSession(secrets: Secrets): Promise<void> {
    await this.closing;
    // Every key from the 12 words is made with the passphrase from here on (see seed.ts).
    setPassphrase(secrets.tronMnemonic, secrets.passphrase);
    this.settings.passphrase = Boolean(secrets.passphrase);
    await this.loadSavedBalances(secrets.tronMnemonic);
    this.priceAgent = undefined;
    this.pricesTorAgent = undefined;
    this.torProxy = undefined;
    this.routes.clear();
    let proxyUri: string | undefined;
    this.torActive = this.settings.torEnabled;
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
    if (this.torActive) {
      this.applyBridge();
      // Tor is on by default, so the first unlock on a computer fetches it (checked as when installed by hand).
      // Nothing goes out without it meanwhile: balances wait, as while Tor connects.
      if (this.dev.nativeTor || this.tor.isInstalled()) this.tor.start();
      else {
        const gen = this.sessionGen;
        void this.tor.install((message) => this.emit('tor-install', message))
          .then(() => { if (gen === this.sessionGen && this.torActive) this.tor.start(); })
          .catch((e) => { if (gen === this.sessionGen) this.tor.reportError(`Could not install Tor: ${(e as Error).message}`); });
      }
    }
    const net = NETWORKS[this.settings.network];
    const account = deriveTronAccount(secrets.tronMnemonic);
    const route = this.dev.route ?? ((u: string) => u);
    const tronNet = this.dev.tronHost
      ? { ...net.tron, host: route(this.dev.tronHost), backup: undefined, usdt: NETWORKS.mainnet.tron.usdt }
      : this.own('TRX') ? { ...net.tron, host: this.own('TRX'), backup: undefined }
      : { ...net.tron, host: route(net.tron.host), backup: net.tron.backup ? route(net.tron.backup) : undefined };
    this.tron = new TronClient(tronNet, this.settings.tronApiKey, account.address, this.ownAgent('TRX', 'tron'), this.torActive);

    const slow = this.torActive;
    // A server of the person's own is the only one asked: no public server learns the addresses then. One on
    // their own network is reached directly, since Tor can't reach it and nothing leaves the network.
    const ownBtc = (this.settings.customBtcServer ?? '').trim();
    const btcApis = this.dev.btcApi ? [this.dev.btcApi] : ownBtc ? [ownBtc] : this.torActive ? [...BTC_ONION_APIS, ...BTC_APIS] : BTC_APIS;
    const btcAgent = ownBtc && isLocalServer(ownBtc) ? undefined : this.torRoute('btc');
    if (this.newBtcSync) { await this.writeBtcSync(this.newBtcSync).catch(() => undefined); this.newBtcSync = null; }
    const btcSync = await this.readBtcSync();
    this.settings.btcFilters = btcSync.filters;
    this.settings.btcFiltersFrom = btcSync.filters || btcSync.birthday ? btcSync.from : undefined;
    this.btcFilters?.close();
    this.btcFilters = null;
    // Filters come from onion nodes, so they need Tor; a server of one's own is asked instead when set.
    if (btcSync.filters && this.torActive && this.torProxy && !ownBtc && !this.dev.btcApi) {
      this.btcFilters = new FilterSync({
        dir: this.dir, records: this.records, dial: tcpDial(this.torProxy, 60_000), birthday: btcSync.birthday,
        onProgress: () => this.emit('btc-sync'),
      });
    }
    this.btc = new BtcClient(btcAccountXpub(secrets.tronMnemonic), btcApis, btcAgent, slow ? 60_000 : 30_000, BITCOIN, () => newTorRoute(btcAgent));
    if (this.btcFilters) this.btc.useFilters(this.btcFilters, 'btc');
    // Own sends, kept (encrypted) so a stuck one can be sped up later.
    const sentFile = path.join(this.dir, 'btc-sent.json');
    this.btc.loadSent(await this.records.read(sentFile).catch(() => undefined));
    this.btc.onSent = (list) => { void this.records.write(sentFile, list).catch(() => undefined); };
    if (this.dev.btcApi) this.btc.spacingMs = 0;
    const scanFile = path.join(this.dir, 'btc-scan.json');
    try { const h = await this.records.read(scanFile); if (h) this.btc.importHints(h); } catch { /* damaged: scanned afresh */ }
    this.btc.onHints = (hints) => { void this.records.write(scanFile, hints).catch(() => undefined); };
    if (!this.torNotReady) void this.btc.refresh().catch(() => undefined);
    // Its own Tor route, so the server can't tie the CoinJoin account's addresses to the regular ones.
    const mixedAgent = ownBtc && isLocalServer(ownBtc) ? undefined : this.torRoute('btc-mixed');
    this.btcMixed = new BtcClient(btcAccountXpub(secrets.tronMnemonic, BTC_MIXED_PATH), btcApis, mixedAgent, slow ? 60_000 : 30_000, BITCOIN_MIXED, () => newTorRoute(mixedAgent));
    if (this.btcFilters) this.btcMixed.useFilters(this.btcFilters, 'btc-mixed');
    const mixedSentFile = path.join(this.dir, 'btc-mixed-sent.json');
    this.btcMixed.loadSent(await this.records.read(mixedSentFile).catch(() => undefined));
    this.btcMixed.onSent = (list) => { void this.records.write(mixedSentFile, list).catch(() => undefined); };
    await this.afterBtcReady().catch(() => undefined);
    if (this.dev.btcApi) this.btcMixed.spacingMs = 0;
    const mixedScanFile = path.join(this.dir, 'btc-mixed-scan.json');
    try { const h = await this.records.read(mixedScanFile); if (h) this.btcMixed.importHints(h); } catch { /* damaged: scanned afresh */ }
    this.btcMixed.onHints = (hints) => { void this.records.write(mixedScanFile, hints).catch(() => undefined); };
    if (!this.torNotReady) void this.btcMixed.refresh().catch(() => undefined);
    this.startBtcMixer();
    this.ltc = new BtcClient(ltcAccountXpub(secrets.tronMnemonic), this.dev.ltcApi ? [this.dev.ltcApi] : this.ownList('LTC', LTC_APIS), this.ownAgent('LTC', 'ltc'), slow ? 60_000 : 30_000, LITECOIN);
    if (!ownBtc || !isLocalServer(ownBtc)) { this.btc.lookupRoutes = this.lookupRoutes('btc'); this.btcMixed.lookupRoutes = this.lookupRoutes('btc-mixed'); }
    this.ltc.lookupRoutes = this.lookupRoutes('ltc');
    if (this.dev.ltcApi) this.ltc.spacingMs = 0;
    this.scrt = new ScrtClient(scrtPublicKey(secrets.tronMnemonic), this.dev.scrtLcd ? this.dev.scrtLcd.split(',') : this.ownList('SCRT', SCRT_LCDS), this.ownAgent('SCRT', 'scrt'), slow ? 60_000 : 20_000, scrtPrivacyKeys(secrets.tronMnemonic));
    this.firo = new FiroClient(firoAccountXpub(secrets.tronMnemonic), this.dev.firoApi ? [this.dev.firoApi] : this.ownList('FIRO', FIRO_APIS), this.ownAgent('FIRO', 'firo'), slow ? 60_000 : 20_000);
    this.doge = new DogeClient(dogeAccountXpub(secrets.tronMnemonic), this.dev.dogeApi ? [this.dev.dogeApi] : DOGE_APIS, this.torRoute('doge'), slow ? 60_000 : 20_000, this.dev.dogeApi ? (this.dev.dogeBackup ? { backup: this.dev.dogeBackup } : {}) : { pushUrls: DOGE_PUSH_URLS, backup: DOGE_BACKUP, rawUrls: DOGE_RAW_URLS });
    this.ada = new AdaClient(adaAddress(secrets.tronMnemonic), this.dev.adaApi ?? (this.own('ADA') || ADA_API), this.ownAgent('ADA', 'ada'), slow ? 60_000 : 20_000);
    this.bch = new BchClient(bchAccountXpub(secrets.tronMnemonic), this.dev.bchApi ? [this.dev.bchApi] : this.ownList('BCH', BCH_APIS), this.ownAgent('BCH', 'bch'), slow ? 60_000 : 20_000);
    this.sol = new SolClient(solAddress(secrets.tronMnemonic), this.dev.solRpc ? [this.dev.solRpc] : this.ownList('SOL', SOL_RPCS), this.ownAgent('SOL', 'sol'), slow ? 60_000 : 20_000);
    this.dash = new DashClient(dashAccountXpub(secrets.tronMnemonic), this.dev.dashApi ? [this.dev.dashApi] : this.ownList('DASH', DASH_APIS), this.ownAgent('DASH', 'dash'), slow ? 60_000 : 20_000);
    this.startMixer(secrets, slow);
    this.eth = new EthClient(this.dev.ethRpc ? [this.dev.ethRpc] : this.ownList('ETH', ETH_RPCS), this.dev.ethScout ?? ETH_SCOUT, ETH_USDT, deriveEthAccount(secrets.tronMnemonic).address, this.ownAgent('ETH', 'eth'), slow ? 60_000 : 15_000);
    this.evmSplit = await this.readEvmLayout();
    this.settings.evmSeparate = this.evmSplit;
    this.settings.developer = DEVELOPER_BUILD;
    this.pol = new EthClient(this.dev.polRpc ? [this.dev.polRpc] : this.ownList('POL', POL_RPCS), this.dev.polScout ?? POL_SCOUT, this.dev.polUsdt ?? '', deriveEthAccount(secrets.tronMnemonic, this.evmIndex(POLYGON.id)).address, this.ownAgent('POL', 'pol'), slow ? 60_000 : 15_000, POLYGON);
    this.arb = new EthClient(this.dev.arbRpc ? [this.dev.arbRpc] : this.ownList('ARB', ARB_RPCS), this.dev.arbScout ?? ARB_SCOUT, this.dev.arbUsdt ?? '', deriveEthAccount(secrets.tronMnemonic, this.evmIndex(ARBITRUM.id)).address, this.ownAgent('ARB', 'arb'), slow ? 60_000 : 15_000, ARBITRUM);
    this.bsc = new EthClient(this.dev.bscRpc ? [this.dev.bscRpc] : this.ownList('BSC', BSC_RPCS), this.dev.bscScout ?? BSC_SCOUT, '', deriveEthAccount(secrets.tronMnemonic, this.evmIndex(BSC.id)).address, this.ownAgent('BSC', 'bsc'), slow ? 60_000 : 15_000, BSC);
    // WalletConnect wallets are gone: one made before opens as a maximum-privacy wallet, same seed, same addresses.
    void fs.rm(path.join(this.dir, 'mode.json'), { force: true }).catch(() => undefined);
    void fs.rm(path.join(this.dir, 'walletconnect.json'), { force: true }).catch(() => undefined);
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
    // The privacy engines start side by side and in the background: unlocking no longer waits for each in turn,
    // and each balance fills in when its engine is up.
    const gen = this.viewGen;
    this.enginesStarting = Promise.allSettled([this.startZec(secrets), this.startZano(secrets), this.startKsr(secrets), this.startArrr(secrets), this.startMweb(secrets), this.startSpark(secrets)])
      .then(() => { if (gen === this.viewGen) this.emit('balance-changed'); });
    if (this.dev.tronHost) await this.enginesStarting; // tests expect them up when unlocking returns
  }
  /** The engines' start, for anything that needs them up (tests, a send right after unlocking). */
  protected enginesStarting: Promise<void> = Promise.resolve();

  /**
   * Dash CoinJoin: mixing runs by itself while the wallet is unlocked, for wallets that have split coins into it.
   * With Tor on, the masternode connections go through Tor too, never directly.
   */
  /** Bitcoin CoinJoin. It only runs after "Mix BTC" with the password, and stops when the wallet locks. */
  protected startBtcMixer(): void {
    const btc = this.btc!, mixed = this.btcMixed!;
    const mixer = new BtcMixer({
      dir: this.dir, records: this.records,
      coordinator: () => this.dev.coinjoinCoordinator ?? this.settings.coinjoinCoordinator ?? COINJOIN_COORDINATORS[0].url,
      newAgent: () => { if (!this.torProxy) return undefined; const a = socksAgent(this.torProxy); newTorRoute(a); return a; },
      coins: async () => (await btc.coins()).filter((u) => u.confirmed).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, script: btcScript(u.address) })),
      mixedCoins: async () => (await mixed.coins()).filter((u) => u.confirmed).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, script: btcScript(u.address), chain: u.chain, index: u.index })),
      firstUnused: () => mixed.nextReceiveIndex,
      maxFeePerK: async () => { const r = await btc.feeRate().catch(() => 10n); const k = (r * 2n > 5n ? r * 2n : 5n) * 1000n; return k > 50_000n ? 50_000n : k; },
      canConnect: () => this.torActive && !this.torNotReady,
      onMixed: () => { void btc.refresh(true).catch(() => undefined); void mixed.refresh(true).catch(() => undefined); this.emit('balance-changed'); },
      ...(this.dev.coinjoinTest ? { extra: this.dev.coinjoinTest } : {}),
    });
    mixer.onChange = () => this.emit('balance-changed');
    this.btcMixer = mixer;
  }

  /** What "Mix BTC" would mix: the chosen coins, or every regular coin that isn't frozen, largest first. */
  async btcMixInfo(coins?: string[]) {
    const { btc } = this.session();
    if (!this.btcMixer) throw new Error('CoinJoin is not available.');
    const frozen = new Set((await this.btcCoinNotes()).frozen);
    const all = (await btc.coins()).filter((u) => u.confirmed && u.value >= 5000n);
    const chosen = coins?.length ? all.filter((u) => coins.includes(coinId(u))) : all.filter((u) => !frozen.has(coinId(u)));
    const use = chosen.sort((a, b) => (b.value > a.value ? 1 : -1));
    const coordinator = this.settings.coinjoinCoordinator || COINJOIN_COORDINATORS[0].url;
    const target = this.settings.coinjoinTarget ?? DEFAULT_MIX_TARGET;
    // Mixed coins not hidden among enough others yet go round again.
    const again = target > 1 && this.btcMixed ? await this.btcMixer.toRemix((await this.btcMixed.coins()).filter((u) => u.confirmed).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, script: new Uint8Array(), chain: u.chain, index: u.index })), target) : [];
    return {
      remix: again.length, remixAmount: formatAmount(again.reduce((s2, u) => s2 + u.value, 0n), 8), target,
      coins: use.map((u) => coinId(u)), count: use.length, perRound: MAX_COINS_PER_ROUND,
      amount: formatAmount(use.reduce((s, u) => s + u.value, 0n), 8),
      coordinator: COINJOIN_COORDINATORS.find((c) => c.url === coordinator)?.name ?? coordinator,
      tor: this.torActive,
    };
  }

  /** Starts mixing. The password unlocks the keys of just these coins, held only while mixing runs. */
  async btcMixStart(password: string, coins?: string[]): Promise<{ ok: true }> {
    const { btc } = this.session();
    if (!this.btcMixer) throw new Error('CoinJoin is not available.');
    if (!this.torActive) throw new Error('CoinJoin needs Tor. Turn it on in Settings first.');
    if (this.btcMixer.status.running) throw new Error('Mixing is already running.');
    const info = await this.btcMixInfo(coins);
    if (!info.count && !info.remix) throw new Error('No confirmed BTC to mix. Coins need 1 confirmation, at least 0.00005 BTC, and not frozen.');
    const secrets = await this.vault.open(password);
    const { HDKey } = require('@scure/bip32');
    const root = HDKey.fromMasterSeed(bip39Seed(secrets.tronMnemonic));
    const account = root.derive(BTC_PATH);
    const coinKeys = new Map<string, Uint8Array>();
    for (const u of await btc.coins()) {
      if (!info.coins.includes(coinId(u))) continue;
      const k = account.deriveChild(u.chain).deriveChild(u.index);
      if (btcScriptOfKey(k.publicKey) !== Buffer.from(btcScript(u.address)).toString('hex')) throw new Error('A coin does not match this wallet\'s keys, so mixing was stopped.');
      coinKeys.set(coinId(u), Uint8Array.from(k.privateKey));
    }
    const mixedPrivate = root.derive(BTC_MIXED_PATH);
    const mixedAccount = HDKey.fromExtendedKey(mixedPrivate.publicExtendedKey);
    await this.btcMixer.start({ coinKeys, idKey: identificationKey(root.privateKey), mixedAccount, mixedPrivate: info.target > 1 ? mixedPrivate : undefined, target: info.target });
    return { ok: true };
  }

  async btcMixStop(): Promise<void> {
    this.session();
    this.btcMixer?.stop();
  }

  protected startMixer(secrets: Secrets, slow: boolean): void {
    const devConnect = this.dev.dashConnect?.match(/^(.+):(\d+)$/);
    const real = tcpDial(this.torProxy);
    const dial = devConnect ? (_h: string, _p: number) => real(devConnect[1], Number(devConnect[2])) : real;
    const mixer = new DashMixer({
      apis: this.dev.dashApi ? [this.dev.dashApi] : DASH_APIS, agent: this.torRoute('dash-mix'), timeoutMs: slow ? 60_000 : 20_000,
      dir: this.dir, records: this.records, dial, seeds: this.dev.dashSeeds,
    }, DashMixer.account(secrets.tronMnemonic));
    this.mixer = mixer;
    void (async () => {
      if (!(await mixer.used().catch(() => false)) || (await mixer.paused())) return;
      // Wait for Tor before the first connection; the mixer itself retries on failure.
      for (let i = 0; i < 120 && this.torNotReady && this.mixer === mixer; i++) await new Promise((r) => setTimeout(r, 5_000));
      if (this.mixer === mixer) mixer.start();
    })();
  }

  /** Firo Spark: the engine syncs the anonymity sets itself. Without it, FIRO is transparent only. */
  protected async startSpark(secrets: Secrets): Promise<void> {
    const gen = this.sessionGen;
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
    if (gen !== this.sessionGen) return; // locked while waiting for Tor
    this.spark = client;
    try { await client.start(); } catch (e) { client.lastError = (e as Error).message; }
    if (gen !== this.sessionGen) void Promise.resolve(client.close()).catch(() => undefined); // locked while it started
  }

  /** Litecoin MWEB: a light client of its own. Without its engine, LTC simply has no private balance. */
  protected async startMweb(secrets: Secrets): Promise<void> {
    const gen = this.sessionGen;
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
    if (gen !== this.sessionGen) return; // locked while waiting for Tor
    this.mweb = client;
    try { await client.start(); } catch (e) { client.lastError = (e as Error).message; }
    if (gen !== this.sessionGen) void Promise.resolve(client.close()).catch(() => undefined); // locked while it started
  }

  protected get arrrAvailable(): boolean { return arrrEngineAvailable(this.dev.arrrBin); }

  protected async startArrr(secrets: Secrets): Promise<void> {
    const gen = this.sessionGen;
    // Its engine makes keys from the 12 words without a passphrase, so a wallet with one leaves it off.
    if (secrets.passphrase) return;
    if (!this.arrrAvailable) return;
    // A lightwalletd on one's own network is reached directly: Tor can't reach it.
    const torPort = this.torActive && !isLocalServer(this.own('ARRR')) ? (await this.tor.isolated('arrr')) || undefined : undefined; // its own gate: a fresh route per send
    if (this.torActive && !torPort) return; // Never fall back to a direct connection.
    const client = new ArrrClient({
      engine: () => startArrrEngine(this.dev.arrrBin),
      dir: this.dir,
      secret: secrets.moneroFilePasswords.mainnet,
      servers: this.dev.arrrServers ?? this.ownList('ARRR', ARRR_SERVERS),
      socks: torPort,
      canConnect: () => !this.torNotReady,
      onChange: () => this.emit('balance-changed'),
    }, secrets.tronMnemonic, secrets.restoreDate);
    if (gen !== this.sessionGen) return; // locked while waiting for Tor
    this.arrr = client;
    try { await client.start(); } catch (e) { client.lastError = (e as Error).message; }
    if (gen !== this.sessionGen) void Promise.resolve(client.stop()).catch(() => undefined); // locked while it started
  }

  protected get zanoAvailable(): boolean { return zanoEngineAvailable(this.dev.zanoBin); }

  protected async startZano(secrets: Secrets): Promise<void> {
    const gen = this.sessionGen;
    if (!this.zanoAvailable) return;
    const torPort = this.torActive ? (await this.tor.isolated('zano')) || undefined : undefined; // its own gate: a fresh route per send
    if (this.torActive && !torPort) return; // Never fall back to a direct connection.
    const client = new ZanoClient({
      engine: () => startZanoEngine(this.dev.zanoBin, this.dir),
      node: this.dev.zanoNode ?? ((this.settings.customZanoNode ?? '').trim() || ZANO_NODE),
      socks: torPort,
      canConnect: () => !this.torNotReady,
      onChange: () => this.emit('balance-changed'),
    }, zanoKeys(secrets.tronMnemonic, secrets.moneroFilePasswords.mainnet));
    if (gen !== this.sessionGen) return; // locked while waiting for Tor
    this.zano = client;
    try { await client.start(); } catch (e) { client.lastError = (e as Error).message; }
    if (gen !== this.sessionGen) void Promise.resolve(client.stop()).catch(() => undefined); // locked while it started
  }

  /** KSR isn't launched: only the developer build (and the tests' stand-in engine) runs it. */
  protected get ksrAvailable(): boolean { return (DEVELOPER_BUILD || Boolean(this.dev.ksrBin)) && ksrEngineAvailable(this.dev.ksrBin); }

  /** The node KSR uses: the person's own, or the public one (none until the chain launches). */
  protected get ksrNode(): string { return this.dev.ksrNode ?? ((this.settings.customKsrNode ?? '').trim() || KSR_NODE); }

  /**
   * Kusari, on the Zano client: its own engine, its own key (a label of its own, so a K... address can't be tied to
   * this seed's Zano address), wallet file and password, and its own Tor route. No fallback to a direct connection.
   */
  protected async startKsr(secrets: Secrets): Promise<void> {
    const gen = this.sessionGen;
    // The developer build shows KSR before there is any node: the wallet, its address and the screens work, and
    // the balance says no node is set. Until one is, the engine is pointed at a local port that refuses (through Tor,
    // Tor refuses it), so nothing goes anywhere.
    const node = this.ksrNode || (DEVELOPER_BUILD ? KSR_NO_NODE : '');
    if (!this.ksrAvailable || !node) return;
    const torPort = this.torActive ? (await this.tor.isolated('ksr')) || undefined : undefined; // its own gate: a fresh route per send
    if (this.torActive && !torPort) return; // Never fall back to a direct connection.
    const client = new ZanoClient({
      engine: () => startKsrEngine(this.dev.ksrBin, this.dir),
      node,
      socks: torPort,
      canConnect: () => !this.torNotReady,
      onChange: () => this.emit('balance-changed'),
      chain: KSR_CHAIN,
    }, ksrKeys(secrets.tronMnemonic, secrets.moneroFilePasswords.mainnet));
    if (gen !== this.sessionGen) return; // locked while waiting for Tor
    this.ksr = client;
    try { await client.start(); } catch (e) { client.lastError = (e as Error).message; }
    if (gen !== this.sessionGen) void Promise.resolve(client.stop()).catch(() => undefined); // locked while it started
  }

  protected get zecAvailable(): boolean { return zecEngineAvailable(this.dev.zecBin); }

  /** Every other coin works without this, so a problem here stays on the Zcash row. */
  protected async startZec(secrets: Secrets): Promise<void> {
    const gen = this.sessionGen;
    // Its engine makes keys from the 12 words without a passphrase, so a wallet with one leaves it off.
    if (secrets.passphrase) return;
    if (!this.zecAvailable) return;
    const torPort = this.torActive && !isLocalServer(this.own('ZEC')) ? (await this.tor.isolated('zec')) || undefined : undefined; // its own gate: a fresh route per send
    if (this.torActive && !torPort) return; // Never fall back to a direct connection.
    const client = new ZecClient({
      engine: () => startZecEngine(this.dev.zecBin),
      dir: this.dir,
      secret: secrets.moneroFilePasswords.mainnet,
      servers: this.dev.zecServers ?? this.ownList('ZEC', ZEC_SERVERS),
      socks: torPort,
      canConnect: () => !this.torNotReady,
      onChange: () => this.emit('balance-changed'),
    }, secrets.tronMnemonic, secrets.zecBirthday);
    if (gen !== this.sessionGen) return; // locked while waiting for Tor
    this.zec = client;
    try { await client.start(); } catch (e) { client.lastError = (e as Error).message; }
    if (gen !== this.sessionGen) void Promise.resolve(client.stop()).catch(() => undefined); // locked while it started
  }

  async unlock(password: string): Promise<void> {
    if (this.tron && this.monero) return;
    let secrets: Secrets;
    const decoyId = await this.duressId();
    if (decoyId) {
      // Both are tried at once, so the time it takes doesn't tell which password was given.
      const decoy = new Vault(path.join(this.walletDir(decoyId), 'vault.json'), this.kdf);
      const [real, fake] = await Promise.allSettled([this.vault.open(password), decoy.open(password)]);
      if (real.status === 'fulfilled') secrets = real.value;
      else if (fake.status === 'fulfilled') {
        // The duress password: the decoy wallet opens in this wallet's place, under its name.
        secrets = fake.value;
        this.duressOf = this.walletId;
        this.dir = this.walletDir(decoyId);
        this.vault = decoy;
      } else throw real.reason;
    } else secrets = await this.vault.open(password);
    if (this.tron) await this.lock(); // a start that failed half way
    try {
      await this.startSession(secrets);
      this.emit('unlocked');
      this.keepHiddenSlot();
    } catch (e) {
      // Nothing half started stays behind: the next try starts clean.
      await this.lock().catch(() => undefined);
      throw e;
    }
  }

  async lock(): Promise<void> {
    this.sessionGen++;
    if (this.balanceSaveTimer) await this.saveBalancesNow();
    this.balanceKey?.fill(0);
    this.balanceKey = null;
    if (this.recordKey) {
      this.recordKey.fill(0); // anything still holding the records object now writes nothing
      this.recordKey = null;
      this.records = lockedRecords;
    }
    this.savedBalances = new Map();
    this.torActive = false;
    this.previews.clear();
    this.pendingSwaps.clear();
    this.balanceMemo.clear();
    this.forgetViews();
    this.balanceRetryAt.clear();
    this.lookupFailures.length = 0;
    this.balanceFails.clear();
    this.routes.clear();
    this.lastLookupError.clear();
    this.tron = null;
    this.btc = null;
    this.btcFilters?.close();
    this.btcFilters = null;
    this.btcMixer?.stop();
    this.btcMixer = null;
    this.btcMixed = null;
    this.ltc = null;
    this.scrt = null;
    this.eth = null;
    this.pol = null;
    this.arb = null;
    this.bsc = null;
    this.dash = null;
    this.mixer?.stop();
    this.mixer = null;
    this.firo = null;
    this.doge = null;
    this.ada = null;
    this.bch = null;
    this.sol = null;
    // Engines stop in the background; deleting a wallet waits for them, since they hold its files open.
    const starting = this.enginesStarting;
    this.engineStops = Promise.allSettled([this.zec?.stop(), this.zano?.stop(), this.ksr?.stop(), this.arrr?.stop(), starting]).then(() => undefined);
    this.zec = null;
    this.zano = null;
    this.ksr = null;
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
    clearPassphrases();
    this.onLock();
    // Back from a decoy session: the next unlock starts from the real wallet again.
    if (this.duressOf) { const id = this.duressOf; this.duressOf = null; this.activate(id); }
  }

  /** Hooks for the layers above: Bitcoin is set up (delayed sends come back), the wallet locked. */
  protected async afterBtcReady(): Promise<void> {}
  protected onLock(): void {}

  // ---- duress password ----

  /**
   * A second password that opens a decoy wallet (its own seed, made here) in place of this one, for when someone
   * forces the wallet open. The real wallet's files are never touched from a decoy session.
   *
   * Every wallet keeps a hidden wallet beside it, whether a duress password is set or not: when none is, it is one
   * nobody can open (its password is random and kept nowhere). So the files look the same either way, and every
   * unlock tries two vaults, which takes the same time either way. Whether one is set is in the wallet's sealed
   * records.
   */
  protected duressOf: string | null = null;
  /** The hidden wallet being made in the background after an unlock, for tests to wait on. */
  slotting: Promise<void> | null = null;
  protected async duressId(dir = this.dir): Promise<string | null> {
    try {
      const j = JSON.parse(String(await fs.readFile(path.join(dir, 'duress.json'), 'utf8')));
      return typeof j?.id === 'string' && /^[0-9a-f]{16}$/.test(j.id) ? j.id : null;
    } catch { return null; }
  }
  protected get duressStatePath(): string { return path.join(this.dir, 'duress-state.json'); }

  async duressStatus(): Promise<{ set: boolean }> {
    this.session();
    // In a decoy session, the decoy has none of its own: it looks like a wallet without one.
    if (this.duressOf) return { set: false };
    const j = await this.records.read(this.duressStatePath).catch(() => undefined);
    return { set: j?.set === true };
  }

  /** A hidden wallet that opens with `password`, set up like any new wallet. Returns its ID. */
  protected async makeHidden(password: string, decoy: boolean): Promise<string> {
    const id = randomBytes(8).toString('hex');
    const dir = this.walletDir(id);
    const tronMnemonic = generateTronMnemonic();
    // One nobody can open needs no working Monero seed (making one starts the Monero engine): words of the same kind.
    const moneroSeed = decoy ? await generateMoneroSeed('mainnet') : Array.from({ length: 25 }, () => BIP39_WORDS[randomBytes(2).readUInt16BE(0) % 2048]).join(' ');
    const secrets = this.newSecrets(tronMnemonic, moneroSeed, { mainnet: Math.max(0, estimateMainnetHeight(new Date()) - 5040), testnet: -1 });
    await fs.mkdir(dir, { recursive: true });
    await new Vault(path.join(dir, 'vault.json'), this.kdf).save(password, secrets);
    await fs.writeFile(path.join(dir, 'evm-layout.json'), JSON.stringify({ split: true }), { mode: 0o600 });
    await sealedRecords(recordsKey(tronMnemonic)).write(path.join(dir, 'btc-sync.json'), { filters: true, birthday: btcBirthdayFor(new Date()), from: new Date().toISOString().slice(0, 10) });
    return id;
  }

  protected async placeHidden(password: string, decoy: boolean): Promise<void> {
    const dir = this.dir;
    const id = await this.makeHidden(password, decoy);
    if (this.dir !== dir) { await fs.rm(this.walletDir(id), { recursive: true, force: true }).catch(() => undefined); return; } // switched away meanwhile
    await this.duressDrop();
    await fs.writeFile(path.join(dir, 'duress.json'), JSON.stringify({ id }), { mode: 0o600 });
    await this.records.write(path.join(dir, 'duress-state.json'), { set: decoy });
  }

  /** After the real wallet opens: a wallet from before this, or whose decoy was deleted, gets its hidden wallet. */
  protected keepHiddenSlot(): void {
    if (this.duressOf || this.slotting) return;
    const dir = this.dir;
    this.slotting = (async () => {
      if (await this.duressId(dir)) return;
      if (this.dir === dir && !this.duressOf) await this.placeHidden(randomBytes(32).toString('hex'), false);
    })().catch(() => undefined).finally(() => { this.slotting = null; });
  }

  async duressSet(current: string, duress: string): Promise<void> {
    this.session();
    await this.vault.open(current); // the wallet's own password, checked
    if (duress === current) throw new Error('The duress password must be different from your wallet password.');
    if (duress.length < MIN_PASSWORD) throw new Error(`The password must be at least ${MIN_PASSWORD} characters.`);
    await this.slotting;
    await this.placeHidden(duress, true);
  }

  async duressRemove(current: string): Promise<void> {
    this.session();
    await this.vault.open(current);
    await this.slotting;
    await this.placeHidden(randomBytes(32).toString('hex'), false);
  }

  protected async duressDrop(dir = this.dir): Promise<void> {
    const old = await this.duressId(dir);
    if (old) {
      await new Vault(path.join(this.walletDir(old), 'vault.json'), this.kdf).destroy().catch(() => undefined);
      await fs.rm(this.walletDir(old), { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.rm(path.join(dir, 'duress.json'), { force: true }).catch(() => undefined);
  }

  protected session() {
    if (!this.tron || !this.monero || !this.btc || !this.eth || !this.dash || !this.firo) throw new Error('The wallet is locked.');
    return { tron: this.tron, monero: this.monero, btc: this.btc, eth: this.eth, dash: this.dash, firo: this.firo };
  }

  // ---- reads ----

  /** While true, every outside request is bound to fail, so none are made. */
  protected get torNotReady(): boolean { return this.torActive && this.tor.state.phase !== 'ready'; }

  protected friendlyError(e: Error): string {
    return this.torActive && /ECONNREFUSED 127\.0\.0\.1|socks/i.test(e.message) ? 'Not connected to Tor. Balances load once it connects.' : e.message;
  }

  protected balanceMemo = new Map<string, { at: number; total: bigint; spendable: bigint; decimals: number }>();
  protected balanceRetryAt = new Map<string, number>();

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
  protected applyBridge(): void {
    const b = this.settings.torBridge ?? 'auto';
    let custom: string[] = [];
    if (b === 'custom') { try { custom = parseCustomBridges(this.settings.torBridgeLines ?? ''); } catch { custom = []; } }
    this.tor.setBridge(b, custom);
  }

  /** Several Tor routes for one coin's address lookups (see BtcClient.lookupRoutes); none without Tor. */
  protected lookupRoutes(name: string, count = 4): { agent: Agent; renew: () => void }[] {
    if (!this.torActive) return [];
    return Array.from({ length: count }, (_, i) => this.torRoute(`${name}-${i}`)).filter((a): a is NonNullable<typeof a> => Boolean(a)).map((agent) => ({ agent, renew: () => newTorRoute(agent) }));
  }
  protected torRoute(name: string): ReturnType<typeof socksAgent> | undefined {
    if (!this.torProxy) return undefined;
    const agent = socksAgent(this.torProxy);
    newTorRoute(agent);
    this.routes.set(name, agent);
    return agent;
  }

  protected renewTorRoute(key: string): void {
    if (!this.torActive || key === 'XMR') return;
    newTorRoute(this.routes.get(LOOKUP_ROUTE[key]));
    // Coins whose engine reaches its node itself: its gate logs in to Tor anew, so the next connection (the send)
    // goes out on a circuit of its own.
    const engine = ENGINE_GATE[key];
    if (engine) this.tor.renewIsolated(engine);
  }

  protected noteFailure(key: string, startedAt: number, e: Error): void {
    const message = e.message.replace(/https?:\/\/\S+/g, '[link]').replace(/\b[1-9A-HJ-NP-Za-km-z]{25,}\b/g, '[address]').slice(0, 160);
    this.lastLookupError.set(key, message);
    // Everything waiting on one failed lookup hears about it at once. That's still one failure.
    const stamp = `${key} ${message}`;
    if (this.lastNoted?.stamp === stamp && Date.now() - this.lastNoted.at < 1000) return;
    this.lastNoted = { stamp, at: Date.now() };
    this.lookupFailures.push(`${new Date().toISOString()} ${key} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${message}`);
    this.lookupFailures.splice(0, Math.max(0, this.lookupFailures.length - 100));
  }

  /** One lookup per coin at a time: a second look while one is out waits for that one instead of asking again. */
  protected balanceInFlight = new Map<string, { at: number; p: Promise<BalanceView> }>();
  protected readBalance(key: string, fn: () => Promise<[bigint, bigint]>, decimals: number, ttl: number): Promise<BalanceView> {
    const running = this.balanceInFlight.get(key);
    // One that has been out for minutes is stuck somewhere: a fresh look replaces it rather than waiting on it.
    if (running && Date.now() - running.at < STUCK_LOOKUP_MS) return running.p;
    const p = this.readBalanceOnce(key, fn, decimals, ttl).finally(() => { if (this.balanceInFlight.get(key)?.p === p) this.balanceInFlight.delete(key); });
    this.balanceInFlight.set(key, { at: Date.now(), p });
    return p;
  }

  protected async readBalanceOnce(key: string, fn: () => Promise<[bigint, bigint]>, decimals: number, ttl: number): Promise<BalanceView> {
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

  /**
   * Each balance gets a moment; one still loading after that shows its last value (or "loading") and fills in by
   * itself when it arrives, so a slow server never holds up the rest of the screen.
   */
  protected lastViews: BalanceView[] = [];
  /** The last balances, encrypted on disk with a key from the seed: shown at once after an unlock or a restart. */
  protected balanceKey: Uint8Array | null = null;
  protected balancesFile = '';
  protected savedBalances = new Map<string, SavedBalance>();
  protected balanceSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The wallet's records on this device, encrypted while a wallet is unlocked (see records.ts). */
  protected records: Records = plainRecords;
  protected recordKey: Uint8Array | null = null;
  protected async loadSavedBalances(seed: string): Promise<void> {
    this.recordKey = recordsKey(seed);
    this.records = sealedRecords(this.recordKey);
    this.balanceKey = balanceCacheKey(seed);
    this.balancesFile = path.join(this.dir, `balances-${this.settings.network}.enc`);
    this.savedBalances = await readBalanceCache(this.balancesFile, this.balanceKey);
  }
  protected async saveBalancesNow(): Promise<void> {
    if (this.balanceSaveTimer) { clearTimeout(this.balanceSaveTimer); this.balanceSaveTimer = null; }
    if (this.balanceKey && this.balancesFile) await writeBalanceCache(this.balancesFile, this.balanceKey, this.savedBalances).catch(() => undefined);
  }
  /**
   * Fresh balances are remembered; one still loading shows its last remembered value, marked as recent, and so does
   * one that failed while Tor is connected (with Tor down, the screen says so instead).
   */
  protected withSavedBalances(views: Record<string, BalanceView | undefined>): void {
    if (!this.balanceKey) return;
    const now = Date.now();
    const torDown = this.torActive && this.tor.state.phase !== 'ready';
    let changed = false;
    for (const [coin, v] of Object.entries(views)) {
      if (!v) continue;
      const s = this.savedBalances.get(coin);
      if (v.ok && !v.stale) {
        if (!s || s.total !== v.total || s.spendable !== v.spendable || now - s.at > 10 * 60_000) { this.savedBalances.set(coin, { at: now, total: v.total, spendable: v.spendable }); changed = true; }
      } else if (!v.ok && s && now - s.at < SAVED_BALANCE_MAX_AGE_MS && (v.pending || !torDown)) {
        views[coin] = { ok: true, total: s.total, spendable: s.spendable, stale: true };
      }
    }
    if (changed && !this.balanceSaveTimer) this.balanceSaveTimer = setTimeout(() => { this.balanceSaveTimer = null; void this.saveBalancesNow(); }, 3_000);
  }
  protected lateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Counts locks and sends, so a lookup that finishes after one never shows up as current. */
  protected viewGen = 0;
  protected forgetViews(): void { this.viewGen++; this.lastViews = []; this.balanceInFlight.clear(); }
  protected async quickViews(views: Promise<BalanceView>[], waitMs: number): Promise<BalanceView[]> {
    const gen = this.viewGen;
    const lateArrived = () => {
      if (this.lateTimer) return;
      this.lateTimer = setTimeout(() => { this.lateTimer = null; this.emit('balance-changed'); }, 1_000);
    };
    return Promise.all(views.map((p, i) => {
      let late = false;
      const done = p.then((v) => { if (gen !== this.viewGen) return v; this.lastViews[i] = v; if (late) lateArrived(); return v; });
      return Promise.race([done, new Promise<BalanceView>((r) => setTimeout(() => { late = true; r(this.lastViews[i] ?? { ok: false, pending: true, total: '', spendable: '' }); }, waitMs))]);
    }));
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
    const ksr = this.ksr;
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
    const ksrView = (): BalanceView => {
      if (!this.ksrNode) return { ok: false, total: '', spendable: '', error: 'No Kusari node is set yet. KSR has no public network before it launches: add a node in Settings to try it.' };
      const b = ksr?.balance();
      if (b) return { ok: true, total: formatAmount(b[0], 12), spendable: formatAmount(b[1], 12) };
      if (ksr?.lastError && !this.torNotReady) return { ok: false, total: '', spendable: '', error: this.friendlyError(new Error(ksr.lastError)) };
      return { ok: false, pending: true, total: '', spendable: '' };
    };
    const zecView = (): BalanceView => {
      const b = zec?.balance();
      if (b) return { ok: true, total: formatAmount(b[0], 8), spendable: formatAmount(b[1], 8) };
      if (zec?.lastError && !this.torNotReady) return { ok: false, total: '', spendable: '', error: this.friendlyError(new Error(zec.lastError)) };
      return { ok: false, pending: true, total: '', spendable: '' };
    };
    const [BTC, XMR, ETH, TRX, USDTE, USDT, SOL, USDTS, LINK, WLD, POL, USDTP, ARB, ETHA, USDTA, BCH, LTC, DOGE, ADA, DASH, FIRO, SCRT, SSCRT, ...EXTRA] = await this.quickViews([
      // BTC is the regular coins plus the CoinJoin account's.
      Promise.all([btcSettle(), this.btcMixed ? this.btcMixed.getBalance().catch(() => null) : null]).then(([view, m]) => {
        this.btcMixedBalance = m ?? this.btcMixedBalance;
        if (!view.ok || !this.btcMixedBalance) return view;
        const units = (v: string) => (/^0(\.0*)?$/.test(v) ? 0n : parseAmount(v, 8));
        return { ...view, total: formatAmount(units(view.total) + this.btcMixedBalance.total, 8), spendable: formatAmount(units(view.spendable) + this.btcMixedBalance.spendable, 8) };
      }),
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
      settle('ADA', async () => { const b = await this.ada!.getBalance(); return [b.total, b.spendable]; }, 6),
      settle('DASH', async () => {
        const b = await dash.getBalance();
        // CoinJoin coins count toward the balance; they're spent through a private send, not a regular one.
        await this.mixer?.refreshIfStale().catch(() => undefined);
        return [b.total + (this.mixer?.balance().total ?? 0n), b.spendable];
      }, 8),
      // FIRO is the public coins plus the private (Spark) ones, once Spark has synced.
      settle('FIRO', async () => { const b = await firo.getBalance(); const p = this.spark?.balance(); return [b.total + (p?.total ?? 0n), b.spendable + (p?.spendable ?? 0n)]; }, 8),
      settle('SCRT', async () => { const b = await this.scrt!.getBalance(); return [b, b]; }, 6),
      // Until the viewing key is set on the contract, the private balance can't be read; the sSCRT screen offers to set it.
      settle('SSCRT', async () => { const b = await this.scrt!.getPrivateBalance(); this.sscrtNeedsKey = b === null; return [b ?? 0n, b ?? 0n]; }, 6),
      // Added later: every further token, on its chain's client. Keep in step with EXTRA_ASSETS.
      ...EXTRA_ASSETS.map((a) => settle(a, async () => { const b = isSpl(a) ? await this.sol!.getUsdtBalance(a) : await this.evm(a).balanceOf(a as EthAsset); return [b, b]; }, DECIMALS[a])),
    ], this.dev.tronHost ? 120_000 : OVERVIEW_WAIT_MS);
    const balances: Record<string, BalanceView | undefined> = { XMR, BTC, ETH, TRX, USDTE, USDT, SOL, USDTS, LINK, WLD, POL, USDTP, ARB, ETHA, USDTA, BCH, LTC, DOGE, ADA, DASH, FIRO, SCRT, SSCRT, ...Object.fromEntries(EXTRA_ASSETS.map((a, i) => [a, EXTRA[i]])), ...(zec ? { ZEC: zecView() } : {}), ...(zano ? { ZANO: zanoView() } : {}), ...(ksr ? { KSR: ksrView() } : {}), ...(arrr ? { ARRR: arrrView() } : {}) };
    this.withSavedBalances(balances);
    return {
      network: this.settings.network,
      tor: this.torActive ? this.tor.state : null,
      balances: balances as Record<string, BalanceView>,
      sscrt: { needsKey: this.sscrtNeedsKey },
      coinjoin: this.mixer ? { ...this.mixer.status, rounds: MIX_ROUNDS } : null,
      btcMix: this.btcMixer ? { ...this.btcMixer.status, mixed: formatAmount(this.btcMixedBalance?.total ?? 0n, 8), mixedSpendable: formatAmount(this.btcMixedBalance?.spendable ?? 0n, 8) } : null,
      spark: this.spark ? { ...this.spark.info(), balance: this.spark.balance() ? { total: formatAmount(this.spark.balance()!.total, 8), spendable: formatAmount(this.spark.balance()!.spendable, 8) } : null } : null,
      mweb: this.mweb ? { ...this.mweb.info(), balance: this.mweb.balance() ? { total: formatAmount(this.mweb.balance()!.total, 8), spendable: formatAmount(this.mweb.balance()!.spendable, 8) } : null } : null,
      arrr: arrr ? { scanning: arrr.isScanning, percent: arrr.percent } : null,
      btcSync: this.btcFilters ? { ...this.btcFilters.progress, error: this.btcFilters.lastError } : null,
      zec: zec ? { ...zec.state(), address: zec.receive?.unified ?? '', transparentAddress: zec.transparentAddress } : null,
      addresses: { ...Object.fromEntries(EVM.map((a) => [a, this.evm(a).address])), BTC: btc.receiveAddress, XMR: await monero.getPrimaryAddress(), ETH: eth.address, TRX: tron.address, USDTE: eth.address, USDT: tron.address, DASH: dash.receiveAddress, FIRO: firo.receiveAddress, SOL: this.sol!.receiveAddress, USDTS: this.sol!.receiveAddress, USDCS: this.sol!.receiveAddress, ORCA: this.sol!.receiveAddress, PUMP: this.sol!.receiveAddress, BCH: bareBch(this.bch!.receiveAddress), LTC: this.ltc!.receiveAddress, SCRT: this.scrt!.address, SSCRT: this.scrt!.address, DOGE: this.doge!.receiveAddress, ...(this.ada ? { ADA: this.ada.receiveAddress } : {}), ...(zec ? { ZEC: zec.receive?.unified ?? '' } : {}), ...(zano ? { ZANO: zano.receive } : {}), ...(ksr ? { KSR: ksr.receive } : {}), ...(arrr ? { ARRR: arrr.receive } : {}) },
      ksr: ksr ? { scanning: ksr.isScanning } : null,
      monero: monero.state,
    };
  }

  /** Answers without any network, so the receive screen never waits on a slow connection. */
  async addresses() {
    const { tron, monero, btc, eth, dash } = this.session();
    // Every Ethereum, Polygon and Arbitrum coin and token lives on the one 0x address.
    return { ...Object.fromEntries(EVM.map((a) => [a, this.evm(a).address])), DASH: dash.receiveAddress, FIRO: this.firo!.receiveAddress, SOL: this.sol!.receiveAddress, USDTS: this.sol!.receiveAddress, USDCS: this.sol!.receiveAddress, ORCA: this.sol!.receiveAddress, PUMP: this.sol!.receiveAddress, BCH: bareBch(this.bch!.receiveAddress), LTC: this.ltc!.receiveAddress, SCRT: this.scrt!.address, SSCRT: this.scrt!.address, DOGE: this.doge!.receiveAddress, ...(this.ada ? { ADA: this.ada.receiveAddress } : {}), BTC: btc.receiveAddress, XMR: await monero.getPrimaryAddress(), ETH: eth.address, TRX: tron.address, USDTE: eth.address, USDT: tron.address, ...(this.zec ? { ZEC: this.zec.receive?.unified ?? '', ZEC_T: this.zec.transparentAddress } : {}), ...(this.zano ? { ZANO: this.zano.receive } : {}), ...(this.ksr ? { KSR: this.ksr.receive } : {}), ...(this.arrr ? { ARRR: this.arrr.receive } : {}) };
  }

  async torInfo() {
    return { updatable: !this.dev.nativeTor, enabled: this.torActive, setting: this.settings.torEnabled, allowed: true, installed: this.tor.isInstalled(), state: this.tor.state };
  }

  async installTor() {
    return this.tor.install((message) => this.emit('tor-install', message));
  }

  async history(asset: Asset) {
    const { tron, monero, btc, dash } = this.session();
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
    if (asset === 'ADA') return this.ada!.getHistory();
    if (asset === 'BCH') return this.bch!.getHistory();
    if (asset === 'ZEC') return this.zec ? this.zec.getHistory() : [];
    if (asset === 'ZANO') return this.zano ? this.zano.getHistory() : [];
    if (asset === 'KSR') return this.ksr ? this.ksr.getHistory() : [];
    if (asset === 'ARRR') return this.arrr ? this.arrr.getHistory() : [];
    if (asset === 'BTC') return btc.getHistory();
    if (asset === 'LTC') return this.ltc!.getHistory();
    if (asset === 'SCRT') return this.scrt!.getHistory();
    if (asset === 'SSCRT') return this.scrt!.getPrivateHistory();
    if (isEvm(asset)) return this.evm(asset).getHistory(asset);
    return asset === 'XMR' ? monero.getHistory() : tron.getHistory(asset);
  }


  /** The client for the chain an EVM coin or token lives on. */
  /**
   * Each EVM chain on an address of its own (Polygon, Arbitrum and BNB Chain on indexes 1-3 of the usual path), so one
   * address doesn't tie a person's activity on four chains together. Wallets made before this, and restored ones (other
   * wallets use one address everywhere), keep the shared address until switched in the settings.
   */
  /** The person's own server for a coin, or ''. */
  protected own(coin: string): string { return (this.settings.customServers?.[coin] ?? '').trim(); }
  /** Their own server alone when set (no public server learns the addresses then), else the public list. */
  protected ownList(coin: string, list: string[]): string[] { const o = this.own(coin); return o ? [o] : list; }
  /** One on their own network is reached directly (Tor can't reach it, nothing leaves the network); else Tor. */
  protected ownAgent(coin: string, route: string) { const o = this.own(coin); return o && isLocalServer(o) ? undefined : this.torRoute(route); }

  /** Private Bitcoin sync (block filters): on or off for this wallet, and the block it scans from. */
  protected btcFilters: FilterSync | null = null;
  protected newBtcSync: { filters: boolean; birthday: number; from?: string } | null = null;
  protected get btcSyncPath() { return path.join(this.dir, 'btc-sync.json'); }
  protected async readBtcSync(): Promise<{ filters: boolean; birthday: number; from?: string }> {
    const j = await this.records.read(this.btcSyncPath).catch(() => undefined);
    const birthday = Number.isInteger(j?.birthday) && j.birthday >= TAPROOT_HEIGHT ? j.birthday : 0;
    return { filters: j?.filters === true && birthday > 0, birthday, from: typeof j?.from === 'string' ? j.from : undefined };
  }
  protected async writeBtcSync(v: { filters: boolean; birthday: number; from?: string }): Promise<void> {
    await this.records.write(this.btcSyncPath, v);
  }

  protected evmSplit = false;
  protected get evmLayoutPath() { return path.join(this.dir, 'evm-layout.json'); }
  protected async readEvmLayout(): Promise<boolean> {
    try { return JSON.parse(String(await fs.readFile(this.evmLayoutPath, 'utf8')))?.split === true; } catch { return false; }
  }
  protected async writeEvmLayout(split: boolean): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.evmLayoutPath, JSON.stringify({ split }), { mode: 0o600 });
  }
  protected evmIndex(chainId: bigint): number {
    if (!this.evmSplit) return 0;
    return chainId === POLYGON.id ? 1 : chainId === ARBITRUM.id ? 2 : chainId === BSC.id ? 3 : 0;
  }
  /** The key for an EVM coin's own chain address. */
  protected evmAccount(asset: Asset, mnemonic: string) { return deriveEthAccount(mnemonic, this.evmIndex(chainOf(asset as EthAsset).id)); }

  protected evm(asset: Asset): EthClient {
    const id = chainOf(asset as EthAsset).id;
    const client = id === POLYGON.id ? this.pol : id === ARBITRUM.id ? this.arb : id === BSC.id ? this.bsc : this.session().eth;
    if (!client) throw new Error('The wallet is locked.');
    return client;
  }

  /** USD prices. Sends no address or balance, only asks for these three coins. Cached for 5 minutes. */
  async prices(): Promise<PriceMap | null> {
    if (!this.settings.showPrices) return null;
    await this.loadSavedPrices();
    // Old prices are shown right away while fresh ones load.
    if (this.priceCache && this.priceCache.at === 0 && !this.priceInFlight) {
      this.priceInFlight = this.fetchPrices().finally(() => { this.priceInFlight = null; });
      return this.priceCache.value;
    }
    if (this.priceCache && Date.now() - this.priceCache.at < 300_000) return this.priceCache.value;
    // After every source has failed, wait a little: asking again only prolongs a rate limit.
    if (Date.now() < this.priceRetryAt) return this.priceCache?.value ?? null;
    if (!this.priceInFlight) this.priceInFlight = this.fetchPrices().finally(() => { this.priceInFlight = null; });
    return this.priceInFlight;
  }

  protected async fetchPrices(): Promise<PriceMap | null> {
    const tiers = this.dev.priceSources ? [this.dev.priceSources] : this.dev.priceUrl ? [[coingecko(this.dev.priceUrl)]] : PRICE_TIERS;
    const tor = this.torActive;
    const agent = this.pricesAgent();
    const ask = async (source: PriceSource) => source.parse(await getJson(source.url, { agent, timeoutMs: tor ? 30_000 : 10_000, headers: { Accept: 'application/json', 'User-Agent': 'KusariWallet', ...source.headers } }));
    // A coin no market lists (KSR before launch) can't be found in a later tier either, so it sends no one there.
    const missing = (v: PriceMap | null) => !v || (Object.keys(DECIMALS) as Asset[]).some((a) => !NO_MARKET.has(a) && !v[a]);
    // Each tier only when the ones before it left a coin out; within a tier all at once, earlier sources winning.
    let value: PriceMap | null = null;
    let failures = 0;
    for (const tier of tiers) {
      if (!missing(value)) break;
      const got = await Promise.allSettled(tier.map(ask));
      for (const r of got) if (r.status === 'fulfilled') value = { ...r.value, ...(value ?? {}) } as PriceMap; else failures++;
    }
    // A Tor exit that a price service has rate-limited stays limited: the next try leaves through another one.
    if (tor && failures) newTorRoute(agent);
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
    if (value) {
      // Coins this round didn't price keep their last known price, so one slow source doesn't blank them.
      const merged = { ...(this.priceCache?.value ?? {}), ...value } as PriceMap;
      this.priceCache = { at: Date.now(), value: merged };
      void this.savePrices(merged);
      return merged;
    }
    this.priceRetryAt = Date.now() + 60_000;
    return this.priceCache?.value ?? null;
  }

  /** Prices have their own Tor route, so a rate limit on one service doesn't follow the swaps around. */
  protected pricesTorAgent: ReturnType<typeof socksAgent> | undefined;
  protected pricesAgent() {
    if (!this.torActive || !this.torProxy) return this.priceAgent;
    return (this.pricesTorAgent ??= this.torRoute('prices'));
  }

  /** The last prices go to disk (prices only, nothing about the wallet), so a restart shows them at once. */
  protected get pricesFile() { return path.join(this.baseDir, 'prices.json'); }
  protected async savePrices(value: PriceMap): Promise<void> {
    try { await fs.writeFile(this.pricesFile, JSON.stringify({ at: Date.now(), value }), { mode: 0o600 }); } catch { /* next time */ }
  }
  /** Prices from the last run, when less than a day old: shown until fresh ones arrive. */
  protected async loadSavedPrices(): Promise<void> {
    if (this.priceCache) return;
    try {
      const j = JSON.parse(await fs.readFile(this.pricesFile, 'utf8') as unknown as string);
      if (typeof j?.at !== 'number' || Date.now() - j.at > 24 * 3600_000 || !j.value || typeof j.value !== 'object') return;
      const value: Record<string, { usd: number; change: number | null }> = {};
      for (const [k, v] of Object.entries(j.value as Record<string, any>)) if (k in DECIMALS && Number.isFinite(v?.usd) && v.usd > 0) value[k] = { usd: v.usd, change: Number.isFinite(v?.change) ? v.change : null };
      // Marked old, so the first look still asks for fresh ones.
      this.priceCache = { at: 0, value: value as PriceMap };
    } catch { /* none yet */ }
  }

  protected async aavePrices(): Promise<Partial<PriceMap>> {
    const client = { eth: this.eth, bsc: this.bsc, arb: this.arb, pol: this.pol };
    const answers = await Promise.allSettled(AAVE_MARKETS.map(async (m) => {
      const c = client[m.chain];
      if (!c) return {};
      const hex = await within(15_000, c.call(m.oracle, aaveCall(m)), null);
      return hex ? readAave(m, hex) : {};
    }));
    return Object.assign({}, ...answers.map((a) => (a.status === 'fulfilled' ? a.value : {})));
  }

  protected get btcCoinsPath() { return path.join(this.dir, 'btc-coins.json'); }

  /** Your notes on Bitcoin coins and which are frozen, kept on this device only. */
  protected async btcCoinNotes(): Promise<{ labels: Record<string, string>; frozen: string[] }> {
    try {
      const j = await this.records.read(this.btcCoinsPath);
      const labels = j?.labels && typeof j.labels === 'object' ? Object.fromEntries(Object.entries(j.labels).filter(([k, v]) => COIN_ID.test(k) && typeof v === 'string')) as Record<string, string> : {};
      const frozen = Array.isArray(j?.frozen) ? j.frozen.filter((k: unknown): k is string => typeof k === 'string' && COIN_ID.test(k)) : [];
      return { labels, frozen };
    } catch { return { labels: {}, frozen: [] }; }
  }

}

/** The engines that reach their node through a gate of their own (see socks-gate.ts). */
const ENGINE_GATE: Record<string, string | undefined> = { ZANO: 'zano', KSR: 'ksr', ZEC: 'zec', ARRR: 'arrr' };

/** Where KSR points with no node set (developer build): a local port nothing listens on. */
const KSR_NO_NODE = '127.0.0.1:1';

/** The block a private Bitcoin sync starts from for a wallet first used on `date`: a week early, never before taproot. */
export function btcBirthdayFor(date: Date): number {
  return Math.max(TAPROOT_HEIGHT, estimateBtcHeight(date) - 1008);
}

/** A BIP39 passphrase: optional, but never only spaces, and short enough to type. */
export function checkPassphrase(p: string): void {
  if (!p) return;
  if (typeof p !== 'string' || p.length > 200) throw new Error('The passphrase is too long.');
  if (!p.trim()) throw new Error('The passphrase can\'t be only spaces.');
}
