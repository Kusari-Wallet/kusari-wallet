// WabiSabi anonymous credentials, client side: keyed-verification anonymous credentials over secp256k1 with
// Fiat-Shamir proofs on a STROBE transcript. A port of the managed reference implementation
// (zkSNACKs/NWabiSabi, csharp/WabiSabi, MIT licence), kept wire compatible with it.
import { randomBytes } from 'node:crypto';
import { Strobe128, PROTOCOL, le32 } from './strobe';

const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { sha256 } = require('@noble/hashes/sha2.js');

export type Point = any;
const P = secp256k1.Point;
export const N: bigint = P.Fn.ORDER;
const FP: bigint = P.Fp.ORDER;
export const O: Point = P.ZERO;
export const CREDENTIAL_COUNT = 2;
const utf8 = (s: string) => new TextEncoder().encode(s);

// ---- scalars and points ----

export const mod = (a: bigint): bigint => ((a % N) + N) % N;
export function scalarBytes(s: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = mod(s);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
const toBig = (b: Uint8Array): bigint => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
/** A scalar from 32 big-endian bytes; null when it overflows the group order, as the reference rejects it. */
export function scalarFrom(b: Uint8Array): bigint | null {
  if (b.length !== 32) return null;
  const v = toBig(b);
  return v >= N ? null : v;
}
export function randomScalar(rand: (n: number) => Uint8Array = randomBytes): bigint {
  for (;;) {
    const s = scalarFrom(rand(32));
    if (s !== null && s !== 0n) return s;
  }
}

export function mul(k: bigint, p: Point): Point {
  const s = mod(k);
  if (s === 0n || p.is0()) return O;
  return p.multiply(s);
}
export const add = (a: Point, b: Point): Point => a.add(b);
export const sub = (a: Point, b: Point): Point => a.subtract(b);
export const eq = (a: Point, b: Point): boolean => a.equals(b);

/** 33 bytes, compressed; the point at infinity is all zeros. */
export function pointBytes(p: Point): Uint8Array {
  if (p.is0()) return new Uint8Array(33);
  return p.toBytes(true);
}
export function pointFrom(b: Uint8Array): Point {
  if (b.length !== 33) throw new Error('Not a group element.');
  if (b[0] === 0) return O;
  if (b[0] !== 2 && b[0] !== 3) throw new Error('Not a group element.');
  return P.fromBytes(b);
}

/** Hash to a point: SHA-256 repeated until the x coordinate lands on the curve; y is the square root that is itself a square. */
export function pointFromBuffer(data: Uint8Array): Point {
  let buf: Uint8Array = sha256(data);
  for (;;) {
    const x = toBig(buf);
    if (x < FP) {
      const y2 = (x * x % FP * x + 7n) % FP;
      const y = powMod(y2, (FP + 1n) / 4n, FP);
      if (y * y % FP === y2) {
        const out = new Uint8Array(33);
        out[0] = y & 1n ? 3 : 2;
        out.set(buf, 1);
        return P.fromBytes(out);
      }
    }
    buf = sha256(buf);
  }
}
function powMod(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; }
  return r;
}

// Fixed generators get precomputed tables: most of the work is multiplying them.
const gen = (name: string): Point => { const g = pointFromBuffer(utf8(name)); g.precompute(8); return g; };
export const G = {
  G: P.BASE as Point,
  Gw: gen('Gw'), Gwp: gen('Gwp'), Gx0: gen('Gx0'), Gx1: gen('Gx1'), GV: gen('GV'),
  Gg: gen('Gg'), Gh: gen('Gh'), Ga: gen('Ga'), Gs: gen('Gs'),
};
const POW2: bigint[] = Array.from({ length: 255 }, (_, i) => 1n << BigInt(i));
const NEG_GH_POW2: Point[] = [];
const negGhPow2 = (i: number): Point => (NEG_GH_POW2[i] ??= mul(N - POW2[i], G.Gh));

const pedersen = (s: bigint, b: bigint): Point => add(mul(s, G.Gg), mul(b, G.Gh));
const sumPoints = (ps: Point[]): Point => ps.reduce((a, p) => add(a, p), O);
const dot = (scalars: bigint[], points: Point[]): Point => sumPoints(points.map((g, i) => mul(scalars[i], g)));

