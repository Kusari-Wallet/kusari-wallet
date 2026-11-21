// Payjoin: the person being paid adds a coin of theirs to the payment, so the transaction no longer shows which
// coins were the payer's or how much was paid. BIP78 (the sender posts to the receiver's server) and BIP77 (both
// sides leave end-to-end encrypted messages at a directory, reached through Oblivious HTTP, so neither the
// directory nor the other side learns the IP address). Written from the two specifications.
import { randomBytes, randomInt } from 'node:crypto';
import { ellswiftDecode, ellswiftEncode } from './ellswift';
import { compressed, newPrivateKey, publicKeyOf, setupReceiver, setupSender, AEAD_ID, KDF_ID, KEM_ID } from './hpke';

const btc = require('@scure/btc-signer');
const { extract, expand } = require('@noble/hashes/hkdf.js');
const { sha256 } = require('@noble/hashes/sha2.js');
const { chacha20poly1305 } = require('@noble/ciphers/chacha.js');

const te = (s: string): Uint8Array => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

// ---- bech32 without a checksum, upper case (BIP77's fragment parameters and mailbox IDs) ----

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function toWords(bytes: Uint8Array): number[] {
  const out: number[] = []; let acc = 0; let bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } acc &= (1 << bits) - 1; }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}
function fromWords(words: number[]): Uint8Array {
  const out: number[] = []; let acc = 0; let bits = 0;
  for (const w of words) { acc = (acc << 5) | w; bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } acc &= (1 << bits) - 1; }
  return Uint8Array.from(out);
}
export const b32encode = (bytes: Uint8Array): string => toWords(bytes).map((w) => CHARSET[w]).join('').toUpperCase();
export function b32decode(s: string): Uint8Array {
  const words = [...s.toLowerCase()].map((c) => CHARSET.indexOf(c));
  if (words.some((w) => w < 0)) throw new Error('Not a valid Payjoin link.');
  return fromWords(words);
}
/** A mailbox's name at the directory: the first 8 bytes of SHA-256 of its compressed key. */
export const shortId = (pub: Uint8Array): string => b32encode(sha256(compressed(pub)).subarray(0, 8));

// ---- links ----

export interface PayjoinV2 { directory: string; mailbox: string; receiverKey: Uint8Array; ohttp: OhttpKeys; expires: number }
export interface OhttpKeys { keyId: number; pub: Uint8Array }
export type PayjoinTarget = { kind: 'v1'; url: string; noSubstitution: boolean } | ({ kind: 'v2'; noSubstitution: boolean } & PayjoinV2);

/** HTTPS, or a .onion address (Tor encrypts and authenticates those itself). */
function safeUrl(u: URL): boolean { return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname.endsWith('.onion')); }

/** The `pj` parameter of a payment link, or null when it is missing or can't be used safely. */
export function parsePayjoin(pj: string, pjos?: string | null): PayjoinTarget | null {
  let url: URL;
  try { url = new URL(pj.trim()); } catch { return null; }
  if (!safeUrl(url) || url.username || url.password) return null;
  const noSubstitution = pjos === '0';
  let fragment = url.hash.replace(/^#/, '');
  try { fragment = decodeURIComponent(fragment); } catch { return null; }
  if (!/RK1/i.test(fragment) || !/OH1/i.test(fragment) || !/EX1/i.test(fragment)) {
    url.hash = '';
    return { kind: 'v1', url: url.toString(), noSubstitution };
  }
  const params = new Map<string, string>();
  for (const part of fragment.split(/[-+ ]/)) { // '+' (an older separator) may arrive as a space
    const m = part.match(/^([A-Za-z]{2})1([02-9AC-HJ-NP-Zac-hj-np-z]+)$/);
    if (!m) return null;
    params.set(m[1].toUpperCase(), m[2]);
  }
  try {
    const ex = b32decode(params.get('EX')!); const oh = b32decode(params.get('OH')!); const rk = b32decode(params.get('RK')!);
    if (ex.length !== 4 || oh.length !== 34 || rk.length !== 33) return null;
    compressed(oh.subarray(1)); compressed(rk); // both must be points
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 1 || !/^[02-9AC-HJ-NP-Z]{13}$/i.test(segments[0])) return null;
    return {
      kind: 'v2', noSubstitution: true, directory: url.origin, mailbox: segments[0].toUpperCase(),
      receiverKey: rk, ohttp: { keyId: oh[0], pub: oh.subarray(1) }, expires: Buffer.from(ex).readUInt32LE(0),
    };
  } catch { return null; }
}

