// Dash CoinJoin, client side: joining a masternode's mixing session with coins of one standard size, checking
// the transaction it builds, and signing only our own inputs. Message formats follow Dash Core 23/24.
import { DashPeer, DashTx, Reader, TxIn, TxOut, Writer, bip69In, bip69Out, dsha, readIn, readTx, txBytes, txId, writeIn, writeTx } from './dash-p2p';

const { secp256k1 } = require('@noble/curves/secp256k1.js');

/** The five sizes everyone mixes in, largest first: 10, 1, 0.1, 0.01 and 0.001 DASH, each with its tiny marker. */
export const DENOMS = [1_000_010_000n, 100_001_000n, 10_000_100n, 1_000_010n, 100_001n] as const;
/** What a session refers to them by: bit 0 is the largest. */
export const denomBit = (amount: bigint): number => { const i = DENOMS.indexOf(amount as any); return i < 0 ? 0 : 1 << i; };
export const denomAmount = (bit: number): bigint => { const i = Math.log2(bit); return Number.isInteger(i) && i >= 0 && i < DENOMS.length ? DENOMS[i] : 0n; };
export const isDenom = (amount: bigint): boolean => denomBit(amount) !== 0;
/** The fee a masternode keeps from a misbehaving participant's collateral, and the most a collateral coin may hold. */
export const COLLATERAL = 10_000n;
export const MAX_COLLATERAL = COLLATERAL * 4n;
export const isCollateralAmount = (v: bigint): boolean => v >= COLLATERAL && v <= MAX_COLLATERAL;
/** Dash Core puts at most 9 coins in one participant's entry. */
export const MAX_ENTRY = 9;
export const QUEUE_TIMEOUT_MS = 30_000;
export const SIGNING_TIMEOUT_MS = 15_000;

const SIGHASH_ALL_ANYONECANPAY = 0x81;

export enum PoolState { IDLE, QUEUE, ACCEPTING_ENTRIES, SIGNING, ERROR }
export enum PoolMessage {
  ERR_ALREADY_HAVE, ERR_DENOM, ERR_ENTRIES_FULL, ERR_EXISTING_TX, ERR_FEES, ERR_INVALID_COLLATERAL, ERR_INVALID_INPUT,
  ERR_INVALID_SCRIPT, ERR_INVALID_TX, ERR_MAXIMUM, ERR_MN_LIST, ERR_MODE, ERR_NON_STANDARD_PUBKEY, ERR_NOT_A_MN,
  ERR_QUEUE_FULL, ERR_RECENT, ERR_SESSION, ERR_MISSING_TX, ERR_VERSION, MSG_NOERR, MSG_SUCCESS, MSG_ENTRIES_ADDED, ERR_SIZE_MISMATCH,
}

const MESSAGES: Partial<Record<PoolMessage, string>> = {
  [PoolMessage.ERR_QUEUE_FULL]: 'the session is full',
  [PoolMessage.ERR_RECENT]: 'the masternode mixed too recently',
  [PoolMessage.ERR_SESSION]: 'the session ended',
  [PoolMessage.ERR_INVALID_COLLATERAL]: 'it refused the collateral',
  [PoolMessage.ERR_MISSING_TX]: 'it does not see a coin yet',
  [PoolMessage.ERR_DENOM]: 'the coin sizes do not match',
  [PoolMessage.ERR_FEES]: 'the amounts do not match',
  [PoolMessage.ERR_INVALID_INPUT]: 'it refused a coin',
  [PoolMessage.ERR_ALREADY_HAVE]: 'an address was used twice',
  [PoolMessage.ERR_MN_LIST]: 'it is not in the masternode list',
  [PoolMessage.ERR_ENTRIES_FULL]: 'the session is full',
  [PoolMessage.ERR_EXISTING_TX]: 'it already has a different session',
  [PoolMessage.ERR_MAXIMUM]: 'too many coins at once',
  [PoolMessage.ERR_SIZE_MISMATCH]: 'the number of coins in and out differ',
};
export const poolMessageText = (m: number): string => MESSAGES[m as PoolMessage] ?? `masternode message ${m}`;