// ---- statements and proofs ----

/** Rows of [public point, generators...]; empty cells are the point at infinity. */
type Statement = Point[][];
interface Knowledge { statement: Statement; witness: bigint[] }
export interface Proof { nonces: Point[]; responses: bigint[] }

function table(rows: number, cols: number): Point[][] { return Array.from({ length: rows }, () => Array.from({ length: cols }, () => O)); }

export class Transcript {
  constructor(private strobe: Strobe128) {}
  static create(label: string): Transcript {
    const t = new Transcript(new Strobe128(PROTOCOL));
    t.message(utf8('domain-separator'), utf8(label));
    return t;
  }
  private message(label: Uint8Array, msg: Uint8Array): void {
    this.strobe.meta(label, false);
    this.strobe.meta(le32(msg.length), true);
    this.strobe.ad(msg, false);
  }
  private messages(label: Uint8Array, msgs: Uint8Array[]): void {
    this.strobe.meta(label, false);
    this.strobe.meta(le32(msgs.length), true);
    msgs.forEach((m, i) => this.message(le32(i), m));
  }
  commitStatement(s: Statement): void {
    const pub = s.map((row) => pointBytes(row[0]));
    const gens = s.flatMap((row) => row.slice(1).map(pointBytes));
    this.messages(utf8('statement'), [...pub, ...gens]);
  }
  commitNonces(nonces: Point[]): void {
    if (nonces.some((n) => n.is0())) throw new Error('A proof nonce is the point at infinity.');
    this.messages(utf8('nonce-commitment'), nonces.map(pointBytes));
  }
  challenge(): bigint {
    for (;;) {
      this.strobe.meta(utf8('challenge'), false);
      const s = scalarFrom(this.strobe.prf(32, false));
      if (s !== null) return s;
    }
  }
  /** Secret nonces from the transcript so far, the witness and fresh randomness, on a copy so the transcript is untouched. */
  nonces(witness: bigint[], count: number, rand: (n: number) => Uint8Array): bigint[] {
    const s = this.strobe.copy();
    for (const w of witness) s.key(scalarBytes(w), false);
    s.key(rand(32), false);
    const out: bigint[] = [];
    while (out.length < count) {
      const v = scalarFrom(s.prf(32, false));
      if (v !== null) out.push(v);
    }
    return out;
  }
}

function prove(t: Transcript, knowledge: Knowledge[], rand: (n: number) => Uint8Array): Proof[] {
  for (const k of knowledge) t.commitStatement(k.statement);
  const pending: { nonces: Point[]; secret: bigint[]; witness: bigint[] }[] = [];
  for (const k of knowledge) {
    const secret = t.nonces(k.witness, k.witness.length, rand);
    if (secret.some((s) => s === 0n)) throw new Error('A secret nonce is zero.');
    const nonces = k.statement.map((row) => dot(secret, row.slice(1)));
    t.commitNonces(nonces);
    pending.push({ nonces, secret, witness: k.witness });
  }
  const c = t.challenge();
  return pending.map((p) => ({ nonces: p.nonces, responses: p.secret.map((s, i) => mod(s + c * p.witness[i])) }));
}

function verify(t: Transcript, statements: Statement[], proofs: Proof[]): boolean {
  if (statements.length !== proofs.length) return false;
  for (const s of statements) t.commitStatement(s);
  for (const p of proofs) t.commitNonces(p.nonces);
  const c = t.challenge();
  if (c === 0n) return false;
  return statements.every((s, i) => {
    const p = proofs[i];
    if (p.nonces.length !== s.length) return false;
    return s.every((row, r) => {
      const gens = row.slice(1);
      if (p.responses.length !== gens.length) return false;
      return eq(dot(p.responses, gens), add(p.nonces[r], mul(c, row[0])));
    });
  });
}

