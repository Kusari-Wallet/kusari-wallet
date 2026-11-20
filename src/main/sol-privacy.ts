// The Solana private pool (PrivacyCash, program 9fhQBb...): its notes, keys, encryption and transaction layout,
// written from the protocol as its ISC-licensed SDK uses it (see THIRD-PARTY-NOTICES.md). No network here.
//
// A note (UTXO) is Poseidon(amount, pubkey, blinding, mint); spending it reveals Poseidon(commitment, index,
// Poseidon(privkey, commitment, index)). Every transaction spends two notes and makes two, as Tornado Nova does,
// proven with Groth16 on the pool's circuit. Notes are encrypted to the wallet's own key and published with the
// transaction, so the 12 words alone restore them (and the PrivacyCash site, signing in with the same SOL key,
// shows the same balance).

const { ed25519 } = require('@noble/curves/ed25519.js');
const { sha256 } = require('@noble/hashes/sha2.js');
const { keccak_256 } = require('@noble/hashes/sha3.js');
const { hmac } = require('@noble/hashes/hmac.js');
const { gcm, ctr } = require('@noble/ciphers/aes.js');
const { base58 } = require('@scure/base');
const { poseidon1, poseidon2, poseidon3, poseidon4 } = require('poseidon-lite');

export const POOL_PROGRAM = '9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD';
export const POOL_FEE_RECIPIENT = '97rSMQUukMDjA7PYErccyx7ZxbHvSDaeXp2ig5BwSrTf';
export const POOL_LOOKUP_TABLE = 'HEN49U2ySJ85Vc78qprSW9y6mFDhs1NczRxyppNHjofe';
export const POOL_RELAYER = 'https://api3.privacycash.org';
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const TREE_DEPTH = 26;
const SIGN_IN = 'Privacy Money account sign in';
const SOL_MINT = '11111111111111111111111111111112'; // what the program calls SOL
const SYSTEM_ID = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TRANSACT = Uint8Array.from([217, 149, 130, 143, 221, 52, 252, 119]);
const TRANSACT_SPL = Uint8Array.from([154, 66, 244, 204, 78, 225, 163, 151]);
const V2 = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 2]);
export const MAX_TX_SIZE = 1232;

