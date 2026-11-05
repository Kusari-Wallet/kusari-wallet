import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs, existsSync } from 'node:fs';
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
  if (!res.ok || !res.body) throw new Error(`다운로드 실패 (${res.status})`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_DOWNLOAD) throw new Error('파일이 너무 커서 중단했어.');
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
  if (key.getFingerprint().toLowerCase() !== fingerprint.toLowerCase()) throw new Error('서명 키가 공식 키가 아니야.');
  const signature = await openpgp.readSignature({ armoredSignature });
  const message = await openpgp.createMessage({ binary: data });
  const { signatures } = await openpgp.verify({ message, signature, verificationKeys: key, format: 'binary' });
  if (signatures.length === 0) throw new Error('서명이 없어.');
  await signatures[0].verified;
}

export class TorManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private stopping = false;
  private port = 0;
  private restartTimer: NodeJS.Timeout | null = null;
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
    if (!p) throw new Error('이 운영체제는 Tor 자동 설치를 지원하지 않아.');
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
    onProgress('최신 버전 확인 중…');
    const versionUrl = src.versionUrl ?? `https://aus1.torproject.org/torbrowser/update_3/release/${platform.versionFile}`;
    const info = await getJson(versionUrl, { timeoutMs: 30_000 });
    const version = String(info.version ?? '');
    if (!/^\d+\.\d+(\.\d+)*$/.test(version)) throw new Error('Tor 버전 정보를 읽지 못했어.');

    onProgress('서명 키 받는 중…');
    let keyBytes: Buffer | null = null;
    for (const url of src.keyUrls) {
      try { keyBytes = await download(url); break; } catch { /* next source */ }
    }
    if (!keyBytes) throw new Error('Tor 서명 키를 받지 못했어.');

    const name = `tor-expert-bundle-${platform.bundle}-${version}.tar.gz`;
    let bundle: Buffer | null = null;
    let signature = '';
    let lastError = '';
    for (const base of src.bundleBases) {
      try {
        signature = (await download(`${base}/${version}/${name}.asc`)).toString('utf8');
        bundle = await download(`${base}/${version}/${name}`, (b) => onProgress(`Tor 받는 중… ${Math.floor(b / 1048576)}MB`));
        break;
      } catch (e) { lastError = (e as Error).message; }
    }
    if (!bundle) throw new Error(`Tor를 받지 못했어. ${lastError}`);

    onProgress('서명 확인 중…');
    try {
      await verifyDetached(bundle, signature, keyBytes, src.fingerprint);
    } catch (e) {
      throw new Error(`Tor 파일 서명 확인에 실패해서 설치를 중단했어. ${(e as Error).message}`);
    }

    onProgress('설치 중…');
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
      throw new Error('받은 파일에 Tor 실행 파일이 없어.');
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

  start(): void {
    if (this.opts.socksOverride) { this.patch({ phase: 'ready', percent: 100, error: null }); void this.check(); return; }
    if (this.proc) return;
    this.stopping = false;
    if (!existsSync(this.binPath)) { this.patch({ phase: 'error', error: 'Tor가 설치돼 있지 않아.' }); return; }
    this.patch({ phase: 'starting', percent: 0, error: null, verified: null, exitIp: null });
    const dataDir = path.join(this.dir, 'data');
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
    let tail = '';
    const onData = (d: Buffer) => {
      const text = tail + d.toString('utf8');
      const lines = text.split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        const m = line.match(/Bootstrapped (\d+)%/);
        if (!m) continue;
        const percent = Number(m[1]);
        if (percent >= 100) { this.patch({ phase: 'ready', percent: 100 }); void this.check(); }
        else this.patch({ phase: 'starting', percent });
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', () => undefined);
    proc.on('error', (e) => { this.patch({ phase: 'error', error: `Tor를 실행하지 못했어. ${e.message}` }); });
    proc.on('exit', () => {
      this.proc = null;
      if (this.stopping) return;
      // Nothing listens on the port now, so wallet traffic fails rather than leaving unprotected.
      this.patch({ phase: 'error', percent: 0, verified: null, exitIp: null, error: 'Tor가 종료됐어. 다시 시작하는 중이야.' });
      this.restartTimer = setTimeout(() => this.start(), 5000);
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