/** A BIP77 link to be paid at, for a receive address. */
export function payjoinUri(o: { address: string; amount?: string; directory: string; receiverKey: Uint8Array; ohttp: OhttpKeys; expires: number }): string {
  const ex = Buffer.alloc(4); ex.writeUInt32LE(o.expires);
  const fragment = [`EX1${b32encode(ex)}`, `OH1${b32encode(Uint8Array.from([o.ohttp.keyId, ...compressed(o.ohttp.pub)]))}`, `RK1${b32encode(compressed(o.receiverKey))}`].join('-');
  const pj = `${o.directory.toUpperCase()}/${shortId(o.receiverKey)}%23${fragment}`;
  return `bitcoin:${o.address.toUpperCase()}?${o.amount ? `amount=${o.amount}&` : ''}pjos=0&pj=${pj}`;
}

// ---- Oblivious HTTP (RFC 9458) carrying Binary HTTP (RFC 9292), padded as BIP77 asks ----

export const OHTTP_BYTES = 8192;
const BHTTP_REQUEST_BYTES = OHTTP_BYTES - 7 - 65 - 16;

function varint(n: number): Uint8Array {
  if (n < 64) return Uint8Array.of(n);
  if (n < 16384) return Uint8Array.of(0x40 | (n >> 8), n & 0xff);
  const b = Buffer.alloc(4); b.writeUInt32BE((n | 0x80000000) >>> 0); return b;
}
function readVarint(b: Uint8Array, o: number): [number, number] {
  const len = 1 << (b[o] >> 6);
  if (o + len > b.length) throw new Error('A directory answer was cut short.');
  let v = b[o] & 0x3f;
  for (let i = 1; i < len; i++) v = v * 256 + b[o + i];
  return [v, o + len];
}
const field = (b: Uint8Array): Uint8Array => cat(varint(b.length), b);

export function bhttpRequest(method: string, target: string, body?: Uint8Array): Uint8Array {
  const u = new URL(target);
  const msg = cat(varint(0), field(te(method)), field(te(u.protocol.replace(':', ''))), field(te(u.host)), field(te(u.pathname + u.search)), varint(0), field(body ?? new Uint8Array(0)), varint(0));
  if (msg.length > BHTTP_REQUEST_BYTES) throw new Error('A Payjoin message is too large.');
  return cat(msg, randomBytes(BHTTP_REQUEST_BYTES - msg.length));
}
export function bhttpResponse(b: Uint8Array): { status: number; body: Uint8Array } {
  let o = 0; let v: number;
  [v, o] = readVarint(b, o);
  if (v !== 1) throw new Error('A directory answer was not understood.');
  let status: number;
  for (;;) { [status, o] = readVarint(b, o); if (status >= 200) break; [v, o] = readVarint(b, o); o += v; } // skip 1xx and their headers
  [v, o] = readVarint(b, o); o += v; // headers
  [v, o] = readVarint(b, o);
  if (o + v > b.length) throw new Error('A directory answer was cut short.');
  return { status, body: b.slice(o, o + v) };
}
/** The server side, for tests: a request out of its Binary HTTP form. */
export function bhttpParseRequest(b: Uint8Array): { method: string; url: string; body: Uint8Array } {
  let o = 0; let v: number;
  [v, o] = readVarint(b, o);
  if (v !== 0) throw new Error('Not a known-length request.');
  const parts: string[] = [];
  for (let i = 0; i < 4; i++) { [v, o] = readVarint(b, o); parts.push(Buffer.from(b.subarray(o, o + v)).toString()); o += v; }
  [v, o] = readVarint(b, o); o += v;
  [v, o] = readVarint(b, o);
  return { method: parts[0], url: `${parts[1]}://${parts[2]}${parts[3]}`, body: b.slice(o, o + v) };
}
export function bhttpEncodeResponse(status: number, body: Uint8Array): Uint8Array {
  const msg = cat(varint(1), varint(status), varint(0), field(body), varint(0));
  return cat(msg, new Uint8Array(OHTTP_BYTES - 32 - 16 - msg.length));
}

const ohttpHeader = (keyId: number): Uint8Array => Uint8Array.of(keyId, KEM_ID >> 8, KEM_ID & 0xff, KDF_ID >> 8, KDF_ID & 0xff, AEAD_ID >> 8, AEAD_ID & 0xff);
const REQ_LABEL = te('message/bhttp request');
const RES_LABEL = te('message/bhttp response');

