// Decred staking: tickets bought through a Voting Service Provider (vspd, API v3), as dcrwallet buys them.
//
// A purchase is one split transaction and one ticket per seat. The split pays each ticket's exact cost (price and
// ticket fee) to a fresh change address of this wallet, plus one output per ticket that later pays the VSP's fee.
// Each ticket spends its split output; its commitment (where the stake and reward return) names the same address,
// and its voting rights go to a key of its own under a hardened path, which is handed to the VSP so it can vote.
// Nothing is broadcast here: the VSP broadcasts the split and the ticket when it is first asked for a fee, so a VSP
// that turns the ticket down leaves nothing on the chain. The fee transaction is given to the VSP, which broadcasts
// it once the ticket has 6 confirmations; until then its coin is held back from sends.
//
// Formats follow dcrd (wire, txscript, stake) and dcrwallet (createtx.go, txrules/poolfees.go, vsp client); a test
// rebuilds a ticket dcrwallet made on simnet byte for byte, and tests/dcr-simnet.js runs a purchase against dcrd,
// dcrwallet and vspd.
import { bip39Seed } from './seed';
import type { Agent } from 'node:http';
import { DCR_PATH, DcrTx, Writer, dcrAddressOf, dcrNet, DcrNet, dcrScript, dcrSignatureHash, dcrTxid, decodeDcrAddress, hash160, isDcrAddress, p2pkhSigScript, serializeDcrTx, verifyDcrInput } from './dcr';
import type { InsightUtxo } from './insight';
import { requestRaw } from './request';
import { randomInt } from 'node:crypto';

const { HDKey } = require('@scure/bip32');
const { blake256 } = require('@noble/hashes/blake1.js');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { ed25519 } = require('@noble/curves/ed25519.js');
const { base58 } = require('@scure/base');

/** The public list of VSPs that Decred's own software shows. */
export const VSP_LIST_URL = 'https://api.decred.org/?c=vsp';
/** Voting keys: hardened, so a key given to a VSP reveals no other key of this wallet. */
export const DCR_VOTING_PATH = `${DCR_PATH}/2'`;
export const MAX_TICKETS = 10;

const FEE_PER_BYTE = 10n;
const DUST = 6_030n;
/** A ticket's size as dcrwallet sizes it: one P2PKH input, the voting output, the commitment and the stake change. */
const TICKET_SIZE = 298n;
export const TICKET_FEE = TICKET_SIZE * FEE_PER_BYTE;
/** Split and fee transactions: version, counts, lock time, expiry; inputs; P2PKH outputs. */
const SIZE_BASE = 15n;
const SIZE_INPUT = 165n;
const SIZE_OUTPUT = 36n;
const FEE_TX_FEE = (SIZE_BASE + SIZE_INPUT + SIZE_OUTPUT) * FEE_PER_BYTE;
const FEE_TX_FEE_CHANGE = (SIZE_BASE + SIZE_INPUT + 2n * SIZE_OUTPUT) * FEE_PER_BYTE;
/** Votes may pay no fee from the reward, revocations up to 2^14 atoms (dcrwallet's revocationFeeLimit). */
const COMMITMENT_FEE_LIMITS = [0x00, 0x4e];
const OP_SSTX = 0xba;
const OP_SSTXCHANGE = 0xbd;
/** dcrwallet's block height for an input whose transaction isn't in a block yet. */
const UNMINED_HEIGHT = 0x7fffffff;

// ---- the VSP's fee ----

/** A block's subsidy (dcrd blockchain/standalone CalcBlockSubsidy): the base, cut by 100/101 every interval. */
function blockSubsidy(height: number, net: DcrNet): bigint {
  if (height <= 1) return 0n;
  let s = net.baseSubsidy;
  for (let i = 0, n = Math.floor(height / net.subsidyReductionInterval); i < n && s > 0n; i++) s = (s * 100n) / 101n;
  return s;
}

