// The Solana private pool: notes, keys and layout pinned, and deposit, scan and withdrawal end to end against a
// stand-in for the program and its relayer (tests/solpool-standin.js), whose verifying key is tied here to the
// program's own (its hash is pinned).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { base58 } = require('@scure/base');
const { ed25519 } = require('@noble/curves/ed25519.js');
const { standIn, verifyingKey } = require('./solpool-standin');
const P = require('../dist/main/sol-privacy');
const { SolPool } = require('../dist/main/sol-pool');
const { runSolPool } = require('../dist/main/solpool-run');
const { plainRecords } = require('../dist/main/records');

const SECRET = new Uint8Array(32).fill(7);
const SOL = P.POOL_TOKENS.SOL;
const rnd = (n) => new Uint8Array(crypto.randomBytes(n));

test('keys, notes and hashes: pinned values', () => {
  const keys = P.poolKeys(SECRET);
  assert.equal(keys.pubV2.toString(), '14968820344346075545381639096131038837498032865261861076423972819830377782804');
  assert.equal(keys.pubV1.toString(), '13779218436958727066502725933661737830987441725511914357657462245225569572526');
  const n = { amount: 123456789n, blinding: 987654321n, index: 42, mint: SOL.mint, version: 2 };
  assert.equal(P.commitmentOf(n, keys, SOL).toString(), '13314471004995430787362486031377728950416540350737764344943040484534841041993');
  assert.equal(P.nullifierOf(n, keys, SOL).toString(), '5828374957077704077008042300409801765530007614641356803258461000771642082883');
  assert.equal(P.mintField(SOL), 11111111111111111111111111111112n);
  assert.equal(P.mintField(P.POOL_TOKENS.USDCS).toString(), '351564470195712479312889784364378094793935933814098925423924767071335165789');
  const e = { recipient: P.POOL_FEE_RECIPIENT, extAmount: -5000000n, enc1: Uint8Array.from([1, 2, 3]), enc2: Uint8Array.from([4, 5]), fee: 12500n, feeRecipient: P.POOL_FEE_RECIPIENT, mint: SOL.mint };
  assert.equal(P.extDataHash(e).toString(), '18947198471909635321873772904246554855660373564473772195972728344370882098787');
  assert.equal(P.zeros()[1], 14744269619966411208579211824598458697587494354926760081771325075741142829156n, 'Poseidon(0, 0), the tree\'s first empty node');
  assert.equal(P.publicAmount(-5000000n, 12500n), P.FIELD - 5012500n);
});

test('notes: encrypted to this wallet only; the first (V1) layout read too', () => {
  const keys = P.poolKeys(SECRET);
  const other = P.poolKeys(new Uint8Array(32).fill(8));
  const n = { amount: 5n * 10n ** 7n, blinding: P.randomBlinding(rnd), index: 9, mint: SOL.mint, version: 2 };
  const enc = P.encryptNote(n, keys, SOL, rnd);
  assert.deepEqual([...enc.slice(0, 8)], [0, 0, 0, 0, 0, 0, 0, 2]);
  const back = P.decryptNote(enc, keys);
  assert.equal(back.amount, n.amount); assert.equal(back.blinding, n.blinding); assert.equal(back.hintIndex, 9); assert.equal(back.version, 2);
  assert.equal(P.decryptNote(enc, other), null);
  const bad = Uint8Array.from(enc); bad[25] ^= 1;
  assert.equal(P.decryptNote(bad, keys), null, 'a changed tag');
  // V1, made here with Node's own AES and HMAC: AES-128-CTR under the key's first 16 bytes, tag HMAC-SHA256 under bytes 16..31.
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-128-ctr', Buffer.from(keys.encV1.slice(0, 16)), iv);
  const data = Buffer.concat([c.update(`7000|12345|3|${SOL.mint}`), c.final()]);
  const tag = crypto.createHmac('sha256', Buffer.from(keys.encV1.slice(16, 31))).update(iv).update(data).digest().subarray(0, 16);
  const v1 = P.decryptNote(Buffer.concat([iv, tag, data]), keys);
  assert.equal(v1.amount, 7000n); assert.equal(v1.blinding, 12345n); assert.equal(v1.version, 1);
  assert.equal(P.decryptNote(Buffer.concat([iv, tag, data]), other), null);
});

