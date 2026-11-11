// Plain TCP for the Dash peer-to-peer network: straight out, or through Tor's SOCKS port, which then picks the
// route and resolves names. With Tor on there is never a direct fallback.
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Dial, Link } from './dash-p2p';

const { SocksClient } = require('socks');

function wrap(sock: net.Socket): Link {
  sock.setNoDelay(true);
  return {
    write: (b) => { sock.write(b); },
    close: () => { sock.destroy(); },
    onData: (cb) => { sock.on('data', cb); },
    onClose: (cb) => {
      let err: Error | undefined;
      sock.on('error', (e) => { err = e; });
      sock.on('close', () => cb(err));
    },
  };
}

/** `socks` is the Tor proxy as socks5h://host:port, or undefined to connect directly. */
export function tcpDial(socks?: string, timeoutMs = 30_000): Dial {
  return async (host, port) => {
    if (socks) {
      const u = new URL(socks);
      // A login of its own puts every connection on a separate Tor route.
      const { socket } = await SocksClient.createConnection({
        proxy: { host: u.hostname, port: Number(u.port), type: 5, userId: randomBytes(8).toString('hex'), password: 'x' },
        command: 'connect', destination: { host, port }, timeout: timeoutMs,
      });
      return wrap(socket);
    }
    return new Promise<Link>((resolve, reject) => {
      const sock = net.connect({ host, port });
      const t = setTimeout(() => { sock.destroy(); reject(new Error('Could not connect to the Dash node in time.')); }, timeoutMs);
      sock.once('connect', () => { clearTimeout(t); resolve(wrap(sock)); });
      sock.once('error', (e) => { clearTimeout(t); reject(e); });
    });
  };
}
