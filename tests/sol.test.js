const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { base58 } = require('@scure/base');
const { SOL_FEE, SOL_RENT_MINIMUM, SOL_USDT_MINT, SolClient, isSolAddress, signSolTransfer, signSolUsdtTransfer, solAddress, tokenAccountOf } = require('../dist/main/sol');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ME = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'; // what Phantom shows for this phrase
const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const HASH = base58.encode(new Uint8Array(32).fill(7));

test('address: the same as other Solana wallets; bad ones refused', () => {
  assert.equal(solAddress(PHRASE), ME);
  assert.ok(isSolAddress(OTHER));
  assert.equal(isSolAddress('11111111111111111111111111111111'), false, 'the system program');
  assert.equal(isSolAddress('DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'), false, 'Dogecoin is too short');
  assert.equal(isSolAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44e'), false);
});

test('signing: exact bytes of a System Program transfer, and a valid signature', () => {
  const { base64, id } = signSolTransfer(PHRASE, OTHER, 1_500_000_000n, HASH);
  const raw = Buffer.from(base64, 'base64');
  assert.equal(raw[0], 1);
  const signature = raw.subarray(1, 65);
  assert.equal(id, base58.encode(signature));
  const m = raw.subarray(65);
  assert.deepEqual([...m.subarray(0, 4)], [1, 0, 1, 3]);
  assert.equal(base58.encode(m.subarray(4, 36)), ME);
  assert.equal(base58.encode(m.subarray(36, 68)), OTHER);
  assert.ok(m.subarray(68, 100).every((b) => b === 0), 'the system program');
  assert.equal(base58.encode(m.subarray(100, 132)), HASH);
  assert.deepEqual([...m.subarray(132, 138)], [1, 2, 2, 0, 1, 12]);
  assert.equal(m.readUInt32LE(138), 2);
  assert.equal(m.readBigUInt64LE(142), 1_500_000_000n);
  assert.equal(m.length, 150);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(base58.decode(ME))]);
  assert.ok(crypto.verify(null, m, crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature), 'checked by another implementation');
  assert.throws(() => signSolTransfer(PHRASE, 'x', 1n, HASH), /SOL address/);
  assert.throws(() => signSolTransfer(PHRASE, OTHER, 0n, HASH), /more than zero/);
});

function rpc(state) {
  const log = [];
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => { b += d; });
    q.on('end', () => {
      const { method, params } = JSON.parse(b);
      log.push({ method, params });
      r.setHeader('content-type', 'application/json');
      if (state.status) { r.statusCode = state.status; return r.end('{}'); }
      const ok = (result) => r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      if (method === 'getBalance') return ok({ value: params[0] === ME ? state.balance : (state.other ?? 0) });
      if (method === 'getLatestBlockhash') return ok({ value: { blockhash: HASH } });
      if (method === 'sendTransaction') {
        if (state.refuse) return r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'Blockhash not found' } }));
        return ok(state.wrongId ?? base58.encode(Buffer.from(params[0], 'base64').subarray(1, 65)));
      }
      if (method === 'getSignaturesForAddress') return ok([{ signature: 'sigIn', blockTime: 1700000000, confirmationStatus: 'finalized', err: null }, { signature: 'sigOut', blockTime: 1700000100, confirmationStatus: 'confirmed', err: null }, { signature: 'sigBad', err: { x: 1 } }]);
      if (method === 'getTransaction') {
        const inbound = params[0] === 'sigIn';
        return ok({ transaction: { message: { accountKeys: inbound ? [OTHER, ME] : [ME, OTHER] } }, meta: { preBalances: inbound ? [5e9, 0] : [2e9, 0], postBalances: inbound ? [3e9, 2e9] : [1e9, 1e9] } });
      }
      r.statusCode = 404; r.end('{}');
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, log, url: `http://127.0.0.1:${server.address().port}` })));
}

test('balance, history and sending', async (t) => {
  const state = { balance: 2_000_000_000 };
  const m = await rpc(state);
  t.after(() => { m.server.close(); m.server.closeAllConnections(); });
  const c = new SolClient(ME, [m.url]);
  assert.deepEqual(await c.getBalance(), { total: 2_000_000_000n, spendable: 2_000_000_000n });
  const history = await c.getHistory();
  assert.deepEqual(history.map((h) => [h.direction, h.amount, h.status]), [['in', '2', 'confirmed'], ['out', '1', 'confirmed']]);
  const draft = await c.draft(OTHER, 1_000_000_000n);
  assert.deepEqual([draft.amount, draft.fee], [1_000_000_000n, SOL_FEE]);
  const id = await c.send(draft, PHRASE);
  assert.ok(id.length > 60);
  assert.equal((await c.draft(OTHER, 'max')).amount, 2_000_000_000n - SOL_FEE);
});

