// A WabiSabi round as the coordinator describes it: its parameters and ID, the inputs and outputs so far, the
// ownership proofs that bind inputs to the round, and the transaction everyone signs. Follows Wasabi Wallet's
// coordinator protocol (WalletWasabi, MIT licence).
import { StrobeHasher } from './strobe';
import { IssuerParams, pointBytes } from './credentials';
import { fromHex, readIssuerParams } from './messages';

const { sha256 } = require('@noble/hashes/sha2.js');
const { hmac } = require('@noble/hashes/hmac.js');
const { ripemd160 } = require('@noble/hashes/legacy.js');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1.js');
const btc = require('@scure/btc-signer');

export enum Phase { InputRegistration = 0, ConnectionConfirmation = 1, OutputRegistration = 2, TransactionSigning = 3, Ended = 4 }
export enum EndRoundState { None = 0, AbortedWithError = 1, AbortedNotEnoughAlices = 2, TransactionBroadcastFailed = 3, TransactionBroadcasted = 4, NotAllAlicesSign = 5, AbortedNotEnoughAlicesSigned = 6, AbortedNotAllAlicesConfirmed = 7, AbortedLoadBalancing = 8 }
/** NBitcoin's ScriptType numbers. */
export const SCRIPT_TYPE = { P2PKH: 1, P2SH: 2, P2WPKH: 4, P2WSH: 5, Taproot: 7 } as const;
const SCRIPT_TYPE_NAMES = ['Witness', 'P2PKH', 'P2SH', 'P2PK', 'P2WPKH', 'P2WSH', 'MultiSig', 'Taproot'];

// Wasabi's size estimates, in virtual bytes.
const INPUT_VSIZE: Record<number, number> = { 4: 69, 7: 58, 1: 148, 2: 297, 5: 105 };
export const P2TR_OUTPUT_VSIZE = 43;
/** Version, locktime, two 3-byte varints, then marker and flag as witness data. */
export const SHARED_OVERHEAD = 4 + 4 + 3 + 3 + Math.ceil(2 / 4);

export interface RoundParameters {
  network: string; feePerK: bigint; minInputs: number; maxInputs: number;
  inputMin: bigint; inputMax: bigint; outputMin: bigint; outputMax: bigint;
  inputTypes: number[]; outputTypes: number[];
  connectionConfirmationMs: number; outputRegistrationMs: number; signingMs: number;
  maxAmountCredential: bigint; maxVsizePerAlice: number; coordinationId: string;
  delaySigning: boolean; maxTxSize: number; minRelayFeePerK: bigint; coordinationFee: number;
  timeouts: { connectionConfirmation: bigint; outputRegistration: bigint; signing: bigint };
}
export interface Coin { txid: string; vout: number; value: bigint; script: Uint8Array; proof?: Uint8Array }
export interface TxOut { value: bigint; script: Uint8Array }
export interface RoundState {
  id: string; blameOf: string; phase: Phase; end: EndRoundState;
  amountIssuer: IssuerParams; vsizeIssuer: IssuerParams;
  inputRegistrationStart: number; inputRegistrationEnd: number; inputRegistrationTimeout: bigint;
  params: RoundParameters; signing: boolean; inputs: Coin[]; outputs: TxOut[];
  /** Witnesses already given in the signing phase, by input index. */
  witnesses: Map<number, Uint8Array[]>;
  /** How many events this state carries, for status checkpoints. */
  events: number;
}

// ---- small readers ----

/** "0d 0h 1m 30s" as .NET ticks (100 ns). */
export function timeSpanTicks(s: unknown): bigint {
  const m = typeof s === 'string' ? /^(-?\d+)d (-?\d+)h (-?\d+)m (-?\d+)s$/.exec(s) : null;
  if (!m) throw new Error('The coordinator sent a time span in an unexpected form.');
  return BigInt(((Number(m[1]) * 24 + Number(m[2])) * 60 + Number(m[3])) * 60 + Number(m[4])) * 10_000_000n;
}
const ticksMs = (t: bigint) => Number(t / 10_000n);
function int(v: unknown, what: string): bigint {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error(`The coordinator sent an unexpected ${what}.`);
  return BigInt(v);
}
const num = (v: unknown, what: string) => Number(int(v, what));
function date(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw new Error('The coordinator sent an unexpected date.');
  return t;
}