export function ohttpEncapsulate(keys: OhttpKeys, method: string, target: string, body?: Uint8Array): { request: Uint8Array; open: (res: Uint8Array) => { status: number; body: Uint8Array } } {
  const hdr = ohttpHeader(keys.keyId);
  const { enc, ctx } = setupSender(keys.pub, cat(REQ_LABEL, Uint8Array.of(0), hdr));
  const request = cat(hdr, enc, ctx.seal(bhttpRequest(method, target, body)));
  if (request.length !== OHTTP_BYTES) throw new Error('A Payjoin request has the wrong size.');
  const secret = ctx.export(RES_LABEL, 32);
  return {
    request,
    open: (res) => {
      if (res.length !== OHTTP_BYTES) throw new Error('The Payjoin directory gave an answer of the wrong size.');
      const nonce = res.subarray(0, 32);
      const prk = extract(sha256, secret, cat(enc, nonce));
      const pt = chacha20poly1305(expand(sha256, prk, te('key'), 32), expand(sha256, prk, te('nonce'), 12)).decrypt(res.subarray(32));
      return bhttpResponse(pt);
    },
  };
}
/** The gateway side, for tests. */
export function ohttpDecapsulate(sk: Uint8Array, keyId: number, request: Uint8Array): { method: string; url: string; body: Uint8Array; reply: (status: number, body: Uint8Array) => Uint8Array } {
  const hdr = request.subarray(0, 7);
  if (hdr[0] !== keyId) throw new Error('Unknown key.');
  const enc = request.subarray(7, 72);
  const ctx = setupReceiver(enc, sk, cat(REQ_LABEL, Uint8Array.of(0), hdr));
  const req = bhttpParseRequest(ctx.open(request.subarray(72)));
  const secret = ctx.export(RES_LABEL, 32);
  return {
    ...req,
    reply: (status, body) => {
      const nonce = randomBytes(32);
      const prk = extract(sha256, secret, cat(enc, nonce));
      return cat(nonce, chacha20poly1305(expand(sha256, prk, te('key'), 32), expand(sha256, prk, te('nonce'), 12)).encrypt(bhttpEncodeResponse(status, body)));
    },
  };
}

/** A directory's key configuration (RFC 9458), as its gateway gives it. Only the suite BIP77 uses is taken. */
export function parseOhttpKeys(b: Uint8Array): OhttpKeys {
  // Some gateways put the configuration in a list with a 2-byte length first.
  if (b.length >= 2 && (b[0] << 8 | b[1]) === b.length - 2) b = b.subarray(2);
  if (b.length < 1 + 2 + 65 + 2 || (b[1] << 8 | b[2]) !== KEM_ID) throw new Error('The Payjoin directory uses keys this wallet does not know.');
  const pub = b.slice(3, 68);
  const n = b[68] << 8 | b[69];
  let ok = false;
  for (let i = 70; i + 4 <= 70 + n && i + 4 <= b.length; i += 4) if ((b[i] << 8 | b[i + 1]) === KDF_ID && (b[i + 2] << 8 | b[i + 3]) === AEAD_ID) ok = true;
  if (!ok) throw new Error('The Payjoin directory uses keys this wallet does not know.');
  compressed(pub);
  return { keyId: b[0], pub };
}

// ---- end-to-end messages (BIP77) ----

const MESSAGE_BYTES = 7168;
const INFO_A = te('PjV2MsgA');
const INFO_B = te('PjV2MsgB');
const pad = (b: Uint8Array, len: number): Uint8Array => { if (b.length > len) throw new Error('A Payjoin message is too large.'); return cat(b, new Uint8Array(len - b.length)); };

