// Decred's peer-to-peer wire format for what mixing needs: the message frame, version, inventory, and the eight
// mixing messages (dcrd wire, protocol version 10+), with their hashes and signatures. Tests pin the encodings to
// messages the Go code made.
import { Reader, Writer } from './dash-p2p';
import { DcrTx, serializeDcrTx, dcrTxid } from './dcr';
import { mixSigHash, schnorrSign, schnorrVerify } from './dcr-mix-crypto';

const { blake256 } = require('@noble/hashes/blake1.js');

export const MIX_VERSION = 10;
export const PROTOCOL_VERSION = 11;
export const INV_TYPE_TX = 1;
export const INV_TYPE_MIX = 4;
export const NET_MAGIC = { mainnet: 0xd9b400f9, simnet: 0x12141c16 } as const;
export const MAX_MIX_PEERS = 64;
export const MAX_MCOUNT = 16;
export const MAX_MTOT = 1024;

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
/** A hash as it is shown (reversed), like chainhash.Hash.String(). */
export const hashString = (h: Uint8Array) => Buffer.from(h).reverse().toString('hex');

// ---- frames ----

export function frame(magic: number, command: string, payload: Uint8Array = new Uint8Array()): Buffer {
  if (command.length > 12) throw new Error('command too long');
  const h = Buffer.alloc(24);
  h.writeUInt32LE(magic >>> 0, 0);
  h.write(command, 4, 'ascii');
  h.writeUInt32LE(payload.length, 16);
  Buffer.from(blake256(payload)).copy(h, 20, 0, 4);
  return Buffer.concat([h, Buffer.from(payload)]);
}

export class Unframer {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly magic: number, private readonly max = 8 * 1024 * 1024 + 1024) {}
  push(chunk: Buffer): { command: string; payload: Buffer }[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out: { command: string; payload: Buffer }[] = [];
    while (this.buf.length >= 24) {
      if (this.buf.readUInt32LE(0) !== this.magic) throw new Error('The Decred peer is on another network.');
      const len = this.buf.readUInt32LE(16);
      if (len > this.max) throw new Error('The Decred peer sent a message that is too large.');
      if (this.buf.length < 24 + len) break;
      const payload = this.buf.subarray(24, 24 + len);
      if (!Buffer.from(blake256(payload)).subarray(0, 4).equals(this.buf.subarray(20, 24))) throw new Error('The Decred peer sent a damaged message.');
      out.push({ command: this.buf.subarray(4, 16).toString('ascii').replace(/\0+$/, ''), payload: Buffer.from(payload) });
      this.buf = this.buf.subarray(24 + len);
    }
    return out;
  }
}

/** Version: no services, no address, a random nonce, our height, no transaction relay. */
export function versionPayload(height: number, nonce: Uint8Array): Buffer {
  const w = new Writer().u32(PROTOCOL_VERSION).u64(0n).i64(BigInt(Math.floor(Date.now() / 1000)));
  w.bytes(Buffer.alloc(26)).bytes(Buffer.alloc(26)).bytes(nonce);
  // The last byte asks the node to relay: without it a node sends no transaction or mixing inventory at all.
  w.varbytes(Buffer.from('/dcrwire:1.0.0/')).i32(height).u8(1);
  return w.done();
}

export function readVersion(p: Buffer): { version: number; services: bigint; height: number } {
  const r = new Reader(p);
  const version = r.u32(); const services = r.u64(); r.i64(); r.bytes(26); r.bytes(26); r.bytes(8); r.varbytes();
  return { version, services, height: r.left >= 4 ? r.i32() : 0 };
}

export function invPayload(items: { type: number; hash: Uint8Array }[]): Buffer {
  const w = new Writer().varint(items.length);
  for (const i of items) w.u32(i.type).bytes(i.hash);
  return w.done();
}