/** NBitcoin's script text: data pushes as hex, OP_0 as "0", OP_1 as "1". Only standard output scripts are read. */
export function parseScript(s: unknown): Uint8Array {
  if (typeof s !== 'string') throw new Error('The coordinator sent an unexpected script.');
  const p = s.trim().split(/\s+/);
  const data = (h: string, len: number) => { const b = fromHex(h, len); return b; };
  const cat = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((x) => [...x]));
  if (p.length === 2 && p[0] === '1' && p[1].length === 64) return cat([0x51, 32], data(p[1], 32));
  if (p.length === 2 && p[0] === '0' && p[1].length === 40) return cat([0x00, 20], data(p[1], 20));
  if (p.length === 2 && p[0] === '0' && p[1].length === 64) return cat([0x00, 32], data(p[1], 32));
  if (p.length === 5 && p[0] === 'OP_DUP' && p[1] === 'OP_HASH160' && p[3] === 'OP_EQUALVERIFY' && p[4] === 'OP_CHECKSIG') return cat([0x76, 0xa9, 20], data(p[2], 20), [0x88, 0xac]);
  if (p.length === 3 && p[0] === 'OP_HASH160' && p[2] === 'OP_EQUAL') return cat([0xa9, 20], data(p[1], 20), [0x87]);
  throw new Error('The coordinator sent a script this wallet does not use.');
}
export function scriptText(script: Uint8Array): string {
  const hex = Buffer.from(script.slice(2)).toString('hex');
  if (script.length === 34 && script[0] === 0x51 && script[1] === 32) return `1 ${hex}`;
  if ((script.length === 22 && script[1] === 20 || script.length === 34 && script[1] === 32) && script[0] === 0) return `0 ${hex}`;
  throw new Error('Only taproot and segwit outputs are registered.');
}
export function scriptType(script: Uint8Array): number {
  if (script.length === 34 && script[0] === 0x51 && script[1] === 32) return SCRIPT_TYPE.Taproot;
  if (script.length === 22 && script[0] === 0 && script[1] === 20) return SCRIPT_TYPE.P2WPKH;
  if (script.length === 34 && script[0] === 0 && script[1] === 32) return SCRIPT_TYPE.P2WSH;
  if (script.length === 25 && script[0] === 0x76) return SCRIPT_TYPE.P2PKH;
  if (script.length === 23 && script[0] === 0xa9) return SCRIPT_TYPE.P2SH;
  return -1;
}
export function inputVsize(script: Uint8Array): number {
  const v = INPUT_VSIZE[scriptType(script)];
  if (!v) throw new Error('An input of a kind this wallet cannot size was registered.');
  return v;
}
/** A serialized TxOut with no value: 8 bytes, a length byte, the script. */
export const outputVsize = (script: Uint8Array): number => 8 + 1 + script.length;
/** NBitcoin's FeeRate.GetFee: whole satoshis rounded down, at least one. */
export function fee(feePerK: bigint, vsize: number): bigint {
  const f = feePerK * BigInt(vsize) / 1000n;
  return f === 0n ? 1n : f;
}
export const effectiveValue = (c: { value: bigint; script: Uint8Array }, feePerK: bigint) => c.value - fee(feePerK, inputVsize(c.script));

/** Outpoint bytes: the txid in internal order, then the index as 4 bytes little endian. */
export function outpointBytes(txid: string, vout: number): Uint8Array {
  const b = new Uint8Array(36);
  b.set(Buffer.from(txid, 'hex').reverse());
  new DataView(b.buffer).setUint32(32, vout, true);
  return b;
}
function readOutpoint(h: unknown): { txid: string; vout: number } {
  const b = fromHex(h, 36);
  return { txid: Buffer.from(b.slice(0, 32)).reverse().toString('hex'), vout: new DataView(b.buffer, b.byteOffset).getUint32(32, true) };
}

