// Bitcoin's peer-to-peer protocol, as much as block-filter sync needs (BIP157): the handshake, finding peers that
// serve filters (addrv2, BIP155), headers, filter headers and checkpoints, filters, blocks, and handing over a
// transaction. Connections go over Tor to onion nodes, each on a route of its own.
import { randomBytes } from 'node:crypto';
import { Reader, Writer, type Link } from './dash-p2p';
import { dsha, fromHexLE, parseTx } from './btc-block';
import { BTC_P2P, type P2pNet } from './p2p-net';

const { sha3_256 } = require('@noble/hashes/sha3.js');

export const BTC_MAGIC = Buffer.from('f9beb4d9', 'hex');
export const BTC_PORT = 8333;
const PROTOCOL = 70016;
const MAX_PAYLOAD = 8 * 1024 * 1024; // the largest block, with room
export const NODE_NETWORK = 1n;
export const NODE_COMPACT_FILTERS = 1n << 6n;
export const NODE_NETWORK_LIMITED = 1n << 10n;
const MSG_WITNESS_BLOCK = 0x40000002;
const MSG_WITNESS_TX = 0x40000001;
/** A transaction's ID in its travelling order, or nothing for bytes that aren't one. */
const txidOf = (raw: Buffer): Buffer => { try { return Buffer.from(fromHexLE(parseTx(raw).txid)); } catch { return Buffer.alloc(0); } };

export function frame(command: string, payload: Buffer = Buffer.alloc(0), magic: Buffer = BTC_MAGIC): Buffer {
  const head = Buffer.alloc(24);
  magic.copy(head, 0);
  head.write(command, 4, 12, 'ascii');
  head.writeUInt32LE(payload.length, 16);
  Buffer.from(dsha(payload)).copy(head, 20, 0, 4);
  return Buffer.concat([head, payload]);
}

export class Unframer {
  constructor(private readonly net: P2pNet = BTC_P2P) {}
  private parts: Buffer[] = [];
  private size = 0;
  push(chunk: Buffer): { command: string; payload: Buffer }[] {
    this.parts.push(chunk); this.size += chunk.length;
    const out: { command: string; payload: Buffer }[] = [];
    for (;;) {
      if (this.size < 24) break;
      let buf = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
      this.parts = [buf];
      if (!buf.subarray(0, 4).equals(this.net.magic)) throw new Error(`The peer is not on the ${this.net.name} network.`);
      const len = buf.readUInt32LE(16);
      if (len > MAX_PAYLOAD) throw new Error(`The ${this.net.name} peer sent a message that is too large.`);
      if (buf.length < 24 + len) break;
      const payload = Buffer.from(buf.subarray(24, 24 + len));
      if (!Buffer.from(dsha(payload)).subarray(0, 4).equals(buf.subarray(20, 24))) throw new Error(`The ${this.net.name} peer sent a damaged message.`);
      const command = buf.subarray(4, 16).toString('ascii').replace(/\0+$/, '');
      buf = buf.subarray(24 + len);
      this.parts = buf.length ? [buf] : [];
      this.size = buf.length;
      out.push({ command, payload });
    }
    return out;
  }
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A Tor v3 onion name from its 32-byte key (as addrv2 carries it). */
export function onionFromKey(key: Uint8Array): string {
  if (key.length !== 32) throw new Error('bad onion key');
  const check = sha3_256(Buffer.concat([Buffer.from('.onion checksum'), Buffer.from(key), Buffer.from([3])])).subarray(0, 2);
  const all = Buffer.concat([Buffer.from(key), Buffer.from(check), Buffer.from([3])]);
  let bits = 0; let value = 0; let s = '';
  for (const byte of all) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { s += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) s += B32[(value << (5 - bits)) & 31];
  return `${s}.onion`;
}

export interface PeerAddress { host: string; port: number; services: bigint }

/** The onion peers in an addrv2 message (other networks are left out: over Tor, onion nodes keep exits out of it). */
export function readAddrV2(payload: Buffer, ipv4 = false): PeerAddress[] {
  const r = new Reader(payload);
  const out: PeerAddress[] = [];
  for (let n = r.count(8); n > 0; n--) {
    r.u32();
    // CompactSize services.
    const c = r.u8();
    const services = c < 0xfd ? BigInt(c) : c === 0xfd ? BigInt(r.u16()) : c === 0xfe ? BigInt(r.u32()) : r.u64();
    const net = r.u8();
    const addr = r.varbytes();
    const port = r.bytes(2).readUInt16BE(0);
    if (net === 4 && addr.length === 32 && port > 0) out.push({ host: onionFromKey(addr), port, services });
    else if (ipv4 && net === 1 && addr.length === 4 && port > 0 && publicIpv4(addr)) out.push({ host: Array.from(addr).join('.'), port, services });
  }
  return out;
}

/** A public IPv4 address (no private, loopback, link-local, shared or reserved ranges). */
function publicIpv4(a: Uint8Array): boolean {
  const [x, y] = a;
  return !(x === 0 || x === 10 || x === 127 || x >= 224 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127));
}

