import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs, existsSync, readFileSync, readlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
// eslint-disable-next-line
const openpgp: any = require('openpgp');
import * as tar from 'tar';
import { getJson, socksAgent } from './request';

/** Tor Browser Developers signing key, as published on support.torproject.org. */
export const TOR_SIGNING_FINGERPRINT = 'ef6e286dda85ea2a4ba7de684e2c6e8793298290';

const MAX_DOWNLOAD = 250 * 1024 * 1024;
const PLATFORM: Record<string, { bundle: string; versionFile: string; exe: string }> = {
  win32: { bundle: 'windows-x86_64', versionFile: 'download-windows-x86_64.json', exe: 'tor.exe' },
  linux: { bundle: 'linux-x86_64', versionFile: 'download-linux-x86_64.json', exe: 'tor' },
  darwin: { bundle: 'macos-aarch64', versionFile: 'download-macos.json', exe: 'tor' },
};

export interface TorSources {
  versionUrl?: string;
  bundleBases: string[];
  keyUrls: string[];
  fingerprint: string;
  checkUrl?: string;
}

const DEFAULT_SOURCES: TorSources = {
  bundleBases: ['https://dist.torproject.org/torbrowser', 'https://archive.torproject.org/tor-package-archive/torbrowser'],
  keyUrls: [
    'https://openpgpkey.torproject.org/.well-known/openpgpkey/torproject.org/hu/kounek7zrdx745qydx6p59t9mqjpuhdf',
    `https://keys.openpgp.org/vks/v1/by-fingerprint/${TOR_SIGNING_FINGERPRINT.toUpperCase()}`,
  ],
  fingerprint: TOR_SIGNING_FINGERPRINT,
  checkUrl: 'https://check.torproject.org/api/ip',
};

export type TorPhase = 'off' | 'starting' | 'ready' | 'error';
export interface TorState {
  phase: TorPhase;
  percent: number;
  verified: boolean | null;
  exitIp: string | null;
  error: string | null;
  installedVersion: string | null;
}

async function download(url: string, onProgress?: (bytes: number) => void): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_DOWNLOAD) throw new Error('The file is too large, so this was stopped.');
    chunks.push(chunk);
    onProgress?.(size);
  }
  return Buffer.concat(chunks);
}

/** Throws unless `data` carries a valid signature from the pinned key. */
export async function verifyDetached(data: Buffer, armoredSignature: string, keyBytes: Buffer, fingerprint: string): Promise<void> {
  const head = keyBytes.subarray(0, 20).toString('latin1');
  const key = head.startsWith('-----')
    ? await openpgp.readKey({ armoredKey: keyBytes.toString('utf8') })
    : await openpgp.readKey({ binaryKey: keyBytes });
  if (key.getFingerprint().toLowerCase() !== fingerprint.toLowerCase()) throw new Error('The signing key is not the official key.');
  const signature = await openpgp.readSignature({ armoredSignature });
  const message = await openpgp.createMessage({ binary: data });
  const { signatures } = await openpgp.verify({ message, signature, verificationKeys: key, format: 'binary' });
  if (signatures.length === 0) throw new Error('No signature found.');
  await signatures[0].verified;
}