export function sealA(body: Uint8Array, replyPub: Uint8Array, receiverPub: Uint8Array): Uint8Array {
  const { enc, ctx } = setupSender(receiverPub, INFO_A);
  return cat(ellswiftEncode(enc), ctx.seal(cat(compressed(replyPub), pad(body, MESSAGE_BYTES - 64 - 33 - 16))));
}
export function openA(msg: Uint8Array, receiverSk: Uint8Array): { body: Uint8Array; replyPub: Uint8Array } {
  if (msg.length < 64 + 33 + 16) throw new Error('A Payjoin message was cut short.');
  const pt = setupReceiver(ellswiftDecode(msg.subarray(0, 64)), receiverSk, INFO_A).open(msg.subarray(64));
  return { replyPub: pt.slice(0, 33), body: pt.slice(33) };
}
export function sealB(body: Uint8Array, receiverSk: Uint8Array, replyPub: Uint8Array): Uint8Array {
  const { enc, ctx } = setupSender(replyPub, INFO_B, receiverSk);
  return cat(ellswiftEncode(enc), ctx.seal(pad(body, MESSAGE_BYTES - 64 - 16)));
}
export function openB(msg: Uint8Array, receiverPub: Uint8Array, replySk: Uint8Array): Uint8Array {
  if (msg.length < 64 + 16) throw new Error('A Payjoin message was cut short.');
  return setupReceiver(ellswiftDecode(msg.subarray(0, 64)), replySk, INFO_B, receiverPub).open(msg.subarray(64));
}
/** Text up to the zero padding. */
const untilZero = (b: Uint8Array): Uint8Array => { const i = b.indexOf(0); return i < 0 ? b : b.subarray(0, i); };

// ---- PSBTs ----

/** How long a PSBT really is, so padding after it can be dropped (a proposal comes zero-padded). */
export function psbtLength(b: Uint8Array): number {
  if (b.length < 5 || hex(b.subarray(0, 5)) !== '70736274ff') throw new Error('Not a PSBT.');
  let o = 5;
  const compact = (): number => {
    if (o >= b.length) throw new Error('A PSBT was cut short.');
    const f = b[o++];
    if (f < 0xfd) return f;
    const n = f === 0xfd ? 2 : f === 0xfe ? 4 : 8;
    if (o + n > b.length) throw new Error('A PSBT was cut short.');
    let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + b[o + i];
    o += n;
    if (v > b.length) throw new Error('A PSBT was cut short.'); // never a real length here
    return v;
  };
  let tx: Uint8Array | null = null;
  const map = (): void => {
    for (;;) {
      if (o >= b.length) throw new Error('A PSBT was cut short.');
      const kl = compact();
      if (kl === 0) return;
      const keyAt = o; o += kl;
      const vl = compact();
      if (!tx && kl === 1 && b[keyAt] === 0) tx = b.subarray(o, o + vl);
      o += vl;
      if (o > b.length) throw new Error('A PSBT was cut short.');
    }
  };
  map();
  if (!tx) throw new Error('A PSBT has no transaction.');
  const parsed = btc.RawTx.decode(tx);
  for (let i = 0; i < parsed.inputs.length; i++) map();
  for (let i = 0; i < parsed.outputs.length; i++) map();
  return o;
}

const TX_OPTS = { allowUnknownOutputs: true, allowUnknownInputs: true, allowUnknown: true, disableScriptCheck: true };
export const readPsbt = (b: Uint8Array): any => btc.Transaction.fromPSBT(b.subarray(0, psbtLength(b)), TX_OPTS);
const outpoint = (i: any): string => `${hex(i.txid)}:${i.index}`;
const inputVb = (script: Uint8Array): number => {
  // P2TR 57.5, P2WPKH 68, P2SH-P2WPKH 91, P2PKH 148: what a typical spend adds.
  if (script.length === 34 && script[0] === 0x51) return 57.5;
  if (script.length === 22 && script[0] === 0x00) return 68;
  if (script.length === 23 && script[0] === 0xa9) return 91;
  return 148;
};
const prevout = (i: any): { script: Uint8Array; amount: bigint } | null => {
  if (i.witnessUtxo) return i.witnessUtxo;
  if (i.nonWitnessUtxo) return i.nonWitnessUtxo.outputs[i.index] ?? null;
  return null;
};

/** The original payment as a BIP78 PSBT: final, with each coin's output, and nothing else. */
export function originalPsbt(signedHex: string, prevouts: { script: Uint8Array; amount: bigint }[]): Uint8Array {
  const signed = btc.Transaction.fromRaw(Buffer.from(signedHex, 'hex'), TX_OPTS);
  const out = new btc.Transaction({ version: signed.version, lockTime: signed.lockTime, ...TX_OPTS });
  for (let i = 0; i < signed.inputsLength; i++) {
    const s = signed.getInput(i);
    out.addInput({ txid: s.txid, index: s.index, sequence: s.sequence, witnessUtxo: prevouts[i], finalScriptWitness: s.finalScriptWitness, ...(s.finalScriptSig?.length ? { finalScriptSig: s.finalScriptSig } : {}) }, true);
  }
  for (let i = 0; i < signed.outputsLength; i++) { const o = signed.getOutput(i); out.addOutput({ script: o.script, amount: o.amount }, true); }
  return out.toPSBT(0);
}

