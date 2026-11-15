// Decred mixing (StakeShuffle): a client for the peer-to-peer mixing protocol dcrd and dcrwallet speak, ported from
// dcrd's mixing/mixpool and mixing/mixclient (ISC) and kept to their rules and timing, so this wallet pairs and mixes
// with dcrwallet and Decrediton users.
//
// Each coin to mix is a "local peer": an ephemeral identity that submits a pair request (PR) naming the coin, the
// mixed amount and how many outputs of it. At each epoch the compatible PRs form a session; the peers exchange keys
// (KE), ciphertexts (CT), reserve slots in an exponential DC-net (SR, solved by a peer that can factor polynomials:
// this client can, FP), publish their output hashes through an XOR DC-net (DC) and sign the joined transaction (CM).
// When a step fails, the peers reveal their secrets (RS), find who cheated, and run again without them; when peers
// saw different PRs, they agree on an alternate session. Nobody, the other peers included, learns which outputs are
// whose.
import { randomBytes, randomInt } from 'node:crypto';
import { DcrTx, dcrTxid, dcrSignatureHash, p2pkhSigScript, hash160 } from './dcr';
import {
  ChaChaPrng, F, KX, DecapsulateError, addVectors, bigToBytes, bytesToBig, coefficients, dcMix, dcMixPads, encapsulateAll,
  isRoot, newKX, privateKeyFromStream, publicKeyOf, schnorrSign, schnorrVerify, sharedSecrets, solveRoots, sortForSession, srMix, srMixPads,
  utxoProofHash, validSession, xorVectors,
} from './dcr-mix-crypto';
import {
  CM, CT, DC, FP, KE, MixMsg, MixUTXO, PR, RS, SR, TxOutW, MAX_MCOUNT, MAX_MIX_PEERS, MAX_MTOT, hashString, mixHash, mixPrev, mixRun, mixSid, prPairing,
  rsCommitment, signMix, verifyMix,
} from './dcr-wire';

const { secp256k1 } = require('@noble/curves/secp256k1.js');

export const MIN_PEERS = 4;
export const MAX_MIX_AMOUNT = 21_000_000_00000000n / BigInt(MIN_PEERS);
export const SCRIPT_CLASS = 'P2PKH-secp256k1-v0';
const PR_FLAG_CAN_SOLVE_ROOTS = 1;
const FEE_RATE = 10_000n; // atoms per kB
const MAX_RELAY_FEE_MULTIPLIER = 10_000;
const EARLY_KE_MS = 5_000;
const LATE_KE_MS = 20 * 60_000;
const MAX_MESSAGES_PER_IDENTITY = 1_000;
const MSG_JITTER_MS = 300;
const OP_SSGEN = 0xbb; const OP_SSRTX = 0xbc; const OP_TGEN = 0xc3;

const hx = (b: Uint8Array) => Buffer.from(b).toString('hex');
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const randMs = (max: number) => (max > 0 ? randomInt(Math.max(1, Math.floor(max))) : 0);

export class MixError extends Error { constructor(message: string, readonly kind = 'mix') { super(message); } }

// ---- sizes and fees (mixpool limits.go, mixclient limits.go) ----

const varintSize = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);
const INPUT_SIZE = 32 + 4 + 1 + 8 + 4 + 4 + varintSize(108) + 108 + 4;
const outputSize = (scriptSize: number) => 8 + 2 + varintSize(scriptSize) + scriptSize;
const P2PKH_OUT = outputSize(25);

export function estimateSize(inputs: number, outputs: number, hasChange: boolean): number {
  const outs = outputs + (hasChange ? 1 : 0);
  return 12 + 2 * varintSize(inputs) + varintSize(outs) + inputs * INPUT_SIZE + outs * P2PKH_OUT;
}
export function feeForSize(size: number): bigint { const f = (FEE_RATE * BigInt(size)) / 1000n; return f === 0n ? FEE_RATE : f; }
export function isDust(amount: bigint, scriptSize = 25): boolean {
  const total = BigInt(8 + 2 + varintSize(scriptSize) + scriptSize + 165);
  return (amount * 1000n) / (3n * total) < FEE_RATE;
}

/** A PR's fee: inputs less mixed outputs and change, between the relay fee for its share and 10,000 times that. */
export function prFeeOk(pr: { inputValue: bigint; messageCount: number; mixAmount: bigint; change: TxOutW | null; utxos: unknown[] }): boolean {
  let fee = pr.inputValue - BigInt(pr.messageCount) * pr.mixAmount;
  if (pr.change) fee -= pr.change.value;
  const size = estimateSize(pr.utxos.length, pr.messageCount, !!pr.change);
  return fee >= feeForSize(size) && fee <= feeForSize(size * MAX_RELAY_FEE_MULTIPLIER);
}

/** The whole mix transaction must stay under 100,000 bytes (coinjoinSize.join). */
class CoinjoinSize {
  private inputs = 0; private outputs: number[] = [];
  join(inputs: number, mcount: number, hasChange: boolean): boolean {
    const outs = [...this.outputs, ...Array(mcount + (hasChange ? 1 : 0)).fill(25)];
    const ins = this.inputs + inputs;
    const size = 12 + 2 * varintSize(ins) + varintSize(outs.length) + ins * INPUT_SIZE + outs.reduce((s, x) => s + outputSize(x), 0);
    if (size > 100_000) return false;
    this.inputs = ins; this.outputs = outs; return true;
  }
}

// ---- the message pool ----

type MsgType = 'PR' | 'KE' | 'CT' | 'SR' | 'FP' | 'DC' | 'CM' | 'RS';
const TYPE_OF: Record<string, MsgType> = { mixpairreq: 'PR', mixkeyxchg: 'KE', mixcphrtxt: 'CT', mixslotres: 'SR', mixfactpoly: 'FP', mixdcnet: 'DC', mixconfirm: 'CM', mixsecrets: 'RS' };

interface Entry { msg: MixMsg; type: MsgType; sid: string; hash: string }
interface Session { sid: string; prs: Uint8Array[]; hashes: Set<string>; waiters: Set<() => void>; expiry: number }

export class MissingPRError extends Error { constructor(readonly pr: Uint8Array) { super('missing own PR'); } }

/**
 * The mixing messages seen, as dcrd's mixpool keeps them: PRs, and every other message by session. A message whose
 * session or KE isn't known yet waits as an orphan.
 */
export class MixPool {
  readonly prs = new Map<string, PR>();
  readonly pool = new Map<string, Entry>();
  readonly sessions = new Map<string, Session>();
  private readonly byIdentity = new Map<string, string[]>();
  private readonly latestKE = new Map<string, KE>();
  private orphans = new Map<string, MixMsg>();
  readonly hashes = new Map<MixMsg, string>();

  constructor(readonly epochMs: number, private readonly height: () => number, private readonly maxExpiryBlocks: number) {}

  hashOf(m: MixMsg): string { let h = this.hashes.get(m); if (!h) { h = hashString(mixHash(m)); this.hashes.set(m, h); } return h; }
  has(hash: string): boolean { return this.pool.has(hash) || this.prs.has(hash); }
  message(hash: string): MixMsg | undefined { return this.prs.get(hash) ?? this.pool.get(hash)?.msg; }

  /** Accepts a message; returns what was accepted (orphans it freed included). Throws on a bad message. */
  accept(m: MixMsg): MixMsg[] {
    if (mixRun(m) !== 0) throw new MixError('nonzero reruns are unsupported');
    const hash = this.hashOf(m);
    if (this.has(hash)) return [];
    if (!verifyMix(m)) throw new MixError('invalid signature');
    const id = hx(m.identity);
    if (m.cmd === 'mixpairreq') {
      this.checkPR(m);
      if ((this.byIdentity.get(id) ?? []).length) return [];
      this.prs.set(hash, m);
      this.byIdentity.set(id, [hash]);
      return [m, ...this.reconsider(id)];
    }
    if (m.cmd === 'mixkeyxchg') {
      this.checkKE(m);
      const r = this.acceptKE(m, hash, id);
      return r ? [r, ...this.reconsider(id)] : [];
    }
    this.checkLimits(m);
    const sid = hx(m.sid);
    const type = TYPE_OF[m.cmd];
    let haveKE = false;
    for (const prev of this.byIdentity.get(id) ?? []) {
      const e = this.pool.get(prev);
      if (!e) continue;
      if (e.type === type && e.sid === sid) throw new MixError(`conflicting ${type} in session`);
      if (e.type === 'KE' && e.sid === sid) haveKE = true;
    }
    if (!haveKE) { this.addOrphan(m, hash); return []; }
    if ((this.byIdentity.get(id) ?? []).length >= MAX_MESSAGES_PER_IDENTITY) throw new MixError('identity over its message limit');
    const ses = this.sessions.get(sid);
    if (!ses) throw new MixError('unknown session');
    this.acceptEntry(m, type, hash, id, ses);
    return [m];
  }