// ---- messages ----

export const dsaPayload = (denom: number, collateral: DashTx): Buffer => writeTx(new Writer().i32(denom), collateral).done();

export interface StatusUpdate { session: number; state: PoolState; accepted: boolean; message: number }
export function readStatus(b: Buffer): StatusUpdate {
  const r = new Reader(b);
  return { session: r.i32(), state: r.i32(), accepted: r.i32() === 1, message: r.i32() };
}

export interface Queue { denom: number; proTxHash: string; time: number; ready: boolean; signature: Buffer }
export function readQueue(b: Buffer): Queue {
  const r = new Reader(b);
  const denom = r.i32();
  const proTxHash = Buffer.from(r.bytes(32)).reverse().toString('hex');
  const time = Number(r.i64());
  const ready = r.u8() !== 0;
  return { denom, proTxHash, time, ready, signature: Buffer.from(r.left ? r.varbytes() : Buffer.alloc(0)) };
}

export function dsiPayload(inputs: TxIn[], collateral: DashTx, outputs: TxOut[]): Buffer {
  const w = new Writer().varint(inputs.length);
  for (const i of inputs) writeIn(w, { ...i, script: Buffer.alloc(0) });
  writeTx(w, collateral);
  w.varint(outputs.length);
  for (const o of outputs) w.u64(o.value).varbytes(o.script);
  return w.done();
}

export function readFinal(b: Buffer): { session: number; tx: DashTx } {
  const r = new Reader(b);
  return { session: r.i32(), tx: readTx(r) };
}

export function dssPayload(signed: TxIn[]): Buffer {
  const w = new Writer().varint(signed.length);
  for (const i of signed) writeIn(w, i);
  return w.done();
}

export function readComplete(b: Buffer): { session: number; message: number } {
  const r = new Reader(b);
  return { session: r.i32(), message: r.i32() };
}

// ---- signing ----

/** Pay-to-public-key-hash, the only script mixing allows. */
export const p2pkh = (hash160: Uint8Array): Buffer => Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), Buffer.from(hash160), Buffer.from([0x88, 0xac])]);
export const isP2pkh = (s: Buffer): boolean => s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac;

/** The legacy signature hash, which Dash keeps. With ANYONECANPAY only the input being signed is included. */
export function legacySighash(tx: DashTx, index: number, scriptCode: Buffer, hashType: number): Buffer {
  const anyone = (hashType & 0x80) !== 0;
  if ((hashType & 0x1f) !== 1) throw new Error('Only SIGHASH_ALL is used here.');
  const inputs = (anyone ? [tx.inputs[index]] : tx.inputs).map((i) => ({ ...i, script: i === tx.inputs[index] ? scriptCode : Buffer.alloc(0) }));
  const copy: DashTx = { ...tx, inputs };
  const w = new Writer().bytes(txBytes(copy)).u32(hashType);
  return dsha(w.done());
}

function pushData(b: Uint8Array): Buffer {
  if (b.length >= 0x4c) throw new Error('Push too large.');
  return Buffer.concat([Buffer.from([b.length]), Buffer.from(b)]);
}

export interface OwnCoin { txid: string; vout: number; value: bigint; script: Buffer; privateKey: Uint8Array; publicKey: Uint8Array }

/** A scriptSig for one of our inputs: DER signature with the hash type, then the compressed public key. */
export function signInput(tx: DashTx, index: number, coin: OwnCoin, hashType: number): Buffer {
  const digest = legacySighash(tx, index, coin.script, hashType);
  const der: Uint8Array = secp256k1.sign(digest, coin.privateKey, { lowS: true, prehash: false, format: 'der' });
  return Buffer.concat([pushData(Buffer.concat([Buffer.from(der), Buffer.from([hashType])])), pushData(coin.publicKey)]);
}