export function readInv(p: Buffer): { type: number; hash: Buffer }[] {
  const r = new Reader(p);
  const n = r.varint();
  if (n > 50_000) throw new Error('inventory too large');
  return Array.from({ length: n }, () => ({ type: r.u32(), hash: r.bytes(32) }));
}

// ---- transactions ----

export function readDcrTx(r: Reader): DcrTx {
  const v = r.u32();
  const version = v & 0xffff;
  if (v >>> 16 !== 0) throw new Error('only full transactions are read');
  const nIn = r.varint();
  if (nIn > 10_000) throw new Error('too many inputs');
  const inputs = Array.from({ length: nIn }, () => {
    const txid = Buffer.from(r.bytes(32)).reverse().toString('hex');
    return { txid, vout: r.u32(), tree: r.u8(), sequence: r.u32(), value: 0n, blockHeight: 0, blockIndex: 0, sigScript: new Uint8Array() };
  });
  const nOut = r.varint();
  if (nOut > 10_000) throw new Error('too many outputs');
  const outputs = Array.from({ length: nOut }, () => ({ value: r.i64(), version: r.u16(), script: Uint8Array.from(r.varbytes()) }));
  const lockTime = r.u32(); const expiry = r.u32();
  const nW = r.varint();
  if (nW !== nIn) throw new Error('witness count differs from input count');
  for (const i of inputs) { i.value = r.i64(); i.blockHeight = r.u32(); i.blockIndex = r.u32(); i.sigScript = Uint8Array.from(r.varbytes()); }
  return { version, inputs, outputs, lockTime, expiry };
}

// ---- mixing messages ----

export interface MixUTXO { txid: string; vout: number; tree: number; script: Uint8Array; pubKey: Uint8Array; signature: Uint8Array; opcode: number }
export interface TxOutW { value: bigint; version: number; script: Uint8Array }

interface Base { sig: Uint8Array; identity: Uint8Array }
export interface PR extends Base { cmd: 'mixpairreq'; expiry: number; mixAmount: bigint; scriptClass: string; txVersion: number; lockTime: number; messageCount: number; inputValue: bigint; utxos: MixUTXO[]; change: TxOutW | null; flags: number; pairingFlags: number }
export interface KE extends Base { cmd: 'mixkeyxchg'; sid: Uint8Array; epoch: bigint; run: number; pos: number; ecdh: Uint8Array; pqpk: Uint8Array; commitment: Uint8Array; seenPRs: Uint8Array[] }
export interface CT extends Base { cmd: 'mixcphrtxt'; sid: Uint8Array; run: number; ciphertexts: Uint8Array[]; seenKEs: Uint8Array[] }
export interface SR extends Base { cmd: 'mixslotres'; sid: Uint8Array; run: number; dcmix: Uint8Array[][]; seenCTs: Uint8Array[] }
export interface FP extends Base { cmd: 'mixfactpoly'; sid: Uint8Array; run: number; roots: Uint8Array[]; seenSRs: Uint8Array[] }
export interface DC extends Base { cmd: 'mixdcnet'; sid: Uint8Array; run: number; dcnet: Uint8Array[][]; seenSRs: Uint8Array[] }
export interface CM extends Base { cmd: 'mixconfirm'; sid: Uint8Array; run: number; mix: DcrTx; seenDCs: Uint8Array[] }
export interface RS extends Base { cmd: 'mixsecrets'; sid: Uint8Array; run: number; seed: Uint8Array; srMsgs: Uint8Array[]; dcMsgs: Uint8Array[]; seenRSs: Uint8Array[] }
export type MixMsg = PR | KE | CT | SR | FP | DC | CM | RS;
export const MIX_COMMANDS = ['mixpairreq', 'mixkeyxchg', 'mixcphrtxt', 'mixslotres', 'mixfactpoly', 'mixdcnet', 'mixconfirm', 'mixsecrets'];