  private checkPR(pr: PR): void {
    if (pr.mixAmount > MAX_MIX_AMOUNT || pr.messageCount > MAX_MCOUNT) throw new MixError('PR over limits');
    let inputValue = pr.inputValue;
    if (pr.change) {
      if (pr.change.value < 0n || isDust(pr.change.value) || pr.change.value > inputValue) throw new MixError('bad change');
      inputValue -= pr.change.value;
      if (pr.change.version !== 0 || !(/^76a914[0-9a-f]{40}88ac$/.test(hx(pr.change.script)) || /^a914[0-9a-f]{40}87$/.test(hx(pr.change.script)))) throw new MixError('bad change script');
    }
    if (!pr.utxos.length || pr.messageCount === 0 || isDust(pr.mixAmount) || inputValue < BigInt(pr.messageCount) * pr.mixAmount) throw new MixError('bad PR amounts');
    const h = this.height();
    if (h >= pr.expiry) throw new MixError('PR expired');
    if (pr.expiry > h + this.maxExpiryBlocks + 1) throw new MixError('PR expiry too far');
    if (pr.scriptClass !== SCRIPT_CLASS) throw new MixError('unsupported script class');
    if (!prFeeOk(pr)) throw new MixError('PR fee out of range');
    const seen = new Set<string>();
    for (const u of pr.utxos) {
      const k = `${u.txid}:${u.vout}`;
      if (seen.has(k) || u.script.length) throw new MixError('bad PR UTXO');
      seen.add(k);
      if (u.pubKey.length !== 33 || !schnorrVerify(u.pubKey, utxoProofHash(pr.expiry, u.pubKey), u.signature)) throw new MixError('bad UTXO proof');
    }
  }

  private checkKE(ke: KE): void {
    if (!validSession(ke.seenPRs, ke.sid, ke.epoch, ke.run)) throw new MixError('invalid session');
    if (ke.pos >= ke.seenPRs.length) throw new MixError('peer position out of bounds');
    const epochMs = Number(ke.epoch) * 1000; const now = Date.now();
    if (now + EARLY_KE_MS < epochMs) throw new MixError('KE too early');
    if (now - LATE_KE_MS > epochMs) throw new MixError('KE too late');
    if (Number(ke.epoch) % 60 !== 0) throw new MixError('KE epoch not a whole minute');
  }

  private checkLimits(m: MixMsg): void {
    const prev = mixPrev(m).length;
    if (prev > MAX_MIX_PEERS) throw new MixError('too many references');
    if (m.cmd === 'mixcphrtxt' && m.ciphertexts.length > MAX_MIX_PEERS) throw new MixError('too many ciphertexts');
    if (m.cmd === 'mixslotres' && (m.dcmix.length > MAX_MCOUNT || m.dcmix.some((r) => r.length > MAX_MTOT))) throw new MixError('SR over limits');
    if (m.cmd === 'mixdcnet' && (m.dcnet.length > MAX_MCOUNT || m.dcnet.some((r) => r.length > MAX_MTOT))) throw new MixError('DC over limits');
    if (m.cmd === 'mixfactpoly' && m.roots.length > MAX_MTOT) throw new MixError('FP over limits');
    if (m.cmd === 'mixsecrets' && (m.srMsgs.length > MAX_MCOUNT || m.dcMsgs.length > MAX_MCOUNT)) throw new MixError('RS over limits');
  }

  private acceptKE(ke: KE, hash: string, id: string): KE | null {
    const sid = hx(ke.sid);
    const ses0 = this.sessions.get(sid);
    if (ses0) for (const h of ses0.hashes) { const e = this.pool.get(h); if (e?.type === 'KE' && eq(e.msg.identity, ke.identity)) throw new MixError('conflicting KE'); }
    if ((this.byIdentity.get(id) ?? []).length >= MAX_MESSAGES_PER_IDENTITY) throw new MixError('identity over its message limit');
    let expiry = 0xffffffff; let pairing: Buffer | null = null; let missing: Uint8Array | null = null;
    ke.seenPRs.forEach((h, i) => {
      const pr = this.prs.get(hashString(h));
      if (!pr) { if (i === ke.pos) missing = h; return; }
      expiry = Math.min(expiry, pr.expiry);
      if (i === ke.pos && !eq(pr.identity, ke.identity)) throw new MixError('KE identity does not match its PR');
      const p = prPairing(pr);
      if (!pairing) pairing = p; else if (!pairing.equals(p)) throw new MixError('incompatible PRs');
    });
    if (missing) { this.addOrphan(ke, hash); throw new MissingPRError(missing); }
    let ses = this.sessions.get(sid);
    if (!ses) { ses = { sid, prs: ke.seenPRs, hashes: new Set(), waiters: new Set(), expiry }; this.sessions.set(sid, ses); }
    this.acceptEntry(ke, 'KE', hash, id, ses);
    this.latestKE.set(id, ke);
    return ke;
  }

  private acceptEntry(m: MixMsg, type: MsgType, hash: string, id: string, ses: Session): void {
    ses.hashes.add(hash);
    this.pool.set(hash, { msg: m, type, sid: ses.sid, hash });
    this.byIdentity.set(id, [...(this.byIdentity.get(id) ?? []), hash]);
    for (const w of [...ses.waiters]) w();
  }

  private addOrphan(m: MixMsg, hash: string): void {
    if (this.orphans.size >= 250) this.orphans.delete(this.orphans.keys().next().value!);
    this.orphans.set(hash, m);
  }

  private reconsider(id: string): MixMsg[] {
    const out: MixMsg[] = [];
    for (let again = true; again;) {
      again = false;
      for (const [h, m] of this.orphans) {
        if (hx(m.identity) !== id && m.cmd !== 'mixkeyxchg') continue;
        this.orphans.delete(h);
        try { const a = this.accept(m); if (a.length) { out.push(...a); again = true; } } catch { /* still missing, or bad */ }
      }
    }
    return out;
  }

  /** PRs that could pair with this pairing: newest expiry wins a coin claimed twice; sorted by hash. */
  compatiblePRs(pairing: Buffer): PR[] {
    const res = [...this.prs.values()].filter((pr) => prPairing(pr).equals(pairing)).sort((a, b) => b.expiry - a.expiry);
    const seen = new Map<string, number>();
    const kept = res.filter((pr) => {
      let keep = true;
      for (const u of pr.utxos) {
        const k = `${u.txid}:${u.vout}`;
        const prev = seen.get(k);
        if (prev === undefined) seen.set(k, pr.expiry); else if (pr.expiry < prev) keep = false;
      }
      return keep;
    });
    return kept.sort((a, b) => Buffer.compare(Buffer.from(mixHash(a)), Buffer.from(mixHash(b))));
  }

  /** The newest KE of each identity in an epoch whose PR has this pairing (for alternate sessions). */
  kesByPairing(pairing: Buffer, epoch: bigint): KE[] {
    const out: KE[] = [];
    for (const [id, ke] of this.latestKE) {
      if (ke.epoch !== epoch) continue;
      const pr = this.prs.get(this.byIdentity.get(id)?.[0] ?? '');
      if (pr && prPairing(pr).equals(pairing)) out.push(ke);
    }
    return out;
  }