export interface IssuerParams { Cw: Point; I: Point }
export interface Mac { t: bigint; V: Point }
export interface Credential { value: bigint; randomness: bigint; mac: Mac }
export interface Presentation { Ca: Point; Cx0: Point; Cx1: Point; CV: Point; S: Point }
export interface IssuanceRequest { Ma: Point; bits: Point[] }
export interface CredentialsRequest { delta: bigint; presented: Presentation[]; requested: IssuanceRequest[]; proofs: Proof[] }
export interface CredentialsResponse { issued: Mac[]; proofs: Proof[] }
interface Requested { value: bigint; randomness: bigint; Ma: Point }
export interface Pending { transcript: Transcript; requested: Requested[] }

const generateU = (t: bigint): Point => pointFromBuffer(scalarBytes(t));

function issuerParamsStatement(ip: IssuerParams, mac: Mac, Ma: Point): Statement {
  const U = generateU(mac.t);
  return [
    [mac.V, G.Gw, O, U, mul(mac.t, U), Ma],
    [sub(G.GV, ip.I), O, O, G.Gx0, G.Gx1, G.Ga],
    [ip.Cw, G.Gw, G.Gwp, O, O, O],
  ];
}

function showCredentialStatement(c: Presentation, Z: Point, ip: IssuerParams): Statement {
  return [
    [Z, ip.I, O, O, O, O],
    [c.Cx1, G.Gx1, G.Gx0, c.Cx0, O, O],
    [c.Ca, G.Ga, O, O, G.Gg, G.Gh],
    [c.S, O, O, O, O, G.Gs],
  ];
}

function rangeProofStatement(Ma: Point, bits: Point[], width: number): Statement {
  const rows = width * 2 + 1;
  const cols = width * 3 + 2;
  const eqs = table(rows, cols);
  const bitsTotal = dot(POW2.slice(0, width), bits);
  eqs[0][0] = sub(Ma, bitsTotal);
  eqs[0][1] = G.Gh;
  const negGh = G.Gh.negate();
  for (let i = 0; i < width; i++) {
    const bit = 3 * i + 2, rnd = bit + 1, prod = bit + 2, rep = 2 * i + 1, sq = rep + 1;
    eqs[0][rnd] = negGhPow2(i);
    eqs[rep][0] = bits[i];
    eqs[rep][bit] = G.Gg;
    eqs[rep][rnd] = G.Gh;
    eqs[sq][bit] = sub(bits[i], G.Gg);
    eqs[sq][prod] = negGh;
  }
  return eqs;
}

/** The client of one credential issuer (amounts or vsizes) of a round. */
export class WabiSabiClient {
  readonly width: number;
  constructor(private readonly ip: IssuerParams, readonly maxValue: bigint, private readonly rand: (n: number) => Uint8Array = randomBytes) {
    // ceil(log2(max)), as the reference computes it with floating point.
    this.width = Math.ceil(Math.log2(Number(maxValue)));
    if (!(this.width > 0 && this.width <= 255)) throw new Error('Unusable credential range.');
  }

  private transcript(isNull: boolean): Transcript { return Transcript.create(`UnifiedRegistration/${CREDENTIAL_COUNT}/${isNull ? 'True' : 'False'}`); }

  zeroRequest(): { request: CredentialsRequest; pending: Pending } {
    const knowledge: Knowledge[] = [];
    const requested: Requested[] = [];
    const issuance: IssuanceRequest[] = [];
    for (let i = 0; i < CREDENTIAL_COUNT; i++) {
      const r = randomScalar(this.rand);
      const Ma = mul(r, G.Gh);
      knowledge.push({ statement: rangeProofStatement(Ma, [], 0), witness: [r] });
      issuance.push({ Ma, bits: [] });
      requested.push({ value: 0n, randomness: r, Ma });
    }
    const transcript = this.transcript(true);
    const proofs = prove(transcript, knowledge, this.rand);
    return { request: { delta: 0n, presented: [], requested: issuance, proofs }, pending: { transcript, requested } };
  }