const writeHashes = (w: Writer, hs: Uint8Array[]) => { w.varint(hs.length); for (const h of hs) w.bytes(h); };
const readHashes = (r: Reader, max = MAX_MIX_PEERS) => { const n = r.varint(); if (n > max) throw new Error('too many references'); return Array.from({ length: n }, () => Uint8Array.from(r.bytes(32))); };
function writeTxOut(w: Writer, o: TxOutW) { w.i64(o.value).u16(o.version).varbytes(o.script); }
function writeOutpoint(w: Writer, txid: string, vout: number, tree: number) { w.bytes(Buffer.from(txid, 'hex').reverse()).u32(vout).u8(tree); }
function writeVects(w: Writer, vecs: Uint8Array[][]) {
  w.varint(vecs.length);
  if (!vecs.length) return;
  w.varint(vecs[0].length).varint(20);
  for (const v of vecs) for (const x of v) w.bytes(x);
}
function readVects(r: Reader): Uint8Array[][] {
  const n = r.varint();
  if (n === 0) return [];
  if (n > MAX_MCOUNT) throw new Error('too many vectors');
  const m = r.varint(); const size = r.varint();
  if (m > MAX_MTOT || size !== 20) throw new Error('bad vector dimensions');
  return Array.from({ length: n }, () => Array.from({ length: m }, () => Uint8Array.from(r.bytes(20))));
}

/** Everything but the signature, as it is signed and hashed. */
export function mixBody(m: MixMsg): Buffer {
  const w = new Writer().bytes(m.identity);
  switch (m.cmd) {
    case 'mixpairreq':
      w.u32(m.expiry).i64(m.mixAmount).varbytes(Buffer.from(m.scriptClass, 'ascii')).u16(m.txVersion).u32(m.lockTime).u32(m.messageCount).i64(m.inputValue).varint(m.utxos.length);
      for (const u of m.utxos) { writeOutpoint(w, u.txid, u.vout, u.tree); w.varbytes(u.script).varbytes(u.pubKey).varbytes(u.signature).u8(u.opcode); }
      w.u8(m.change ? 1 : 0);
      if (m.change) writeTxOut(w, m.change);
      return w.u8(m.flags).u8(m.pairingFlags).done();
    case 'mixkeyxchg':
      w.bytes(m.sid).u64(m.epoch).u32(m.run).u32(m.pos).bytes(m.ecdh).bytes(m.pqpk).bytes(m.commitment); writeHashes(w, m.seenPRs); return w.done();
    case 'mixcphrtxt':
      // One count for both: each ciphertext answers one of the KEs referenced.
      if (m.ciphertexts.length !== m.seenKEs.length) throw new Error('differing counts of ciphertexts and key exchanges');
      w.bytes(m.sid).u32(m.run).varint(m.ciphertexts.length); for (const c of m.ciphertexts) w.bytes(c); for (const h of m.seenKEs) w.bytes(h); return w.done();
    case 'mixslotres':
      w.bytes(m.sid).u32(m.run).varint(m.dcmix.length).varint(m.dcmix[0]?.length ?? 0);
      for (const row of m.dcmix) for (const v of row) w.varbytes(v);
      writeHashes(w, m.seenCTs); return w.done();
    case 'mixfactpoly':
      w.bytes(m.sid).u32(m.run).varint(m.roots.length); for (const x of m.roots) w.varbytes(x); writeHashes(w, m.seenSRs); return w.done();
    case 'mixdcnet':
      w.bytes(m.sid).u32(m.run); writeVects(w, m.dcnet); writeHashes(w, m.seenSRs); return w.done();
    case 'mixconfirm':
      w.bytes(m.sid).u32(m.run).bytes(serializeDcrTx(m.mix)); writeHashes(w, m.seenDCs); return w.done();
    case 'mixsecrets':
      w.bytes(m.sid).u32(m.run).bytes(m.seed).varint(m.srMsgs.length); for (const x of m.srMsgs) w.varbytes(x);
      w.varint(m.dcMsgs.length); if (m.dcMsgs.length) { w.varint(20); for (const x of m.dcMsgs) w.bytes(x); }
      writeHashes(w, m.seenRSs); return w.done();
  }
}