  /** Waits until messages of one type from `expected` identities are in the session, or the deadline. */
  async receive(sidBytes: Uint8Array, type: MsgType, expected: number, deadline: number, ignoreRS = false): Promise<{ msgs: MixMsg[]; secretsRevealed: boolean }> {
    const sid = hx(sidBytes);
    const ses = this.sessions.get(sid);
    if (!ses) throw new MixError(`unknown session ${sid}`);
    const count = () => { const ids = new Set<string>(); for (const h of ses.hashes) { const e = this.pool.get(h)!; if (e.type === type || (e.type === 'RS' && !ignoreRS)) ids.add(hx(e.msg.identity)); } return ids.size; };
    while (count() < expected && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, deadline - Date.now());
        function done() { clearTimeout(t); ses!.waiters.delete(done); resolve(); }
        ses.waiters.add(done);
      });
    }
    const msgs: MixMsg[] = []; let secretsRevealed = false;
    for (const h of ses.hashes) {
      const e = this.pool.get(h)!;
      if (e.type === type) msgs.push(e.msg);
      else if (e.type === 'RS' && type !== 'RS' && !ignoreRS) secretsRevealed = true;
    }
    return { msgs, secretsRevealed };
  }

  removePR(hash: string): void {
    const pr = this.prs.get(hash);
    if (!pr) return;
    this.prs.delete(hash);
    const id = hx(pr.identity);
    for (const h of this.byIdentity.get(id) ?? []) this.pool.delete(h);
    this.byIdentity.delete(id);
    this.latestKE.delete(id);
  }

  /** PRs whose peer sent no KE in the epoch are dropped (RemoveUnresponsiveDuringEpoch). */
  removeUnresponsive(prs: PR[], epoch: bigint): void {
    for (const pr of prs) {
      const id = hx(pr.identity);
      const active = (this.byIdentity.get(id) ?? []).some((h) => { const e = this.pool.get(h); return e?.type === 'KE' && (e.msg as KE).epoch === epoch; });
      if (!active) this.removePR(this.hashOf(pr));
    }
  }

  removeSession(sidBytes: Uint8Array): void {
    const ses = this.sessions.get(hx(sidBytes));
    if (!ses) return;
    for (const h of ses.hashes) this.pool.delete(h);
    this.sessions.delete(ses.sid);
  }

  /** Drops PRs (and their sessions' messages) expired at this height, and PRs whose coins a block spent. */
  expire(height: number, spent: Set<string> = new Set()): void {
    for (const [h, pr] of [...this.prs]) if (pr.expiry <= height || pr.utxos.some((u) => spent.has(`${u.txid}:${u.vout}`))) this.removePR(h);
    for (const [sid, s] of [...this.sessions]) if (s.expiry <= height) { for (const h of s.hashes) this.pool.delete(h); this.sessions.delete(sid); }
  }
}

// ---- the transaction ----

export interface MixInput { txid: string; vout: number; tree: number; value: bigint; script: Uint8Array; priv: Uint8Array }

/** A coin to mix: its inputs, the change, the mixed amount and count, and where the mixed outputs go. */
export class CoinJoin {
  tx: DcrTx = { version: 1, inputs: [], outputs: [], lockTime: 0, expiry: 0 };
  readonly utxos: MixUTXO[] = [];
  readonly inputValue: bigint;
  private gens: Uint8Array[] = [];
  private genScripts: Uint8Array[] = [];
  private contributed = new Map<string, string>();
  private myInputs: number[] = [];
  txHash = '';
  mixedIndices: number[] = [];
  /** Set once this peer's secrets (its output hashes among them) were published for blame. */
  revealed = false;

  constructor(readonly inputs: MixInput[], readonly change: TxOutW | null, readonly mixValue: bigint, readonly prExpiry: number, readonly mcount: number, private readonly genFn: (n: number) => Uint8Array[]) {
    this.inputValue = inputs.reduce((s, i) => s + i.value, 0n);
    for (const i of inputs) {
      const pub = publicKeyOf(i.priv);
      const opcode = [OP_SSGEN, OP_SSRTX, OP_TGEN].includes(i.script[0]) ? i.script[0] : 0;
      this.utxos.push({ txid: i.txid, vout: i.vout, tree: i.tree, script: new Uint8Array(), pubKey: pub, signature: schnorrSign(i.priv, utxoProofHash(prExpiry, pub)), opcode });
    }
  }

  /** The output hashes to mix (HASH160s of fresh addresses). */
  gen(): Uint8Array[] {
    const gens = this.genFn(this.mcount);
    if (gens.length !== this.mcount || gens.some((g) => g.length !== 20)) throw new MixError('bad mixed outputs');
    this.gens = gens;
    this.genScripts = gens.map((g) => Uint8Array.from([0x76, 0xa9, 0x14, ...g, 0x88, 0xac]));
    return gens;
  }

  resetUnmixed(prs: PR[]): void {
    this.tx = { version: 1, inputs: [], outputs: [], lockTime: 0, expiry: 0 };
    this.contributed.clear(); this.myInputs = []; this.mixedIndices = [];
    for (const pr of prs) {
      for (const u of pr.utxos) {
        this.tx.inputs.push({ txid: u.txid, vout: u.vout, tree: u.tree, sequence: 0xffffffff, value: -1n, blockHeight: 0, blockIndex: 0xffffffff, sigScript: new Uint8Array() });
        this.contributed.set(`${u.txid}:${u.vout}`, hx(pr.identity));
      }
      if (pr.change) this.tx.outputs.push({ value: pr.change.value, version: pr.change.version, script: pr.change.script });
    }
  }

  addMixed(m: Uint8Array): void {
    if (m.length !== 20) return;
    this.tx.outputs.push({ value: this.mixValue, version: 0, script: Uint8Array.from([0x76, 0xa9, 0x14, ...m, 0x88, 0xac]) });
  }

  /** dcrutil txsort: inputs by tree, then reversed hash, then index; outputs by value, version, script. */
  sort(): void {
    this.tx.inputs.sort((a, b) => a.tree - b.tree || Buffer.compare(Buffer.from(a.txid, 'hex'), Buffer.from(b.txid, 'hex')) || a.vout - b.vout);
    this.tx.outputs.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : a.version - b.version || Buffer.compare(Buffer.from(a.script), Buffer.from(b.script))));
    const mine = new Set(this.inputs.map((i) => `${i.txid}:${i.vout}`));
    this.myInputs = this.tx.inputs.flatMap((x, i) => (mine.has(`${x.txid}:${x.vout}`) ? [i] : []));
    this.txHash = dcrTxid(this.tx);
  }

  /** Signs this peer's inputs once every one of its outputs is in the transaction. */
  confirm(): void {
    const idx = this.genScripts.map((s) => this.tx.outputs.findIndex((o) => o.value === this.mixValue && o.version === 0 && eq(o.script, s)));
    if (idx.some((i) => i < 0)) throw new MixError('coinjoin is missing gen output', 'missingGen');
    for (const i of this.myInputs) {
      const inp = this.tx.inputs[i];
      const mine = this.inputs.find((x) => x.txid === inp.txid && x.vout === inp.vout)!;
      const pub = publicKeyOf(mine.priv);
      inp.sigScript = p2pkhSigScript(dcrSignatureHash(this.tx, i, mine.script), mine.priv, pub);
    }
    this.mixedIndices = idx;
  }

  mergeSignatures(cm: CM): boolean {
    if (dcrTxid(cm.mix) !== this.txHash) return false;
    cm.mix.inputs.forEach((x, i) => { if (this.contributed.get(`${x.txid}:${x.vout}`) === hx(cm.identity)) this.tx.inputs[i].sigScript = x.sigScript; });
    return true;
  }
}

/** Every input's signature checked against the key its PR named (validateMergedCoinjoin). Returns blamed PR identities. */
function badInputs(cj: CoinJoin, prs: PR[]): string[] {
  const byOutpoint = new Map<string, { u: MixUTXO; id: string }>();
  for (const pr of prs) for (const u of pr.utxos) byOutpoint.set(`${u.txid}:${u.vout}`, { u, id: hx(pr.identity) });
  const blamed = new Set<string>();
  cj.tx.inputs.forEach((inp, i) => {
    const e = byOutpoint.get(`${inp.txid}:${inp.vout}`);
    if (!e) { blamed.add('?'); return; }
    const p2pkh = [0x76, 0xa9, 0x14, ...hash160(e.u.pubKey), 0x88, 0xac];
    const script = Uint8Array.from(e.u.opcode ? [e.u.opcode, ...p2pkh] : p2pkh);
    if (![0, OP_SSGEN, OP_SSRTX, OP_TGEN].includes(e.u.opcode) || !checkP2pkhSig(cj.tx, i, script, e.u.pubKey)) blamed.add(e.id);
  });
  return [...blamed];
}

