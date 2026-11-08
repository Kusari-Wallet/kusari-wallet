import { promises as fs } from 'node:fs';
// These ship a CommonJS build ("default" export condition), which is what require picks.
const { Core } = require('@walletconnect/core');
const { WalletKit } = require('@reown/walletkit');
const { buildApprovedNamespaces, getSdkError } = require('@walletconnect/utils');
type IWalletKit = any;

/**
 * WalletConnect, only in wallets made in WalletConnect mode, and never under Tor (its relay would be reached directly).
 * Only EVM accounts are offered: the privacy coins are never shared with a dApp.
 */
export const WC_CHAINS: { id: bigint; name: string }[] = [
  { id: 1n, name: 'Ethereum' }, { id: 137n, name: 'Polygon' }, { id: 42161n, name: 'Arbitrum' }, { id: 56n, name: 'BNB Smart Chain' },
];
/** Requests the wallet answers itself, and the ones that need the person and their password. */
const SILENT = ['eth_accounts', 'eth_requestAccounts', 'eth_chainId', 'wallet_switchEthereumChain'];
export const NEEDS_APPROVAL = ['personal_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4', 'eth_sendTransaction'];
const EVENTS = ['accountsChanged', 'chainChanged'];

/** WalletConnect's key-value store, kept as one JSON file in the wallet's own folder. */
export class FileStorage {
  private data: Record<string, unknown> | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}
  private async load(): Promise<Record<string, unknown>> {
    if (!this.data) {
      try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8') as unknown as string); } catch { this.data = {}; }
    }
    return this.data!;
  }
  private save(): Promise<void> {
    const text = JSON.stringify(this.data ?? {});
    this.writing = this.writing.then(() => fs.writeFile(this.file, text, { mode: 0o600 })).catch(() => undefined);
    return this.writing;
  }
  async getKeys(): Promise<string[]> { return Object.keys(await this.load()); }
  async getEntries<T = any>(): Promise<[string, T][]> { return Object.entries(await this.load()) as [string, T][]; }
  async getItem<T = any>(key: string): Promise<T | undefined> { return (await this.load())[key] as T | undefined; }
  async setItem<T = any>(key: string, value: T): Promise<void> { (await this.load())[key] = value; await this.save(); }
  async removeItem(key: string): Promise<void> { delete (await this.load())[key]; await this.save(); }
}

export interface WcProposal { id: number; name: string; url: string; description: string; chains: string[]; unsupported: string[]; verified: string; scam: boolean }
export interface WcRequest { id: number; topic: string; dapp: string; url: string; chainId: bigint; method: string; params: any }
export interface WcSession { topic: string; name: string; url: string; expiry: number }

const chainOfCaip = (caip: string): bigint | null => (/^eip155:(\d+)$/.test(caip) ? BigInt(caip.split(':')[1]) : null);

export class WalletConnectManager {
  private kit: IWalletKit | null = null;
  private starting: Promise<IWalletKit> | null = null;
  private proposals = new Map<number, any>();
  private requests = new Map<number, WcRequest>();

  constructor(
    private readonly projectId: string,
    private readonly storageFile: string,
    private readonly address: string,
    private readonly emit: (event: string, data: unknown) => void,
  ) {}

  private start(): Promise<IWalletKit> {
    if (this.kit) return Promise.resolve(this.kit);
    if (!this.starting) {
      this.starting = (async () => {
        // No usage reports to WalletConnect: only the relay (needed to talk to dApps) and its scam check are used.
        const core = new Core({ projectId: this.projectId, storage: new FileStorage(this.storageFile) as any, logger: 'silent' as any, telemetryEnabled: false });
        const kit = await WalletKit.init({ core, metadata: { name: 'Kusari Wallet', description: 'A self-custody privacy wallet', url: 'https://github.com/Kusari-Wallet', icons: [] } });
        kit.on('session_proposal', (p: any) => this.onProposal(p));
        kit.on('session_request', (r: any) => void this.onRequest(r));
        kit.on('session_delete', () => this.emit('wc-sessions', this.sessions()));
        this.kit = kit;
        return kit;
      })();
      this.starting.catch(() => { this.starting = null; });
    }
    return this.starting;
  }

  /** Opens saved sessions again, so dApps already connected can reach the wallet. */
  async resume(): Promise<void> {
    try { await fs.access(this.storageFile); } catch { return; } // nothing was ever connected
    await this.start();
  }

  async pair(uri: string): Promise<void> {
    const clean = uri.trim();
    if (!/^wc:[0-9a-f]{64}@2\?/i.test(clean)) throw new Error('This is not a WalletConnect link. It starts with wc: and comes from the dApp\'s "WalletConnect" button.');
    const kit = await this.start();
    await kit.pair({ uri: clean });
  }