/** Signs every input of a transaction that only spends our own coins, with SIGHASH_ALL. */
export function signAll(tx: DashTx, coins: OwnCoin[]): DashTx {
  const signed = { ...tx, inputs: tx.inputs.map((i) => ({ ...i })) };
  tx.inputs.forEach((i, n) => {
    const c = coins.find((x) => x.txid === i.txid && x.vout === i.vout);
    if (!c) throw new Error('An input is not this wallet\'s, so signing was stopped.');
    signed.inputs[n].script = signInput(tx, n, c, 0x01);
  });
  return signed;
}

/**
 * The collateral for one session: spends one small coin to itself minus the masternode's fee, or, when the
 * coin is too small to split, burns it into an empty OP_RETURN. It's only broadcast if we misbehave.
 */
export function collateralTx(coin: OwnCoin, changeScript: Buffer): DashTx {
  if (coin.value < COLLATERAL) throw new Error('No coin can pay for collateral.');
  const outputs: TxOut[] = coin.value >= COLLATERAL * 2n ? [{ value: coin.value - COLLATERAL, script: changeScript }] : [{ value: 0n, script: Buffer.from([0x6a]) }];
  const tx: DashTx = { version: 1, type: 0, inputs: [{ txid: coin.txid, vout: coin.vout, script: Buffer.alloc(0), sequence: 0xffffffff }], outputs, lockTime: 0 };
  return signAll(tx, [coin]);
}

// ---- checking what the masternode built ----

/**
 * Refuses a final transaction unless it is what a fair mix looks like: BIP69 order, standard P2PKH outputs of
 * the session's size (or the next size up, which Dash 24's rebalancing adds), no address twice, every one of our
 * outputs and inputs present, and someone else's coins beside ours on both sides.
 */
export function checkFinal(tx: DashTx, mine: { inputs: TxIn[]; outputs: TxOut[] }, denom: number): void {
  const sortedIn = [...tx.inputs].sort(bip69In);
  const sortedOut = [...tx.outputs].sort(bip69Out);
  if (sortedIn.some((x, i) => x !== tx.inputs[i]) || sortedOut.some((x, i) => x !== tx.outputs[i])) throw new Error('The masternode built the mix out of order, so it was not signed.');
  if (tx.type !== 0 || tx.lockTime !== 0) throw new Error('The masternode built an unusual mix, so it was not signed.');
  const amount = denomAmount(denom);
  const bigger = denom > 1 ? denomAmount(denom >> 1) : 0n;
  const scripts = new Set<string>();
  let sameSize = 0;
  for (const o of tx.outputs) {
    if (!isP2pkh(o.script) || (o.value !== amount && o.value !== bigger)) throw new Error('The mix has an output of the wrong kind, so it was not signed.');
    const key = o.script.toString('hex');
    if (scripts.has(key)) throw new Error('The mix pays one address twice, so it was not signed.');
    scripts.add(key);
    if (o.value === amount) sameSize++;
  }
  for (const o of mine.outputs) {
    if (!tx.outputs.some((x) => x.value === o.value && x.script.equals(o.script))) throw new Error('The mix is missing one of this wallet\'s outputs, so it was not signed.');
  }
  for (const i of mine.inputs) {
    if (!tx.inputs.some((x) => x.txid === i.txid && x.vout === i.vout)) throw new Error('The mix is missing one of this wallet\'s coins, so it was not signed.');
  }
  if (new Set(tx.inputs.map((i) => `${i.txid}:${i.vout}`)).size !== tx.inputs.length) throw new Error('The mix spends a coin twice, so it was not signed.');
  if (sameSize <= mine.outputs.length || tx.inputs.length <= mine.inputs.length) throw new Error('No one else was in the mix, so it was not signed.');
}

// ---- one session ----

export interface SessionPlan {
  denom: number;
  coins: OwnCoin[];
  outputs: TxOut[];
  collateral: DashTx;
  proTxHash: string;
}

export type SessionStep = 'queued' | 'ready' | 'entered' | 'signing' | 'done';

/**
 * Runs one mixing session with a masternode we're already connected to. Resolves with the coins the mix spent
 * once the masternode reports it published (its ID depends on everyone's signatures, so it's found on chain);
 * rejects on refusal, timeout, or a transaction that fails the checks.
 */