export type PoolAsset = 'SOL' | 'USDCS' | 'USDTS';
export interface PoolToken { asset: PoolAsset; mint: string; relayerName: string; decimals: number; symbol: string }
export const POOL_TOKENS: Record<PoolAsset, PoolToken> = {
  SOL: { asset: 'SOL', mint: SOL_MINT, relayerName: 'sol', decimals: 9, symbol: 'SOL' },
  USDCS: { asset: 'USDCS', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', relayerName: 'usdc', decimals: 6, symbol: 'USDC' },
  USDTS: { asset: 'USDTS', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', relayerName: 'usdt', decimals: 6, symbol: 'USDT' },
};
export const isSplPool = (t: PoolToken) => t.asset !== 'SOL';

// ---- bytes ----

export function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function unhex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(s)) throw new Error('The pool server gave an unexpected answer.');
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}
const utf8 = (s: string) => new TextEncoder().encode(s);
export function be32(n: bigint): Uint8Array {
  if (n < 0n || n >= 1n << 256n) throw new Error('Number out of range.');
  return unhex(n.toString(16).padStart(64, '0'));
}
export const fromBe = (b: Uint8Array) => (b.length ? BigInt(`0x${hex(b)}`) : 0n);
const fromLe = (b: Uint8Array) => fromBe(Uint8Array.from(b).reverse());
function u64le(n: bigint): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n), true); return b; }
function u32le(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
const compact = (n: number) => {
  const out: number[] = [];
  for (;;) { const b = n & 127; n >>= 7; if (n) out.push(b | 128); else { out.push(b); return Uint8Array.from(out); } }
};

// ---- keys ----

export interface PoolKeys { encV1: Uint8Array; encV2: Uint8Array; privV1: bigint; privV2: bigint; pubV1: bigint; pubV2: bigint }

/** From the wallet's SOL key: its signature of the sign-in text, as the PrivacyCash site makes it. */
export function poolKeys(solSecret: Uint8Array): PoolKeys {
  const sig: Uint8Array = ed25519.sign(utf8(SIGN_IN), solSecret);
  const encV1 = sig.slice(0, 31);
  const encV2: Uint8Array = keccak_256(sig);
  const privV1 = fromBe(sha256(encV1)) % FIELD;
  const privV2 = fromBe(keccak_256(encV2)) % FIELD;
  return { encV1, encV2, privV1, privV2, pubV1: poseidon1([privV1]), pubV2: poseidon1([privV2]) };
}

/** The mint as the circuit takes it: SOL's "address" read as a decimal number, a token's first 31 bytes. */
export function mintField(t: PoolToken): bigint {
  if (t.mint === SOL_MINT) return BigInt(SOL_MINT);
  return fromBe((base58.decode(t.mint) as Uint8Array).slice(0, 31));
}

// ---- notes ----

export interface Note { amount: bigint; blinding: bigint; index: number; mint: string; version: 1 | 2 }

export const commitmentOf = (n: Note, keys: PoolKeys, t: PoolToken): bigint =>
  poseidon4([n.amount, n.version === 1 ? keys.pubV1 : keys.pubV2, n.blinding, mintField(t)]);

export function nullifierOf(n: Note, keys: PoolKeys, t: PoolToken): bigint {
  const c = commitmentOf(n, keys, t);
  const idx = BigInt(n.index);
  return poseidon3([c, idx, poseidon3([n.version === 1 ? keys.privV1 : keys.privV2, c, idx])]);
}

/** A blinding over the whole field (the SDK draws one below 10^9; any value in the field is valid). */
export function randomBlinding(random: (n: number) => Uint8Array): bigint {
  for (;;) { const v = fromBe(random(32)) >> 2n; if (v < FIELD) return v; }
}

const noteText = (n: Note, t: PoolToken) => `${n.amount}|${n.blinding}|${n.index}|${t.mint}`;

export function encryptNote(n: Note, keys: PoolKeys, t: PoolToken, random: (n: number) => Uint8Array): Uint8Array {
  const iv = random(12);
  const sealed: Uint8Array = gcm(keys.encV2, iv).encrypt(utf8(noteText(n, t)));
  // @noble/ciphers puts the tag after the data; the pool's layout has it before.
  return join([V2, iv, sealed.slice(-16), sealed.slice(0, -16)]);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** One published output, or null when it isn't this wallet's. Both the current (V2) and the first (V1) layout. */
export function decryptNote(data: Uint8Array, keys: PoolKeys): Omit<Note, 'index'> & { hintIndex: number } | null {
  let plain: Uint8Array;
  let version: 1 | 2;
  try {
    if (data.length >= 36 && equal(data.slice(0, 8), V2)) {
      plain = gcm(keys.encV2, data.slice(8, 20)).decrypt(join([data.slice(36), data.slice(20, 36)]));
      version = 2;
    } else {
      if (data.length < 33) return null;
      const iv = data.slice(0, 16);
      const tag = (hmac(sha256, keys.encV1.slice(16, 31), join([iv, data.slice(32)])) as Uint8Array).slice(0, 16);
      if (!equal(tag, data.slice(16, 32))) return null;
      plain = ctr(keys.encV1.slice(0, 16), iv).decrypt(data.slice(32));
      version = 1;
    }
  } catch { return null; }
  const parts = new TextDecoder().decode(plain).split('|');
  if (parts.length !== 4 || !/^\d{1,30}$/.test(parts[0]) || !/^\d{1,80}$/.test(parts[1]) || !/^\d{0,15}$/.test(parts[2])) return null;
  const amount = BigInt(parts[0]);
  const blinding = BigInt(parts[1]);
  if (blinding >= FIELD) return null;
  return { amount, blinding, hintIndex: Number(parts[2] || 0), mint: parts[3], version };
}

// ---- the Merkle tree ----

let zeroCache: bigint[] | null = null;
export function zeros(): bigint[] {
  if (!zeroCache) { zeroCache = [0n]; for (let i = 0; i < TREE_DEPTH; i++) zeroCache.push(poseidon2([zeroCache[i], zeroCache[i]])); }
  return zeroCache;
}

/** The root a leaf at an index reaches through a path. */
export function rootFrom(leaf: bigint, index: number, path: bigint[]): bigint {
  if (path.length !== TREE_DEPTH) throw new Error('The pool server gave a path of the wrong length.');
  let node = leaf;
  for (let i = 0; i < TREE_DEPTH; i++) node = (Math.floor(index / 2 ** i) % 2) ? poseidon2([path[i], node]) : poseidon2([node, path[i]]);
  return node;
}

export interface TreeState { nextIndex: number; root: bigint; history: bigint[]; maxDeposit: bigint }

/** The program's MerkleTreeAccount (zero-copy, after Anchor's 8-byte name). */
export function parseTree(data: Uint8Array): TreeState {
  if (data.length < 4131) throw new Error('The pool account is not what was expected.');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = (o: number) => fromBe(data.slice(o, o + 32));
  const history: bigint[] = [];
  for (let i = 0; i < 100; i++) history.push(at(912 + i * 32));
  return { nextIndex: Number(v.getBigUint64(40, true)), root: at(880), history, maxDeposit: v.getBigUint64(4120, true) };
}

export interface FeeRates { depositRate: number; withdrawRate: number; margin: number }
export function parseGlobalConfig(data: Uint8Array): FeeRates {
  if (data.length < 46) throw new Error('The pool account is not what was expected.');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { depositRate: v.getUint16(40, true), withdrawRate: v.getUint16(42, true), margin: v.getUint16(44, true) };
}

// ---- addresses ----

function onCurve(key: Uint8Array): boolean {
  try { ed25519.Point.fromBytes(key, true); return true; } catch { return false; }
}

export function programAddress(seeds: Uint8Array[], program: string): string {
  for (let bump = 255; bump >= 0; bump--) {
    const h: Uint8Array = sha256(join([...seeds, Uint8Array.from([bump]), base58.decode(program), utf8('ProgramDerivedAddress')]));
    if (!onCurve(h)) return base58.encode(h);
  }
  throw new Error('No program address exists for these seeds.');
}
export const tokenAccount = (owner: string, mint: string) =>
  programAddress([base58.decode(owner), base58.decode(TOKEN_PROGRAM), base58.decode(mint)], ATA_PROGRAM);

export function poolAccounts(t: PoolToken) {
  const tree = programAddress(isSplPool(t) ? [utf8('merkle_tree'), base58.decode(t.mint)] : [utf8('merkle_tree')], POOL_PROGRAM);
  const globalConfig = programAddress([utf8('global_config')], POOL_PROGRAM);
  return {
    tree, globalConfig,
    treeToken: programAddress([utf8('tree_token')], POOL_PROGRAM),
    treeAta: isSplPool(t) ? tokenAccount(globalConfig, t.mint) : '',
    feeRecipientAta: isSplPool(t) ? tokenAccount(POOL_FEE_RECIPIENT, t.mint) : '',
  };
}

export function nullifierAccounts(nf0: Uint8Array, nf1: Uint8Array) {
  const at = (seed: string, nf: Uint8Array) => programAddress([utf8(seed), nf], POOL_PROGRAM);
  return { nf0: at('nullifier0', nf0), nf1: at('nullifier1', nf1), nf2: at('nullifier0', nf1), nf3: at('nullifier1', nf0) };
}
/** The two accounts whose existence would mean a note is spent (it may have gone in either slot). */
export const spentMarkers = (nf: bigint) => [programAddress([utf8('nullifier0'), be32(nf)], POOL_PROGRAM), programAddress([utf8('nullifier1'), be32(nf)], POOL_PROGRAM)];

// ---- a transaction ----

export interface ExtData { recipient: string; extAmount: bigint; enc1: Uint8Array; enc2: Uint8Array; fee: bigint; feeRecipient: string; mint: string }

/** sha256 over the Borsh encoding, as the program checks it; the circuit takes it read little-endian, mod p. */
export function extDataHash(e: ExtData): bigint {
  const raw = sha256(join([
    base58.decode(e.recipient), u64le(e.extAmount), u32le(e.enc1.length), e.enc1, u32le(e.enc2.length), e.enc2,
    u64le(e.fee), base58.decode(e.feeRecipient), base58.decode(e.mint),
  ]));
  return fromLe(raw) % FIELD;
}

export const publicAmount = (extAmount: bigint, fee: bigint) => (((extAmount - fee) % FIELD) + FIELD) % FIELD;

export interface Groth16Proof { pi_a: string[]; pi_b: string[][]; pi_c: string[] }

/** The proof as the program's verifier reads it: A and C big-endian, B's pairs swapped (Ethereum's order). */
export function proofBytes(p: Groth16Proof): Uint8Array {
  const n = (s: string) => be32(BigInt(s));
  return join([
    n(p.pi_a[0]), n(p.pi_a[1]),
    n(p.pi_b[0][1]), n(p.pi_b[0][0]), n(p.pi_b[1][1]), n(p.pi_b[1][0]),
    n(p.pi_c[0]), n(p.pi_c[1]),
  ]);
}

/** Public signals in circuit order: root, publicAmount, extDataHash, nullifiers, commitments. */
export function instructionData(spl: boolean, proof: Uint8Array, signals: bigint[], e: ExtData): Uint8Array {
  if (proof.length !== 256 || signals.length !== 7) throw new Error('A proof of the wrong shape.');
  return join([spl ? TRANSACT_SPL : TRANSACT, proof, ...signals.map(be32), u64le(e.extAmount), u64le(e.fee), u32le(e.enc1.length), e.enc1, u32le(e.enc2.length), e.enc2]);
}

export interface Meta { key: string; signer: boolean; writable: boolean }
export interface Instruction { program: string; accounts: Meta[]; data: Uint8Array }

/** The deposit instruction (the depositor signs and pays; the recipient is the fee account, as the site does). */
export function depositInstruction(t: PoolToken, signer: string, nfs: ReturnType<typeof nullifierAccounts>, data: Uint8Array): Instruction {
  const a = poolAccounts(t);
  const w = (key: string) => ({ key, signer: false, writable: true });
  const r = (key: string) => ({ key, signer: false, writable: false });
  const head = [w(a.tree), w(nfs.nf0), w(nfs.nf1), r(nfs.nf2), r(nfs.nf3)];
  const me = { key: signer, signer: true, writable: true };
  if (!isSplPool(t)) {
    return { program: POOL_PROGRAM, data, accounts: [...head, w(a.treeToken), r(a.globalConfig), w(POOL_FEE_RECIPIENT), w(POOL_FEE_RECIPIENT), me, r(SYSTEM_ID)] };
  }
  return {
    program: POOL_PROGRAM, data,
    accounts: [...head, r(a.globalConfig), me, r(t.mint), w(tokenAccount(signer, t.mint)), w(POOL_FEE_RECIPIENT), w(a.feeRecipientAta),
      w(a.treeAta), w(a.feeRecipientAta), r(TOKEN_PROGRAM), r(ATA_PROGRAM), r(SYSTEM_ID)],
  };
}

export const computeLimit = (units: number): Instruction => ({ program: COMPUTE_BUDGET, accounts: [], data: join([Uint8Array.from([2]), u32le(units)]) });
export const computePrice = (microLamports: bigint): Instruction => ({ program: COMPUTE_BUDGET, accounts: [], data: join([Uint8Array.from([3]), u64le(microLamports)]) });

/** The addresses an address lookup table holds (after its 56-byte header). */
export function parseLookupTable(data: Uint8Array): string[] {
  if (data.length < 56 || (data.length - 56) % 32) throw new Error('The lookup table is not what was expected.');
  const out: string[] = [];
  for (let o = 56; o < data.length; o += 32) out.push(base58.encode(data.slice(o, o + 32)));
  return out;
}

/** A version 0 message: accounts the table holds (not signers or programs) are loaded from it. */
export function compileV0(payer: string, instructions: Instruction[], recentBlockhash: string, table: { address: string; keys: string[] }): Uint8Array {
  const blockhash: Uint8Array = base58.decode(recentBlockhash);
  if (blockhash.length !== 32) throw new Error('The server gave an unexpected answer.');
  const metas = new Map<string, Meta & { program: boolean }>();
  const add = (m: Meta, program = false) => {
    const k = metas.get(m.key);
    metas.set(m.key, k ? { key: m.key, signer: k.signer || m.signer, writable: k.writable || m.writable, program: k.program || program } : { ...m, program });
  };
  add({ key: payer, signer: true, writable: true });
  for (const ix of instructions) { ix.accounts.forEach((m) => add(m)); add({ key: ix.program, signer: false, writable: false }, true); }
  const inTable = (m: Meta & { program: boolean }) => !m.signer && !m.program && table.keys.includes(m.key);
  const rank = (m: Meta) => (m.signer ? (m.writable ? 0 : 1) : (m.writable ? 2 : 3));
  const all = [...metas.values()];
  const statics = all.filter((m) => !inTable(m)).sort((x, y) => (x.key === payer ? -1 : y.key === payer ? 1 : rank(x) - rank(y)));
  const loadedW = all.filter((m) => inTable(m) && m.writable);
  const loadedR = all.filter((m) => inTable(m) && !m.writable);
  const order = [...statics, ...loadedW, ...loadedR].map((m) => m.key);
  const index = (k: string) => order.indexOf(k);
  const header = Uint8Array.from([statics.filter((m) => m.signer).length, statics.filter((m) => m.signer && !m.writable).length, statics.filter((m) => !m.signer && !m.writable).length]);
  const lookups = loadedW.length + loadedR.length
    ? join([compact(1), base58.decode(table.address), compact(loadedW.length), Uint8Array.from(loadedW.map((m) => table.keys.indexOf(m.key))), compact(loadedR.length), Uint8Array.from(loadedR.map((m) => table.keys.indexOf(m.key)))])
    : compact(0);
  return join([
    Uint8Array.from([0x80]), header,
    compact(statics.length), ...statics.map((m) => base58.decode(m.key) as Uint8Array),
    blockhash,
    compact(instructions.length),
    ...instructions.map((ix) => join([Uint8Array.from([index(ix.program)]), compact(ix.accounts.length), Uint8Array.from(ix.accounts.map((m) => index(m.key))), compact(ix.data.length), ix.data])),
    lookups,
  ]);
}

export function signV0(secret: Uint8Array, message: Uint8Array): { raw: Uint8Array; base64: string; id: string } {
  const signature: Uint8Array = ed25519.sign(message, secret);
  const raw = join([compact(1), signature, message]);
  let s = '';
  for (const b of raw) s += String.fromCharCode(b);
  return { raw, base64: btoa(s), id: base58.encode(signature) };
}

// ---- the circuit's input ----

export interface Spend { note: Note | null; path: bigint[] } // null: an empty note (amount 0, no tree check)
export interface Output { amount: bigint; blinding: bigint }

/** Inputs for transaction2.circom, and the signals the proof will carry (to check against its output). */
export function circuitInput(keys: PoolKeys, t: PoolToken, root: bigint, ins: [Spend, Spend], outs: [Output, Output], e: ExtData, random: (n: number) => Uint8Array) {
  const notes = ins.map((s) => s.note ?? { amount: 0n, blinding: randomBlinding(random), index: 0, mint: t.mint, version: 2 as const });
  const extHash = extDataHash(e);
  const pub = publicAmount(e.extAmount, e.fee);
  const sumIn = notes.reduce((s, n) => s + n.amount, 0n);
  const sumOut = outs.reduce((s, o) => s + o.amount, 0n);
  if ((sumIn + pub) % FIELD !== sumOut % FIELD) throw new Error('The amounts of this transaction do not add up.');
  const outCommitments = outs.map((o) => poseidon4([o.amount, keys.pubV2, o.blinding, mintField(t)]));
  const nullifiers = notes.map((n) => nullifierOf(n, keys, t));
  if (nullifiers[0] === nullifiers[1]) throw new Error('The same note twice.');
  const s = (v: bigint) => v.toString();
  return {
    input: {
      root: s(root), inputNullifier: nullifiers.map(s), outputCommitment: outCommitments.map(s), publicAmount: s(pub), extDataHash: s(extHash),
      inAmount: notes.map((n) => s(n.amount)), inPrivateKey: notes.map((n) => s(n.version === 1 ? keys.privV1 : keys.privV2)),
      inBlinding: notes.map((n) => s(n.blinding)), inPathIndices: notes.map((n) => n.index),
      inPathElements: ins.map((x) => (x.note ? x.path : Array(TREE_DEPTH).fill(0n)).map(s)),
      outAmount: outs.map((o) => s(o.amount)), outBlinding: outs.map((o) => s(o.blinding)), outPubkey: [s(keys.pubV2), s(keys.pubV2)],
      mintAddress: s(mintField(t)),
    },
    signals: [root, pub, extHash, nullifiers[0], nullifiers[1], outCommitments[0], outCommitments[1]],
  };
}