export const encodeMix = (m: MixMsg): Buffer => Buffer.concat([Buffer.from(m.sig), mixBody(m)]);
/** The message's hash (its inventory ID): BLAKE-256 of signature and body. */
export const mixHash = (m: MixMsg): Uint8Array => blake256(encodeMix(m));
export const mixSid = (m: MixMsg): Uint8Array | null => (m.cmd === 'mixpairreq' ? null : m.sid);
export const mixRun = (m: MixMsg): number => (m.cmd === 'mixpairreq' ? 0 : m.run);
export function mixPrev(m: MixMsg): Uint8Array[] {
  switch (m.cmd) {
    case 'mixkeyxchg': return m.seenPRs; case 'mixcphrtxt': return m.seenKEs; case 'mixslotres': return m.seenCTs;
    case 'mixdcnet': return m.seenSRs; case 'mixconfirm': return m.seenDCs; case 'mixsecrets': return m.seenRSs; default: return [];
  }
}

function signedHash(m: MixMsg): Uint8Array {
  const tag = Buffer.from(`${m.cmd}-sig`, 'ascii');
  const data = blake256(Buffer.concat([new Writer().varbytes(tag).done(), mixBody(m)]));
  return mixSigHash(m.cmd, mixSid(m), mixRun(m), data);
}

export function signMix(m: MixMsg, priv: Uint8Array): void { m.sig = schnorrSign(priv, signedHash(m)); }
export const verifyMix = (m: MixMsg): boolean => schnorrVerify(m.identity, signedHash(m), m.sig);

/** The RS commitment a KE carries: the hash of the secrets message without signature or references. */
export const rsCommitment = (rs: RS): Uint8Array => mixHash({ ...rs, sig: new Uint8Array(64), seenRSs: [] });

/** What makes PRs compatible for one session: amount, script class, transaction version, lock time, pairing flags. */
export function prPairing(pr: PR): Buffer {
  return new Writer().i64(pr.mixAmount).varbytes(Buffer.from(pr.scriptClass, 'ascii')).u16(pr.txVersion).u32(pr.lockTime).u8(pr.pairingFlags).done();
}