  /** Presents `present` and asks for `amounts` (padded with zeros to two, or none for an output registration). */
  request(amounts: bigint[], present: Credential[]): { request: CredentialsRequest; pending: Pending } {
    if (amounts.length > CREDENTIAL_COUNT) throw new Error('Too many credentials requested.');
    const want = amounts.length ? [...amounts, ...Array(CREDENTIAL_COUNT - amounts.length).fill(0n)] : [];
    if (present.length !== CREDENTIAL_COUNT) throw new Error('Two credentials have to be presented.');
    const seen = new Set(present.map((c) => `${c.mac.t}:${Buffer.from(pointBytes(c.mac.V)).toString('hex')}`));
    if (seen.size !== present.length) throw new Error('A credential was presented twice.');
    for (const v of want) if (v < 0n || v >= (1n << BigInt(this.width))) throw new Error('A requested credential value is out of range.');
    const knowledge: Knowledge[] = [];
    const presented: Presentation[] = [];
    const zs: bigint[] = [];
    for (const c of present) {
      const z = randomScalar(this.rand);
      const U = generateU(c.mac.t);
      const pres: Presentation = {
        Ca: add(mul(z, G.Ga), pedersen(c.value, c.randomness)),
        Cx0: add(mul(z, G.Gx0), U),
        Cx1: add(mul(z, G.Gx1), mul(c.mac.t, U)),
        CV: add(mul(z, G.GV), c.mac.V),
        S: mul(c.randomness, G.Gs),
      };
      presented.push(pres);
      knowledge.push({ statement: showCredentialStatement(pres, mul(z, this.ip.I), this.ip), witness: [z, mod(-(c.mac.t * z)), c.mac.t, c.value, c.randomness] });
      zs.push(z);
    }
    const requested: Requested[] = [];
    const issuance: IssuanceRequest[] = [];
    for (const value of want) {
      const r = randomScalar(this.rand);
      const Ma = pedersen(value, r);
      const bitValues = Array.from({ length: this.width }, (_, i) => (value >> BigInt(i)) & 1n);
      const bitRand = bitValues.map(() => randomScalar(this.rand));
      const bits = bitValues.map((b, i) => pedersen(b, bitRand[i]));
      const witness: bigint[] = [r];
      for (let i = 0; i < this.width; i++) witness.push(bitValues[i], bitRand[i], mod(bitRand[i] * bitValues[i]));
      knowledge.push({ statement: rangeProofStatement(Ma, bits, this.width), witness });
      issuance.push({ Ma, bits });
      requested.push({ value, randomness: r, Ma });
    }
    const zSum = mod(zs.reduce((a, z) => a + z, 0n));
    const deltaR = mod(present.reduce((a, c) => a + c.randomness, 0n) - requested.reduce((a, r) => a + r.randomness, 0n));
    knowledge.push({ statement: [[add(mul(zSum, G.Ga), mul(deltaR, G.Gh)), G.Ga, G.Gh]], witness: [zSum, deltaR] });
    const transcript = this.transcript(false);
    const proofs = prove(transcript, knowledge, this.rand);
    const delta = want.reduce((a, v) => a + v, 0n) - present.reduce((a, c) => a + c.value, 0n);
    return { request: { delta, presented, requested: issuance, proofs }, pending: { transcript, requested } };
  }

  /** Checks the issuer's proofs and returns the new credentials. */
  handle(res: CredentialsResponse, pending: Pending): Credential[] {
    if (res.issued.length !== CREDENTIAL_COUNT || pending.requested.length !== CREDENTIAL_COUNT) throw new Error('The coordinator issued a different number of credentials.');
    const statements = pending.requested.map((r, i) => issuerParamsStatement(this.ip, res.issued[i], r.Ma));
    if (res.issued.some((m) => m.t === 0n || m.V.is0())) throw new Error('The coordinator issued an unusable credential.');
    if (!verify(pending.transcript, statements, res.proofs)) throw new Error('The coordinator\'s credential proofs are wrong.');
    return pending.requested.map((r, i) => ({ value: r.value, randomness: r.randomness, mac: res.issued[i] }));
  }
}

/** The proof system and statements, for a stand-in coordinator in tests. */
export const internals = { prove, verify, issuerParamsStatement, showCredentialStatement, rangeProofStatement, generateU, pedersen, sumPoints };
