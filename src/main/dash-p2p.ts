// Dash's peer-to-peer protocol, as much as CoinJoin needs: the message envelope, the version handshake, the
// masternode list (mnlistdiff) and reading and writing the plain transactions mixing deals in.
import { randomBytes } from 'node:crypto';

const { sha256: sha256Bytes } = require('@noble/hashes/sha2.js');

export const DASH_MAGIC = Buffer.from('bf0c6bbd', 'hex');
export const DASH_PORT = 9999;
/**
 * The version this client speaks. Below 70234, a masternode pushes CoinJoin queues to us directly instead of
 * announcing them, which a client connected to that one masternode only needs. 70233 still gets every
 * mnlistdiff field this file reads, and masternodes accept anything from 70221 up.
 */
export const DASH_PROTOCOL = 70233;
const USER_AGENT = '/Kusari:1.0/';
const MAX_PAYLOAD = 32 * 1024 * 1024;

export const sha256 = (b: Uint8Array): Buffer => Buffer.from(sha256Bytes(b));
export const dsha = (b: Uint8Array): Buffer => sha256(sha256(b));
/** A hash in the byte order it travels in, written the way explorers show it. */
export const hashHex = (b: Uint8Array): string => Buffer.from(b).reverse().toString('hex');
export const hashBytes = (hex: string): Buffer => Buffer.from(hex, 'hex').reverse();
/** A uniform whole number below `n`, from the system's random source. */
export function randomBelow(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new Error('bad range');
  const limit = Math.floor(2 ** 32 / n) * n;
  for (;;) { const v = randomBytes(4).readUInt32LE(0); if (v < limit) return v % n; }
}

// ---- writing and reading ----

export class Writer {
  private parts: Buffer[] = [];
  bytes(b: Uint8Array): this { this.parts.push(Buffer.from(b)); return this; }
  u8(n: number): this { return this.bytes(Buffer.from([n])); }
  u16(n: number): this { const b = Buffer.alloc(2); b.writeUInt16LE(n); return this.bytes(b); }
  u32(n: number): this { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return this.bytes(b); }
  i32(n: number): this { const b = Buffer.alloc(4); b.writeInt32LE(n); return this.bytes(b); }
  u64(n: bigint): this { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return this.bytes(b); }
  i64(n: bigint): this { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return this.bytes(b); }
  varint(n: number): this {
    if (n < 0xfd) return this.u8(n);
    if (n <= 0xffff) return this.u8(0xfd).u16(n);
    return this.u8(0xfe).u32(n);
  }
  varbytes(b: Uint8Array): this { return this.varint(b.length).bytes(b); }
  done(): Buffer { return Buffer.concat(this.parts); }
}

export class Reader {
  at = 0;
  constructor(readonly buf: Buffer) {}
  get left(): number { return this.buf.length - this.at; }
  bytes(n: number): Buffer {
    if (n < 0 || this.at + n > this.buf.length) throw new Error('A Dash message was shorter than it said.');
    const b = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return b;
  }
  u8(): number { return this.bytes(1)[0]; }
  u16(): number { return this.bytes(2).readUInt16LE(); }
  u32(): number { return this.bytes(4).readUInt32LE(); }
  i32(): number { return this.bytes(4).readInt32LE(); }
  u64(): bigint { return this.bytes(8).readBigUInt64LE(); }
  i64(): bigint { return this.bytes(8).readBigInt64LE(); }
  varint(): number {
    const c = this.u8();
    if (c < 0xfd) return c;
    if (c === 0xfd) return this.u16();
    if (c === 0xfe) return this.u32();
    const v = this.u64();
    if (v > BigInt(MAX_PAYLOAD)) throw new Error('A Dash message gave a size that is too large.');
    return Number(v);
  }
  /** A count of items, refused when the message can't hold that many of at least `min` bytes each. */
  count(min = 1): number {
    const n = this.varint();
    if (n * min > this.left) throw new Error('A Dash message gave a count that is too large.');
    return n;
  }
  varbytes(): Buffer { return this.bytes(this.count(1)); }
}

// ---- transactions ----

export interface TxIn { txid: string; vout: number; script: Buffer; sequence: number }
export interface TxOut { value: bigint; script: Buffer }
export interface DashTx { version: number; type: number; inputs: TxIn[]; outputs: TxOut[]; lockTime: number; payload?: Buffer }

export function writeIn(w: Writer, i: TxIn): Writer {
  return w.bytes(hashBytes(i.txid)).u32(i.vout).varbytes(i.script).u32(i.sequence);
}

export function readIn(r: Reader): TxIn {
  const txid = hashHex(r.bytes(32));
  return { txid, vout: r.u32(), script: Buffer.from(r.varbytes()), sequence: r.u32() };
}