export interface SenderRules {
  /** The signed original: what is broadcast if Payjoin doesn't work out. */
  original: Uint8Array;
  /** Where the payment goes, which must keep at least its value (substitution is never allowed here). */
  payScript: Uint8Array;
  /** The sender's change, which may pay up to `maxFeeContribution` toward the receiver's added coin. */
  changeIndex: number | null;
  maxFeeContribution: bigint;
  minFeeRate: number;
}

/** The query parameters of a request (BIP78), from the sender's rules. */
export function senderParams(r: SenderRules, version: 1 | 2): string {
  const p = new URLSearchParams();
  if (version === 1) p.set('v', '1');
  if (r.changeIndex !== null && r.maxFeeContribution > 0n) { p.set('additionalfeeoutputindex', String(r.changeIndex)); p.set('maxadditionalfeecontribution', String(r.maxFeeContribution)); }
  p.set('disableoutputsubstitution', 'true');
  p.set('minfeerate', String(r.minFeeRate));
  return p.toString();
}

/**
 * The sender's checklist (BIP78): the proposal keeps every coin, sequence, lock time and output of the original,
 * pays the receiver at least as much, never takes more from the change than offered and only for fees, and doesn't
 * lower the fee. Returns the proposal with this wallet's coins ready to sign again.
 */
export function checkProposal(proposalBytes: Uint8Array, r: SenderRules): { tx: any; ours: number[]; added: number; contribution: bigint } {
  const original = readPsbt(r.original);
  const proposal = readPsbt(proposalBytes);
  if (proposal.version !== original.version) throw new Error('The receiver changed the transaction version.');
  if (proposal.lockTime !== original.lockTime) throw new Error('The receiver changed the lock time.');
  const origIns = Array.from({ length: original.inputsLength }, (_, i) => original.getInput(i));
  const ours: number[] = [];
  let next = 0; let sequence: number | null = null; let added = 0;
  for (let i = 0; i < proposal.inputsLength; i++) {
    const p = proposal.getInput(i);
    if (p.bip32Derivation?.length || p.tapBip32Derivation?.length) throw new Error('The receiver\'s proposal carries key paths.');
    if (p.partialSig?.length || p.tapKeySig || p.tapScriptSig?.length) throw new Error('The receiver\'s proposal carries partial signatures.');
    if (sequence === null) sequence = p.sequence; else if (p.sequence !== sequence) throw new Error('The receiver\'s inputs use different sequence numbers.');
    const o = origIns[next];
    if (o && outpoint(p) === outpoint(o)) {
      if (p.sequence !== o.sequence) throw new Error('The receiver changed an input\'s sequence number.');
      if (p.finalScriptWitness?.length || p.finalScriptSig?.length) throw new Error('The receiver\'s proposal finalized one of this wallet\'s inputs.');
      const u = prevout(p);
      if (u && (hex(u.script) !== hex(o.witnessUtxo.script) || u.amount !== o.witnessUtxo.amount)) throw new Error('The receiver changed one of this wallet\'s coins.');
      ours.push(i); next++;
      continue;
    }
    if (origIns.some((x) => outpoint(x) === outpoint(p))) throw new Error('The receiver reordered the inputs.');
    if (!p.finalScriptWitness?.length && !p.finalScriptSig?.length) throw new Error('The receiver\'s own input is not signed.');
    if (!prevout(p)) throw new Error('The receiver\'s input lacks its coin\'s details.');
    added++;
  }
  if (next !== origIns.length) throw new Error('The receiver left out one of this wallet\'s coins.');

  const origOuts = Array.from({ length: original.outputsLength }, (_, i) => original.getOutput(i));
  let contribution = 0n; let j = 0;
  for (let i = 0; i < proposal.outputsLength; i++) {
    const p = proposal.getOutput(i);
    if (p.bip32Derivation?.length || p.tapBip32Derivation?.length) throw new Error('The receiver\'s proposal carries key paths.');
    const o = origOuts[j];
    if (o && hex(p.script) === hex(o.script)) {
      if (j === r.changeIndex) {
        if (p.amount < o.amount) contribution = BigInt(o.amount) - BigInt(p.amount);
      } else if (p.amount < o.amount) throw new Error(hex(o.script) === hex(r.payScript) ? 'The receiver lowered the payment.' : 'The receiver lowered an output.');
      j++;
    }
  }
  if (j !== origOuts.length) throw new Error('The receiver left out or reordered an output of the original.');

  const byOutpoint = new Map(origIns.map((x) => [outpoint(x), x.witnessUtxo]));
  const inSum = (t: any): bigint => {
    let s = 0n;
    for (let i = 0; i < t.inputsLength; i++) { const p = t.getInput(i); const u = byOutpoint.get(outpoint(p)) ?? prevout(p); if (!u) throw new Error('A coin\'s details are missing.'); s += u.amount; }
    return s;
  };
  const outSum = (t: any): bigint => { let s = 0n; for (let i = 0; i < t.outputsLength; i++) s += t.getOutput(i).amount; return s; };
  const origFee = inSum(original) - outSum(original);
  const newFee = inSum(proposal) - outSum(proposal);
  if (newFee < origFee) throw new Error('The receiver lowered the fee.');
  if (contribution > 0n) {
    if (contribution > r.maxFeeContribution) throw new Error('The receiver took more from the change than offered.');
    if (contribution > newFee - origFee) throw new Error('The receiver took change for something other than fees.');
    const origVsize = btc.Transaction.fromRaw(original.extract(), TX_OPTS).vsize;
    const origRate = Number(origFee) / origVsize;
    const ourType = inputVb(origIns[0].witnessUtxo.script);
    if (Number(contribution) > Math.ceil(origRate * ourType * added) + 1) throw new Error('The receiver took more from the change than its coin costs.');
  }
  return { tx: proposal, ours, added, contribution };
}