test('account rules: rent, fee, and refusals reach the person', async (t) => {
  const state = { balance: 2_000_000 };
  const m = await rpc(state);
  t.after(() => { m.server.close(); m.server.closeAllConnections(); });
  const c = new SolClient(ME, [m.url]);
  await assert.rejects(c.draft(OTHER, 2_000_000n), /Not enough/);
  await assert.rejects(c.draft(OTHER, 1_500_000n), /must keep at least/);
  state.balance = 5_000_000;
  await assert.rejects(c.draft(OTHER, 100_000n), /has no SOL yet/);
  state.other = 1;
  assert.equal((await c.draft(OTHER, 100_000n)).amount, 100_000n);
  assert.equal(SOL_RENT_MINIMUM, 890_880n);
  state.refuse = true;
  await assert.rejects(c.send({ to: OTHER, amount: 1000n, fee: SOL_FEE }, PHRASE), /Blockhash/);
  state.refuse = false;
  state.wrongId = 'nope';
  await assert.rejects(c.send({ to: OTHER, amount: 1000n, fee: SOL_FEE }, PHRASE), /different transaction/);
});

test('a blocked server moves on to the next one', async (t) => {
  const blocked = await rpc({ status: 403 });
  const good = await rpc({ balance: 7 });
  t.after(() => { for (const s of [blocked, good]) { s.server.close(); s.server.closeAllConnections(); } });
  assert.equal((await new SolClient(ME, [blocked.url, good.url]).getBalance()).total, 7n);
  await assert.rejects(new SolClient(ME, [blocked.url]).getBalance(), /403/);
});

// Worked out by @solana/spl-token's getAssociatedTokenAddressSync, the library other wallets use.
const MY_USDT = tokenAccountOf(ME);
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RENT = 2_039_280;

test('USDT token accounts: derived like every other Solana wallet', () => {
  assert.equal(tokenAccountOf('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'), '2VqZ17739aFHER515kEjPTq2rrLZ4rR29gLfB8A7jfWN');
  assert.equal(tokenAccountOf('11111111111111111111111111111112'), '8xXwUzGc9de1wJt9A66M96QwoDQt7QovkRxngjSmmvwa');
  assert.equal(tokenAccountOf('Ah9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'), tokenAccountOf('Ah9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'));
});

function tokenRow(owner, amount, pubkey = tokenAccountOf(owner), mint = SOL_USDT_MINT) {
  return { pubkey, account: { owner: TOKEN, data: { parsed: { info: { mint, owner, tokenAmount: { amount: String(amount), decimals: 6 } } } } } };
}

function usdtRpc(state) {
  const log = [];
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => { b += d; });
    q.on('end', () => {
      const { method, params } = JSON.parse(b);
      log.push({ method, params });
      r.setHeader('content-type', 'application/json');
      const ok = (result) => r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      if (method === 'getBalance') return ok({ value: state.sol ?? 10_000_000 });
      if (method === 'getTokenAccountsByOwner') return r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Indexed requests require a personal token.' } }));
      if (method === 'getAccountInfo') {
        if (params[0] === OTHER) return ok({ value: state.otherIsToken ? { owner: TOKEN, data: ['', 'base64'] } : null });
        if (params[0] === tokenAccountOf(OTHER)) return ok({ value: state.receiverHas ? { owner: TOKEN, data: tokenRow(OTHER, 0, undefined, state.receiverMint).account.data } : null });
        const row = (state.rows ?? [tokenRow(ME, state.usdt ?? 5_000_000)]).find((x) => x.pubkey === params[0]);
        return ok({ value: row ? row.account : null });
      }
      if (method === 'getMinimumBalanceForRentExemption') return ok(RENT);
      if (method === 'getLatestBlockhash') return ok({ value: { blockhash: HASH } });
      if (method === 'sendTransaction') return ok(base58.encode(Buffer.from(params[0], 'base64').subarray(1, 65)));
      if (method === 'getSignaturesForAddress') return ok([{ signature: 'a', blockTime: 1700000000, confirmationStatus: 'finalized', err: null }, { signature: 'b', blockTime: 1700000100, confirmationStatus: 'confirmed', err: null }]);
      if (method === 'getTransaction') {
        const bal = (owner, amount) => ({ mint: SOL_USDT_MINT, owner, uiTokenAmount: { amount: String(amount) } });
        if (params[0] === 'a') return ok({ meta: { preTokenBalances: [], postTokenBalances: [bal(ME, 3_000_000), bal(OTHER, 1)] } });
        return ok({ meta: { preTokenBalances: [bal(ME, 3_000_000)], postTokenBalances: [bal(ME, 2_500_000)] } });
      }
      ok(null);
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, log, url: `http://127.0.0.1:${server.address().port}` })));
}
const usdtClient = async (t, state = {}) => {
  const m = await usdtRpc(state);
  t.after(() => { m.server.close(); m.server.closeAllConnections(); });
  return { ...m, c: new SolClient(ME, [m.url]) };
};