// ---- round state ----

function readParams(p: any): RoundParameters {
  const types = (v: unknown) => {
    if (!Array.isArray(v) || v.length > 8) throw new Error('The coordinator sent unexpected script types.');
    return v.map((t) => { const n = num(t, 'script type'); if (n < 0 || n > 7) throw new Error('The coordinator sent an unknown script type.'); return n; });
  };
  const rate = p?.CoordinationFeeRate?.Rate;
  const timeouts = { connectionConfirmation: timeSpanTicks(p?.ConnectionConfirmationTimeout), outputRegistration: timeSpanTicks(p?.OutputRegistrationTimeout), signing: timeSpanTicks(p?.TransactionSigningTimeout) };
  if (typeof p?.Network !== 'string' || typeof p?.CoordinationIdentifier !== 'string' || typeof p?.DelayTransactionSigning !== 'boolean') throw new Error('The coordinator sent unexpected round parameters.');
  return {
    network: p.Network, feePerK: int(p.MiningFeeRate, 'fee rate'), minInputs: num(p.MinInputCountByRound, 'input count'), maxInputs: num(p.MaxInputCountByRound, 'input count'),
    inputMin: int(p.AllowedInputAmounts?.Min, 'amount'), inputMax: int(p.AllowedInputAmounts?.Max, 'amount'),
    outputMin: int(p.AllowedOutputAmounts?.Min, 'amount'), outputMax: int(p.AllowedOutputAmounts?.Max, 'amount'),
    inputTypes: types(p.AllowedInputTypes), outputTypes: types(p.AllowedOutputTypes),
    connectionConfirmationMs: ticksMs(timeouts.connectionConfirmation), outputRegistrationMs: ticksMs(timeouts.outputRegistration), signingMs: ticksMs(timeouts.signing),
    maxAmountCredential: int(p.MaxAmountCredentialValue, 'amount'), maxVsizePerAlice: num(p.MaxVsizeAllocationPerAlice, 'size'),
    coordinationId: p.CoordinationIdentifier, delaySigning: p.DelayTransactionSigning,
    maxTxSize: num(p.MaxTransactionSize, 'size'), minRelayFeePerK: int(p.MinRelayTxFee, 'fee rate'),
    coordinationFee: typeof rate === 'number' ? rate : NaN, timeouts,
  };
}

/** A round from the status answer. `base` is the earlier full state, when only newer events were asked for. */
export function readRound(r: any, base?: RoundState): RoundState {
  if (typeof r?.id !== 'string' || !/^[0-9a-f]{64}$/.test(r.id)) throw new Error('The coordinator sent an unexpected round ID.');
  const state = r.coinjoinState;
  if (state?.Type !== 'ConstructionState' && state?.Type !== 'SigningState') throw new Error('The coordinator sent an unexpected round state.');
  if (!Array.isArray(state.Events) || state.Events.length > 4000) throw new Error('The coordinator sent too many events.');
  let params = base?.params;
  const inputs = [...(base?.inputs ?? [])];
  const outputs = [...(base?.outputs ?? [])];
  for (const e of state.Events) {
    if (e?.Type === 'RoundCreated') {
      if (params) throw new Error('The coordinator sent a round created twice.');
      params = readParams(e.RoundParameters);
    } else if (e?.Type === 'InputAdded') {
      const o = readOutpoint(e.Coin?.Outpoint);
      inputs.push({ ...o, value: int(e.Coin?.TxOut?.Value, 'amount'), script: parseScript(e.Coin?.TxOut?.ScriptPubKey), proof: fromHex(e.OwnershipProof) });
    } else if (e?.Type === 'OutputAdded') {
      outputs.push({ value: int(e.Output?.Value, 'amount'), script: parseScript(e.Output?.ScriptPubKey) });
    } else throw new Error('The coordinator sent an unknown round event.');
  }
  if (!params) throw new Error('The coordinator sent a round without parameters.');
  const witnesses = new Map<number, Uint8Array[]>();
  if (state.Type === 'SigningState' && state.Witnesses && typeof state.Witnesses === 'object') {
    for (const [k, v] of Object.entries(state.Witnesses)) witnesses.set(Number(k), readWitness(fromHex(v)));
  }
  const phase = num(r.phase, 'phase');
  if (phase < 0 || phase > 4) throw new Error('The coordinator sent an unknown phase.');
  const start = date(r.inputRegistrationStart);
  const timeout = timeSpanTicks(r.inputRegistrationTimeout);
  return {
    id: r.id, blameOf: String(r.blameOf ?? ''), phase, end: num(r.endRoundState, 'end state'),
    amountIssuer: readIssuerParams(r.amountCredentialIssuerParameters), vsizeIssuer: readIssuerParams(r.vsizeCredentialIssuerParameters),
    inputRegistrationStart: start, inputRegistrationTimeout: timeout, inputRegistrationEnd: start + ticksMs(timeout),
    params, signing: state.Type === 'SigningState', inputs, outputs, witnesses,
    events: (base?.events ?? 0) + state.Events.length,
  };
}
export const isBlame = (r: RoundState) => /[1-9a-f]/.test(r.blameOf);