  private onProposal(p: any): void {
    const params = p.params;
    const asked = [...Object.values(params.requiredNamespaces ?? {}), ...Object.values(params.optionalNamespaces ?? {})]
      .flatMap((ns: any) => ns?.chains ?? []) as string[];
    const supported = new Set(WC_CHAINS.map((c) => `eip155:${c.id}`));
    const meta = params.proposer?.metadata ?? {};
    const v = p.verifyContext?.verified ?? {};
    this.proposals.set(p.id, p);
    this.emit('wc-proposal', {
      id: p.id, name: String(meta.name ?? 'Unknown dApp').slice(0, 80), url: String(meta.url ?? '').slice(0, 200), description: String(meta.description ?? '').slice(0, 300),
      chains: [...new Set(asked.filter((c) => supported.has(c)))], unsupported: [...new Set(asked.filter((c) => !supported.has(c)))],
      verified: String(v.validation ?? 'UNKNOWN'), scam: v.isScam === true,
    } satisfies WcProposal);
  }

  async approve(id: number): Promise<void> {
    const p = this.proposals.get(id);
    if (!p) throw new Error('This request has expired. Connect again from the dApp.');
    const kit = await this.start();
    const chains = WC_CHAINS.map((c) => `eip155:${c.id}`);
    const namespaces = buildApprovedNamespaces({
      proposal: p.params,
      supportedNamespaces: { eip155: { chains, methods: [...SILENT, ...NEEDS_APPROVAL], events: EVENTS, accounts: chains.map((c) => `${c}:${this.address}`) } },
    });
    await kit.approveSession({ id, namespaces });
    this.proposals.delete(id);
    this.emit('wc-sessions', this.sessions());
  }

  async reject(id: number): Promise<void> {
    const kit = await this.start();
    this.proposals.delete(id);
    await kit.rejectSession({ id, reason: getSdkError('USER_REJECTED') }).catch(() => undefined);
  }

  sessions(): WcSession[] {
    if (!this.kit) return [];
    return Object.values(this.kit.getActiveSessions()).map((s: any) => ({ topic: s.topic, name: String(s.peer?.metadata?.name ?? 'dApp'), url: String(s.peer?.metadata?.url ?? ''), expiry: Number(s.expiry) * 1000 }));
  }

  async disconnect(topic: string): Promise<void> {
    const kit = await this.start();
    await kit.disconnectSession({ topic, reason: getSdkError('USER_DISCONNECTED') });
    this.emit('wc-sessions', this.sessions());
  }

  private async onRequest(r: any): Promise<void> {
    const { topic, id } = r;
    const method = String(r.params?.request?.method ?? '');
    const params = r.params?.request?.params;
    const chainId = chainOfCaip(String(r.params?.chainId ?? '')) ?? 0n;
    const answer = (result: unknown) => this.kit!.respondSessionRequest({ topic, response: { id, jsonrpc: '2.0', result } });
    const refuse = (message: string, code = 4001) => this.kit!.respondSessionRequest({ topic, response: { id, jsonrpc: '2.0', error: { code, message } } });
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return void answer([this.address]);
    if (method === 'eth_chainId') return void answer(`0x${chainId.toString(16)}`);
    if (method === 'wallet_switchEthereumChain') {
      const want = BigInt(params?.[0]?.chainId ?? 0);
      if (WC_CHAINS.some((c) => c.id === want)) return void answer(null);
      this.tellRefused(topic, method, `network ${want}`);
      return void refuse('This wallet doesn\'t support that network.', 4902);
    }
    if (!NEEDS_APPROVAL.includes(method) || !WC_CHAINS.some((c) => c.id === chainId)) {
      // Never turned down silently: the person sees what the dApp asked for and why nothing popped up.
      this.tellRefused(topic, method, WC_CHAINS.some((c) => c.id === chainId) ? '' : `network ${chainId}`);
      return void refuse(`This wallet doesn't do ${method || 'that'}.`, 4200);
    }
    const session = this.kit!.getActiveSessions()[topic];
    const meta = session?.peer?.metadata ?? {};
    const request: WcRequest = { id, topic, dapp: String(meta.name ?? 'dApp'), url: String(meta.url ?? ''), chainId, method, params };
    this.requests.set(id, request);
    // Only what the screen needs, as plain values: the details are read with wcRequestInfo.
    this.emit('wc-request', { id, dapp: request.dapp, url: request.url, chainId: String(chainId), method });
  }

  private tellRefused(topic: string, method: string, network: string): void {
    const meta = this.kit?.getActiveSessions()?.[topic]?.peer?.metadata ?? {};
    this.emit('wc-refused', { dapp: String(meta.name ?? 'dApp').slice(0, 80), url: String(meta.url ?? '').slice(0, 200), method: method.slice(0, 60), network });
  }

  request(id: number): WcRequest {
    const r = this.requests.get(id);
    if (!r) throw new Error('This request has expired. Try again from the dApp.');
    return r;
  }

  async respond(id: number, result: unknown): Promise<void> {
    const r = this.request(id);
    this.requests.delete(id);
    await this.kit!.respondSessionRequest({ topic: r.topic, response: { id, jsonrpc: '2.0', result } });
  }

  async decline(id: number): Promise<void> {
    const r = this.requests.get(id);
    this.requests.delete(id);
    if (r) await this.kit!.respondSessionRequest({ topic: r.topic, response: { id, jsonrpc: '2.0', error: getSdkError('USER_REJECTED') } }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    const kit = this.kit;
    this.kit = null;
    this.starting = null;
    this.proposals.clear();
    this.requests.clear();
    // The relay connection is closed so a locked wallet can't be reached.
    await (kit as any)?.core?.relayer?.transportClose?.().catch?.(() => undefined);
  }
}
