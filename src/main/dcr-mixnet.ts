// Mixing's network side: a few connections to Decred nodes (over Tor when it's on, each on its own route), where
// mixing messages are announced, fetched and sent. Nodes are found through Decred's HTTPS seeders, as dcrd finds them.
// Nothing about this wallet goes into the version message; no transactions are relayed to it.
import { randomBytes } from 'node:crypto';
import type { Dial, Link } from './dash-p2p';
import { DcrTx, dcrTxid, serializeDcrTx } from './dcr';
import {
  INV_TYPE_MIX, MIX_COMMANDS, MIX_VERSION, MixMsg, NET_MAGIC, Unframer, decodeMix, encodeMix, frame, hashString, invPayload, readInv, readVersion, versionPayload,
} from './dcr-wire';
import { MissingPRError, MixNet, MixPool } from './dcr-mix';
import { requestRaw } from './request';

export const DCR_SEEDERS = ['mainnet-seed-1.decred.org', 'mainnet-seed-2.decred.org', 'mainnet-seed.jholdstock.uk']; // dcrd's mainnet seeders
const NODE_NETWORK = 1;

/** Nodes from an HTTPS seeder: JSON values one after another, each {host, services, pver}. */
export function parseSeeder(text: string): { host: string; port: number }[] {
  let items: any[] = [];
  try { const j = JSON.parse(text); items = Array.isArray(j) ? j : [j]; } catch {
    items = text.split(/\n+/).map((l) => l.trim()).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }
  const out: { host: string; port: number }[] = [];
  for (const n of items.slice(0, 16)) {
    if (typeof n?.host !== 'string' || Number(n.pver) < MIX_VERSION) continue;
    const m = n.host.match(/^\[?([0-9a-fA-F:.]+)\]?:(\d{1,5})$/);
    if (m) out.push({ host: m[1], port: Number(m[2]) });
  }
  return out;
}

class Conn {
  private readonly unframer: Unframer;
  ready = false;
  closed = false;
  constructor(private readonly link: Link, private readonly magic: number, readonly name: string, onMsg: (c: Conn, cmd: string, p: Buffer) => void, onClose: (c: Conn) => void) {
    this.unframer = new Unframer(magic);
    link.onData((chunk) => {
      let msgs;
      try { msgs = this.unframer.push(chunk); } catch { this.close(); return; }
      for (const m of msgs) onMsg(this, m.command, m.payload);
    });
    link.onClose(() => { this.closed = true; onClose(this); });
  }
  send(cmd: string, payload?: Uint8Array): void { if (!this.closed) try { this.link.write(frame(this.magic, cmd, payload)); } catch { this.close(); } }
  close(): void { if (!this.closed) { this.closed = true; try { this.link.close(); } catch { /* gone */ } } }
}

export interface MixNetOpts {
  net: 'mainnet' | 'simnet';
  dial: Dial;
  /** Fixed nodes (a local simnet, or the person's own node); otherwise the seeders are asked. */
  nodes?: { host: string; port: number }[];
  seedAgent?: any;
  height: () => number;
  peers?: number;
  /** A backup for sending the mix transaction (the wallet's server). */
  publishBackup?: (hex: string, id: string) => Promise<void>;
  log?: (s: string) => void;
}

export class MixNetwork implements MixNet {
  private conns = new Set<Conn>();
  private asked = new Set<string>();
  private stopped = false;
  private readonly magic: number;
  pool: MixPool | null = null;

  constructor(private readonly o: MixNetOpts) { this.magic = NET_MAGIC[o.net]; }

  private log(s: string) { this.o.log?.(s); }

  async start(pool: MixPool): Promise<void> {
    this.pool = pool;
    await this.fill();
    const t = setInterval(() => { if (this.stopped) clearInterval(t); else void this.fill().catch(() => undefined); }, 60_000);
    (t as any).unref?.();
  }

  stop(): void { this.stopped = true; for (const c of this.conns) c.close(); this.conns.clear(); }

  get connected(): number { return [...this.conns].filter((c) => c.ready).length; }