/** Dash puts a special transaction's type in the version's upper half and its payload at the end. */
export function writeTx(w: Writer, tx: DashTx): Writer {
  w.u16(tx.version).u16(tx.type).varint(tx.inputs.length);
  for (const i of tx.inputs) writeIn(w, i);
  w.varint(tx.outputs.length);
  for (const o of tx.outputs) w.u64(o.value).varbytes(o.script);
  w.u32(tx.lockTime);
  if (tx.version >= 3 && tx.type !== 0) w.varbytes(tx.payload ?? Buffer.alloc(0));
  return w;
}

export function readTx(r: Reader): DashTx {
  const version = r.u16();
  const type = r.u16();
  const inputs: TxIn[] = [];
  for (let n = r.count(41); n > 0; n--) inputs.push(readIn(r));
  const outputs: TxOut[] = [];
  for (let n = r.count(9); n > 0; n--) outputs.push({ value: r.u64(), script: Buffer.from(r.varbytes()) });
  const lockTime = r.u32();
  const payload = version >= 3 && type !== 0 ? Buffer.from(r.varbytes()) : undefined;
  return { version, type, inputs, outputs, lockTime, payload };
}

export const txBytes = (tx: DashTx): Buffer => writeTx(new Writer(), tx).done();
export const txId = (tx: DashTx): string => hashHex(dsha(txBytes(tx)));

/** BIP69: inputs by previous transaction (as shown) then index, outputs by amount then script. Mixing requires it. */
export const bip69In = (a: TxIn, b: TxIn): number => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout);
export const bip69Out = (a: TxOut, b: TxOut): number => (a.value < b.value ? -1 : a.value > b.value ? 1 : Buffer.compare(a.script, b.script));

// ---- the envelope ----

export function frame(command: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(24);
  DASH_MAGIC.copy(head, 0);
  head.write(command, 4, 12, 'ascii');
  head.writeUInt32LE(payload.length, 16);
  dsha(payload).copy(head, 20, 0, 4);
  return Buffer.concat([head, payload]);
}

/** Splits a byte stream into messages, refusing anything that isn't well formed. */
export class Unframer {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): { command: string; payload: Buffer }[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: { command: string; payload: Buffer }[] = [];
    while (this.buf.length >= 24) {
      if (!this.buf.subarray(0, 4).equals(DASH_MAGIC)) throw new Error('The Dash peer is not on the Dash network.');
      const len = this.buf.readUInt32LE(16);
      if (len > MAX_PAYLOAD) throw new Error('The Dash peer sent a message that is too large.');
      if (this.buf.length < 24 + len) break;
      const payload = Buffer.from(this.buf.subarray(24, 24 + len));
      if (!dsha(payload).subarray(0, 4).equals(this.buf.subarray(20, 24))) throw new Error('The Dash peer sent a damaged message.');
      const command = this.buf.subarray(4, 16).toString('ascii').replace(/\0+$/, '');
      this.buf = this.buf.subarray(24 + len);
      out.push({ command, payload });
    }
    return out;
  }
}

// ---- a connection ----

/** A plain byte pipe: a TCP socket here, through Tor or not, or the Android side's socket. */
export interface Link {
  write(b: Buffer): void;
  close(): void;
  onData(cb: (b: Buffer) => void): void;
  onClose(cb: (e?: Error) => void): void;
}
export type Dial = (host: string, port: number) => Promise<Link>;

