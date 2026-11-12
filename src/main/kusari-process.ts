// Starts kusari-wallet-rpc, Kusari's own wallet server (Monero's, built from native/kusari-coin), and talks to it
// over JSON-RPC on 127.0.0.1. A random login made for each start stops other programs on this PC from using it.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export interface KusariEngine {
  /** Answers are text, because amounts can pass what a JSON number holds exactly. */
  call(method: string, params?: unknown, raw?: string, timeoutMs?: number): Promise<string>;
  /** Where the wallet files are. */
  dir: string;
  close(): Promise<void>;
}

export interface KusariEngineOptions {
  node: string;
  /** Tor's SOCKS port. When set, the wallet reaches the node through it and no other way. */
  socks?: number;
  /** Tests only, for a regtest node. */
  extraArgs?: string[];
}

const EXE = process.platform === 'win32' ? 'kusari-wallet-rpc.exe' : 'kusari-wallet-rpc';

function findEngine(override?: string): string | null {
  const candidates = [override, (process as any).resourcesPath && path.join((process as any).resourcesPath, 'kusari', EXE)];
  return candidates.find((c): c is string => Boolean(c) && existsSync(c as string)) ?? null;
}

export const kusariEngineAvailable = (override?: string): boolean => findEngine(override) !== null;
export const kusariEngineInfo = (override?: string): string => findEngine(override) ?? 'Engine file not found';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** The parts of a WWW-Authenticate: Digest challenge. */
export function parseChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of header.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

/** RFC 2617 digest with qop=auth, the scheme Monero's RPC server asks for. */
export function digestHeader(c: Record<string, string>, user: string, pass: string, method: string, uri: string, nc: number, cnonce: string): string {
  const ha1 = md5(`${user}:${c.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const ncText = nc.toString(16).padStart(8, '0');
  const qop = (c.qop ?? '').split(',').map((q) => q.trim()).includes('auth') ? 'auth' : '';
  const response = qop ? md5(`${ha1}:${c.nonce}:${ncText}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${c.nonce}:${ha2}`);
  const parts = [`username="${user}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`, `response="${response}"`, 'algorithm=MD5'];
  if (qop) parts.push(`qop=${qop}`, `nc=${ncText}`, `cnonce="${cnonce}"`);
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

export function kusariRpc(port: number, user: string, pass: string) {
  let challenge: Record<string, string> | null = null;
  let nc = 0;
  const post = (body: string, timeoutMs: number) => new Promise<{ status: number; text: string; auth?: string }>((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) };
    if (challenge) headers.Authorization = digestHeader(challenge, user, pass, 'POST', '/json_rpc', ++nc, randomBytes(8).toString('hex'));
    const req = http.request({ host: '127.0.0.1', port, path: '/json_rpc', method: 'POST', headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 500, text: Buffer.concat(chunks).toString('utf8'), auth: res.headers['www-authenticate'] as string | undefined }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('The Kusari wallet took too long to answer.')));
    req.on('error', reject);
    req.end(body);
  });
  return async (body: string, timeoutMs = 60_000): Promise<string> => {
    let r = await post(body, timeoutMs);
    // A first request, or a nonce that has gone stale: answer the new challenge once.
    if (r.status === 401 && r.auth) {
      challenge = parseChallenge(r.auth);
      nc = 0;
      r = await post(body, timeoutMs);
    }
    if (r.status !== 200) throw new Error(`The Kusari wallet answered ${r.status}.`);
    return r.text;
  };
}

export async function startKusariEngine(override: string | undefined, dir: string, o: KusariEngineOptions): Promise<KusariEngine> {
  const file = findEngine(override);
  if (!file) throw new Error('This build has no Kusari engine.');
  if (!/^[A-Za-z0-9.\-[\]:]+:\d{2,5}$/.test(o.node)) throw new Error('Set a Kusari node in Settings.');
  const home = path.join(dir, 'kusari');
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  const user = 'kusari';
  const pass = randomBytes(24).toString('hex');
  const args = [
    '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(port),
    '--rpc-login', `${user}:${pass}`,
    '--wallet-dir', home,
    '--daemon-address', o.node,
    '--non-interactive', '--no-initial-sync',
    '--log-file', path.join(home, 'wallet-rpc.log'), '--log-level', '0', '--max-log-files', '2',
    ...(o.socks ? ['--proxy', `127.0.0.1:${o.socks}`] : []),
    ...(o.extraArgs ?? []),
  ];
  // The login goes on the command line, which other programs of the same user can read. It only reaches this
  // wallet server, which listens on 127.0.0.1 and lives as long as this session.
  const child = spawn(file, args, { stdio: 'ignore', windowsHide: true, cwd: home });
  let dead: Error | null = null;
  child.on('error', (e) => { dead = e; });
  child.on('exit', () => { dead = dead ?? new Error('Kusari engine stopped.'); });
  const rpc = kusariRpc(port, user, pass);
  const call = (method: string, params: unknown = {}, raw?: string, timeoutMs?: number) => {
    if (dead) return Promise.reject(dead);
    return rpc(raw ?? JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }), timeoutMs).catch((e) => { throw dead ?? e; });
  };
  const end = Date.now() + 30_000;
  for (;;) {
    try { await call('get_version'); break; } catch (e) {
      if (dead || Date.now() > end) { child.kill(); throw dead ?? new Error('The Kusari engine did not start.'); }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return {
    dir: home,
    call,
    async close() {
      if (dead) return;
      const gone = new Promise((r) => child.once('exit', r));
      // stop_wallet saves the wallet file first.
      await call('stop_wallet', {}, undefined, 10_000).catch(() => undefined);
      await Promise.race([gone, new Promise((r) => setTimeout(r, 8000))]);
      if (!dead) child.kill();
    },
  };
}