test('the shipped proving key belongs to the program\'s verifying key', async () => {
  const bytes = await verifyingKey();
  const all = Buffer.concat([bytes.alpha, bytes.beta, bytes.gamma, bytes.delta, ...bytes.ic]);
  // sha256 of VERIFYING_KEY's bytes in the program (alpha, beta, gamma, delta, IC), read from its source.
  assert.equal(crypto.createHash('sha256').update(all).digest('hex'), '514b4fe8cbfaed2c697e28d44bcbd1cb5f8c678f61beaf21358046f721f89e6c');
});

test('deposit, find, withdraw: end to end against the stand-in program and relayer', { timeout: 240_000 }, async (t) => {
  await verifyingKey();
  const { st, server } = standIn();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solpool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const conns = [];
  const make = () => new SolPool(P.poolKeys(SECRET), base58.encode(ed25519.getPublicKey(SECRET)), {
    rpcs: [`${base}/rpc`], relayer: `${base}/r`, records: plainRecords, file: path.join(dir, 'sol-pool.json'),
    conn: (purpose) => { conns.push(purpose); return {}; }, prove: (input) => runSolPool('prove', { input }), pauseMs: () => 10,
  });
  const pool = make();
  const me = base58.encode(ed25519.getPublicKey(SECRET));

  await pool.enable('SOL');
  assert.equal((await pool.balance('SOL')).scannedTo, 6, 'a new wallet starts at the pool\'s current end');
  const cost = await pool.depositCost('SOL');
  assert.equal(cost.fee, 5_000n + 160_000n + 2n * 953_520n);

  const d1 = await pool.deposit('SOL', 50_000_000n, SECRET);
  assert.equal(st.deposits[0].id, d1);
  assert.equal(st.deposits[0].amount, 50_000_000n);
  assert.deepEqual(await pool.balance('SOL'), { asset: 'SOL', ready: 0n, arriving: 50_000_000n, notes: 1, scannedTo: 6, poolSize: null });
  await pool.deposit('SOL', 30_000_000n, SECRET);
  assert.equal(await make().scan('SOL'), 2, 'both notes found (by a fresh client, from the published outputs)');
  let b = await pool.balance('SOL');
  assert.equal(b.ready, 80_000_000n); assert.equal(b.arriving, 0n); assert.equal(b.scannedTo, 10);

  // Too much for one withdrawal, and the quote.
  const q = await pool.withdrawQuote('SOL', 'max');
  assert.equal(q.amount + q.fee <= 80_000_000n, true);
  assert.equal(q.fee, (q.amount * 2500n) / 1_000_000n + 1_000_000n);
  await assert.rejects(pool.withdrawQuote('SOL', 80_000_000n), /More than one withdrawal/);
  await assert.rejects(pool.withdrawQuote('SOL', 5_000_000n), /less than the pool relayer/);

  // A path the chain doesn't confirm is refused before anything is proven or sent.
  st.lie = 'path';
  await assert.rejects(pool.withdraw('SOL', 60_000_000n, me), /chain does not confirm/);
  st.lie = null;
  assert.equal(st.withdrawals.length, 0);

  const recipient = base58.encode(crypto.randomBytes(32));
  conns.length = 0;
  await pool.withdraw('SOL', 60_000_000n, recipient);
  assert.equal(st.withdrawals.length, 1);
  assert.deepEqual(st.withdrawals[0], { to: recipient, amount: 60_000_000n, fee: 60_000_000n * 25n / 10000n + 1_000_000n });
  assert.ok(conns.includes('path') && conns.includes('submit'), 'path lookup and withdrawal on routes of their own');
  assert.ok(st.lastAsk.length >= 2, 'tree paths asked for among others');
  b = await pool.balance('SOL');
  const change = 80_000_000n - 60_000_000n - st.withdrawals[0].fee;
  assert.equal(b.ready, 0n); assert.equal(b.arriving, change);
  await pool.scan('SOL');
  b = await pool.balance('SOL');
  assert.equal(b.ready, change, 'the change note is found and is spendable');

  // A restored wallet (scanning from the start) sees only what is unspent.
  const fresh = new SolPool(P.poolKeys(SECRET), base58.encode(ed25519.getPublicKey(SECRET)), { rpcs: [`${base}/rpc`], relayer: `${base}/r`, records: plainRecords, file: path.join(dir, 'restored.json'), conn: () => ({}), prove: (input) => runSolPool('prove', { input }), pauseMs: () => 10 });
  await fresh.enable('SOL', true);
  await fresh.scan('SOL');
  assert.equal((await fresh.balance('SOL')).ready, change);

  // The change spent from the restored wallet; the first wallet's copy of it is then refused and marked spent.
  await fresh.withdraw('SOL', 10_000_000n, recipient);
  assert.equal(st.withdrawals.length, 2);
  await assert.rejects(pool.withdraw('SOL', 10_000_000n, recipient), /already in use/);
  assert.equal((await pool.balance('SOL')).ready, 0n);
});