/** The round ID the coordinator must have computed from these parameters, so a round can't be changed under one ID. */
export function roundId(r: RoundState, startMs: number): string {
  const p = r.params;
  const h = new StrobeHasher('round-parameters')
    .long('input-registration-start', BigInt(startMs))
    .long('input-registration-timeout', r.inputRegistrationTimeout)
    .long('connection-confirmation-timeout', p.timeouts.connectionConfirmation)
    .long('output-registration-timeout', p.timeouts.outputRegistration)
    .long('transaction-signing-timeout', p.timeouts.signing)
    .long('allowed-input-amounts-min', p.inputMin).long('allowed-input-amounts-max', p.inputMax);
  p.inputTypes.forEach((t, i) => h.str(`allowed-input-types-${i}`, SCRIPT_TYPE_NAMES[t]));
  h.long('allowed-output-amounts-min', p.outputMin).long('allowed-output-amounts-max', p.outputMax);
  p.outputTypes.forEach((t, i) => h.str(`allowed-output-types-${i}`, SCRIPT_TYPE_NAMES[t]));
  h.str('network', p.network).long('fee-rate', p.feePerK)
    .long('coordination-fee-rate.Rate', 0n).long('coordination-fee-rate.PlebsDontPayThreshold', 0n)
    .int('max-transaction-size', p.maxTxSize).long('min-relay-tx-fee', p.minRelayFeePerK)
    .long('maximum-amount-credential-value', p.maxAmountCredential)
    .long('maximum-vsize-credential-value', BigInt(p.maxVsizePerAlice))
    .long('per-alice-vsize-allocation', BigInt(p.maxVsizePerAlice))
    .long('maximum-suggested-amount', p.maxAmountCredential)
    .str('coordination-identifier', p.coordinationId)
    .bytes('amount-credential-issuer-parameters.Cw', pointBytes(r.amountIssuer.Cw)).bytes('amount-credential-issuer-parameters.I', pointBytes(r.amountIssuer.I))
    .bytes('vsize-credential-issuer-parameters.Cw', pointBytes(r.vsizeIssuer.Cw)).bytes('vsize-credential-issuer-parameters.I', pointBytes(r.vsizeIssuer.I));
  return Buffer.from(h.hash()).reverse().toString('hex');
}
/** The ID check uses the start time in whole milliseconds, as the coordinator does. */
export const idMatches = (r: RoundState): boolean => roundId(r, Math.floor(r.inputRegistrationStart)) === r.id;

// ---- ownership proofs (SLIP-19 with a BIP-322 style signature) ----

const varint = (n: number): Uint8Array => (n < 0xfd ? Uint8Array.of(n) : Uint8Array.of(0xfd, n & 0xff, n >> 8));
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const MAGIC = Uint8Array.of(0x53, 0x4c, 0x00, 0x19);