/** Tor's own messages, safe to paste somewhere: no IP addresses. */
export function scrubLog(line: string): string {
  return line
    .replace(/(?<!Tor )\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
    .replace(/\[?\b(?:[0-9a-f]{1,4}:){3,}[0-9a-f:]*\]?|\[?\b[0-9a-f]{0,4}::[0-9a-f:]*\]?/gi, '[ip]')
    .replace(/\b[a-z2-7]{16,56}\.onion\b/gi, '[onion]')
    .replace(/[A-Z]:\\[^"\s]*(?: [^"\s\\]+\\[^"\s]*)*/gi, '[path]')
    .replace(/\/(?:home|Users|data)\/[^"\s]*/g, '[path]');
}

const LOG_LINES = 200;

export class TorManager extends EventEmitter {
  private log: string[] = [];
  private proc: ChildProcess | null = null;
  private stopping = false;
  private port = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private quickExits = 0;
  private lastProblem = '';
  state: TorState = { phase: 'off', percent: 0, verified: null, exitIp: null, error: null, installedVersion: null };

  constructor(private readonly dir: string, private readonly opts: {
    sources?: TorSources;
    /** Development: use this tor binary instead of the downloaded one. */
    binPath?: string;
    /** Development: use this SOCKS proxy and run no tor at all. */
    socksOverride?: string;
  } = {}) { super(); }

  private get sources() { return this.opts.sources ?? DEFAULT_SOURCES; }
  private get runtimeDir() { return path.join(this.dir, 'runtime'); }
  private get platform() {
    const p = PLATFORM[process.platform];
    if (!p) throw new Error('Automatic Tor install isn\'t supported on this operating system.');
    return p;
  }
  private get binPath() { return this.opts.binPath ?? path.join(this.runtimeDir, 'tor', this.platform.exe); }

  private patch(update: Partial<TorState>): void {
    this.state = { ...this.state, ...update };
    this.emit('state', this.state);
  }

  isInstalled(): boolean {
    return Boolean(this.opts.socksOverride) || existsSync(this.binPath);
  }

  async loadInstalledVersion(): Promise<void> {
    try {
      const info = JSON.parse(await fs.readFile(path.join(this.dir, 'installed.json'), 'utf8'));
      this.state.installedVersion = String(info.version);
    } catch { /* not installed */ }
  }

  /**
   * Downloads the official bundle and checks its signature before anything is unpacked.
   * This one step is on the normal internet, because Tor doesn't exist yet.
   */
  async install(onProgress: (message: string) => void = () => {}): Promise<string> {
    const src = this.sources;
    const platform = this.platform;
    onProgress('Checking for the latest version…');
    const versionUrl = src.versionUrl ?? `https://aus1.torproject.org/torbrowser/update_3/release/${platform.versionFile}`;
    const info = await getJson(versionUrl, { timeoutMs: 30_000 });
    const version = String(info.version ?? '');
    if (!/^\d+\.\d+(\.\d+)*$/.test(version)) throw new Error('Could not read Tor version information.');

    onProgress('Downloading the signing key…');
    let keyBytes: Buffer | null = null;
    for (const url of src.keyUrls) {
      try { keyBytes = await download(url); break; } catch { /* next source */ }
    }
    if (!keyBytes) throw new Error('Could not download the Tor signing key.');

    const name = `tor-expert-bundle-${platform.bundle}-${version}.tar.gz`;
    let bundle: Buffer | null = null;
    let signature = '';
    let lastError = '';
    for (const base of src.bundleBases) {
      try {
        signature = (await download(`${base}/${version}/${name}.asc`)).toString('utf8');
        bundle = await download(`${base}/${version}/${name}`, (b) => onProgress(`Downloading Tor… ${Math.floor(b / 1048576)} MB`));
        break;
      } catch (e) { lastError = (e as Error).message; }
    }
    if (!bundle) throw new Error(`Could not download Tor. ${lastError}`);

    onProgress('Checking the signature…');
    try {
      await verifyDetached(bundle, signature, keyBytes, src.fingerprint);
    } catch (e) {
      throw new Error(`The Tor file signature check failed, so the install was stopped. ${(e as Error).message}`);
    }

    onProgress('Installing…');
    await fs.mkdir(this.dir, { recursive: true });
    const archive = path.join(this.dir, 'bundle.tar.gz');
    const staging = path.join(this.dir, 'runtime.new');
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(archive, bundle);
    await tar.x({ file: archive, cwd: staging, strict: true, filter: (_p, entry: any) => entry.type === 'File' || entry.type === 'Directory' });
    await fs.rm(archive, { force: true });
    if (!existsSync(path.join(staging, 'tor', platform.exe))) {
      await fs.rm(staging, { recursive: true, force: true });
      throw new Error('The download has no Tor executable.');
    }
    await this.stop();
    await fs.rm(this.runtimeDir, { recursive: true, force: true });
    await fs.rename(staging, this.runtimeDir);
    await fs.writeFile(path.join(this.dir, 'installed.json'), JSON.stringify({ version, installedAt: new Date().toISOString() }));
    this.patch({ installedVersion: version });
    return version;
  }

  /** Picks the SOCKS address. Wallet clients are built on it before Tor runs, so they have no other way out. */
  async allocate(): Promise<string> {
    if (this.opts.socksOverride) return this.opts.socksOverride;
    if (!this.port) {
      this.port = await new Promise<number>((resolve, reject) => {
        const s = net.createServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
          const { port } = s.address() as net.AddressInfo;
          s.close(() => resolve(port));
        });
      });
    }
    return `socks5h://127.0.0.1:${this.port}`;
  }

  useDirect(): void {}

  recentLog(): string[] { return [...this.log]; }

  start(): void {
    if (this.opts.socksOverride) { this.patch({ phase: 'ready', percent: 100, error: null }); void this.check(); return; }
    if (this.proc) return;
    this.stopping = false;
    if (!existsSync(this.binPath)) { this.patch({ phase: 'error', error: 'Tor isn\'t installed.' }); return; }
    this.patch({ phase: 'starting', percent: 0, error: null, verified: null, exitIp: null });
    const dataDir = path.join(this.dir, 'data');
    // A Tor left running by an earlier run that closed badly keeps the data folder locked, and a new one quits at once.
    this.killLeftover();
    const startedAt = Date.now();
    const proc = spawn(this.binPath, [
      '--ignore-missing-torrc', '-f', path.join(this.dir, 'no-torrc'),
      '--SocksPort', `127.0.0.1:${this.port}`,
      '--DataDirectory', dataDir,
      '--ClientOnly', '1',
      '--Log', 'notice stdout',
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LD_LIBRARY_PATH: path.dirname(this.binPath) },
    });
    this.proc = proc;
    if (proc.pid) void fs.writeFile(this.pidPath, String(proc.pid)).catch(() => undefined);
    let tail = '';
    const onData = (d: Buffer) => {
      const text = tail + d.toString('utf8');
      const lines = text.split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) { this.log.push(scrubLog(line.trim()).slice(0, 300)); this.log.splice(0, Math.max(0, this.log.length - LOG_LINES)); }
        if (/\[(warn|err)\]/.test(line)) this.lastProblem = scrubLog(line.replace(/^.*\[(warn|err)\]\s*/, '').trim()).slice(0, 200);
        const m = line.match(/Bootstrapped (\d+)%/);
        if (!m) continue;
        const percent = Number(m[1]);
        if (percent >= 100) { this.patch({ phase: 'ready', percent: 100 }); void this.check(); }
        else this.patch({ phase: 'starting', percent });
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (e) => { this.patch({ phase: 'error', error: `Could not start Tor. ${e.message}` }); });
    proc.on('exit', (code) => {
      this.proc = null;
      void fs.rm(this.pidPath, { force: true }).catch(() => undefined);
      if (this.stopping) return;
      // Quitting again and again right after starting is a problem to show, with longer waits between tries.
      this.quickExits = Date.now() - startedAt < 60_000 ? this.quickExits + 1 : 0;
      const wait = [5, 15, 30, 60][Math.min(this.quickExits, 3)] * 1000;
      const why = this.lastProblem ? ` Tor said: ${this.lastProblem}` : code ? ` (exit code ${code})` : '';
      // Nothing listens on the port now, so wallet traffic fails rather than leaving unprotected.
      this.patch({ phase: 'error', percent: 0, verified: null, exitIp: null, error: `Tor stopped. Restarting it in ${wait / 1000} seconds.${why}` });
      this.restartTimer = setTimeout(() => this.start(), wait);
    });
  }

  /** Asks the Tor Project's check service whether traffic really arrives from Tor. */
  private async check(): Promise<void> {
    const url = this.sources.checkUrl;
    if (!url) return;
    try {
      const res = await getJson(url, { agent: socksAgent(await this.allocate()), timeoutMs: 60_000 });
      this.patch({ verified: res.IsTor === true, exitIp: typeof res.IP === 'string' ? res.IP : null });
    } catch { /* Tor itself still works; only this optional check failed */ }
  }

  clearLog(): void { this.log = []; }

  private get pidPath() { return path.join(this.dir, 'tor.pid'); }

  /** Stops the Tor an earlier run started, if it is still there and really is this wallet's Tor. */
  private killLeftover(): void {
    let pid = 0;
    try { pid = Number(readFileSync(this.pidPath, 'utf8').trim()); } catch { return; }
    if (!(pid > 0) || pid === process.pid) return;
    try { process.kill(pid, 0); } catch { return; } // already gone
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }).toString();
        if (!/^"tor\.exe"/i.test(out.trim())) return;
      } else if (process.platform === 'linux') {
        if (readlinkSync(`/proc/${pid}/exe`) !== this.binPath) return;
      } else return;
      process.kill(pid);
      // Its lock on the data folder goes when it exits.
      const until = Date.now() + 3000;
      while (Date.now() < until) { try { process.kill(pid, 0); } catch { break; } execFileSync(process.platform === 'win32' ? 'cmd' : 'sleep', process.platform === 'win32' ? ['/c', 'ping -n 2 127.0.0.1 >nul'] : ['0.2'], { windowsHide: true }); }
    } catch { /* could not check it: leave it alone */ }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      await new Promise<void>((resolve) => {
        const done = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3000);
        proc.once('exit', () => { clearTimeout(done); resolve(); });
        proc.kill();
      });
    }
    this.patch({ phase: 'off', percent: 0, verified: null, exitIp: null, error: null });
  }
}
