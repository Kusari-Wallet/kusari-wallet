const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { base58 } = require('@scure/base');
const { SOL_FEE, SOL_RENT_MINIMUM, SolClient, isSolAddress, signSolTransfer, solAddress } = require('../dist/main/sol');

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