interface Waiter { commands: string[]; test?: (payload: Buffer) => boolean; resolve: (m: { command: string; payload: Buffer }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class DashPeer {
  private waiters: Waiter[] = [];
  private inbox: { command: string; payload: Buffer }[] = [];
  private closed: Error | null = null;
  private readonly unframer = new Unframer();
  peerVersion = 0;

  constructor(private readonly link: Link) {
    link.onData((chunk) => {
      let msgs;
      try { msgs = this.unframer.push(chunk); } catch (e) { this.fail(e as Error); return; }
      for (const m of msgs) this.deliver(m);
    });
    link.onClose((e) => this.fail(e ?? new Error('The Dash peer closed the connection.')));
  }

  private deliver(m: { command: string; payload: Buffer }): void {
    if (m.command === 'ping') { this.send('pong', m.payload.subarray(0, 8)); return; }
    const i = this.waiters.findIndex((w) => w.commands.includes(m.command) && (!w.test || w.test(m.payload)));
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
      return;
    }
    // Kept for a later wait, within reason: a busy node announces plenty this client never asked for.
    if (/^(ds|mnlistdiff|version|verack|headers|reject)/.test(m.command)) {
      this.inbox.push(m);
      if (this.inbox.length > 200) this.inbox.shift();
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
    this.link.write(frame(command, payload));
  }

  /** The next message with one of these commands (and passing `test`), including one that already came. */
  next(commands: string[], timeoutMs: number, test?: (payload: Buffer) => boolean): Promise<{ command: string; payload: Buffer }> {
    const i = this.inbox.findIndex((m) => commands.includes(m.command) && (!test || test(m.payload)));
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        commands, test, resolve, reject,
        timer: setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error(`The Dash peer did not answer in time (${commands.join('/')}).`)); }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  /**
   * Version and verack both ways. `toMasternode` says so in our version message, as Dash Core's own mixing
   * connections do: the masternode then sends nothing but what mixing needs.
   */
  async handshake(host: string, port: number, toMasternode: boolean, timeoutMs = 30_000): Promise<void> {
    const w = new Writer().i32(DASH_PROTOCOL).u64(0n).i64(BigInt(Math.floor(Date.now() / 1000)));
    w.bytes(netAddr(host, port)).bytes(netAddr('0.0.0.0', 0)).bytes(randomBytes(8));
    w.varbytes(Buffer.from(USER_AGENT)).i32(0).u8(0).bytes(randomBytes(32)).u8(toMasternode ? 1 : 0);
    this.send('version', w.done());
    const v = await this.next(['version'], timeoutMs);
    this.peerVersion = v.payload.readInt32LE(0);
    if (this.peerVersion < 70221) throw new Error('The Dash peer runs a version too old to mix with.');
    this.send('verack');
    await this.next(['verack'], timeoutMs);
  }

  close(): void { this.fail(new Error('Closed.')); }
}

/** A version message's address field: services, an IPv6 or IPv4-mapped address, the port in network order. */
function netAddr(host: string, port: number): Buffer {
  const b = Buffer.alloc(26);
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) { b[18] = 0xff; b[19] = 0xff; for (let i = 0; i < 4; i++) b[20 + i] = Number(v4[i + 1]); }
  b.writeUInt16BE(port, 24);
  return b;
}

// ---- the masternode list ----

export interface Masternode {
  proTxHash: string;
  host: string;
  port: number;
  operatorKey: Buffer;
  legacyKey: boolean;
  valid: boolean;
  type: number;
}

export interface MasternodeList {
  blockHash: string;
  /** The block's coinbase transaction ID, which carries the list's merkle root. */
  coinbase: string;
  height: number;
  masternodes: Masternode[];
}

/** A legacy CService: 16 address bytes (IPv4 mapped into IPv6) and a big-endian port. */
function readService(r: Reader): { host: string; port: number } {
  const a = r.bytes(16);
  const port = r.bytes(2).readUInt16BE();
  return { host: ipText(a), port };
}

function ipText(a: Buffer): string {
  const mapped = a.subarray(0, 10).every((x) => x === 0) && a[10] === 0xff && a[11] === 0xff;
  if (mapped) return `${a[12]}.${a[13]}.${a[14]}.${a[15]}`;
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(a.readUInt16BE(i).toString(16));
  return parts.join(':');
}

/** An address in the newer list form (BIP155 with a type byte first); only IPv4 and IPv6 are usable here. */
function readExtEntry(r: Reader): { host: string; port: number } | null {
  const type = r.u8();
  if (type === 0x01) {
    const net = r.u8();
    const addr = r.varbytes();
    const port = r.bytes(2).readUInt16BE();
    if (net === 1 && addr.length === 4) return { host: `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`, port };
    if (net === 2 && addr.length === 16) return { host: ipText(addr), port };
    return null;
  }
  if (type === 0x02) { r.varbytes(); r.bytes(2); return null; } // a domain name, for Platform only
  return null;
}

/** One entry of the simplified list, plus its bytes as hashed for the list's merkle root. */
export function readListEntry(r: Reader): { mn: Masternode | null; hashed: Buffer; proTxHash: Buffer } {
  const version = r.u16();
  const start = r.at;
  const proTxHash = Buffer.from(r.bytes(32));
  r.bytes(32); // confirmedHash
  let service: { host: string; port: number } | null = null;
  if (version >= 3) {
    const netVersion = r.u8();
    if (netVersion === 0 || netVersion > 1) throw new Error('The masternode list uses an address format this wallet does not know.');
    let lastPurpose = -1;
    for (let p = r.count(2); p > 0; p--) {
      const purpose = r.u8();
      if (purpose > 2 || purpose <= lastPurpose) throw new Error('The masternode list has a damaged address entry.');
      lastPurpose = purpose;
      for (let e = r.count(1); e > 0; e--) {
        const one = readExtEntry(r);
        if (purpose === 0 && one && !service) service = one;
      }
    }
  } else {
    service = readService(r);
  }
  const operatorKey = Buffer.from(r.bytes(48));
  r.bytes(20); // voting key
  const valid = r.u8() !== 0;
  let type = 0;
  if (version >= 2) {
    type = r.u16();
    if (type === 1) {
      if (version < 3) r.bytes(2); // platform HTTP port
      r.bytes(20); // platform node id
    }
  }
  const hashed = Buffer.from(r.buf.subarray(start, r.at));
  const mn = service && service.port > 0 ? { proTxHash: hashHex(proTxHash), ...service, operatorKey, legacyKey: version === 1, valid, type } : null;
  return { mn, hashed, proTxHash };
}