test('USDT: balance from the standard token account only', async (t) => {
  const { c } = await usdtClient(t, { rows: [tokenRow(ME, 5_000_000), tokenRow(ME, 9_000_000, OTHER)] });
  assert.equal(await c.getUsdtBalance(), 5_000_000n);
  const none = await usdtClient(t, { rows: [] });
  assert.equal(await none.c.getUsdtBalance(), 0n);
  const odd = await usdtClient(t, { rows: [tokenRow(OTHER, 5, MY_USDT)] });
  await assert.rejects(odd.c.getUsdtBalance(), /unexpected/);
});

test('USDT: a receiver without an account gets one, and the deposit is in the fee', async (t) => {
  const { c, log } = await usdtClient(t);
  const d = await c.draftUsdt(OTHER, 2_000_000n);
  assert.deepEqual(d, { to: OTHER, toAccount: tokenAccountOf(OTHER), create: true, amount: 2_000_000n, fee: SOL_FEE + BigInt(RENT), asset: 'USDTS' });
  const id = await c.sendUsdt(d, PHRASE);
  const raw = Buffer.from(log.find((l) => l.method === 'sendTransaction').params[0], 'base64');
  assert.equal(base58.encode(raw.subarray(1, 65)), id);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(base58.decode(ME))]);
  assert.ok(crypto.verify(null, raw.subarray(65), crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), raw.subarray(1, 65)));
  assert.equal(raw.subarray(65)[0], 1, 'only this wallet signs');
});

test('USDT: an existing account is reused, max sends everything', async (t) => {
  const { c } = await usdtClient(t, { receiverHas: true });
  const d = await c.draftUsdt(OTHER, 'max');
  assert.equal(d.create, false);
  assert.equal(d.fee, SOL_FEE);
  assert.equal(d.amount, 5_000_000n);
  const { base64 } = signSolUsdtTransfer(PHRASE, d, HASH);
  const m = Buffer.from(base64, 'base64').subarray(65);
  assert.equal(m.subarray(-10)[0], 12, 'TransferChecked');
  assert.equal(m.readBigUInt64LE(m.length - 9), 5_000_000n);
  assert.equal(m[m.length - 1], 6, 'decimals');
});

test('USDT: refusals before anything is signed', async (t) => {
  await assert.rejects((await usdtClient(t, { otherIsToken: true })).c.draftUsdt(OTHER, 1n), /token account, not a wallet/);
  await assert.rejects((await usdtClient(t, { receiverHas: true, receiverMint: OTHER })).c.draftUsdt(OTHER, 1n), /looks wrong/);
  await assert.rejects((await usdtClient(t)).c.draftUsdt(OTHER, 6_000_000n), /Not enough USDT/);
  await assert.rejects((await usdtClient(t, { sol: 0 })).c.draftUsdt(OTHER, 1n), /No SOL for the fee/);
  await assert.rejects((await usdtClient(t, { sol: 100_000 })).c.draftUsdt(OTHER, 1n), /needs 0\.00204428 SOL, because/);
  await assert.rejects((await usdtClient(t, { sol: RENT + 5_000 + 1_000 })).c.draftUsdt(OTHER, 1n), /must keep at least/);
  const { c } = await usdtClient(t);
  await assert.rejects(c.draftUsdt(ME, 1n), /own address/);
  await assert.rejects(c.draftUsdt(MY_USDT, 1n), /own address/);
  assert.throws(() => signSolUsdtTransfer(PHRASE, { to: OTHER, toAccount: MY_USDT, create: false, amount: 1n, fee: 0n }, HASH), /does not match/);
});

test('USDT: history from token balance changes', async (t) => {
  const { c, log } = await usdtClient(t);
  const h = await c.getUsdtHistory();
  assert.equal(log.find((l) => l.method === 'getSignaturesForAddress').params[0], MY_USDT);
  assert.deepEqual(h.map((x) => [x.asset, x.direction, x.amount, x.status]), [['USDTS', 'in', '3', 'confirmed'], ['USDTS', 'out', '0.5', 'confirmed']]);
});