function checkP2pkhSig(tx: DcrTx, i: number, script: Uint8Array, pub: Uint8Array): boolean {
  const s = tx.inputs[i].sigScript;
  if (!s.length || s[0] < 9 || s[0] > 73 || s.length !== 1 + s[0] + 1 + 33 || s[1 + s[0]] !== 33 || s[s[0]] !== 1) return false;
  if (!eq(s.subarray(2 + s[0]), pub)) return false;
  try { return secp256k1.verify(s.subarray(1, s[0]), dcrSignatureHash(tx, i, script), pub, { prehash: false, lowS: true, format: 'der' }); } catch { return false; }
}

// ---- the client ----

interface Peer {
  id: Uint8Array; idHex: string; priv?: Uint8Array; pr: PR; coinjoin?: CoinJoin; remote: boolean; jitter: number;
  done?: () => boolean; resolve?: (r: { ok: true; txid: string } | { ok: false; error: Error }) => void;
  // run state
  prngSeed?: Uint8Array; prng?: ChaChaPrng; kx?: KX; srMsg?: bigint[]; dcMsg?: Uint8Array[];
  ke?: KE | null; ct?: CT | null; sr?: SR | null; fp?: FP | null; dc?: DC | null; cm?: CM | null; rs?: RS | null;
  myVk: number; myStart: number; srKP?: Uint8Array[][]; dcKP?: Uint8Array[][][]; triggeredBlame: boolean;
}

interface SessionRun { sid: Uint8Array; idx: number; prs: PR[]; freshGen: boolean; peers: Peer[]; mcounts: number[]; mtot: number; localPeers: Map<string, Peer>; kes: KE[]; roots: bigint[]; cj?: CoinJoin }

interface Paired { localPeers: Map<string, Peer>; pairing: Buffer; runs: SessionRun[]; epoch: number; deadlines: Record<'KE' | 'CT' | 'SR' | 'DC' | 'DCRS' | 'CM', number>; agreementIdx: number; agreement: boolean }

class Blamed extends Error { constructor(readonly ids: string[]) { super(`blamed peers ${ids.join(' ')}`); } }
class AltSession extends Error { constructor(readonly prs: PR[] | null, readonly sid: Uint8Array | null, readonly unresponsive: PR[], readonly err?: string) { super('alternate session'); } }
class SizeLimited extends Error { constructor(readonly prs: PR[], readonly sid: Uint8Array, readonly excluded: PR[]) { super('size limited'); } }
const ONLY_KES = 'session ended without mix occurring';
const TRIGGERED_BLAME = 'blame required';
const SECRETS_REVEALED = 'secrets revealed';
const NO_LOCAL_PEERS = 'no active local peers';

export interface MixNet {
  /** Hands a message to the network (and the local pool has it already). */
  broadcast(m: MixMsg): void;
  /** Sends a finished transaction. */
  publish(tx: DcrTx): Promise<void>;
}

export interface MixClientOpts { epochMs: number; stageTimeoutMs: number; pairingVersion: number; solveRoots: boolean; log?: (s: string) => void }

export class MixClient {
  private pending = new Map<string, { pairing: Buffer; localPeers: Map<string, Peer> }>();
  private stopped = false;
  private warm: Promise<void>;
  private readonly maxJitter: number;
  private readonly peerJitter: number;

  constructor(readonly pool: MixPool, private readonly net: MixNet, private readonly o: MixClientOpts) {
    this.maxJitter = o.stageTimeoutMs / 10;
    this.peerJitter = this.maxJitter - MSG_JITTER_MS;
    this.warm = this.ticker();
  }

  private log(s: string) { this.o.log?.(s); }
  stop(): void { this.stopped = true; }

  private nextEpoch(now = Date.now()): number { return (Math.floor(now / this.o.epochMs) + 1) * this.o.epochMs; }

  private async ticker(): Promise<void> {
    // The first epoch only listens: PRs for the next one arrive during it.
    const first = this.nextEpoch();
    await sleep(first - Date.now() + this.o.stageTimeoutMs + 2000);
    while (!this.stopped) {
      const epoch = this.nextEpoch();
      await sleep(epoch - Date.now());
      if (this.stopped) return;
      for (const [key, p] of [...this.pending]) {
        let prs = this.pool.compatiblePRs(p.pairing);
        const prIds = new Set(prs.map((pr) => hx(pr.identity)));
        const localPeers = new Map<string, Peer>();
        for (const [id, peer] of p.localPeers) if (prIds.has(id) && !peer.done?.()) localPeers.set(id, this.clone(peer, false));
        if (!localPeers.size) continue;
        this.log(`epoch: ${prs.length} compatible PRs, ${localPeers.size} local`);
        if (prs.length > MAX_MIX_PEERS) prs = [...[...localPeers.values()].map((x) => x.pr), ...prs.filter((pr) => !localPeers.has(hx(pr.identity)))].slice(0, MAX_MIX_PEERS);
        this.pending.delete(key);
        void this.pairSession({ localPeers, pairing: p.pairing, runs: [], epoch, deadlines: { KE: 0, CT: 0, SR: 0, DC: 0, DCRS: 0, CM: 0 }, agreementIdx: 0, agreement: false }, prs, epoch).catch((e) => this.log(`session: ${(e as Error).message}`));
      }
    }
  }

  private clone(p: Peer, freshGen: boolean): Peer {
    const c: Peer = { id: p.id, idHex: p.idHex, priv: p.priv, pr: p.pr, coinjoin: p.coinjoin, remote: false, jitter: p.jitter, done: p.done, resolve: p.resolve, myVk: 0, myStart: 0, triggeredBlame: false };
    if (!freshGen) { c.prngSeed = p.prngSeed; c.prng = p.prng; c.kx = p.kx; c.srMsg = p.srMsg; c.dcMsg = p.dcMsg; }
    return c;
  }

  private genKeys(p: Peer): void {
    p.ke = null;
    p.prngSeed = randomBytes(32);
    p.prng = new ChaChaPrng(p.prngSeed, 0);
    p.kx = newKX(p.prng);
    p.srMsg = Array.from({ length: p.pr.messageCount }, () => bytesToBig(randomBytes(16)) % F);
    p.dcMsg = p.coinjoin!.gen();
  }

  /** Mixes one coinjoin; resolves with the mix transaction's ID, or rejects when the PR expires or it's cancelled. */
  async dicemix(cj: CoinJoin, cancelled: () => boolean = () => false): Promise<string> {
    await Promise.race([this.warm, sleep(0)]);
    const priv = privateKeyFromStream((n) => randomBytes(n));
    const id = publicKeyOf(priv);
    const peer: Peer = { id, idHex: hx(id), priv, pr: null as unknown as PR, coinjoin: cj, remote: false, jitter: randMs(this.peerJitter), done: cancelled, myVk: 0, myStart: 0, triggeredBlame: false };
    await this.prDelay(peer, cancelled);
    if (cancelled()) throw new MixError('cancelled');
    const pr: PR = {
      cmd: 'mixpairreq', sig: new Uint8Array(64), identity: id, expiry: cj.prExpiry, mixAmount: cj.mixValue, scriptClass: SCRIPT_CLASS, txVersion: cj.tx.version,
      lockTime: cj.tx.lockTime, messageCount: cj.mcount, inputValue: cj.inputValue, utxos: cj.utxos, change: cj.change,
      flags: this.o.solveRoots ? PR_FLAG_CAN_SOLVE_ROOTS : 0, pairingFlags: this.o.pairingVersion,
    };
    signMix(pr, priv);
    peer.pr = pr;
    this.genKeys(peer);
    const result = new Promise<{ ok: true; txid: string } | { ok: false; error: Error }>((resolve) => { peer.resolve = resolve; });
    const pairing = prPairing(pr);
    const key = pairing.toString('hex');
    if (!this.pending.has(key)) this.pending.set(key, { pairing, localPeers: new Map() });
    this.pending.get(key)!.localPeers.set(peer.idHex, peer);
    this.submit(pr);
    // Gives up once the PR has expired (checked as the pool drops it) or the caller cancels.
    const watch = setInterval(() => {
      if (this.stopped || cancelled() || !this.pool.has(this.pool.hashOf(pr))) peer.resolve?.({ ok: false, error: new MixError(this.stopped || cancelled() ? 'cancelled' : 'the pair request expired', 'expired') });
    }, 5_000);
    try {
      const r = await result;
      if (!r.ok) throw r.error;
      return r.txid;
    } finally {
      clearInterval(watch);
      for (const p of this.pending.values()) p.localPeers.delete(peer.idHex);
    }
  }

