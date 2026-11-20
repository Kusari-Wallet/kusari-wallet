// The Solana private pool, on the network: finding this wallet's notes, deposits signed here, withdrawals through
// the pool's relayer. Protocol and layout are in sol-privacy.ts; proofs are made in a worker (solpool-run.ts).
//
// What the relayer would otherwise learn is kept from it as far as the protocol allows:
// - Notes are found by downloading every published output and trying to decrypt each here; the relayer's
//   "which indices are mine" lookup is never used. A note's tree position is its place in that list, checked
//   against the chain before it is spent.
// - Tree paths are asked for with other people's commitments mixed in, on a Tor route of their own, and checked
//   against roots the program itself holds. The withdrawal goes out on another route.
// The relayer still sees each withdrawal's recipient and amount (it signs and pays for it) and can refuse it.

import { randomBytes } from 'node:crypto';
import { requestJson } from './request';
import type { Records } from './records';
import * as P from './sol-privacy';

const { base58 } = require('@scure/base');

const CHUNK = 20_000;
const DEPOSIT_UNITS = 400_000;
const DEPOSIT_PRICE = 400_000n; // micro-lamports per unit, as the site sets it
const DECOYS = 6;
const random = (n: number) => new Uint8Array(randomBytes(n));

export interface Conn { agent?: any; route?: string }
export interface PoolDeps {
  rpcs: string[];
  relayer?: string;
  /** A connection for one purpose; each call may be a new Tor route. */
  conn: (purpose: 'scan' | 'path' | 'submit' | 'chain' | 'spent') => Conn;
  records: Records;
  file: string;
  prove: (input: unknown) => Promise<{ proof: P.Groth16Proof; publicSignals: string[] }>;
  timeoutMs?: number;
  /** The pause between the path lookup and the withdrawal (tests set it short). */
  pauseMs?: () => number;
}

export interface StoredNote { index: number; amount: string; blinding: string; version: 1 | 2; commitment: string; spent?: boolean; at?: number }
interface AssetState { next: number | null; notes: StoredNote[]; known: string[] }
interface Store { assets: Partial<Record<P.PoolAsset, AssetState>> }

export interface PoolBalance { asset: P.PoolAsset; ready: bigint; arriving: bigint; notes: number; scannedTo: number | null; poolSize: number | null }
export interface WithdrawQuote { asset: P.PoolAsset; amount: bigint; fee: bigint; received: bigint; max: bigint; minimum: bigint }

/**
 * `keys` (sol-privacy's poolKeys) find and spend notes; withdrawals need nothing else, since the relayer signs
 * them. A deposit is signed with the SOL key itself, passed in for that one call.
 */
export class SolPool {
  constructor(private readonly keys: P.PoolKeys, private readonly me: string, private readonly d: PoolDeps) {}

  // ---- storage ----

  private async read(): Promise<Store> {
    const s = await this.d.records.read(this.d.file).catch(() => undefined);
    return s && typeof s.assets === 'object' && s.assets ? s : { assets: {} };
  }
  private async write(s: Store): Promise<void> { await this.d.records.write(this.d.file, s); }
  private state(s: Store, asset: P.PoolAsset): AssetState {
    const a = s.assets[asset] ?? { next: null, notes: [], known: [] };
    a.known ??= [];
    s.assets[asset] = a;
    return a;
  }

  // ---- network ----