/**
 * The fee a VSP charges for a ticket at this height (dcrwallet txrules.StakePoolTicketFee, as vspd calls it): its
 * percentage of a vote's subsidy (DCP-0012: 89% of the block's, over 5 votes), pushed forward by the reductions
 * expected while the ticket waits, weighted as dcrwallet weighs it.
 */
export function vspFee(price: bigint, height: number, percent: number, net: DcrNet = dcrNet): bigint {
  const pct = BigInt(Math.floor(percent * 100));
  let s = height < net.stakeValidationHeight - 1 ? 0n : (blockSubsidy(height, net) * 89n) / (100n * BigInt(net.ticketsPerBlock));
  for (let i = 0, n = Math.ceil(net.ticketPoolSize / net.subsidyReductionInterval); i < n; i++) s = (s * 100n) / 101n;
  const relay = 10_000n;
  const shift = 1n << 64n;
  return ((pct * s * (price + relay) * shift) / ((s + price) * 10_000n)) / shift;
}

/**
 * The ticket's expiry, as dcrwallet's ticket buyer sets it: the start of the next price window, so a ticket isn't
 * mined at a price that no longer holds. Null when the window ends before a ticket could be mined (the split needs
 * a block first): buy a moment later.
 */
export function ticketExpiry(tip: number, net: DcrNet = dcrNet): number | null {
  const next = (Math.floor(tip / net.window) + 1) * net.window;
  if (tip + 2 === next) return null;
  return tip + 1 === next ? next + net.window : next;
}

// ---- keys, messages ----

/** The private key in Decred's WIF: network ID, signature scheme (secp256k1), key, BLAKE-256 checksum. */
export function dcrWif(privateKey: Uint8Array, net: DcrNet = dcrNet): string {
  const payload = Uint8Array.from([...net.wif, 0, ...privateKey]);
  return base58.encode(Uint8Array.from([...payload, ...blake256(payload).slice(0, 4)]));
}

const varString = (s: string | Uint8Array): Uint8Array => { const b = typeof s === 'string' ? Buffer.from(s, 'utf8') : s; return new Writer().varBytes(b).done(); };

/** What a Decred signed message signs (dcrd's SignMessage). */
export function dcrMessageHash(message: string): Uint8Array {
  return blake256(Uint8Array.from([...varString('Decred Signed Message:\n'), ...varString(message)]));
}

/** A compact, recoverable signature of a message by a P2PKH key, base64: what `signmessage` returns. */
export function signDcrMessage(privateKey: Uint8Array, message: string): string {
  const sig: Uint8Array = secp256k1.sign(dcrMessageHash(message), privateKey, { prehash: false, lowS: true, format: 'recovered' });
  return Buffer.from([27 + 4 + sig[0], ...sig.slice(1)]).toString('base64');
}

/** Whether a signed message was signed by the key of a P2PKH address. */
export function verifyDcrMessage(address: string, signature: string, message: string): boolean {
  try {
    const b = Buffer.from(signature, 'base64');
    if (b.length !== 65 || b[0] < 31 || b[0] > 34) return false;
    const recovered = Uint8Array.from([b[0] - 31, ...b.subarray(1)]);
    const pub = secp256k1.recoverPublicKey(recovered, dcrMessageHash(message), { prehash: false });
    return dcrAddressOf(secp256k1.Point.fromBytes(pub).toBytes(true)) === address;
  } catch { return false; }
}

// ---- transactions ----

const p2pkh = (hash: Uint8Array): Uint8Array => Uint8Array.from([0x76, 0xa9, 0x14, ...hash, 0x88, 0xac]);

/** The commitment: where the stake and reward go, the amount committed, and the fee limits. */
function commitmentScript(hash: Uint8Array, amount: bigint): Uint8Array {
  const a = Buffer.alloc(8);
  a.writeBigUInt64LE(amount); // the top bit marks a P2SH address; this is P2PKH
  return Uint8Array.from([0x6a, 0x1e, ...hash, ...a, ...COMMITMENT_FEE_LIMITS]);
}