/**
 * Signs this wallet's inputs of a checked proposal again, and checks the final fee rate.
 * `keys[k]` signs the k-th original input (a BIP86 output key, already tweaked, or as btc-signer takes it).
 */
export function signProposal(checked: { tx: any; ours: number[] }, r: SenderRules, sign: (tx: any, idx: number, k: number) => void): { hex: string; id: string; fee: bigint } {
  const original = readPsbt(r.original);
  const tx = checked.tx;
  checked.ours.forEach((idx, k) => {
    const o = original.getInput(k);
    tx.updateInput(idx, { witnessUtxo: o.witnessUtxo }, true);
    sign(tx, idx, k);
    tx.finalizeIdx(idx);
  });
  const raw = tx.extract();
  const final = btc.Transaction.fromRaw(raw, TX_OPTS);
  const fee = tx.fee as bigint;
  if (Number(fee) / final.vsize < r.minFeeRate) throw new Error('The Payjoin fee rate is below the minimum.');
  return { hex: hex(raw), id: final.id, fee };
}

// ---- the receiver's side (BIP78 checks, then one coin added) ----

/** The highest fee rate (sat/vB) at which this wallet adds its coin to a Payjoin. */
export const MAX_RECEIVER_FEE_RATE = 500;

export interface ReceiverCoin { txid: string; vout: number; amount: bigint; script: Uint8Array; tapInternalKey: Uint8Array }
export interface OriginalSeen { tx: any; payIndex: number; fee: bigint; vsize: number; hex: string; params: URLSearchParams; outpoints: string[] }

/** Reads and checks an original payment sent to `payScript`. `isOurs` says whether a coin is this wallet's. */
export function receiveOriginal(body: string, payScript: Uint8Array, isOurs: (script: Uint8Array) => boolean): OriginalSeen {
  const [b64, query = ''] = body.split('\n');
  const tx = readPsbt(Uint8Array.from(Buffer.from(b64.trim(), 'base64')));
  let inSum = 0n; let outSum = 0n;
  const outpoints: string[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const p = tx.getInput(i); const u = prevout(p);
    if (!u) throw new Error('original-psbt-rejected: an input lacks its coin');
    if (!p.finalScriptWitness?.length && !p.finalScriptSig?.length) throw new Error('original-psbt-rejected: not signed');
    if (p.bip32Derivation?.length || p.tapBip32Derivation?.length) throw new Error('original-psbt-rejected: key paths included');
    if (isOurs(u.script)) throw new Error('original-psbt-rejected: spends a coin of this wallet');
    inSum += u.amount; outpoints.push(outpoint(p));
  }
  let payIndex = -1;
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i); outSum += o.amount;
    if (hex(o.script) === hex(payScript)) { if (payIndex >= 0) throw new Error('original-psbt-rejected: pays twice'); payIndex = i; }
  }
  if (payIndex < 0) throw new Error('original-psbt-rejected: does not pay this address');
  const raw = tx.extract();
  const vsize = btc.Transaction.fromRaw(raw, TX_OPTS).vsize;
  const fee = inSum - outSum;
  if (fee < BigInt(vsize)) throw new Error('original-psbt-rejected: fee below 1 sat/vB');
  return { tx, payIndex, fee, vsize, hex: hex(raw), params: new URLSearchParams(query.trim()), outpoints };
}

