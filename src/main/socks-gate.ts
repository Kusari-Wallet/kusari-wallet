// A local SOCKS5 gateway between an engine (Zano, Kusari, Zcash, Pirate Chain...) and Tor. Engines reach their node
// over one SOCKS port without a login, so Tor would keep them on the same circuit for the whole session. The gateway
// logs in to Tor with a name of its own and changes it when asked: Tor puts streams with different logins on
// different circuits, so after renew() the engine's next connection (a send) goes out on a fresh route. Open
// connections are closed on renew, so the engine reconnects on the new one. Nothing ever goes out except to Tor.
import net from 'node:net';
import { randomBytes } from 'node:crypto';

export class SocksGate {
  private server: net.Server | null = null;
  private login = randomBytes(12).toString('hex');
  private readonly open = new Set<net.Socket>();
  port = 0;

  constructor(private readonly torPort: number, private readonly torHost = '127.0.0.1') {}

  async start(): Promise<number> {
    if (this.server) return this.port;
    const server = net.createServer((client) => this.serve(client));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.port = (server.address() as net.AddressInfo).port;
    return this.port;
  }

  /** A new Tor login: every connection from here on gets its own circuit; the open ones are closed. */
  renew(): void {
    this.login = randomBytes(12).toString('hex');
    for (const s of this.open) s.destroy();
    this.open.clear();
  }

  close(): void {
    this.renew();
    this.server?.close();
    this.server = null;
  }

  private track(s: net.Socket): void {
    this.open.add(s);
    s.once('close', () => this.open.delete(s));
  }

  private serve(client: net.Socket): void {
    this.track(client);
    client.on('error', () => client.destroy());
    const login = this.login;
    let buf = Buffer.alloc(0);
    let stage: 'hello' | 'request' | 'done' = 'hello';
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 600) { client.destroy(); return; }
      if (stage === 'hello') {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        if (buf[0] !== 5) { client.destroy(); return; }
        const methods = buf.subarray(2, 2 + buf[1]);
        buf = buf.subarray(2 + methods.length);
        if (!methods.includes(0)) { client.end(Buffer.from([5, 0xff])); return; }
        client.write(Buffer.from([5, 0]));
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const len = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + buf[4] : -1;
        if (buf[0] !== 5 || buf[1] !== 1 || len < 0) { client.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        if (buf.length < 4 + len + 2) return;
        const request = Buffer.from(buf.subarray(0, 4 + len + 2));
        const rest = Buffer.from(buf.subarray(4 + len + 2));
        stage = 'done';
        client.off('data', onData);
        client.pause();
        this.forward(client, request, rest, login);
      }
    };
    client.on('data', onData);
  }

  /** The same request to Tor, logged in with this route's name; then the two are joined. */
  private forward(client: net.Socket, request: Buffer, early: Buffer, login: string): void {
    const tor = net.connect(this.torPort, this.torHost);
    this.track(tor);
    const fail = (): void => { if (!client.destroyed) client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])); tor.destroy(); };
    tor.on('error', fail);
    let buf = Buffer.alloc(0);
    let stage: 'hello' | 'auth' | 'reply' = 'hello';
    const user = Buffer.from(login);
    tor.on('connect', () => tor.write(Buffer.from([5, 1, 2])));
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'hello') {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 2) { fail(); return; }
        buf = buf.subarray(2);
        tor.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([user.length]), user]));
        stage = 'auth';
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0) { fail(); return; }
        buf = buf.subarray(2);
        tor.write(request);
        stage = 'reply';
      }
      if (stage === 'reply') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const len = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? 1 + buf[4] : -1;
        if (len < 0) { fail(); return; }
        if (buf.length < 4 + len + 2) return;
        tor.off('data', onData);
        const reply = buf.subarray(0, 4 + len + 2);
        const after = buf.subarray(4 + len + 2);
        client.write(reply);
        if (reply[1] !== 0) { client.end(); tor.destroy(); return; }
        if (after.length) client.write(after);
        if (early.length) tor.write(early);
        client.pipe(tor);
        tor.pipe(client);
        client.resume();
      }
    };
    tor.on('data', onData);
    client.on('close', () => tor.destroy());
    tor.on('close', () => client.destroy());
  }
}
