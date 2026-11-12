// STROBE-128 (v1.0.2), only the operations WabiSabi uses, and the hasher built on it.
// Follows the WabiSabi reference implementation (zkSNACKs/NWabiSabi, MIT licence) byte for byte.
const { keccakP } = require('@noble/hashes/sha3.js');

const RATE = 166;
const DDATA = 0x04;
const DRATE = 0x80;
export const FLAG = { I: 1, A: 2, C: 4, T: 8, M: 16, K: 32 } as const;
const utf8 = (s: string) => new TextEncoder().encode(s);

export const PROTOCOL = 'WabiSabi_v1.0';
export const DOMAIN_SEPARATOR = 'domain-separator';

export class Strobe128 {
  private state = new Uint8Array(200);
  private words = new Uint32Array(this.state.buffer);
  private pos = 0;
  private begin = 0;
  private flags = 0;

  constructor(protocol?: string) {
    if (protocol === undefined) return;
    this.state.set([1, RATE + 2, 1, 0, 1, 12 * 8, ...utf8('STROBEv1.0.2')]);
    this.permute();
    this.meta(utf8(protocol), false);
  }

  copy(): Strobe128 {
    const s = new Strobe128();
    s.state.set(this.state);
    s.pos = this.pos;
    s.begin = this.begin;
    s.flags = this.flags;
    return s;
  }

  /** Associated metadata (M|A). */
  meta(data: Uint8Array, more: boolean): void { this.op(FLAG.M | FLAG.A, more); this.absorb(data); }
  /** Associated data (A). */
  ad(data: Uint8Array, more: boolean): void { this.op(FLAG.A, more); this.absorb(data); }
  /** Pseudorandom output (I|A|C). */
  prf(count: number, more: boolean): Uint8Array { this.op(FLAG.I | FLAG.A | FLAG.C, more); return this.squeeze(count); }
  /** Key (A|C). */
  key(data: Uint8Array, more: boolean): void { this.op(FLAG.A | FLAG.C, more); this.overwrite(data); }

  private permute(): void { keccakP(this.words, 24); }

  private runF(): void {
    this.state[this.pos] ^= this.begin;
    this.state[this.pos + 1] ^= DDATA;
    this.state[RATE + 1] ^= DRATE;
    this.permute();
    this.pos = 0;
    this.begin = 0;
  }

  private absorb(data: Uint8Array): void {
    for (const b of data) {
      this.state[this.pos++] ^= b;
      if (this.pos === RATE) this.runF();
    }
  }

  private overwrite(data: Uint8Array): void {
    for (const b of data) {
      this.state[this.pos++] = b;
      if (this.pos === RATE) this.runF();
    }
  }

  private squeeze(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = this.state[this.pos];
      this.state[this.pos++] = 0;
      if (this.pos === RATE) this.runF();
    }
    return out;
  }

  private op(flags: number, more: boolean): void {
    if (more) {
      if (flags !== this.flags) throw new Error('A strobe operation was continued with other flags.');
      return;
    }
    const oldBegin = this.begin;
    this.flags = flags;
    this.begin = (this.pos + 1) & 0xff;
    this.absorb(new Uint8Array([oldBegin, flags]));
    if ((flags & (FLAG.C | FLAG.K)) && this.pos !== 0) this.runF();
  }
}

export const le32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n, true); return b; };
export const le64 = (n: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, n, true); return b; };

/** Hashes named fields, as the coordinator does for round parameters. */
export class StrobeHasher {
  private strobe = new Strobe128(PROTOCOL);
  constructor(domain: string) { this.str(DOMAIN_SEPARATOR, domain); }
  bytes(field: string, value: Uint8Array): this {
    this.strobe.meta(utf8(field), false);
    this.strobe.meta(le32(value.length), true);
    this.strobe.ad(value, false);
    return this;
  }
  /** A 64-bit number, little endian, as C# BitConverter writes a long. */
  long(field: string, n: bigint): this { return this.bytes(field, le64(n)); }
  int(field: string, n: number): this { return this.bytes(field, le32(n)); }
  /** Strings go under "<field>.Cw", as the reference does. */
  str(field: string, s: string): this { return this.bytes(`${field}.Cw`, utf8(s)); }
  hash(): Uint8Array { return this.strobe.prf(32, false); }
}