interface Waiter { commands: string[]; test?: (p: Buffer) => boolean; resolve: (m: { command: string; payload: Buffer }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class BtcPeer {
  private waiters: Waiter[] = [];
  private inbox: { command: string; payload: Buffer }[] = [];
  private closed: Error | null = null;
  private readonly unframer: Unframer;
  services = 0n;
  startHeight = 0;
  /** Bytes received, for the sync's progress and limits. */
  received = 0;

  constructor(private readonly link: Link, readonly host = '', readonly net: P2pNet = BTC_P2P) {
    this.unframer = new Unframer(net);
    link.onData((chunk) => {
      this.received += chunk.length;
      let msgs;
      try { msgs = this.unframer.push(chunk); } catch (e) { this.fail(e as Error); return; }
      for (const m of msgs) this.deliver(m);
    });
    link.onClose((e) => this.fail(e ?? new Error(`The ${this.net.name} peer closed the connection.`)));
  }

  private deliver(m: { command: string; payload: Buffer }): void {
    if (m.command === 'ping') { try { this.send('pong', m.payload.subarray(0, 8)); } catch { /* closing */ } return; }
    // Asked for headers by the peer: this client has none to give.
    if (m.command === 'getheaders') { try { this.send('headers', Buffer.from([0])); } catch { /* closing */ } return; }
    const i = this.waiters.findIndex((w) => w.commands.includes(m.command) && (!w.test || w.test(m.payload)));
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
      return;
    }
    if (/^(version|verack|headers|cfheaders|cfcheckpt|cfilter|block|addrv2|notfound|reject)$/.test(m.command)) {
      this.inbox.push(m);
      if (this.inbox.length > 1200) this.inbox.shift();
    }
  }

  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = e;
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(e); }
    try { this.link.close(); } catch { /* already gone */ }
  }

  get isClosed(): boolean { return this.closed !== null; }

  send(command: string, payload?: Buffer): void {
    if (this.closed) throw this.closed;
    this.link.write(frame(command, payload, this.net.magic));
  }

  next(commands: string[], timeoutMs: number, test?: (p: Buffer) => boolean): Promise<{ command: string; payload: Buffer }> {
    const i = this.inbox.findIndex((m) => commands.includes(m.command) && (!test || test(m.payload)));
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        commands, test, resolve, reject,
        timer: setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`The ${this.net.name} peer did not answer in time (${commands.join('/')}).`)); }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  /** Version both ways. No services offered, no transactions relayed to us, nothing about this device in it. */
  async handshake(timeoutMs = 45_000): Promise<void> {
    const w = new Writer().i32(PROTOCOL).u64(0n).i64(BigInt(Math.floor(Date.now() / 1000)));
    w.bytes(Buffer.alloc(26)).bytes(Buffer.alloc(26)).bytes(randomBytes(8));
    w.varbytes(Buffer.from('/')).i32(0).u8(0);
    this.send('version', w.done());
    const v = await this.next(['version'], timeoutMs);
    const r = new Reader(v.payload);
    const version = r.i32();
    this.services = r.u64();
    r.i64(); r.bytes(26); r.bytes(26); r.bytes(8); r.varbytes();
    this.startHeight = r.left >= 4 ? r.i32() : 0;
    if (version < 70015) throw new Error(`The ${this.net.name} peer runs a version too old.`);
    this.send('sendaddrv2');
    this.send('verack');
    await this.next(['verack'], timeoutMs);
  }

  get servesFilters(): boolean { return (this.services & NODE_COMPACT_FILTERS) !== 0n; }
  get fullHistory(): boolean { return (this.services & NODE_NETWORK) !== 0n; }

  async addresses(timeoutMs = 30_000): Promise<PeerAddress[]> {
    this.send('getaddr');
    const m = await this.next(['addrv2'], timeoutMs);
    return readAddrV2(m.payload, this.net.ipv4);
  }

  /** Up to 2000 headers after the first locator hash this peer knows. */
  async headers(locator: Uint8Array[], timeoutMs = 60_000): Promise<Buffer[]> {
    const w = new Writer().u32(PROTOCOL).varint(locator.length);
    for (const h of locator) w.bytes(h);
    w.bytes(Buffer.alloc(32));
    this.send('getheaders', w.done());
    const m = await this.next(['headers'], timeoutMs);
    const r = new Reader(m.payload);
    const out: Buffer[] = [];
    for (let n = r.count(81); n > 0; n--) { out.push(Buffer.from(r.bytes(80))); r.varint(); }
    if (out.length > 2000) throw new Error(`The ${this.net.name} peer sent too many headers.`);
    return out;
  }

  /** Filter headers at every thousandth block up to `stop`. */
  async filterCheckpoints(stop: Uint8Array, timeoutMs = 60_000): Promise<Buffer[]> {
    this.send('getcfcheckpt', new Writer().u8(0).bytes(stop).done());
    const m = await this.next(['cfcheckpt'], timeoutMs, (p) => p[0] === 0 && p.subarray(1, 33).equals(Buffer.from(stop)));
    const r = new Reader(m.payload); r.u8(); r.bytes(32);
    const out: Buffer[] = [];
    for (let n = r.count(32); n > 0; n--) out.push(Buffer.from(r.bytes(32)));
    return out;
  }

  /** The filter hashes from `start` to the block `stop` (at most 2000), and the filter header before them. */
  async filterHashes(start: number, stop: Uint8Array, timeoutMs = 60_000): Promise<{ prev: Buffer; hashes: Buffer[] }> {
    this.send('getcfheaders', new Writer().u8(0).u32(start).bytes(stop).done());
    const m = await this.next(['cfheaders'], timeoutMs, (p) => p[0] === 0 && p.subarray(1, 33).equals(Buffer.from(stop)));
    const r = new Reader(m.payload); r.u8(); r.bytes(32);
    const prev = Buffer.from(r.bytes(32));
    const hashes: Buffer[] = [];
    for (let n = r.count(32); n > 0; n--) hashes.push(Buffer.from(r.bytes(32)));
    return { prev, hashes };
  }

  /** The filters from `start` to the block `stop` (at most 1000), in order, each with its block hash. */
  async filters(start: number, stop: Uint8Array, count: number, timeoutMs = 120_000): Promise<{ block: Buffer; filter: Buffer }[]> {
    if (count < 1 || count > 1000) throw new Error('bad filter count');
    this.send('getcfilters', new Writer().u8(0).u32(start).bytes(stop).done());
    const out: { block: Buffer; filter: Buffer }[] = [];
    for (let i = 0; i < count; i++) {
      const m = await this.next(['cfilter'], timeoutMs);
      const r = new Reader(m.payload);
      if (r.u8() !== 0) throw new Error(`The ${this.net.name} peer sent the wrong kind of filter.`);
      out.push({ block: Buffer.from(r.bytes(32)), filter: Buffer.from(r.varbytes()) });
    }
    return out;
  }

  async block(hash: Uint8Array, timeoutMs = 180_000): Promise<Buffer> {
    this.send('getdata', new Writer().varint(1).u32(MSG_WITNESS_BLOCK).bytes(hash).done());
    const m = await this.next(['block', 'notfound'], timeoutMs);
    if (m.command === 'notfound') throw new Error(`The ${this.net.name} peer does not have that block.`);
    return m.payload;
  }

  /** Hands over a signed transaction. Peers accept it unasked; it then spreads like any other. */
  sendTx(raw: Buffer): void {
    this.send('tx', raw);
  }

  /**
   * Whether the peer has a transaction (`txidLE`: the ID in its travelling order). A node hands out a waiting
   * transaction to anyone only once it has been in its pool a couple of minutes, so ask after that.
   */
  async hasTx(txidLE: Uint8Array, timeoutMs = 60_000): Promise<boolean> {
    const id = Buffer.from(txidLE);
    this.send('getdata', new Writer().varint(1).u32(MSG_WITNESS_TX).bytes(txidLE).done());
    const m = await this.next(['tx', 'notfound'], timeoutMs, (p) => p.includes(id) || txidOf(p).equals(id));
    return m.command === 'tx';
  }

  close(): void { this.fail(new Error('Closed.')); }
}
