import http from 'node:http';
import https from 'node:https';
import type { Agent } from 'node:http';
import { SocksProxyAgent } from 'socks-proxy-agent';

/** socks5h: the proxy resolves hostnames, so no DNS query leaves this PC. */
export function socksAgent(proxyUri: string): SocksProxyAgent {
  const { host } = new URL(proxyUri);
  // A new connection per request: a kept one can stall inside a Tor circuit and only show up as a timeout.
  return new SocksProxyAgent(`socks5h://${host}`, { keepAlive: false, timeout: 60_000 });
}

/** For APIs that report problems in the response body: returns the status instead of throwing on it. */
export function requestJson(url: string, opts: { method?: 'GET' | 'POST'; body?: unknown; agent?: Agent; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'KusariWallet', ...opts.headers };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(payload)); }
    const req = lib.request(url, { method: opts.method ?? 'GET', headers, agent: opts.agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let body: any = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 500, body });
      });
      res.on('error', reject);
    });
    req.setTimeout(opts.timeoutMs ?? 30_000, () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Plain text in both directions, for a raw transaction broadcast. Rejects on an error status. */
export function requestText(url: string, opts: { method: 'POST'; body: string; agent?: Agent; timeoutMs?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, { method: opts.method, headers: { 'Content-Type': 'text/plain', 'Content-Length': String(Buffer.byteLength(opts.body)), 'User-Agent': 'KusariWallet' }, agent: opts.agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 400) reject(new Error(text.slice(0, 200) || `Server error (${res.statusCode})`));
        else resolve(text);
      });
      res.on('error', reject);
    });
    req.setTimeout(opts.timeoutMs ?? 30_000, () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end(opts.body);
  });
}

export function getJson(url: string, opts: { headers?: Record<string, string>; agent?: Agent; timeoutMs?: number } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: opts.headers, agent: opts.agent }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) { req.destroy(new Error('The answer is too large.')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) { reject(new Error(`Server error (${res.statusCode})`)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Could not read the answer.')); }
      });
      res.on('error', reject);
    });
    req.setTimeout(opts.timeoutMs ?? 30_000, () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}