/** What an input's proof commits to: the coordinator's name and the round. */
export function commitment(coordinationId: string, id: string): Uint8Array {
  const name = new TextEncoder().encode(coordinationId);
  return cat(varint(name.length), name, Buffer.from(id, 'hex'));
}
function bodyBytes(flags: number, ids: Uint8Array[]): Uint8Array { return cat(MAGIC, Uint8Array.of(flags), varint(ids.length), ...ids); }
function proofHash(body: Uint8Array, script: Uint8Array, commit: Uint8Array): Uint8Array {
  return sha256(cat(body, varint(script.length), script, varint(commit.length), commit));
}
function writeWitness(items: Uint8Array[]): Uint8Array { return cat(varint(items.length), ...items.flatMap((i) => [varint(i.length), i])); }
export const witnessBytes = writeWitness;
function readWitness(b: Uint8Array, at = 0): Uint8Array[] {
  let o = at;
  const vi = () => { const f = b[o++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b[o] | (b[o + 1] << 8); o += 2; return v; } throw new Error('Witness too long.'); };
  const n = vi();
  if (n > 16) throw new Error('Witness too long.');
  const items: Uint8Array[] = [];
  for (let i = 0; i < n; i++) { const l = vi(); if (o + l > b.length) throw new Error('Witness cut short.'); items.push(b.slice(o, o + l)); o += l; }
  if (o !== b.length && at === 0) throw new Error('Witness has trailing bytes.');
  return items;
}

/** The key that identifies this wallet's coins to itself (SLIP-21 path "SLIP-0019"/"Ownership identification key"). */
export function identificationKey(masterPrivateKey: Uint8Array): Uint8Array {
  const { sha512 } = require('@noble/hashes/sha2.js');
  let node: Uint8Array = hmac(sha512, new TextEncoder().encode('Symmetric key seed'), masterPrivateKey);
  for (const label of ['SLIP-0019', 'Ownership identification key']) node = hmac(sha512, node.slice(0, 32), cat(Uint8Array.of(0), new TextEncoder().encode(label)));
  return node.slice(32);
}

/** BIP-86: the internal key tweaked with no script tree. */
function tweakedPrivateKey(priv: Uint8Array): Uint8Array {
  const P = secp256k1.Point.BASE.multiply(BigInt('0x' + Buffer.from(priv).toString('hex')));
  const N = secp256k1.Point.Fn.ORDER;
  let d = BigInt('0x' + Buffer.from(priv).toString('hex'));
  if (!P.hasEvenY()) d = N - d;
  const t = BigInt('0x' + Buffer.from(schnorr.utils.taggedHash('TapTweak', P.toBytes(true).slice(1))).toString('hex'));
  const k = (d + t) % N;
  return Uint8Array.from(Buffer.from(k.toString(16).padStart(64, '0'), 'hex'));
}

/** A taproot coin's proof, with the user-confirmation flag set as CoinJoin input proofs carry it. */
export function ownershipProofTaproot(priv: Uint8Array, script: Uint8Array, idKey: Uint8Array, commit: Uint8Array): Uint8Array {
  const body = bodyBytes(1, [hmac(sha256, idKey, script)]);
  const sig: Uint8Array = schnorr.sign(proofHash(body, script, commit), tweakedPrivateKey(priv), new Uint8Array(32));
  return cat(body, Uint8Array.of(0), writeWitness([sig]));
}