  private async prDelay(p: Peer, cancelled: () => boolean): Promise<void> {
    const now = Date.now();
    const epoch = this.nextEpoch(now);
    let sendBefore = epoch - this.o.stageTimeoutMs - this.maxJitter;
    const sendAfter = epoch + this.o.stageTimeoutMs;
    let wait = 0;
    if (now >= sendBefore) { wait = sendAfter - now; sendBefore += this.o.epochMs; }
    wait += p.jitter + randMs(MSG_JITTER_MS) + randMs(sendBefore - now);
    const until = Date.now() + wait;
    while (Date.now() < until && !cancelled()) await sleep(Math.min(5_000, until - Date.now()));
  }

  private submit(m: MixMsg): void {
    try { this.pool.accept(m); } catch (e) { if (!(e instanceof MissingPRError)) throw e; }
    this.net.broadcast(m);
  }

  private async sendLocal(s: SessionRun, mask: Set<MsgType>): Promise<void> {
    const msgs: { at: number; p: Peer; m: MixMsg }[] = [];
    const now = Date.now();
    for (const p of s.peers) {
      if (p.remote || p.done?.()) continue;
      const types = new Set(mask);
      if (p.triggeredBlame) types.add('RS');
      const add = (m: MixMsg | null | undefined) => { if (m) msgs.push({ at: now + p.jitter + randMs(MSG_JITTER_MS), p, m }); };
      if (types.has('KE')) add(p.ke); if (types.has('CT')) add(p.ct); if (types.has('SR')) add(p.sr); if (types.has('FP')) add(p.fp);
      if (types.has('DC')) add(p.dc); if (types.has('CM')) add(p.cm); if (types.has('RS')) add(p.rs);
    }
    if (!msgs.length && mask.size) throw new MixError(NO_LOCAL_PEERS);
    msgs.sort((a, b) => a.at - b.at);
    for (const x of msgs) {
      await sleep(x.at - Date.now());
      if (x.m.cmd === 'mixsecrets' && x.p.coinjoin) x.p.coinjoin.revealed = true;
      try { signMix(x.m, x.p.priv!); this.submit(x.m); } catch (e) { this.log(`submit: ${(e as Error).message}`); }
    }
  }

  private startDeadlines(ps: Paired, begin: number): void {
    const t = this.o.stageTimeoutMs;
    // DCRS (mixing v0.7.5): after the DC-nets, a stage to hear any revealed secrets before confirming.
    ps.deadlines = { KE: begin + t, CT: begin + 2 * t, SR: begin + 3 * t, DC: begin + 4 * t, DCRS: begin + 5 * t, CM: begin + 6 * t };
  }

  private newRun(ps: Paired, sid: Uint8Array, prs: PR[], freshGen: boolean): SessionRun | null {
    const idx = ps.runs.length;
    const run: SessionRun = { sid, idx, prs, freshGen, peers: [], mcounts: [], mtot: 0, localPeers: new Map(), kes: [], roots: [] };
    let m = 0;
    for (let i = 0; i < prs.length; i++) {
      const pr = prs[i];
      const source = idx > 0 ? ps.runs[idx - 1].localPeers : ps.localPeers;
      let p = source.get(hx(pr.identity));
      if (p) { p = this.clone(p, freshGen); run.localPeers.set(p.idHex, p); }
      else p = { id: pr.identity, idHex: hx(pr.identity), pr, remote: true, jitter: 0, myVk: 0, myStart: 0, triggeredBlame: false };
      p.myVk = i; p.myStart = m;
      run.peers.push(p); run.mcounts.push(pr.messageCount); m += pr.messageCount;
    }
    run.mtot = m;
    if (!run.localPeers.size) return null;
    ps.runs.push(run);
    return run;
  }

  private async pairSession(ps: Paired, prs: PR[], epoch: number): Promise<void> {
    const unixEpoch = BigInt(epoch / 1000);
    const end = epoch + this.o.epochMs;
    let unresponsive: PR[] = [];
    let revealed = false;
    let mixed: SessionRun | null = null;
    this.startDeadlines(ps, epoch);
    const sorted = sortForSession(prs.map((pr) => ({ pr, hash: mixHash(pr) })), unixEpoch);
    let run = this.newRun(ps, sorted.sid, sorted.prs.map((x) => x.pr), false);
    const altCounts = new Map<string, number>();
    try {
      while (run && Date.now() < end && !this.stopped) {
        let err: unknown = null; let r = ps.runs[ps.runs.length - 1];
        try { r = await this.run(ps, unixEpoch); } catch (e) { err = e; r = (e as any).run ?? ps.runs[ps.runs.length - 1]; }
        if (!err) { mixed = r; return; }
        revealed = false;
        let rerun: { sid: Uint8Array; prs: PR[]; freshGen: boolean } | null = null;
        let requireAgreement = false;
        const msg = (err as Error).message;
        if (msg === ONLY_KES || msg === NO_LOCAL_PEERS) return;
        if (err instanceof AltSession) {
          if (err.err) { this.log(`alternate session: ${err.err}`); unresponsive.push(...err.unresponsive); }
          else if (hx(r.sid) !== hx(err.sid!)) unresponsive.push(...err.unresponsive);
          else { ps.agreement = true; ps.agreementIdx = r.idx; }
          const k = err.sid ? hx(err.sid) : '';
          altCounts.set(k, (altCounts.get(k) ?? 0) + 1);
          if (altCounts.get(k)! > 2) return;
          if (err.err) { this.startDeadlines(ps, Date.now()); continue; }
          rerun = { sid: err.sid!, prs: err.prs!, freshGen: false };
        } else if (err instanceof SizeLimited) {
          if (err.prs.length < MIN_PEERS) return;
          rerun = { sid: err.sid, prs: err.prs, freshGen: false };
          requireAgreement = true;
        } else if (msg === TRIGGERED_BLAME || msg === SECRETS_REVEALED) {
          revealed = true;
          let blamed: string[] | null = null;
          try { await this.blame(r); } catch (e) { if (e instanceof Blamed) blamed = e.ids; else { this.log(`blame: ${(e as Error).message}`); return; } }
          if (!blamed) return;
          err = new Blamed(blamed);
          requireAgreement = true;
        }
        if (err instanceof Blamed) {
          if (r.prs.length - err.ids.length < MIN_PEERS) return;
          const keep = r.peers.filter((p) => !err.ids.includes(p.idHex)).map((p) => p.pr);
          for (const p of r.peers) if (err.ids.includes(p.idHex) && !p.remote) p.resolve?.({ ok: false, error: new MixError('this wallet was blamed in a mix') });
          const s = sortForSession(keep.map((pr) => ({ pr, hash: mixHash(pr) })), unixEpoch);
          rerun = { sid: s.sid, prs: s.prs.map((x) => x.pr), freshGen: revealed };
          requireAgreement = true;
        }
        if (!rerun) { this.log(`session ended: ${msg}`); return; }
        if (hx(ps.runs[ps.runs.length - 1].sid) === hx(rerun.sid)) {
          if (ps.agreementIdx >= ps.runs.length) ps.agreementIdx = ps.runs.length - 1;
        } else {
          run = this.newRun(ps, rerun.sid, rerun.prs, rerun.freshGen);
          if (!run) return;
        }
        this.startDeadlines(ps, Date.now());
        if (requireAgreement) ps.agreementIdx = ps.runs.length - 1;
      }
    } finally {
      this.pool.removeUnresponsive(unresponsive, unixEpoch);
      if (mixed?.cj) {
        const txid = dcrTxid(mixed.cj.tx);
        for (const p of mixed.peers) if (!p.remote) { ps.localPeers.delete(p.idHex); p.resolve?.({ ok: true, txid }); }
        const sid = mixed.sid;
        setTimeout(() => this.pool.removeSession(sid), 10_000);
      }
      // Local peers not mixed wait for the next epoch, with new keys if their secrets were revealed.
      for (const p of ps.localPeers.values()) {
        if (p.done?.() || !this.pool.has(this.pool.hashOf(p.pr))) continue;
        const p2 = this.clone(p, revealed);
        if (revealed) { try { this.genKeys(p2); } catch (e) { p.resolve?.({ ok: false, error: e as Error }); continue; } }
        const key = ps.pairing.toString('hex');
        if (!this.pending.has(key)) this.pending.set(key, { pairing: ps.pairing, localPeers: new Map() });
        this.pending.get(key)!.localPeers.set(p2.idHex, p2);
      }
    }
  }

