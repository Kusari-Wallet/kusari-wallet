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

export async function getJson(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<any> {
  const res = await fetch(route(url), { headers: opts.headers, signal: AbortSignal.timeout(Math.max(opts.timeoutMs ?? 30_000, 45_000)) });
  if (!res.ok) throw new Error(`Server error (${res.status})`);
  return res.json();
}

export async function requestJson(url: string, opts: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(route(url), {
    method: opts.method ?? 'GET',
    headers: { Accept: 'application/json', ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...opts.headers },
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
