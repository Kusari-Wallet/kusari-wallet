// Runs the Tor program bundled in the APK through the Android side.
import { EventEmitter } from 'events';
import { getJson } from './request';
import { AUTO_WAIT_MS, DefaultBridges, TorBridge, TorRoute, autoFirst, autoNext, readPtConfig } from '../main/tor-bridges';

const native = () => (window as any).VaultNative;

export class TorManager extends EventEmitter {
  state: any = { phase: 'off', percent: 0, verified: null, exitIp: null, error: null, installedVersion: null, route: null };
  private bridge: TorBridge = 'auto';
  private custom: string[] = [];
  private route: TorRoute | null = null;
  private running = false;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private defaults: Promise<DefaultBridges> | null = null;

  constructor() {
    super();
    (window as any).__torState = (phase: string, percent: number, error: string) => {
      this.patch({ phase, percent, error: error || null, ...(phase === 'ready' ? {} : { verified: null, exitIp: null }) });
      if (phase === 'ready') {
        this.clearAuto();
        try { localStorage.setItem('tor-route', this.route ?? 'none'); } catch { /* only a hint for next time */ }
        void this.check();
      }
    };
  }

  /** The default bridges ship in the APK, from the same signed Tor bundle as the bridge program. */
  private loadDefaults(): Promise<DefaultBridges> {
    if (!this.defaults) this.defaults = fetch('pt_config.json').then((r) => r.text()).then(readPtConfig).catch(() => ({ snowflake: [], obfs4: [] }));
    return this.defaults;
  }

  setBridge(bridge: TorBridge, custom: string[] = []): void {
    const changed = bridge !== this.bridge || custom.join('\n') !== this.custom.join('\n');
    this.bridge = bridge;
    this.custom = custom;
    if (!changed) return;
    this.route = null;
    if (this.running) { native().torStop(); void this.launch(); }
  }

  private lastWorked(): TorRoute | null {
    try { return (localStorage.getItem('tor-route') as TorRoute | null) ?? null; } catch { return null; }
  }

  private clearAuto(): void { if (this.autoTimer) clearTimeout(this.autoTimer); this.autoTimer = null; }

  private async launch(): Promise<void> {
    this.clearAuto();
    const route: TorRoute = this.bridge === 'auto' ? (this.route ?? autoFirst(this.lastWorked())) : this.bridge;
    this.route = route;
    const d = await this.loadDefaults();
    const lines = route === 'none' ? [] : route === 'custom' ? this.custom : d[route];
    if (!this.running) return;
    if (route !== 'none' && (!lines.length || !native().torBridges?.(JSON.stringify(lines)))) {
      if (this.bridge === 'auto') { this.route = autoNext(route); return this.launch(); }
      this.patch({ phase: 'error', percent: 0, error: native().torHasBridges?.() ? 'The bridge lines were refused.' : 'This build has no bridge program.', route });
      return;
    }
    if (route === 'none') native().torBridges?.('[]');
    this.patch({ route });
    native().torStart();
    if (this.bridge === 'auto') {
      this.autoTimer = setTimeout(() => {
        if (!this.running || this.state.phase === 'ready') return;
        this.route = autoNext(route);
        native().torStop();
        void this.launch();
      }, AUTO_WAIT_MS[route]);
    }
  }

  private patch(update: any) { this.state = { ...this.state, ...update }; this.emit('state', this.state); }
  recentLog(): string[] { return []; }
  clearLog(): void {}
  isInstalled() { return Boolean(native().torAvailable()); }
  async loadInstalledVersion() {}
  async install(): Promise<string> { throw new Error('Tor is not available on this device.'); }

  /** After this, the forwarder has no way out except Tor. */
  async allocate(): Promise<string> {
    const port = native().torPrepare();
    if (!port) throw new Error('Could not prepare Tor.');
    return `socks5h://127.0.0.1:${port}`;
  }
  start() { this.running = true; void this.launch(); }
  useDirect() { this.running = false; this.clearAuto(); native().torDirect(); }
  async stop() { this.running = false; this.clearAuto(); native().torStop(); }

  private async check(): Promise<void> {
    try {
      const res = await getJson('https://check.torproject.org/api/ip', { timeoutMs: 60_000 });
      this.patch({ verified: res.IsTor === true, exitIp: typeof res.IP === 'string' ? res.IP : null });
    } catch { /* Tor still works; only this optional check failed */ }
  }
}