  private async completePairing(ps: Paired): Promise<SessionRun> {
    const runs = ps.runs.slice(ps.agreementIdx);
    const check = (r: SessionRun) => {
      const ses = this.pool.sessions.get(hx(r.sid));
      if (!ses) return null;
      const kes = [...ses.hashes].map((h) => this.pool.pool.get(h)!).filter((e) => e.type === 'KE').map((e) => e.msg as KE);
      return new Set(kes.map((k) => hx(k.identity))).size >= r.prs.length ? kes : null;
    };
    while (Date.now() < ps.deadlines.KE) {
      for (const r of runs) { const kes = check(r); if (kes) { r.kes = kes; return r; } }
      await sleep(250);
    }
    for (const r of runs) { const kes = check(r); if (kes) { r.kes = kes; return r; } }
    throw new MixError('incomplete pairing');
  }

  private alternateSession(ps: Paired, prs: PR[]): AltSession {
    const unixEpoch = BigInt(ps.epoch / 1000);
    const kes = this.pool.kesByPairing(ps.pairing, unixEpoch);
    const byHash = new Map(prs.map((pr) => [this.pool.hashOf(pr), pr]));
    const hashById = new Map(prs.map((pr) => [hx(pr.identity), this.pool.hashOf(pr)]));
    const msgs = new Map<string, { pr: PR; ke: KE }>();
    for (const ke of kes) {
      const id = hx(ke.identity);
      if (msgs.has(id)) continue;
      const pr = byHash.get(hashById.get(id) ?? '');
      if (pr) msgs.set(id, { pr, ke });
    }
    const unresponsive = prs.filter((pr) => !msgs.has(hx(pr.identity)));
    const unresponsiveHashes = new Set(unresponsive.map((pr) => this.pool.hashOf(pr)));
    let counts = new Map<string, number>();
    for (const { pr, ke } of msgs.values()) {
      const self = this.pool.hashOf(pr);
      for (const h of ke.seenPRs) { const s = hashString(h); if (s === self || unresponsiveHashes.has(s)) continue; counts.set(s, (counts.get(s) ?? 0) + 1); }
    }
    const needed = Math.floor(counts.size / 2);
    let remaining = [...counts].filter(([, c]) => c >= needed).map(([h]) => h);
    // chainhash order is the reversed display string's bytes.
    const raw = (h: string) => Buffer.from(h, 'hex').reverse();
    for (;;) {
      if (remaining.length < MIN_PEERS) return new AltSession(null, null, unresponsive, 'too few peers');
      remaining.sort((a, b) => (counts.get(a)! - counts.get(b)!) || Buffer.compare(raw(a), raw(b)));
      if (counts.get(remaining[0]) === remaining.length - 1) {
        const chosen = remaining.map((h) => byHash.get(h));
        if (chosen.some((x) => !x)) return new AltSession(null, null, unresponsive, 'unknown PRs');
        const s = sortForSession((chosen as PR[]).map((pr) => ({ pr, hash: mixHash(pr) })), unixEpoch);
        return new AltSession(s.prs.map((x) => x.pr), s.sid, unresponsive);
      }
      remaining = remaining.slice(1);
      counts = new Map(remaining.map((h) => [h, 0]));
      for (const h of remaining) {
        const pr = byHash.get(h); if (!pr) continue;
        const m = msgs.get(hx(pr.identity)); if (!m) continue;
        for (const s of m.ke.seenPRs) { const k = hashString(s); if (k !== h && counts.has(k)) counts.set(k, counts.get(k)! + 1); }
      }
    }
  }