/** Checks another input's proof against its script and this round, as Wasabi does before trusting the round. */
export function verifyOwnership(proof: Uint8Array, script: Uint8Array, commit: Uint8Array): boolean {
  try {
    if (proof.length < 6 || !MAGIC.every((m, i) => proof[i] === m) || !(proof[4] & 1)) return false;
    let o = 5;
    const n = proof[o++];
    if (n >= 0xfd || o + 32 * n > proof.length) return false;
    o += 32 * n;
    const body = proof.slice(0, o);
    if (proof[o++] !== 0) return false; // the script signature is empty for segwit and taproot
    const w = readWitness(proof, o);
    const consumed = writeWitness(w).length;
    if (o + consumed !== proof.length) return false;
    const hash = proofHash(body, script, commit);
    const type = scriptType(script);
    if (type === SCRIPT_TYPE.Taproot) {
      if (w.length !== 1 || w[0].length !== 64) return false;
      return schnorr.verify(w[0], hash, script.slice(2));
    }
    if (type === SCRIPT_TYPE.P2WPKH) {
      if (w.length !== 2 || w[1].length !== 33) return false;
      if (!Buffer.from(ripemd160(sha256(w[1]))).equals(Buffer.from(script.slice(2)))) return false;
      const der = w[0].slice(0, -1);
      return secp256k1.verify(der, hash, w[1], { prehash: false, format: 'der', lowS: false });
    }
    return false;
  } catch {
    return false;
  }
}

// ---- the coinjoin transaction ----

const cmp = (a: Uint8Array, b: Uint8Array) => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; };

/** Inputs by amount, largest first, then by outpoint bytes; outputs merged per script, by amount, then script bytes. */
export function sortedInputs(inputs: Coin[]): Coin[] {
  return [...inputs].sort((a, b) => (a.value === b.value ? cmp(outpointBytes(a.txid, a.vout), outpointBytes(b.txid, b.vout)) : a.value > b.value ? -1 : 1));
}
export function sortedOutputs(outputs: TxOut[]): TxOut[] {
  const merged = new Map<string, TxOut>();
  for (const o of outputs) {
    const k = Buffer.from(o.script).toString('hex');
    const m = merged.get(k);
    merged.set(k, { value: (m?.value ?? 0n) + o.value, script: o.script });
  }
  return [...merged.values()].sort((a, b) => (a.value === b.value ? cmp(a.script, b.script) : a.value > b.value ? -1 : 1));
}

/** The unsigned coinjoin: version 1, lock time 0, every input final, as Wasabi builds it. */
export function unsignedTransaction(r: RoundState): any {
  const tx = new btc.Transaction({ version: 1, lockTime: 0, allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  for (const c of sortedInputs(r.inputs)) tx.addInput({ txid: c.txid, index: c.vout, sequence: 0xffffffff, witnessUtxo: { script: c.script, amount: c.value } });
  for (const o of sortedOutputs(r.outputs)) tx.addOutput({ script: o.script, amount: o.value });
  return tx;
}

/** This wallet's witness for one of its taproot inputs, signed with the default sighash (a 64-byte signature). */
export function signTaprootInput(tx: any, index: number, priv: Uint8Array): Uint8Array {
  const input = tx.getInput(index);
  const pub = secp256k1.getPublicKey(priv, true).slice(1);
  if (!Buffer.from(btc.p2tr(pub).script).equals(Buffer.from(input.witnessUtxo.script))) throw new Error('That input is not this wallet\'s.');
  const copy = tx.clone();
  copy.updateInput(index, { tapInternalKey: pub, sighashType: btc.SigHash.DEFAULT });
  copy.signIdx(priv, index, [btc.SigHash.DEFAULT]);
  copy.finalizeIdx(index);
  const w: Uint8Array[] = copy.getInput(index).finalScriptWitness;
  if (!w || w.length !== 1 || w[0].length !== 64) throw new Error('The signature is not a plain taproot key spend.');
  return writeWitness(w);
}

/** The fee rate the coordinator's transaction actually pays, per 1000 vbytes of what's estimated. */
export function effectiveFeePerK(r: RoundState): bigint {
  const inSum = r.inputs.reduce((s, c) => s + c.value, 0n);
  const outSum = r.outputs.reduce((s, o) => s + o.value, 0n);
  const vsize = r.inputs.reduce((s, c) => s + inputVsize(c.script), 0) + r.outputs.reduce((s, o) => s + outputVsize(o.script), 0);
  return vsize > 0 ? (inSum - outSum) * 1000n / BigInt(vsize) : 0n;
}