export interface TicketParts {
  /** The split output the ticket spends, and its key (it also signs for the commitment address). */
  input: { txid: string; vout: number; value: bigint; blockHeight?: number; blockIndex?: number };
  price: bigint;
  votingHash: Uint8Array;
  commitmentHash: Uint8Array;
  expiry: number;
}

/** A ticket as dcrwallet makes one (createtx.go makeTicket), unsigned. */
export function ticketTx(p: TicketParts): DcrTx {
  return {
    version: 1, lockTime: 0, expiry: p.expiry,
    inputs: [{ txid: p.input.txid, vout: p.input.vout, tree: 0, sequence: 0xffffffff, value: p.input.value, blockHeight: p.input.blockHeight ?? UNMINED_HEIGHT, blockIndex: p.input.blockIndex ?? 0xffffffff, sigScript: new Uint8Array() }],
    outputs: [
      { value: p.price, version: 0, script: Uint8Array.from([OP_SSTX, ...p2pkh(p.votingHash)]) },
      { value: 0n, version: 0, script: commitmentScript(p.commitmentHash, p.input.value) },
      { value: 0n, version: 0, script: Uint8Array.from([OP_SSTXCHANGE, ...p2pkh(new Uint8Array(20))]) },
    ],
  };
}

interface Key { priv: Uint8Array; pub: Uint8Array }

function signP2pkh(tx: DcrTx, keys: Key[]): void {
  keys.forEach((k, i) => { tx.inputs[i].sigScript = p2pkhSigScript(dcrSignatureHash(tx, i, dcrScript(dcrAddressOf(k.pub))), k.priv, k.pub); });
  keys.forEach((k, i) => { if (!verifyDcrInput(tx, i, dcrScript(dcrAddressOf(k.pub)), k.pub)) throw new Error('A signature did not check out, so this was stopped.'); });
}

export interface StakeAddress { address: string; index: number }

export interface TicketPlan {
  split: { hex: string; id: string };
  tickets: {
    hash: string; hex: string; voting: number;
    commitment: StakeAddress;
    /** The split output that will pay the VSP's fee. */
    fund: { txid: string; vout: number; value: bigint } & StakeAddress;
  }[];
  /** The split's own fee, and the change back, if any. */
  fee: bigint; change: bigint;
}

/**
 * The split and the tickets, signed. `coins` are spent largest first; `addresses` are unused change addresses of
 * this wallet (2 per ticket and one for change); voting keys take indexes from `votingFirst`.
 */