  /** One run of a session (mixclient run): KE, CT, SR, FP, DC, CM, and the published mix. */
  private async run(ps: Paired, unixEpoch: bigint): Promise<SessionRun> {
    let ses = ps.runs[ps.runs.length - 1];
    const fail = (e: Error, r = ses) => { (e as any).run = r; return e; };
    let prs = ses.prs;
    let index = new Map(prs.map((pr, i) => [hx(pr.identity), i]));
    for (const p of ses.peers) {
      if (p.remote || p.done?.()) continue;
      if (ses.freshGen) this.genKeys(p);
      if (!p.ke) {
        const seenPRs = prs.map((pr) => mixHash(pr));
        const rs: RS = { cmd: 'mixsecrets', sig: new Uint8Array(64), identity: p.id, sid: ses.sid, run: 0, seed: p.prngSeed!, srMsgs: p.srMsg!.map(bigToBytes), dcMsgs: p.dcMsg!, seenRSs: [] };
        p.ke = { cmd: 'mixkeyxchg', sig: new Uint8Array(64), identity: p.id, sid: ses.sid, epoch: unixEpoch, run: 0, pos: index.get(p.idHex)!, ecdh: p.kx!.ecdhPub, pqpk: p.kx!.pqPub, commitment: rsCommitment(rs), seenPRs };
        p.ct = p.sr = p.fp = p.dc = p.cm = null;
        p.rs = rs;
      }
    }
    ses.freshGen = false;
    await this.sendLocal(ses, new Set(['KE'])).catch((e) => this.log(`KE: ${e.message}`));
    if (prs.length < MIN_PEERS) throw fail(new MixError(ONLY_KES));
    if (!prs.some((pr) => pr.flags & PR_FLAG_CAN_SOLVE_ROOTS)) throw fail(new MixError(ONLY_KES));

    let done: SessionRun;
    try { done = await this.completePairing(ps); } catch (e) {
      if (!ps.agreement) throw fail(this.alternateSession(ps, ses.prs));
      throw fail(e as Error);
    }
    if (done !== ses) { ses = done; prs = ses.prs; index = new Map(prs.map((pr, i) => [hx(pr.identity), i])); }
    const kes = ses.kes;
    for (const p of ps.localPeers.values()) p.coinjoin?.resetUnmixed(prs);
    for (const p of ses.peers) if (!p.remote) p.coinjoin!.resetUnmixed(prs);

    if (!ps.agreement) {
      ps.agreement = true; ps.agreementIdx = ses.idx;
      // Within the peer and message limits (mixing v0.7.5), then the standard transaction size.
      const size = new CoinjoinSize(); const excluded: PR[] = [];
      let npeers = 0; let mtot = 0;
      for (const pr of ses.prs) {
        if (npeers + 1 > MAX_MIX_PEERS || mtot + pr.messageCount > MAX_MTOT || !size.join(pr.utxos.length, pr.messageCount, !!pr.change)) { excluded.push(pr); continue; }
        npeers++; mtot += pr.messageCount;
      }
      if (excluded.length) {
        const kept = ses.prs.filter((pr) => !excluded.includes(pr));
        const s = sortForSession(kept.map((pr) => ({ pr, hash: mixHash(pr) })), unixEpoch);
        throw fail(new SizeLimited(s.prs.map((x) => x.pr), s.sid, excluded));
      }
    }
    for (const ke of kes) { const i = index.get(hx(ke.identity)); if (i !== undefined) ses.peers[i].ke = ke; }
    kes.sort((a, b) => index.get(hx(a.identity))! - index.get(hx(b.identity))!);
    const seenKEs = kes.map((k) => mixHash(k));
    if (!kes.some((k) => ses.localPeers.has(hx(k.identity)))) throw fail(new MixError('excluded all local peers'));

    const blamed: string[] = [];
    const ecdh: Uint8Array[] = []; const pqpk: Uint8Array[] = [];
    for (const ke of kes) {
      try { secp256k1.Point.fromBytes(ke.ecdh); ecdh.push(ke.ecdh); pqpk.push(ke.pqpk); } catch { blamed.push(hx(ke.identity)); }
    }
    if (blamed.length) throw fail(new Blamed(blamed));

    const local = () => ses.peers.filter((p) => !p.remote && !p.done?.());
    for (const p of local()) {
      if (p.ct) continue;
      const cts = encapsulateAll(p.kx!, p.prng!, pqpk);
      p.ct = { cmd: 'mixcphrtxt', sig: new Uint8Array(64), identity: p.id, sid: ses.sid, run: 0, ciphertexts: cts, seenKEs };
    }
    await this.sendLocal(ses, new Set(['CT'])).catch((e) => this.log(`CT: ${e.message}`));

    // Ciphertexts, then slot reservations.
    const ctR = await this.pool.receive(ses.sid, 'CT', prs.length, ps.deadlines.CT);
    if (ctR.secretsRevealed) throw fail(new MixError(SECRETS_REVEALED));
    const cts = ctR.msgs as CT[];
    for (const ct of cts) { const i = index.get(hx(ct.identity)); if (i !== undefined) ses.peers[i].ct = ct; }
    if (cts.length !== prs.length) throw fail(this.timedOut(ses, 'ct'));
    cts.sort((a, b) => index.get(hx(a.identity))! - index.get(hx(b.identity))!);
    const seenCTs = cts.map((c) => mixHash(c));
    const blamedCT = new Set<string>();
    for (const p of local()) {
      if (p.sr) continue;
      const mine: Uint8Array[] = [];
      for (const ct of cts) { if (ct.ciphertexts.length !== prs.length) { blamedCT.add(hx(ct.identity)); continue; } mine.push(ct.ciphertexts[p.myVk]); }
      if (blamedCT.size) break;
      let shared;
      try { shared = sharedSecrets(p.kx!, ecdh, mine, p.myVk, ses.sid, ses.mcounts); } catch (e) {
        if (e instanceof DecapsulateError) { p.triggeredBlame = true; throw fail(new MixError(TRIGGERED_BLAME)); }
        throw e;
      }
      p.srKP = shared.sr; p.dcKP = shared.dc;
      const srMixes = p.srMsg!.map((m, i) => srMix(m, srMixPads(p.srKP![i], p.myStart + i)));
      p.sr = { cmd: 'mixslotres', sig: new Uint8Array(64), identity: p.id, sid: ses.sid, run: 0, dcmix: srMixes.map((v) => v.map(bigToBytes)), seenCTs };
    }
    if (blamedCT.size) throw fail(new Blamed([...blamedCT]));
    await this.sendLocal(ses, new Set(['SR'])).catch((e) => this.log(`SR: ${e.message}`));

    const srR = await this.pool.receive(ses.sid, 'SR', prs.length, ps.deadlines.SR);
    if (srR.secretsRevealed) throw fail(new MixError(SECRETS_REVEALED));
    const srs = srR.msgs as SR[];
    for (const sr of srs) { const i = index.get(hx(sr.identity)); if (i !== undefined) ses.peers[i].sr = sr; }
    if (srs.length !== prs.length) throw fail(this.timedOut(ses, 'sr'));
    srs.sort((a, b) => index.get(hx(a.identity))! - index.get(hx(b.identity))!);
    const seenSRs = srs.map((s) => mixHash(s));
    const vs: bigint[][] = [];
    srs.forEach((sr, i) => {
      if (sr.dcmix.length !== ses.mcounts[i] || sr.dcmix.some((row) => row.length !== ses.mtot)) { blamed.push(hx(sr.identity)); return; }
      for (const row of sr.dcmix) vs.push(row.map(bytesToBig));
    });
    if (blamed.length) throw fail(new Blamed(blamed));
    const coeffs = coefficients(addVectors(vs));
    const roots = await this.roots(ses, seenSRs, coeffs, ps.deadlines.SR);
    ses.roots = roots;

    for (const p of local()) {
      if (p.dc) continue;
      const slots = p.srMsg!.map((m) => roots.findIndex((r) => r === m));
      if (slots.some((s) => s < 0)) { p.triggeredBlame = true; throw fail(new MixError(TRIGGERED_BLAME)); }
      const dcnet = slots.map((slot, i) => dcMix(dcMixPads(p.dcKP![i], p.myStart + i), p.dcMsg![i], slot));
      p.dc = { cmd: 'mixdcnet', sig: new Uint8Array(64), identity: p.id, sid: ses.sid, run: 0, dcnet, seenSRs };
    }
    await this.sendLocal(ses, new Set(['FP', 'DC'])).catch((e) => this.log(`DC: ${e.message}`));

    const dcR = await this.pool.receive(ses.sid, 'DC', prs.length, ps.deadlines.DC);
    if (dcR.secretsRevealed) throw fail(new MixError(SECRETS_REVEALED));
    const dcs = dcR.msgs as DC[];
    for (const dc of dcs) { const i = index.get(hx(dc.identity)); if (i !== undefined) ses.peers[i].dc = dc; }
    if (dcs.length !== prs.length) throw fail(this.timedOut(ses, 'dc'));
    dcs.sort((a, b) => index.get(hx(a.identity))! - index.get(hx(b.identity))!);
    const seenDCs = dcs.map((d) => mixHash(d));
    const vecs: Uint8Array[][] = [];
    dcs.forEach((dc, i) => {
      if (dc.dcnet.length !== ses.mcounts[i] || dc.dcnet.some((v) => v.length !== ses.mtot)) { blamed.push(hx(dc.identity)); return; }
      vecs.push(...dc.dcnet);
    });
    if (blamed.length) throw fail(new Blamed(blamed));
    const mixedMsgs = xorVectors(vecs);

    for (const p of local()) {
      if (p.cm) continue;
      const cj = p.coinjoin!;
      for (const m of mixedMsgs) cj.addMixed(m);
      cj.sort();
      try { cj.confirm(); } catch (e) {
        if ((e as MixError).kind === 'missingGen') { p.triggeredBlame = true; throw fail(new MixError(TRIGGERED_BLAME)); }
        throw e;
      }
      p.cm = { cmd: 'mixconfirm', sig: new Uint8Array(64), identity: p.id, sid: ses.sid, run: 0, mix: structuredClone(cj.tx), seenDCs };
    }
    // Before confirming, wait out a stage for secrets revealed by a peer that couldn't find its message (v0.7.5).
    const rsR = await this.pool.receive(ses.sid, 'RS', 1, ps.deadlines.DCRS);
    if (rsR.msgs.length) throw fail(new MixError(SECRETS_REVEALED));
    await this.sendLocal(ses, new Set(['CM'])).catch((e) => this.log(`CM: ${e.message}`));

    // Secrets revealed from now on are ignored for this run.
    const cmR = await this.pool.receive(ses.sid, 'CM', prs.length, ps.deadlines.CM, true);
    const cms = cmR.msgs as CM[];
    for (const cm of cms) { const i = index.get(hx(cm.identity)); if (i !== undefined) ses.peers[i].cm = cm; }
    if (cms.length !== prs.length) throw fail(this.timedOut(ses, 'cm'));
    const lead = ses.peers.find((p) => !p.remote)!;
    const cj = lead.coinjoin!;
    for (const cm of cms) if (!cj.mergeSignatures(cm)) blamed.push(hx(cm.identity));
    if (blamed.length) throw fail(new Blamed(blamed));
    const bad = badInputs(cj, prs);
    if (bad.length) throw fail(new Blamed(bad.filter((x) => x !== '?')));
    const lowest = Math.min(...ses.peers.filter((p) => !p.remote).map((p) => p.jitter));
    await sleep(lowest + randMs(MSG_JITTER_MS));
    await this.net.publish(cj.tx);
    ses.cj = cj;
    return ses;
  }

