// Runs the Tor program bundled in the APK through the Android side.
import { EventEmitter } from 'events';
import { getJson } from './request';

const native = () => (window as any).VaultNative;

export class TorManager extends EventEmitter {
  state: any = { phase: 'off', percent: 0, verified: null, exitIp: null, error: null, installedVersion: null };

  constructor() {
    super();
    (window as any).__torState = (phase: string, percent: number, error: string) => {
      this.patch({ phase, percent, error: error || null, ...(phase === 'ready' ? {} : { verified: null, exitIp: null }) });
      if (phase === 'ready') void this.check();
    };
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
  start() { native().torStart(); }
  useDirect() { native().torDirect(); }
  async stop() { native().torStop(); }

  private async check(): Promise<void> {
    try {
      const res = await getJson('https://check.torproject.org/api/ip', { timeoutMs: 60_000 });
      this.patch({ verified: res.IsTor === true, exitIp: typeof res.IP === 'string' ? res.IP : null });
    } catch { /* Tor still works; only this optional check failed */ }
  }
}
