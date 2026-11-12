// All outside traffic leaves through the native forwarder, because WebView CORS blocks wallet nodes.
export function route(url: string): string {
  const u = new URL(url);
  if (u.hostname === '127.0.0.1') return url.replace(/\/$/, '');
  const upstream = u.origin;
  const port: number = (window as any).VaultNative.proxyPort(upstream);
  if (!port) throw new Error('Could not start the network connection.');
  return `http://127.0.0.1:${port}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
}

export function socksAgent(): undefined { return undefined; }

/** The forwarder keeps each host on its own Tor route; this moves them all to new ones. */
export function newTorRoute(_agent?: unknown): void { (window as any).VaultNative.torNewRoute(); }

export async function getJson(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<any> {
  const res = await fetch(route(url), { headers: opts.headers, signal: AbortSignal.timeout(Math.max(opts.timeoutMs ?? 30_000, 45_000)) });
  if (!res.ok) throw new Error(`Server error (${res.status})`);
  return res.json();
}

export async function requestJson(url: string, opts: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number; headers?: Record<string, string>; plain?: boolean; route?: string } = {}): Promise<{ status: number; body: any }> {
  // A route name gets its own Tor route in the forwarder, which then sends only the plain headers (see LocalProxy).
  const routing: Record<string, string> = opts.route ? { 'X-Kusari-Route': opts.route } : {};
  const res = await fetch(route(url), {
    method: opts.method ?? 'GET',
    headers: { Accept: 'application/json', ...(opts.body === undefined ? {} : { 'Content-Type': opts.plain ? 'application/json; charset=utf-8' : 'application/json' }), ...opts.headers, ...routing },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(Math.max(opts.timeoutMs ?? 30_000, 45_000)),
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

export async function requestText(url: string, opts: { method: 'POST'; body: string; timeoutMs?: number }): Promise<string> {
  const res = await fetch(route(url), { method: opts.method, headers: { 'Content-Type': 'text/plain' }, body: opts.body, signal: AbortSignal.timeout(Math.max(opts.timeoutMs ?? 30_000, 45_000)) });
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 200) || `Server error (${res.status})`);
  return text;
}

export async function requestForm(url: string, opts: { method: 'GET' | 'POST' | 'DELETE'; form?: string; json?: string; timeoutMs?: number }): Promise<{ status: number; body: any }> {
  const res = await fetch(route(url), {
    method: opts.method,
    headers: { Accept: 'application/json', ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : opts.form === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    body: opts.json ?? opts.form,
    signal: AbortSignal.timeout(Math.max(opts.timeoutMs ?? 30_000, 45_000)),
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body };
}

export async function requestBytes(url: string, opts: { body: Uint8Array; contentType: string; timeoutMs?: number }): Promise<string> {
  const res = await fetch(route(url), { method: 'POST', headers: { 'Content-Type': opts.contentType }, body: opts.body, signal: AbortSignal.timeout(Math.max(opts.timeoutMs ?? 30_000, 45_000)) });
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 300) || `Server error (${res.status})`);
  return text;
}