  private timedOut(ses: SessionRun, stage: 'ct' | 'sr' | 'dc' | 'cm'): Error {
    const ids = ses.peers.filter((p) => !p[stage]).map((p) => p.idHex);
    return ids.length ? new Blamed(ids) : new MixError('blame failed');
  }

  private async roots(ses: SessionRun, seenSRs: Uint8Array[], a: bigint[], deadline: number): Promise<bigint[]> {
    if (this.o.solveRoots) {
      const roots = solveRoots(a, () => bytesToBig(randomBytes(16)));
      if (!roots || roots.length !== a.length - 1) {
        for (const p of ses.peers) if (!p.remote) p.triggeredBlame = true;
        throw Object.assign(new MixError(TRIGGERED_BLAME), { run: ses });
      }
      const rootBytes = roots.map(bigToBytes);
      for (const p of ses.peers) if (!p.remote && !p.fp) p.fp = { cmd: 'mixfactpoly', sig: new Uint8Array(64), identity: p.id, sid: ses.sid, run: 0, roots: rootBytes, seenSRs };
      return roots;
    }
    const checked = new Set<string>();
    for (;;) {
      const r = await this.pool.receive(ses.sid, 'FP', 1, Math.max(deadline, Date.now() + this.o.stageTimeoutMs));
      for (const fp of r.msgs as FP[]) {
        const id = hx(fp.identity);
        if (checked.has(id)) continue;
        checked.add(id);
        if (fp.roots.length !== a.length - 1) continue;
        const roots = fp.roots.map(bytesToBig);
        if (roots.some((x) => x >= F || !isRoot(x, a))) continue;
        if (new Set(roots.map(String)).size !== roots.length) continue;
        if (roots.some((x, i) => i > 0 && roots[i - 1] > x)) continue;
        return roots;
      }
      if (Date.now() > deadline + this.o.stageTimeoutMs) throw Object.assign(new MixError('no factored polynomial'), { run: ses });
    }
  }

  /** Reveal secrets and find who cheated (mixclient blame): throws Blamed with them, or another error. */
  private async blame(ses: SessionRun): Promise<void> {
    const deadline = Date.now() + this.o.stageTimeoutMs;
    await this.sendLocal(ses, new Set()).catch(() => undefined);
    const first = await this.pool.receive(ses.sid, 'RS', 1, deadline);
    const rsHashes = first.msgs.map((m) => mixHash(m));
    for (const p of ses.peers) if (!p.remote && !p.triggeredBlame && p.rs) p.rs.seenRSs = rsHashes;
    await this.sendLocal(ses, new Set(['RS'])).catch(() => undefined);
    const all = await this.pool.receive(ses.sid, 'RS', ses.prs.length, Date.now() + this.o.stageTimeoutMs);
    const index = new Map(ses.prs.map((pr, i) => [hx(pr.identity), i]));
    for (const rs of all.msgs as RS[]) { const i = index.get(hx(rs.identity)); if (i !== undefined) ses.peers[i].rs = rs; }
    const blamed: string[] = [];
    if (all.msgs.length !== ses.peers.length) { for (const p of ses.peers) if (!p.rs) blamed.push(p.idHex); throw new Blamed(blamed); }
    // When nobody else is to blame: whoever started the reveal (no other RS of the session referenced) or
    // referenced one that doesn't exist made a false accusation (mixing v0.7.5).
    const rsSet = new Set((all.msgs as RS[]).map((rs) => hx(mixHash(rs))));
    const falseAccuser = (rs: RS) => {
      const own = hx(mixHash(rs)); let session = false;
      for (const prev of rs.seenRSs) { const h = hx(prev); if (h === own) continue; if (!rsSet.has(h)) return true; session = true; }
      return !session;
    };
    const finish = () => { const ids = (all.msgs as RS[]).filter(falseAccuser).map((rs) => hx(rs.identity)); if (ids.length) throw new Blamed(ids); throw new MixError('blame failed'); };

    // Re-derive every peer's keys and messages from its revealed seed and check them against what it sent.
    const recovered: { kx: KX; prng: ChaChaPrng; srMsg: bigint[]; dcMsg: Uint8Array[] }[] = [];
    const ecdh: Uint8Array[] = []; const pqpk: Uint8Array[] = []; const starts: number[] = [];
    let start = 0;
    for (const p of ses.peers) {
      const rs = p.rs!;
      if (!p.ke || !eq(rsCommitment(rs), p.ke.commitment) || rs.seed.length !== 32 || rs.srMsgs.some((m) => bytesToBig(m) >= F)) { blamed.push(p.idHex); continue; }
      const prng = new ChaChaPrng(rs.seed, 0);
      const kx = newKX(prng);
      if (!eq(kx.ecdhPub, p.ke.ecdh) || !eq(kx.pqPub, p.ke.pqpk)) { blamed.push(p.idHex); continue; }
      ecdh.push(p.ke.ecdh); pqpk.push(p.ke.pqpk);
      starts.push(start); start += p.pr.messageCount;
      if (rs.srMsgs.length !== p.pr.messageCount || rs.dcMsgs.length !== p.pr.messageCount) { blamed.push(p.idHex); continue; }
      recovered.push({ kx, prng, srMsg: rs.srMsgs.map(bytesToBig), dcMsg: rs.dcMsgs });
    }
    if (blamed.length) throw new Blamed(blamed);
    const recoveredCTs = recovered.map((r) => encapsulateAll(r.kx, r.prng, pqpk));
    ses.peers.forEach((p, i) => {
      if (!p.ct || p.ct.ciphertexts.length !== recoveredCTs[i].length || p.ct.ciphertexts.some((c, j) => !eq(c, recoveredCTs[i][j]))) blamed.push(p.idHex);
    });
    if (blamed.length) throw new Blamed(blamed);
    const shared = new Map<string, string[]>();
    ses.peers.forEach((p, i) => { for (const m of recovered[i].srMsg) { const k = m.toString(); shared.set(k, [...(shared.get(k) ?? []), p.idHex]); } });
    for (const ids of shared.values()) if (ids.length > 1) blamed.push(...ids);
    if (blamed.length) throw new Blamed(blamed);
    const secrets: { sr: Uint8Array[][]; dc: Uint8Array[][][] }[] = [];
    ses.peers.forEach((p, i) => {
      if (!p.sr || p.sr.dcmix.length !== p.pr.messageCount || p.sr.dcmix.some((r) => r.length !== ses.mtot)) { blamed.push(p.idHex); secrets.push({ sr: [], dc: [] }); return; }
      let s;
      try { s = sharedSecrets(recovered[i].kx, ecdh, recoveredCTs.map((c) => c[p.myVk]), p.myVk, ses.sid, ses.mcounts); } catch (e) { if (e instanceof DecapsulateError) { blamed.push(p.idHex); secrets.push({ sr: [], dc: [] }); return; } throw e; }
      secrets.push(s);
      const ok = recovered[i].srMsg.every((m, j) => srMix(m, srMixPads(s.sr[j], starts[i] + j)).every((x, k) => x === bytesToBig(p.sr!.dcmix[j][k])));
      if (!ok) blamed.push(p.idHex);
    });
    if (blamed.length) throw new Blamed(blamed);
    if (!ses.roots.length) finish();
    const slotOf = new Map(ses.roots.map((r, i) => [r.toString(), i]));
    ses.peers.forEach((p, i) => {
      if (!p.dc || p.dc.dcnet.length !== p.pr.messageCount) { blamed.push(p.idHex); return; }
      for (let j = 0; j < recovered[i].dcMsg.length; j++) {
        const slot = slotOf.get(recovered[i].srMsg[j].toString());
        if (slot === undefined) throw new MixError('blame failed: no slot for message');
        const want = dcMix(dcMixPads(secrets[i].dc[j], starts[i] + j), recovered[i].dcMsg[j], slot);
        if (want.length !== p.dc.dcnet[j].length || want.some((v, k) => !eq(v, p.dc!.dcnet[j][k]))) { blamed.push(p.idHex); return; }
      }
    });
    if (blamed.length) throw new Blamed(blamed);
    finish();
  }
}

/** The hash160 of a compressed key, for a P2PKH output of a mixed address. */
export const mixedOutputHash = (pub: Uint8Array) => hash160(pub);
export { mixSid };