/**
 * The proposal: the original with one coin of this wallet's at a random place, its value added to the payment, and
 * the fee raised to keep the original's fee rate (from the sender's change as far as offered, the rest from the
 * added value). `sign` signs the added input (taproot key path).
 */
export function buildProposal(seen: OriginalSeen, coin: ReceiverCoin, sign: (tx: any, idx: number) => void, dust = 330n): { psbt: Uint8Array; extraFee: bigint } {
  const orig = seen.tx;
  const seq = orig.getInput(0).sequence;
  for (let i = 1; i < orig.inputsLength; i++) if (orig.getInput(i).sequence !== seq) throw new Error('original-psbt-rejected: mixed sequence numbers');
  const rate = Number(seen.fee) / seen.vsize;
  // This wallet pays its coin's share at the original's fee rate: an absurd rate would make it pay an absurd fee.
  if (rate > MAX_RECEIVER_FEE_RATE) throw new Error('original-psbt-rejected: fee rate too high');
  const extraFee = BigInt(Math.ceil(rate * 57.5));
  let fromSender = 0n;
  const feeIdx = Number(seen.params.get('additionalfeeoutputindex'));
  const maxC = BigInt(Math.max(0, Math.floor(Number(seen.params.get('maxadditionalfeecontribution') ?? 0)) || 0));
  if (seen.params.has('additionalfeeoutputindex') && Number.isInteger(feeIdx) && feeIdx >= 0 && feeIdx < orig.outputsLength && feeIdx !== seen.payIndex && maxC > 0n) {
    const room = orig.getOutput(feeIdx).amount - dust;
    fromSender = [extraFee, maxC, room > 0n ? room : 0n].reduce((a, b) => (a < b ? a : b));
  }
  const fromUs = extraFee - fromSender;
  if (coin.amount <= fromUs + dust) throw new Error('not-enough-money');

  const place = randomInt(orig.inputsLength + 1);
  const tx = new btc.Transaction({ version: orig.version, lockTime: orig.lockTime, ...TX_OPTS });
  const added = (): void => { tx.addInput({ txid: coin.txid, index: coin.vout, sequence: seq, witnessUtxo: { script: coin.script, amount: coin.amount }, tapInternalKey: coin.tapInternalKey }, true); };
  for (let i = 0; i < orig.inputsLength; i++) {
    if (i === place) added();
    const p = orig.getInput(i);
    tx.addInput({ txid: p.txid, index: p.index, sequence: p.sequence, witnessUtxo: prevout(p)! }, true);
  }
  if (place === orig.inputsLength) added();
  for (let i = 0; i < orig.outputsLength; i++) {
    const o = orig.getOutput(i);
    const amount = i === seen.payIndex ? o.amount + coin.amount - fromUs : i === feeIdx && fromSender > 0n ? o.amount - fromSender : o.amount;
    tx.addOutput({ script: o.script, amount }, true);
  }
  const minRate = Number(seen.params.get('minfeerate') ?? 0);
  sign(tx, place);
  tx.finalizeIdx(place);
  // Only what the sender needs: every coin's output, and this wallet's signature.
  const out = new btc.Transaction({ version: orig.version, lockTime: orig.lockTime, ...TX_OPTS });
  for (let i = 0; i < tx.inputsLength; i++) {
    const p = tx.getInput(i);
    out.addInput({ txid: p.txid, index: p.index, sequence: p.sequence, witnessUtxo: p.witnessUtxo, ...(i === place ? { finalScriptWitness: p.finalScriptWitness } : {}) }, true);
  }
  for (let i = 0; i < tx.outputsLength; i++) { const o = tx.getOutput(i); out.addOutput({ script: o.script, amount: o.amount }, true); }
  // The sender's signatures will add about what they did in the original; the fee rate must not fall below its minimum.
  const estVsize = seen.vsize + 57.5;
  if (Number.isFinite(minRate) && minRate > 0 && Number(seen.fee + extraFee) / estVsize < minRate) throw new Error('not-enough-money');
  return { psbt: out.toPSBT(0), extraFee };
}

// ---- talking to a directory ----