export function planTickets(o: { mnemonic: string; coins: InsightUtxo[]; price: bigint; count: number; expiry: number; feeFund: bigint; addresses: StakeAddress[]; votingFirst: number; path?: string }): TicketPlan {
  const { count, price } = o;
  if (!Number.isInteger(count) || count < 1 || count > MAX_TICKETS) throw new Error(`Buy 1 to ${MAX_TICKETS} tickets at a time.`);
  if (o.addresses.length < 2 * count + 1) throw new Error('Not enough addresses for this purchase.');
  const seat = price + TICKET_FEE;
  const need = BigInt(count) * (seat + o.feeFund);
  const coins = [...o.coins].sort((a, b) => (b.value > a.value ? 1 : -1));
  const inputs: InsightUtxo[] = [];
  let sum = 0n; let fee = 0n; let change = 0n; let enough = false;
  for (const u of coins) {
    inputs.push(u); sum += u.value;
    const outs = BigInt(2 * count);
    const withChange = (SIZE_BASE + SIZE_INPUT * BigInt(inputs.length) + SIZE_OUTPUT * (outs + 1n)) * FEE_PER_BYTE;
    const noChange = (SIZE_BASE + SIZE_INPUT * BigInt(inputs.length) + SIZE_OUTPUT * outs) * FEE_PER_BYTE;
    if (sum >= need + withChange + DUST) { fee = withChange; change = sum - need - withChange; enough = true; break; }
    if (sum >= need + noChange) { fee = sum - need; change = 0n; enough = true; break; }
  }
  if (!enough) throw new Error('Not enough spendable DCR for these tickets and their fees.');

  const account = HDKey.fromMasterSeed(bip39Seed(o.mnemonic)).derive(o.path ?? DCR_PATH);
  const voting = HDKey.fromMasterSeed(bip39Seed(o.mnemonic)).derive(DCR_VOTING_PATH);
  const keyAt = (chain: number, index: number): Key => { const c = account.deriveChild(chain).deriveChild(index); return { priv: c.privateKey, pub: c.publicKey }; };
  const splitKeys: Key[] = [];
  // No expiry on the split: dcrd holds the outputs of a transaction that has one until they mature.
  const split: DcrTx = { version: 1, inputs: [], outputs: [], lockTime: 0, expiry: 0 };
  for (const u of inputs) {
    if (u.tree === 1) throw new Error('Coins from tickets can\'t buy tickets yet; send them to yourself first.');
    const k = keyAt(u.chain, u.index);
    if (dcrAddressOf(k.pub) !== u.address) throw new Error('An input address does not match this wallet\'s keys, so signing was stopped.');
    split.inputs.push({ txid: u.txid, vout: u.vout, tree: 0, sequence: 0xffffffff, value: u.value, blockHeight: 0, blockIndex: 0xffffffff, sigScript: new Uint8Array() });
    splitKeys.push(k);
  }
  // Outputs in random order, as a payment's would be: the ticket seats, the fee funds, the change.
  const outs: { role: 'seat' | 'fund' | 'change'; n: number; value: bigint; addr: StakeAddress }[] = [];
  for (let i = 0; i < count; i++) outs.push({ role: 'seat', n: i, value: seat, addr: o.addresses[i] });
  for (let i = 0; i < count; i++) outs.push({ role: 'fund', n: i, value: o.feeFund, addr: o.addresses[count + i] });
  if (change > 0n) outs.push({ role: 'change', n: 0, value: change, addr: o.addresses[2 * count] });
  for (let i = outs.length - 1; i > 0; i--) { const j = randomInt(i + 1); [outs[i], outs[j]] = [outs[j], outs[i]]; }
  for (const out of outs) {
    if (dcrAddressOf(keyAt(1, out.addr.index).pub) !== out.addr.address) throw new Error('A change address does not match this wallet\'s keys, so signing was stopped.');
    split.outputs.push({ value: out.value, version: 0, script: dcrScript(out.addr.address) });
  }
  signP2pkh(split, splitKeys);
  const splitId = dcrTxid(split);

  const tickets: TicketPlan['tickets'] = [];
  for (let i = 0; i < count; i++) {
    const vout = outs.findIndex((x) => x.role === 'seat' && x.n === i);
    const fundOut = outs.findIndex((x) => x.role === 'fund' && x.n === i);
    const commitment = o.addresses[i];
    const vk = voting.deriveChild(0x80000000 + o.votingFirst + i);
    const t = ticketTx({ input: { txid: splitId, vout, value: seat }, price, votingHash: hash160(vk.publicKey), commitmentHash: hash160(keyAt(1, commitment.index).pub), expiry: o.expiry });
    signP2pkh(t, [keyAt(1, commitment.index)]);
    tickets.push({
      hash: dcrTxid(t), hex: Buffer.from(serializeDcrTx(t)).toString('hex'), voting: o.votingFirst + i, commitment,
      fund: { txid: splitId, vout: fundOut, value: o.feeFund, ...o.addresses[count + i] },
    });
  }
  return { split: { hex: Buffer.from(serializeDcrTx(split)).toString('hex'), id: splitId }, tickets, fee, change };
}