  private async rpc(method: string, params: unknown[], purpose: 'chain' | 'spent' = 'chain'): Promise<any> {
    let last: unknown;
    const c = this.d.conn(purpose);
    for (const url of this.d.rpcs) {
      try {
        const res = await requestJson(url, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, agent: c.agent, route: c.route, timeoutMs: this.d.timeoutMs ?? 30_000 });
        if (res.body?.error) { const e = new Error(String(res.body.error.message ?? 'The server refused this.').slice(0, 200)); (e as any).final = true; throw e; }
        if (res.status >= 400) throw new Error(`Server error (${res.status})`);
        return res.body?.result;
      } catch (e) { if ((e as any).final) throw e; last = e; }
    }
    throw last instanceof Error ? last : new Error('Could not reach the SOL server.');
  }

  private async relayer(path: string, opts: { body?: unknown; conn: Conn; timeoutMs?: number }): Promise<any> {
    const res = await requestJson(`${this.d.relayer ?? P.POOL_RELAYER}${path}`, { method: opts.body === undefined ? 'GET' : 'POST', body: opts.body, agent: opts.conn.agent, route: opts.conn.route, timeoutMs: opts.timeoutMs ?? 60_000 });
    if (res.status >= 400 || res.body?.success === false) {
      const msg = typeof res.body?.error === 'string' ? res.body.error : typeof res.body?.message === 'string' ? res.body.message : `status ${res.status}`;
      const e = new Error(`The pool relayer refused: ${msg.slice(0, 200)}`);
      (e as any).relayer = true;
      throw e;
    }
    return res.body;
  }

  private async account(address: string): Promise<Uint8Array | null> {
    const r = await this.rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
    if (!r?.value) return null;
    if (r.value.owner !== P.POOL_PROGRAM && address !== P.POOL_LOOKUP_TABLE) throw new Error('A pool account is not owned by the pool program.');
    return Uint8Array.from(Buffer.from(r.value.data[0], 'base64'));
  }

  async tree(t: P.PoolToken): Promise<P.TreeState> {
    const data = await this.account(P.poolAccounts(t).tree);
    if (!data) throw new Error('The private pool for this coin was not found.');
    return P.parseTree(data);
  }

  // ---- finding notes ----

  /** Starts looking from now (a new wallet has nothing earlier) or, with `fromStart`, from the pool's first note. */
  async enable(asset: P.PoolAsset, fromStart = false): Promise<void> {
    const s = await this.read();
    const a = this.state(s, asset);
    if (fromStart) a.next = 0;
    else if (a.next === null) a.next = (await this.tree(P.POOL_TOKENS[asset])).nextIndex;
    await this.write(s);
  }

  async enabled(asset: P.PoolAsset): Promise<boolean> { return (await this.read()).assets[asset]?.next != null; }

  /** Downloads every output published since the last look and keeps the ones this wallet can open. */
  async scan(asset: P.PoolAsset, progress: (done: number, total: number) => void = () => undefined): Promise<number> {
    const t = P.POOL_TOKENS[asset];
    const s = await this.read();
    const a = this.state(s, asset);
    if (a.next === null) return 0;
    const conn = this.d.conn('scan');
    const token = asset === 'SOL' ? '' : `&token=${t.relayerName}`;
    let found = 0;
    for (;;) {
      const start: number = a.next!;
      const body = await this.relayer(`/utxos/range?start=${start}&end=${start + CHUNK - 1}${token}`, { conn, timeoutMs: 180_000 });
      const list = body?.encrypted_outputs;
      if (!Array.isArray(list) || list.length > CHUNK || !Number.isSafeInteger(body.total) || (body.start !== undefined && Number(body.start) !== start)) throw new Error('The pool relayer gave an unexpected answer.');
      const fresh: StoredNote[] = [];
      list.forEach((h: unknown, i: number) => {
        if (typeof h !== 'string' || h.length > 4000) return;
        let raw: Uint8Array;
        try { raw = P.unhex(h); } catch { return; }
        const n = P.decryptNote(raw, this.keys);
        if (!n || n.mint !== t.mint) return;
        const note: P.Note = { amount: n.amount, blinding: n.blinding, index: start + i, mint: t.mint, version: n.version };
        const commitment = P.commitmentOf(note, this.keys, t).toString();
        a.notes = a.notes.filter((x) => x.commitment !== commitment); // one waiting (index -1) becomes this one
        if (n.amount > 0n) fresh.push({ index: note.index, amount: String(n.amount), blinding: String(n.blinding), version: n.version, commitment });
      });
      if (fresh.length) {
        await this.markSpent(t, fresh);
        a.notes.push(...fresh);
        found += fresh.length;
      }
      a.next = start + list.length;
      await this.write(s);
      progress(a.next, body.total);
      if (!list.length || a.next >= body.total || body.hasMore === false) break;
    }
    return found;
  }

  /** Notes found by the scan may have been spent elsewhere (on the pool's site, with the same key). */
  private async markSpent(t: P.PoolToken, notes: StoredNote[]): Promise<void> {
    const markers = notes.flatMap((n) => P.spentMarkers(P.nullifierOf(this.toNote(n, t), this.keys, t)));
    for (let i = 0; i < markers.length; i += 100) {
      const r = await this.rpc('getMultipleAccounts', [markers.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }], 'spent');
      if (!Array.isArray(r?.value)) throw new Error('The SOL server gave an unexpected answer.');
      r.value.forEach((v: unknown, j: number) => { if (v) notes[Math.floor((i + j) / 2)].spent = true; });
    }
  }

  private toNote(n: StoredNote, t: P.PoolToken): P.Note {
    return { amount: BigInt(n.amount), blinding: BigInt(n.blinding), index: n.index, mint: t.mint, version: n.version };
  }

  async balance(asset: P.PoolAsset): Promise<PoolBalance> {
    const s = await this.read();
    const a = s.assets[asset];
    const live = (a?.notes ?? []).filter((n) => !n.spent);
    const sum = (l: StoredNote[]) => l.reduce((x, n) => x + BigInt(n.amount), 0n);
    return { asset, ready: sum(live.filter((n) => n.index >= 0)), arriving: sum(live.filter((n) => n.index < 0)), notes: live.length, scannedTo: a?.next ?? null, poolSize: null };
  }

  // ---- deposit ----

  private async lookupTable(): Promise<{ address: string; keys: string[] }> {
    const data = await this.account(P.POOL_LOOKUP_TABLE);
    if (!data) throw new Error('The pool lookup table was not found.');
    return { address: P.POOL_LOOKUP_TABLE, keys: P.parseLookupTable(data) };
  }

  /** What a deposit costs beyond its amount: the network fee and the two spent-markers' rent. */
  async depositCost(asset: P.PoolAsset): Promise<{ fee: bigint; max: bigint }> {
    const tree = await this.tree(P.POOL_TOKENS[asset]);
    const rent = BigInt(await this.rpc('getMinimumBalanceForRentExemption', [9]));
    const fee = 5_000n + (DEPOSIT_PRICE * BigInt(DEPOSIT_UNITS)) / 1_000_000n + 2n * rent;
    return { fee, max: tree.maxDeposit };
  }

  /** Builds, proves and signs a deposit; the relayer passes it on, as the pool's site does. Returns its id. */
  async deposit(asset: P.PoolAsset, amount: bigint, secret: Uint8Array): Promise<string> {
    if (base58.encode(require('@noble/curves/ed25519.js').ed25519.getPublicKey(secret)) !== this.me) throw new Error('This key is not this wallet\'s.');
    const t = P.POOL_TOKENS[asset];
    if (amount <= 0n) throw new Error('The amount must be more than zero.');
    const tree = await this.tree(t);
    if (amount > tree.maxDeposit) throw new Error('This is more than the pool takes in one deposit.');
    const a = P.poolAccounts(t);
    const placeholder = P.isSplPool(t) ? a.feeRecipientAta : P.POOL_FEE_RECIPIENT;
    const outs: [P.Output, P.Output] = [{ amount, blinding: P.randomBlinding(random) }, { amount: 0n, blinding: P.randomBlinding(random) }];
    const enc = outs.map((o, i) => P.encryptNote({ amount: o.amount, blinding: o.blinding, index: tree.nextIndex + i, mint: t.mint, version: 2 }, this.keys, t, random));
    const ext: P.ExtData = { recipient: placeholder, extAmount: amount, enc1: enc[0], enc2: enc[1], fee: 0n, feeRecipient: placeholder, mint: t.mint };
    const { input, signals } = P.circuitInput(this.keys, t, tree.root, [{ note: null, path: [] }, { note: null, path: [] }], outs, ext, random);
    const proof = await this.provenBytes(input, signals);
    const nfs = P.nullifierAccounts(P.be32(signals[3]), P.be32(signals[4]));
    const ix = P.depositInstruction(t, this.me, nfs, P.instructionData(P.isSplPool(t), proof, signals, ext));
    const [table, latest] = await Promise.all([this.lookupTable(), this.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])]);
    const blockhash = latest?.value?.blockhash;
    let signed = P.signV0(secret, P.compileV0(this.me, [P.computeLimit(DEPOSIT_UNITS), P.computePrice(DEPOSIT_PRICE), ix], blockhash, table));
    if (signed.raw.length > P.MAX_TX_SIZE) signed = P.signV0(secret, P.compileV0(this.me, [P.computeLimit(DEPOSIT_UNITS), ix], blockhash, table));
    if (signed.raw.length > P.MAX_TX_SIZE) throw new Error('The deposit came out too large to send.');
    // Kept as arriving before it is sent, so a crash between the two can't lose track of it.
    const s = await this.read();
    const st = this.state(s, asset);
    st.notes.push({ index: -1, amount: String(amount), blinding: String(outs[0].blinding), version: 2, commitment: signals[5].toString(), at: Date.now() });
    await this.write(s);
    const body = { signedTransaction: signed.base64, senderAddress: this.me, ...(P.isSplPool(t) ? { mintAddress: t.mint } : {}) };
    try {
      const r = await this.relayer(P.isSplPool(t) ? '/deposit/spl' : '/deposit', { body, conn: this.d.conn('submit'), timeoutMs: 120_000 });
      if (typeof r?.signature === 'string' && r.signature !== signed.id) throw new Error('The pool relayer answered for another transaction.');
    } catch (e) {
      // Not sent after all (the chain hasn't seen it): forget the note waiting for it.
      await new Promise((r) => setTimeout(r, this.d.pauseMs ? this.d.pauseMs() : 20_000));
      const st = await this.rpc('getSignatureStatuses', [[signed.id], { searchTransactionHistory: true }]).catch(() => undefined);
      if (st && Array.isArray(st.value) && !st.value[0]) {
        const again = await this.read();
        const x = this.state(again, asset);
        x.notes = x.notes.filter((n) => n.commitment !== signals[5].toString());
        await this.write(again);
      }
      throw e;
    }
    return signed.id;
  }

  private async provenBytes(input: unknown, signals: bigint[]): Promise<Uint8Array> {
    const { proof, publicSignals } = await this.d.prove(input);
    if (publicSignals.length !== 7 || publicSignals.some((v, i) => BigInt(v) !== signals[i])) throw new Error('The proof does not match this transaction.');
    return P.proofBytes(proof);
  }

  // ---- withdrawal ----

  private async feeRule(t: P.PoolToken): Promise<{ rate: bigint; rent: bigint; minimum: bigint }> {
    const c = await this.relayer('/config', { conn: this.d.conn('scan') });
    const rate = Number(c?.withdraw_fee_rate);
    const rentRaw = t.asset === 'SOL' ? Number(c?.withdraw_rent_fee) : Number(c?.rent_fees?.[t.relayerName]);
    if (!(rate >= 0 && rate <= 0.01) || !(rentRaw >= 0)) throw new Error('The pool relayer asks for an unusual fee.');
    const unit = 10 ** t.decimals;
    const rent = BigInt(Math.ceil(rentRaw * unit));
    if (rent > BigInt(t.asset === 'SOL' ? 0.02 * unit : 5 * unit)) throw new Error('The pool relayer asks for an unusual fee.');
    const minRaw = Number(c?.minimum_withdrawal?.[t.relayerName] ?? 0);
    return { rate: BigInt(Math.round(rate * 1e6)), rent, minimum: minRaw > 0 ? BigInt(Math.ceil(minRaw * unit)) : 0n };
  }
  private feeFor(amount: bigint, r: { rate: bigint; rent: bigint }): bigint { return (amount * r.rate) / 1_000_000n + r.rent; }

  /** The most that can go out while the notes spent and the fee stay within `budget` (a deposit's amount). */
  async quoteWithin(asset: P.PoolAsset, budget: bigint): Promise<WithdrawQuote> {
    const t = P.POOL_TOKENS[asset];
    const rule = await this.feeRule(t);
    const max = (await this.withdrawQuote(asset, 'max')).max;
    let a = ((budget - rule.rent) * 1_000_000n) / (1_000_000n + rule.rate);
    while (a > 0n && a + this.feeFor(a, rule) > budget) a -= 1n;
    return this.withdrawQuote(asset, a < max ? a : max);
  }

  /** The two largest unspent notes: one withdrawal spends at most two. */
  private async inputs(asset: P.PoolAsset): Promise<StoredNote[]> {
    const a = (await this.read()).assets[asset];
    return (a?.notes ?? []).filter((n) => !n.spent && n.index >= 0).sort((x, y) => (BigInt(y.amount) > BigInt(x.amount) ? 1 : -1)).slice(0, 2);
  }

  /** `amount` is what leaves the pool; the recipient gets it less the relayer's fee. */
  async withdrawQuote(asset: P.PoolAsset, amount: bigint | 'max'): Promise<WithdrawQuote> {
    const t = P.POOL_TOKENS[asset];
    const ins = await this.inputs(asset);
    const total = ins.reduce((s, n) => s + BigInt(n.amount), 0n);
    const rule = await this.feeRule(t);
    // The fee is charged on the amount sent out, so the largest amount is a little under what the notes hold.
    let max = total - this.feeFor(total, rule);
    while (max > 0n && max + this.feeFor(max, rule) > total) max -= 1n;
    const out = amount === 'max' ? max : amount;
    if (out <= 0n) throw new Error('There is nothing in the private pool to withdraw.');
    if (out > max) throw new Error('More than one withdrawal can take; withdraw up to the most shown, then the rest.');
    if (out < rule.minimum) throw new Error('This is less than the pool relayer withdraws.');
    const fee = this.feeFor(out, rule);
    return { asset, amount: out, fee, received: out, max, minimum: rule.minimum };
  }

  /** Commitments of other people's notes, to ask for tree paths among: recent ones from the chain and older
   *  ones met in earlier answers. */
  private async decoys(t: P.PoolToken, known: string[]): Promise<string[]> {
    const out = new Set<string>();
    try {
      const tree = P.poolAccounts(t).tree;
      const sigs: any[] = await this.rpc('getSignaturesForAddress', [tree, { limit: 8 }]);
      for (const s of (Array.isArray(sigs) ? sigs : []).sort(() => Math.random() - 0.5).slice(0, 3)) {
        const tx = await this.rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
        const keys: string[] = tx?.transaction?.message?.accountKeys ?? [];
        for (const ix of tx?.transaction?.message?.instructions ?? []) {
          if (keys[ix.programIdIndex] !== P.POOL_PROGRAM) continue;
          const data: Uint8Array = base58.decode(ix.data);
          if (data.length < 8 + 256 + 7 * 32) continue;
          for (const k of [5, 6]) out.add(P.fromBe(data.slice(8 + 256 + k * 32, 8 + 256 + (k + 1) * 32)).toString());
        }
      }
    } catch { /* decoys are best effort */ }
    const pool = [...out, ...known.slice().sort(() => Math.random() - 0.5)];
    return [...new Set(pool)].slice(0, DECOYS);
  }

  /** Tree paths for our notes, asked for among decoys on a route of their own; each checked against the chain. */
  private async paths(t: P.PoolToken, notes: StoredNote[], a: AssetState): Promise<{ root: bigint; paths: bigint[][] }> {
    const decoys = (await this.decoys(t, a.known)).filter((c) => !notes.some((n) => n.commitment === c));
    const ask = [...notes.map((n) => n.commitment), ...decoys].sort(() => Math.random() - 0.5);
    const token = t.asset === 'SOL' ? '' : `&token=${t.relayerName}`;
    const r = await this.relayer(`/merkle/proofv2/?commitments=${ask.join(',')}${token}`, { conn: this.d.conn('path') });
    if (!Array.isArray(r?.proofs) || r.proofs.length !== ask.length) throw new Error('The pool relayer gave an unexpected answer.');
    const tree = await this.tree(t);
    const roots = new Set([tree.root, ...tree.history].map(String));
    let root: bigint | null = null;
    const paths = notes.map((n) => {
      const p = r.proofs[ask.indexOf(n.commitment)];
      const path = (p?.pathElements ?? []).map((x: unknown) => BigInt(String(x)));
      const reached = P.rootFrom(BigInt(n.commitment), n.index, path);
      if (!roots.has(reached.toString()) || (root !== null && root !== reached)) throw new Error('The pool relayer gave a tree path the chain does not confirm.');
      root = reached;
      return path;
    });
    // Neighbouring leaves are other people's notes: decoys for next time.
    for (const p of r.proofs) { const leaf = p?.pathElements?.[0]; if (typeof leaf === 'string' && /^\d{1,80}$/.test(leaf)) a.known.push(leaf); }
    a.known = [...new Set(a.known)].slice(-200);
    return { root: root!, paths };
  }

  /** Proves and hands a withdrawal to the relayer. `recipient` is a SOL address (its token account for tokens). */
  async withdraw(asset: P.PoolAsset, amount: bigint, recipient: string, onStage: (s: 'path' | 'proof' | 'send') => void = () => undefined): Promise<string> {
    const t = P.POOL_TOKENS[asset];
    const quote = await this.withdrawQuote(asset, amount);
    const s = await this.read();
    const a = this.state(s, asset);
    const ins = (await this.inputs(asset)).map((n) => a.notes.find((x) => x.commitment === n.commitment)!);
    onStage('path');
    const { root, paths } = await this.paths(t, ins, a);
    await this.write(s);
    // A pause between the path lookup and the withdrawal, so the two don't arrive together.
    await new Promise((r) => setTimeout(r, this.d.pauseMs ? this.d.pauseMs() : 15_000 + Math.random() * 45_000));
    onStage('proof');
    const total = ins.reduce((x, n) => x + BigInt(n.amount), 0n);
    const change = total - quote.amount - quote.fee;
    if (change < 0n) throw new Error('The notes do not cover this withdrawal.');
    const outs: [P.Output, P.Output] = [{ amount: change, blinding: P.randomBlinding(random) }, { amount: 0n, blinding: P.randomBlinding(random) }];
    const tree = await this.tree(t);
    const enc = outs.map((o, i) => P.encryptNote({ amount: o.amount, blinding: o.blinding, index: tree.nextIndex + i, mint: t.mint, version: 2 }, this.keys, t, random));
    const acc = P.poolAccounts(t);
    const spl = P.isSplPool(t);
    const recipientAta = spl ? P.tokenAccount(recipient, t.mint) : '';
    const ext: P.ExtData = { recipient: spl ? recipientAta : recipient, extAmount: -quote.amount, enc1: enc[0], enc2: enc[1], fee: quote.fee, feeRecipient: spl ? acc.feeRecipientAta : P.POOL_FEE_RECIPIENT, mint: t.mint };
    const spend = (i: number): P.Spend => (ins[i] ? { note: this.toNote(ins[i], t), path: paths[i] } : { note: null, path: [] });
    const { input, signals } = P.circuitInput(this.keys, t, root, [spend(0), spend(1)], outs, ext, random);
    const proof = await this.provenBytes(input, signals);
    const nf0 = P.be32(signals[3]);
    const nf1 = P.be32(signals[4]);
    const nfs = P.nullifierAccounts(nf0, nf1);
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
    const body: Record<string, unknown> = {
      serializedProof: b64(P.instructionData(spl, proof, signals, ext)),
      treeAccount: acc.tree, nullifier0PDA: nfs.nf0, nullifier1PDA: nfs.nf1, nullifier2PDA: nfs.nf2, nullifier3PDA: nfs.nf3,
      treeTokenAccount: acc.treeToken, globalConfigAccount: acc.globalConfig, recipient, feeRecipientAccount: P.POOL_FEE_RECIPIENT,
      extAmount: Number(-quote.amount), encryptedOutput1: b64(enc[0]), encryptedOutput2: b64(enc[1]), fee: Number(quote.fee), lookupTableAddress: P.POOL_LOOKUP_TABLE,
      ...(spl ? { treeAta: acc.treeAta, recipientAta, mintAddress: t.mint, feeRecipientTokenAccount: acc.feeRecipientAta } : {}),
    };
    onStage('send');
    let r: any;
    try {
      r = await this.relayer(spl ? '/withdraw/spl' : '/withdraw', { body, conn: this.d.conn('submit'), timeoutMs: 180_000 });
    } catch (e) {
      // Spent already (on another device or the pool's site): mark it, so the next try picks other notes.
      if (/already in use|already been processed|0x0\b/i.test((e as Error).message)) { await this.markSpent(t, ins); await this.write(s); }
      throw e;
    }
    if (typeof r?.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(r.signature)) throw new Error('The pool relayer gave an unexpected answer.');
    const after = await this.read();
    const st = this.state(after, asset);
    for (const n of st.notes) if (ins.some((x) => x.commitment === n.commitment)) n.spent = true;
    if (change > 0n) st.notes.push({ index: -1, amount: String(change), blinding: String(outs[0].blinding), version: 2, commitment: signals[5].toString(), at: Date.now() });
    await this.write(after);
    return r.signature;
  }
}