export async function runSession(peer: DashPeer, plan: SessionPlan, onStep: (s: SessionStep) => void = () => undefined, timeouts = { queue: QUEUE_TIMEOUT_MS * 3, step: QUEUE_TIMEOUT_MS + 15_000 }): Promise<{ spent: string[] }> {
  if (!plan.coins.length || plan.coins.length > MAX_ENTRY || plan.coins.length !== plan.outputs.length) throw new Error('A mix needs as many outputs as coins, at most 9.');
  const amount = denomAmount(plan.denom);
  if (plan.coins.some((c) => c.value !== amount) || plan.outputs.some((o) => o.value !== amount || !isP2pkh(o.script))) throw new Error('Every coin and output of a mix has to be the session\'s size.');
  const used = new Set([...plan.coins.map((c) => c.script.toString('hex')), ...plan.outputs.map((o) => o.script.toString('hex'))]);
  if (used.size !== plan.coins.length * 2) throw new Error('Every coin and output of a mix needs its own address.');

  peer.send('senddsq', Buffer.from([1]));
  peer.send('dsa', dsaPayload(plan.denom, plan.collateral));
  const refused = (s: StatusUpdate) => new Error(`The masternode refused: ${poolMessageText(s.message)}.`);
  const status = async (timeoutMs: number) => readStatus((await peer.next(['dssu'], timeoutMs)).payload);

  // Accepted into its queue, with a session number.
  let session = 0;
  while (!session) {
    const s = await status(timeouts.step);
    if (!s.accepted) throw refused(s);
    if (s.session) session = s.session;
  }
  onStep('queued');

  // Wait for enough participants: the masternode announces the same queue as ready.
  const isOurs = (b: Buffer) => { try { const q = readQueue(b); return q.ready && q.proTxHash === plan.proTxHash && q.denom === plan.denom; } catch { return false; } };
  const ready = peer.next(['dsq'], timeouts.queue, isOurs);
  const early = peer.next(['dssu'], timeouts.queue, (b) => { try { return !readStatus(b).accepted; } catch { return false; } });
  const first = await Promise.race([ready.then(() => null), early.then((m) => readStatus(m.payload))]);
  if (first) throw refused(first);
  onStep('ready');

  const inputs: TxIn[] = plan.coins.map((c) => ({ txid: c.txid, vout: c.vout, script: Buffer.alloc(0), sequence: 0xffffffff }));
  peer.send('dsi', dsiPayload(inputs, plan.collateral, plan.outputs));
  onStep('entered');

  // The masternode answers our entry, then sends the combined transaction.
  for (;;) {
    const m = await peer.next(['dssu', 'dsf', 'dsc'], timeouts.step);
    if (m.command === 'dssu') { const s = readStatus(m.payload); if (!s.accepted) throw refused(s); continue; }
    if (m.command === 'dsc') { const c = readComplete(m.payload); if (c.session === session) throw new Error(`The mix ended early: ${poolMessageText(c.message)}.`); continue; }
    const f = readFinal(m.payload);
    if (f.session !== session) continue;
    checkFinal(f.tx, { inputs, outputs: plan.outputs }, plan.denom);
    const signed: TxIn[] = [];
    f.tx.inputs.forEach((i, n) => {
      const c = plan.coins.find((x) => x.txid === i.txid && x.vout === i.vout);
      if (c) signed.push({ ...i, script: signInput(f.tx, n, c, SIGHASH_ALL_ANYONECANPAY) });
    });
    peer.send('dss', dssPayload(signed));
    onStep('signing');
    for (;;) {
      const n = await peer.next(['dsc', 'dssu'], SIGNING_TIMEOUT_MS + timeouts.step);
      if (n.command === 'dssu') { const s = readStatus(n.payload); if (!s.accepted) throw refused(s); continue; }
      const c = readComplete(n.payload);
      if (c.session !== session) continue;
      if (c.message !== PoolMessage.MSG_SUCCESS) throw new Error(`The mix did not go through: ${poolMessageText(c.message)}.`);
      onStep('done');
      return { spent: plan.coins.map((x) => `${x.txid}:${x.vout}`) };
    }
  }
}

export { readIn, txBytes, txId };