/**
 * The VSP's fee from a ticket's fund output: the fee to its fee address, and what's left back to this wallet
 * when it's worth an output (else it goes to the VSP with the fee, rather than to miners).
 */
export function feeTx(o: { mnemonic: string; fund: { txid: string; vout: number; value: bigint } & StakeAddress; feeAddress: string; amount: bigint; change: StakeAddress; path?: string }): { hex: string; id: string } {
  if (!isDcrAddress(o.feeAddress)) throw new Error('The VSP gave a fee address that is not a Decred address.');
  const account = HDKey.fromMasterSeed(bip39Seed(o.mnemonic)).derive(o.path ?? DCR_PATH);
  const k = account.deriveChild(1).deriveChild(o.fund.index);
  if (dcrAddressOf(k.publicKey) !== o.fund.address) throw new Error('The fee coin does not match this wallet\'s keys, so signing was stopped.');
  const left = o.fund.value - o.amount - FEE_TX_FEE_CHANGE;
  const pay = left >= DUST ? o.amount : o.fund.value - FEE_TX_FEE;
  if (pay < o.amount) throw new Error('The VSP asked for more than was set aside for its fee.');
  const tx: DcrTx = {
    version: 1, lockTime: 0, expiry: 0,
    inputs: [{ txid: o.fund.txid, vout: o.fund.vout, tree: 0, sequence: 0xffffffff, value: o.fund.value, blockHeight: 0, blockIndex: 0xffffffff, sigScript: new Uint8Array() }],
    outputs: [{ value: pay, version: 0, script: dcrScript(o.feeAddress) }],
  };
  if (left >= DUST) {
    const c = account.deriveChild(1).deriveChild(o.change.index);
    if (dcrAddressOf(c.publicKey) !== o.change.address) throw new Error('The change address does not match this wallet\'s keys, so signing was stopped.');
    tx.outputs.splice(randomInt(2), 0, { value: left, version: 0, script: dcrScript(o.change.address) });
  }
  signP2pkh(tx, [{ priv: k.privateKey, pub: k.publicKey }]);
  return { hex: Buffer.from(serializeDcrTx(tx)).toString('hex'), id: dcrTxid(tx) };
}

/** What a ticket's fee fund must hold: the expected fee with a little room, and the fee transaction's own fee. */
export const feeFundFor = (expected: bigint): bigint => expected + expected / 50n + 1_000n + FEE_TX_FEE_CHANGE;

export function votingKey(mnemonic: string, index: number): { wif: string; address: string } {
  const k = HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(DCR_VOTING_PATH).deriveChild(0x80000000 + index);
  return { wif: dcrWif(k.privateKey), address: dcrAddressOf(k.publicKey) };
}

export function commitmentKey(mnemonic: string, index: number, path = DCR_PATH): Uint8Array {
  return HDKey.fromMasterSeed(bip39Seed(mnemonic)).derive(path).deriveChild(1).deriveChild(index).privateKey;
}

// ---- the VSP ----

export interface VspInfo { url: string; pubkey: string; feePercentage: number; network: string; closed: boolean; closedMessage: string; voting: number; version: string }