  private async candidates(): Promise<{ host: string; port: number }[]> {
    if (this.o.nodes?.length) return this.o.nodes;
    const out: { host: string; port: number }[] = [];
    for (const s of DCR_SEEDERS) {
      try {
        const r = await requestRaw(`https://${s}/api/addrs?services=${NODE_NETWORK}&pver=${MIX_VERSION}`, { method: 'GET', agent: this.o.seedAgent, timeoutMs: 45_000, route: 'dcr-seed' });
        if (r.status === 200) out.push(...parseSeeder(r.text));
      } catch { /* the next seeder */ }
    }
    return out.sort(() => Math.random() - 0.5);
  }

  /** Keeps a few nodes connected. */
  private async fill(): Promise<void> {
    const want = this.o.peers ?? 3;
    if (this.stopped || this.connected >= want) return;
    const list = await this.candidates();
    for (const n of list) {
      if (this.stopped || this.conns.size >= want) break;
      const name = `${n.host}:${n.port}`;
      if ([...this.conns].some((c) => c.name === name)) continue;
      try { await this.connect(n.host, n.port); } catch (e) { this.log(`node ${name}: ${(e as Error).message}`); }
    }
  }

  private async connect(host: string, port: number): Promise<void> {
    const link = await this.o.dial(host, port);
    let verack!: () => void; let failed!: (e: Error) => void;
    const shook = new Promise<void>((res, rej) => { verack = res; failed = rej; });
    const c = new Conn(link, this.magic, `${host}:${port}`, (conn, cmd, p) => {
      try { this.onMessage(conn, cmd, p, verack); } catch (e) { this.log(`message ${cmd}: ${(e as Error).message}`); }
    }, (conn) => { this.conns.delete(conn); failed(new Error('closed')); });
    this.conns.add(c);
    // Height 0: this client has no blocks to serve, and a node that thinks it does picks it to sync headers from,
    // then drops it when none come (dcrd's 10-second header stall).
    c.send('version', versionPayload(0, randomBytes(8)));
    const t = setTimeout(() => failed(new Error('no handshake in time')), 45_000);
    try { await shook; } catch (e) { c.close(); this.conns.delete(c); throw e; } finally { clearTimeout(t); }
    c.ready = true;
  }

  private onMessage(c: Conn, cmd: string, p: Buffer, verack: () => void): void {
    switch (cmd) {
      case 'version': {
        const v = readVersion(p);
        if (v.version < MIX_VERSION) { c.close(); return; }
        c.send('verack');
        return;
      }
      case 'verack': verack(); return;
      case 'ping': c.send('pong', p.subarray(0, 8)); return;
      case 'getheaders': c.send('headers', Buffer.from([0])); return; // none: this client keeps no chain
      case 'inv': {
        const want = readInv(p).filter((i) => i.type === INV_TYPE_MIX).map((i) => i.hash).filter((h) => {
          const s = hashString(h);
          if (this.asked.has(s) || this.pool?.has(s)) return false;
          this.asked.add(s);
          return true;
        });
        if (this.asked.size > 50_000) this.asked.clear();
        if (want.length) c.send('getdata', invPayload(want.map((hash) => ({ type: INV_TYPE_MIX, hash }))));
        return;
      }
      default:
        if (MIX_COMMANDS.includes(cmd) && this.pool) {
          const m = decodeMix(cmd, p);
          try { this.pool.accept(m); } catch (e) {
            if (e instanceof MissingPRError) c.send('getdata', invPayload([{ type: INV_TYPE_MIX, hash: e.pr }]));
            else this.log(`refused ${cmd} from ${c.name}: ${(e as Error).message}`);
          }
        }
    }
  }

  broadcast(m: MixMsg): void {
    const payload = encodeMix(m);
    for (const c of this.conns) if (c.ready) c.send(m.cmd, payload);
  }

  async publish(tx: DcrTx): Promise<void> {
    const raw = serializeDcrTx(tx);
    let sent = 0;
    for (const c of this.conns) if (c.ready) { c.send('tx', raw); sent++; }
    if (this.o.publishBackup) {
      await this.o.publishBackup(Buffer.from(raw).toString('hex'), dcrTxid(tx)).catch((e: Error) => { if (!sent) throw e; });
    }
  }
}