export function merkleRoot(leaves: Buffer[]): Buffer {
  if (!leaves.length) return Buffer.alloc(32);
  let level = leaves;
  while (level.length > 1) {
    const up: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) up.push(dsha(Buffer.concat([level[i], level[i + 1] ?? level[i]])));
    level = up;
  }
  return level[0];
}

/** Bitcoin's partial merkle tree (as in merkleblock): the root it proves and the leaves it marks. */
export function partialMerkle(total: number, hashes: Buffer[], flags: Buffer): { root: Buffer; matched: Buffer[] } {
  if (total === 0 || hashes.length > total) throw new Error('The block proof is not well formed.');
  let height = 0;
  const width = (h: number) => (total + (1 << h) - 1) >> h;
  while (width(height) > 1) height++;
  let bit = 0;
  let used = 0;
  const matched: Buffer[] = [];
  const walk = (h: number, pos: number): Buffer => {
    if (bit >= flags.length * 8) throw new Error('The block proof is not well formed.');
    const parent = (flags[bit >> 3] >> (bit & 7)) & 1;
    bit++;
    if (h === 0 || !parent) {
      if (used >= hashes.length) throw new Error('The block proof is not well formed.');
      const x = hashes[used++];
      if (h === 0 && parent) matched.push(x);
      return x;
    }
    const left = walk(h - 1, pos * 2);
    const right = pos * 2 + 1 < width(h - 1) ? walk(h - 1, pos * 2 + 1) : left;
    if (pos * 2 + 1 < width(h - 1) && left.equals(right)) throw new Error('The block proof is not well formed.');
    return dsha(Buffer.concat([left, right]));
  };
  const root = walk(height, 0);
  if (used !== hashes.length) throw new Error('The block proof is not well formed.');
  return { root, matched };
}

/**
 * Reads an mnlistdiff from the start of the chain and checks it: the list hashes to the root in the block's
 * coinbase, and the coinbase is in the block whose merkle root the caller got from a server it trusts.
 * Quorum data after the list is not needed and not read.
 */
export function readMasternodeList(payload: Buffer, expect: { blockHash: string; merkleRoot: string }): MasternodeList {
  const r = new Reader(payload);
  r.u16(); // diff version
  const base = r.bytes(32);
  if (!base.every((x) => x === 0)) throw new Error('The masternode list is not a full list.');
  const blockHash = hashHex(r.bytes(32));
  if (blockHash !== expect.blockHash) throw new Error('The masternode list is for a different block.');
  const total = r.u32();
  const hashes: Buffer[] = [];
  for (let n = r.count(32); n > 0; n--) hashes.push(Buffer.from(r.bytes(32)));
  const flags = Buffer.from(r.varbytes());
  const cbStart = r.at;
  const cb = readTx(r);
  const cbHash = dsha(r.buf.subarray(cbStart, r.at));
  const proof = partialMerkle(total, hashes, flags);
  if (hashHex(proof.root) !== expect.merkleRoot) throw new Error('The masternode list does not belong to that block.');
  if (!proof.matched.some((m) => m.equals(cbHash))) throw new Error('The masternode list does not belong to that block.');
  if (cb.type !== 5 || !cb.payload || cb.payload.length < 38) throw new Error('The masternode list has no coinbase commitment.');
  const height = cb.payload.readInt32LE(2);
  const listRoot = cb.payload.subarray(6, 38);
  for (let n = r.count(32); n > 0; n--) r.bytes(32); // deleted, none from the start
  const entries: { mn: Masternode | null; hashed: Buffer; proTxHash: Buffer }[] = [];
  for (let n = r.count(100); n > 0; n--) entries.push(readListEntry(r));
  // Dash Core orders the list by pro-tx hash with memcmp over the bytes as they travel.
  const sorted = [...entries].sort((a, b) => Buffer.compare(a.proTxHash, b.proTxHash));
  const root = merkleRoot(sorted.map((e) => dsha(e.hashed)));
  if (!root.equals(listRoot)) throw new Error('The masternode list does not match the block it came with.');
  return { blockHash, coinbase: hashHex(cbHash), height, masternodes: entries.map((e) => e.mn).filter((m): m is Masternode => m !== null) };
}

export function getMnListDiff(blockHash: string): Buffer {
  return new Writer().bytes(Buffer.alloc(32)).bytes(hashBytes(blockHash)).done();
}