/** A VSP's address: https (or http to an onion or this machine), the bare origin. */
export function vspOrigin(input: string): string {
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`); } catch { throw new Error('That is not a VSP address.'); }
  const local = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname.endsWith('.onion') || local))) throw new Error('A VSP must be reached over https.');
  return u.origin;
}

export class VspClient {
  constructor(readonly url: string, private pubkey: string | null, private readonly conn: () => { agent?: Agent; route?: string }) {}

  /** A request to the VSP; the answer must be signed with its key and, for a signed request, echo that request. */
  private async call(path: string, body?: object, signer?: Uint8Array): Promise<any> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = signer && text ? { 'VSP-Client-Signature': signDcrMessage(signer, text) } : {};
    const { agent, route } = this.conn();
    const r = await requestRaw(`${this.url}/api/v3${path}`, { method: text === undefined ? 'GET' : 'POST', body: text, headers, agent, route, timeoutMs: 60_000 });
    let j: any = null;
    try { j = JSON.parse(r.text); } catch { /* not JSON */ }
    if (r.status >= 400 || !j) {
      const msg = typeof j?.message === 'string' ? j.message.slice(0, 200) : `error ${r.status}`;
      const e = new Error(`The VSP refused: ${msg}`); (e as any).vspCode = j?.code; throw e;
    }
    const key = this.pubkey ?? (path === '/vspinfo' && typeof j.pubkey === 'string' ? j.pubkey : null);
    const sig = r.headers['vsp-server-signature'];
    let ok = false;
    try { ok = !!key && !!sig && ed25519.verify(Buffer.from(sig, 'base64'), Buffer.from(r.text, 'utf8'), Buffer.from(key, 'base64')); } catch { ok = false; }
    if (!ok) throw new Error('The VSP\'s answer was not signed with its key, so this was stopped.');
    if (text !== undefined && (typeof j.request !== 'string' || Buffer.from(j.request, 'base64').toString('utf8') !== text)) throw new Error('The VSP answered a different request, so this was stopped.');
    if (!this.pubkey) this.pubkey = key;
    return j;
  }

  async info(): Promise<VspInfo> {
    const j = await this.call('/vspinfo');
    if (!Array.isArray(j.apiversions) || !j.apiversions.includes(3)) throw new Error('This VSP does not offer the API this wallet uses.');
    return { url: this.url, pubkey: this.pubkey!, feePercentage: Number(j.feepercentage), network: String(j.network), closed: !!j.vspclosed, closedMessage: String(j.vspclosedmsg ?? '').slice(0, 300), voting: Number(j.voting ?? 0), version: String(j.vspdversion ?? '') };
  }

  /** The fee for a ticket and where to pay it. The VSP broadcasts the split and the ticket if it hasn't seen them. */
  async feeAddress(ticket: { hash: string; hex: string; parentHex: string }, commitmentKey: Uint8Array): Promise<{ address: string; amount: bigint; expiration: number }> {
    const j = await this.call('/feeaddress', { timestamp: Math.floor(Date.now() / 1000), tickethash: ticket.hash, tickethex: ticket.hex, parenthex: ticket.parentHex }, commitmentKey);
    const amount = BigInt(Number.isSafeInteger(j.feeamount) ? j.feeamount : -1);
    if (amount <= 0n || typeof j.feeaddress !== 'string' || !decodeDcrAddress(j.feeaddress)) throw new Error('The VSP gave an unexpected answer.');
    return { address: j.feeaddress, amount, expiration: Number(j.expiration) };
  }

  async payFee(o: { hash: string; feeHex: string; votingWif: string }, commitmentKey: Uint8Array): Promise<void> {
    await this.call('/payfee', { timestamp: Math.floor(Date.now() / 1000), tickethash: o.hash, feetx: o.feeHex, votingkey: o.votingWif, votechoices: {}, tspendpolicy: {}, treasurypolicy: {} }, commitmentKey);
  }
}

/** The open mainnet VSPs from the public list, for choosing one. */
export function parseVspList(j: any, network = 'mainnet'): { url: string; feePercentage: number; voting: number }[] {
  if (!j || typeof j !== 'object') return [];
  const out: { url: string; feePercentage: number; voting: number }[] = [];
  for (const [host, v] of Object.entries<any>(j)) {
    if (!v || v.network !== network || v.closed || v.vspclosed || (Array.isArray(v.apiversions) && !v.apiversions.includes(3))) continue;
    try { out.push({ url: vspOrigin(typeof v.url === 'string' ? v.url : host), feePercentage: Number(v.feepercentage ?? 0), voting: Number(v.voting ?? 0) }); } catch { /* not https */ }
  }
  return out;
}