export type Post = (url: string, body: Uint8Array, contentType: string, timeoutMs: number) => Promise<{ status: number; body: Uint8Array }>;

async function viaGateway(post: Post, t: { directory: string; ohttp: OhttpKeys }, method: string, mailbox: string, body: Uint8Array | undefined, timeoutMs: number): Promise<{ status: number; body: Uint8Array }> {
  const { request, open } = ohttpEncapsulate(t.ohttp, method, `${t.directory}/${mailbox}`, body);
  const res = await post(`${t.directory}/.well-known/ohttp-gateway`, request, 'message/ohttp-req', timeoutMs);
  if (res.status !== 200) throw new Error(`The Payjoin directory answered ${res.status}.`);
  return open(res.body);
}

/** Leaves the original at the receiver's mailbox and waits for the proposal. Null when none came in time. */
export async function sendV2(post: Post, t: PayjoinV2, original: Uint8Array, query: string, until: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<Uint8Array | null> {
  if (Date.now() / 1000 > t.expires) throw new Error('This Payjoin link has expired.');
  const replySk = newPrivateKey();
  const replyPub = publicKeyOf(replySk);
  const body = te(`${Buffer.from(original).toString('base64')}\n${query}`);
  const posted = await viaGateway(post, t, 'POST', t.mailbox, sealA(body, replyPub, t.receiverKey), 60_000);
  if (posted.status !== 200) throw new Error(`The Payjoin directory refused the payment (${posted.status}).`);
  const mine = shortId(replyPub);
  while (Date.now() < until && Date.now() / 1000 < t.expires) {
    // The poll carries an empty message, so it looks like any other.
    const res = await viaGateway(post, t, 'GET', mine, sealA(new Uint8Array(0), replyPub, t.receiverKey), 60_000).catch(() => null);
    if (res?.status === 200) {
      const pt = openB(res.body, t.receiverKey, replySk);
      if (pt[0] === 0x7b) { // {"errorCode": …}
        let code = 'unavailable';
        try { code = String(JSON.parse(Buffer.from(untilZero(pt)).toString()).errorCode ?? code); } catch { /* */ }
        throw new Error(`payjoin:${code}`);
      }
      return pt.subarray(0, psbtLength(pt));
    }
    // A directory holds a poll up to 30 s when nothing is there; one that answers at once is not asked again at once.
    await sleep(res?.status === 202 ? 1_000 : 5_000);
  }
  return null;
}

/** BIP78: posts the original and takes the proposal from the answer. */
export async function sendV1(post: Post, url: string, original: Uint8Array, query: string, timeoutMs: number): Promise<Uint8Array> {
  const u = new URL(url);
  for (const [k, v] of new URLSearchParams(query)) u.searchParams.set(k, v);
  const res = await post(u.toString(), te(Buffer.from(original).toString('base64')), 'text/plain', timeoutMs);
  const text = Buffer.from(res.body).toString().trim();
  if (res.status !== 200) {
    let code = 'unavailable';
    try { code = String(JSON.parse(text).errorCode ?? code); } catch { /* */ }
    throw new Error(`payjoin:${code}`);
  }
  return Uint8Array.from(Buffer.from(text, 'base64'));
}

/** The receiver's mailbox: the next original sent to it, or null when none is there yet. */
export async function receivePoll(post: Post, s: { directory: string; ohttp: OhttpKeys; receiverSk: Uint8Array }): Promise<{ body: string; replyPub: Uint8Array } | null> {
  const res = await viaGateway(post, s, 'GET', shortId(publicKeyOf(s.receiverSk)), undefined, 60_000);
  if (res.status === 202) return null;
  if (res.status !== 200) throw new Error(`The Payjoin directory answered ${res.status}.`);
  const { body, replyPub } = openA(res.body, s.receiverSk);
  return { body: Buffer.from(untilZero(body)).toString(), replyPub };
}

/** Leaves the proposal (or an error) at the sender's mailbox. */
export async function receiveReply(post: Post, s: { directory: string; ohttp: OhttpKeys; receiverSk: Uint8Array }, replyPub: Uint8Array, reply: Uint8Array): Promise<void> {
  const res = await viaGateway(post, s, 'POST', shortId(replyPub), sealB(reply, s.receiverSk, replyPub), 60_000);
  if (res.status !== 200) throw new Error(`The Payjoin directory refused the proposal (${res.status}).`);
}
export const errorReply = (code: string): Uint8Array => te(JSON.stringify({ errorCode: code, message: 'Payjoin was not possible.' }));