test('a relayer that lists outputs out of order cannot get a note spent at the wrong place', { timeout: 120_000 }, async (t) => {
  await verifyingKey();
  const { st, server } = standIn();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solpool-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const pool = new SolPool(P.poolKeys(SECRET), base58.encode(ed25519.getPublicKey(SECRET)), { rpcs: [`${base}/rpc`], relayer: `${base}/r`, records: plainRecords, file: path.join(dir, 'p.json'), conn: () => ({}), prove: (input) => runSolPool('prove', { input }), pauseMs: () => 10 });
  await pool.enable('SOL');
  await pool.deposit('SOL', 50_000_000n, SECRET);
  st.lie = 'shift';
  await pool.scan('SOL');
  st.lie = null;
  await assert.rejects(pool.withdraw('SOL', 20_000_000n, base58.encode(crypto.randomBytes(32))), /chain does not confirm/);
  assert.equal(st.withdrawals.length, 0);
});

test('token pools: the deposit accounts in the order the program lists them', () => {
  const t = P.POOL_TOKENS.USDCS;
  const me = base58.encode(ed25519.getPublicKey(SECRET));
  const nfs = P.nullifierAccounts(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
  const a = P.poolAccounts(t);
  const ix = P.depositInstruction(t, me, nfs, new Uint8Array(1));
  // TransactSpl: tree, nullifier0..3, global_config, signer, mint, signer_token_account, recipient,
  // recipient_token_account, tree_ata, fee_recipient_ata, token, associated token and system programs.
  assert.deepEqual(ix.accounts.map((m) => m.key), [a.tree, nfs.nf0, nfs.nf1, nfs.nf2, nfs.nf3, a.globalConfig, me, t.mint, P.tokenAccount(me, t.mint), P.POOL_FEE_RECIPIENT, a.feeRecipientAta, a.treeAta, a.feeRecipientAta, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', '11111111111111111111111111111111']);
  assert.deepEqual(ix.accounts.filter((m) => m.signer).map((m) => m.key), [me]);
  assert.equal(P.instructionData(true, new Uint8Array(256), Array(7).fill(0n), { extAmount: 1n, fee: 0n, enc1: new Uint8Array(0), enc2: new Uint8Array(0) }).subarray(0, 8).toString(), [154, 66, 244, 204, 78, 225, 163, 151].toString());
  assert.notEqual(a.tree, P.poolAccounts(SOL).tree, 'a tree of its own per token');
});
