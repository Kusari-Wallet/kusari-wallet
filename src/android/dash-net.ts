// Plain TCP for the Dash peer-to-peer network on Android: the page can't open sockets, so the app does, and
// passes bytes back and forth. The app routes them through Tor whenever Tor is on, and never directly then.
import type { Dial, Link } from '../main/dash-p2p';

const native = () => (window as any).VaultNative;
const links = new Map<number, { data: (b: Buffer) => void; close: (e?: Error) => void; opened: (ok: boolean, err: string) => void }>();
let next = 1;

(window as any).__tcp = (id: number, kind: string, value: string) => {
  const l = links.get(id);
  if (!l) return;
  if (kind === 'o') l.opened(true, '');
  else if (kind === 'd') l.data(Buffer.from(value, 'base64'));
  else { links.delete(id); l.opened(false, value); l.close(value ? new Error(value) : undefined); }
};

/** `socks` set means Tor is on: the app then refuses to connect unless it routes through Tor. */
export function tcpDial(socks?: string, timeoutMs = 30_000): Dial {
  return (host, port) => new Promise<Link>((resolve, reject) => {
    const id = next++;
    const pending: Buffer[] = [];
    let onData: ((b: Buffer) => void) | null = null;
    let onClose: ((e?: Error) => void) | null = null;
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; native().tcpClose(id); links.delete(id); reject(new Error('Could not connect to the Dash node in time.')); } }, timeoutMs);
    links.set(id, {
      data: (b) => { if (onData) onData(b); else pending.push(b); },
      close: (e) => onClose?.(e),
      opened: (ok, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        if (!ok) { reject(new Error(err || 'Could not connect to the Dash node.')); return; }
        resolve({
          write: (b) => { native().tcpWrite(id, b.toString('base64')); },
          close: () => { native().tcpClose(id); },
          onData: (cb) => { onData = cb; for (const b of pending.splice(0)) cb(b); },
          onClose: (cb) => { onClose = cb; },
        });
      },
    });
    if (!native().tcpOpen(id, host, port, Boolean(socks))) { settled = true; clearTimeout(t); links.delete(id); reject(new Error('This build cannot open Dash connections.')); }
  });
}