export function decodeMix(cmd: string, payload: Buffer): MixMsg {
  const r = new Reader(payload);
  const sig = Uint8Array.from(r.bytes(64)); const identity = Uint8Array.from(r.bytes(33));
  let m: MixMsg;
  switch (cmd) {
    case 'mixpairreq': {
      const expiry = r.u32(); const mixAmount = r.i64();
      const scLen = r.varint(); if (scLen > 32) throw new Error('script class too long');
      const scriptClass = r.bytes(scLen).toString('ascii');
      const txVersion = r.u16(); const lockTime = r.u32(); const messageCount = r.u32(); const inputValue = r.i64();
      const n = r.varint(); if (n > 512) throw new Error('too many UTXOs');
      const utxos: MixUTXO[] = Array.from({ length: n }, () => {
        const txid = Buffer.from(r.bytes(32)).reverse().toString('hex'); const vout = r.u32(); const tree = r.u8();
        const script = Uint8Array.from(r.varbytes()); const pubKey = Uint8Array.from(r.varbytes()); const signature = Uint8Array.from(r.varbytes());
        if (pubKey.length > 33 || signature.length > 64 || script.length > 16384) throw new Error('UTXO field too long');
        return { txid, vout, tree, script, pubKey, signature, opcode: r.u8() };
      });
      const has = r.u8(); if (has > 1) throw new Error('bad change flag');
      const change = has ? { value: r.i64(), version: r.u16(), script: Uint8Array.from(r.varbytes()) } : null;
      if (mixAmount < 0n || inputValue < 0n) throw new Error('negative amount');
      m = { cmd, sig, identity, expiry, mixAmount, scriptClass, txVersion, lockTime, messageCount, inputValue, utxos, change, flags: r.u8(), pairingFlags: r.u8() };
      break;
    }
    case 'mixkeyxchg':
      m = { cmd, sig, identity, sid: Uint8Array.from(r.bytes(32)), epoch: r.u64(), run: r.u32(), pos: r.u32(), ecdh: Uint8Array.from(r.bytes(33)), pqpk: Uint8Array.from(r.bytes(1218)), commitment: Uint8Array.from(r.bytes(32)), seenPRs: readHashes(r) };
      break;
    case 'mixcphrtxt': {
      const sid = Uint8Array.from(r.bytes(32)); const run = r.u32();
      const n = r.varint(); if (n > MAX_MIX_PEERS) throw new Error('too many ciphertexts');
      const ciphertexts = Array.from({ length: n }, () => Uint8Array.from(r.bytes(1047)));
      m = { cmd, sig, identity, sid, run, ciphertexts, seenKEs: Array.from({ length: n }, () => Uint8Array.from(r.bytes(32))) };
      break;
    }
    case 'mixslotres': {
      const sid = Uint8Array.from(r.bytes(32)); const run = r.u32();
      const mc = r.varint(); const kp = r.varint();
      if (mc > MAX_MCOUNT || kp > MAX_MTOT) throw new Error('bad slot reservation dimensions');
      const dcmix = Array.from({ length: mc }, () => Array.from({ length: kp }, () => { const v = Uint8Array.from(r.varbytes()); if (v.length > 16) throw new Error('field number too long'); return v; }));
      m = { cmd, sig, identity, sid, run, dcmix, seenCTs: readHashes(r) };
      break;
    }
    case 'mixfactpoly': {
      const sid = Uint8Array.from(r.bytes(32)); const run = r.u32();
      const n = r.varint(); if (n > MAX_MTOT) throw new Error('too many roots');
      const roots = Array.from({ length: n }, () => { const v = Uint8Array.from(r.varbytes()); if (v.length > 16) throw new Error('root too long'); return v; });
      m = { cmd, sig, identity, sid, run, roots, seenSRs: readHashes(r) };
      break;
    }
    case 'mixdcnet':
      m = { cmd, sig, identity, sid: Uint8Array.from(r.bytes(32)), run: r.u32(), dcnet: readVects(r), seenSRs: readHashes(r) };
      break;
    case 'mixconfirm':
      m = { cmd, sig, identity, sid: Uint8Array.from(r.bytes(32)), run: r.u32(), mix: readDcrTx(r), seenDCs: readHashes(r) };
      break;
    case 'mixsecrets': {
      const sid = Uint8Array.from(r.bytes(32)); const run = r.u32(); const seed = Uint8Array.from(r.bytes(32));
      const n = r.varint(); if (n > MAX_MCOUNT) throw new Error('too many secrets');
      const srMsgs = Array.from({ length: n }, () => Uint8Array.from(r.varbytes()));
      const k = r.varint(); if (k > MAX_MCOUNT) throw new Error('too many secrets');
      let dcMsgs: Uint8Array[] = [];
      if (k) { if (r.varint() !== 20) throw new Error('bad message size'); dcMsgs = Array.from({ length: k }, () => Uint8Array.from(r.bytes(20))); }
      m = { cmd, sig, identity, sid, run, seed, srMsgs, dcMsgs, seenRSs: readHashes(r) };
      break;
    }
    default: throw new Error(`not a mixing message: ${cmd}`);
  }
  if (r.left !== 0) throw new Error('extra bytes in a mixing message');
  return m;
}

export const mixTxid = (m: CM): string => dcrTxid(m.mix);
export const idHex = (id: Uint8Array) => hex(id);
