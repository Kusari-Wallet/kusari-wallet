const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');
const { Transaction } = require('@mysten/sui/transactions');
const { verifyTransactionSignature } = require('@mysten/sui/verify');
const { suiAddress, isSuiAddress, signSuiTransfer, SuiClient } = require('../dist/main/sui');

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TO = `0x${'22'.repeat(32)}`;
const coin = (n, balance) => ({ objectId: `0x${String(n).repeat(64).slice(0, 64)}`, version: String(10 + n), digest: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', balance });

test('the address is the one the Sui SDK derives for the seed (m/44\'/784\'/0\'/0\'/0\')', () => {
  const me = suiAddress(M);
  assert.equal(me, Ed25519Keypair.deriveKeypair(M).toSuiAddress());
  assert.equal(me, '0x5e93a736d04fbb25737aa40bee40171ef79f65fae833749e3c089fe7cc2161f1');
  assert.ok(isSuiAddress(TO));
  for (const bad of ['0x22', `0x${'G'.repeat(64)}`, `0x${'AB'.repeat(32)}`, '']) assert.ok(!isSuiAddress(bad), bad);
});

test('a transfer: split from the gas coin to the receiver, signed by this key; "max" sends the gas coin itself', async () => {
  const me = suiAddress(M);
  const d = { to: TO, amount: 123_456_789n, fee: 2_000_000n, budget: 3_000_000n, price: 750n, coins: [coin(1, 10n ** 9n)], all: false };
  const { bytes, signature } = await signSuiTransfer(M, me, d);
  const raw = Buffer.from(bytes, 'base64');
  const signer = await verifyTransactionSignature(raw, signature);
  assert.equal(signer.toSuiAddress(), me);
  const data = Transaction.from(raw).getData();
  assert.equal(data.sender, me);
  assert.equal(String(data.gasData.price), '750'); assert.equal(String(data.gasData.budget), '3000000');
  assert.deepEqual(data.commands.map((c) => c.$kind), ['SplitCoins', 'TransferObjects']);
  const all = Transaction.from(Buffer.from((await signSuiTransfer(M, me, { ...d, all: true })).bytes, 'base64')).getData();
  assert.deepEqual(all.commands.map((c) => c.$kind), ['TransferObjects']);
  assert.equal(all.commands[0].TransferObjects.objects[0].$kind, 'GasCoin');
  await assert.rejects(signSuiTransfer(M, TO, d), /does not match/);
});

test('a send through a stand-in GraphQL service: fee from a dry run, then executed', async (t) => {
  const me = suiAddress(M);
  const asked = [];
  const server = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', () => {
      const { query, variables } = JSON.parse(b); asked.push(query);
      const ok = (data) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ data })); };
      if (/balance\(coinType/.test(query)) return ok({ address: { balance: { totalBalance: '2000000000', coinBalance: '2000000000' } } });
      if (/objects\(first/.test(query)) return ok({ address: { objects: { nodes: [{ address: coin(1).objectId, version: '11', digest: coin(1).digest, contents: { json: { balance: '2000000000' } } }] } } });
      if (/referenceGasPrice/.test(query)) return ok({ epoch: { referenceGasPrice: '750' } });
      if (/simulateTransaction/.test(query)) { assert.ok(variables.t.bcs.value); return ok({ simulateTransaction: { effects: { status: 'SUCCESS', gasEffects: { gasSummary: { computationCost: '750000', storageCost: '1976000', storageRebate: '978120' } } } } }); }
      if (/executeTransaction/.test(query)) return ok({ executeTransaction: { effects: { digest: 'Fz7FvqvHjYgg9bQb3k1ZQd9eJ8nLM5GSrxcLVkqfCvQX', status: 'SUCCESS' } } });
      ok({});
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => server.close());
  const c = new SuiClient(me, [`http://127.0.0.1:${server.address().port}/graphql`]);
  assert.deepEqual(await c.getBalance(), { total: 2_000_000_000n, spendable: 2_000_000_000n });
  const d = await c.draft(TO, 500_000_000n);
  assert.equal(d.fee, 750_000n + 1_976_000n - 978_120n);
  assert.equal(d.budget, ((750_000n + 1_976_000n) * 12n) / 10n + 1_000n);
  const max = await c.draft(TO, 'max');
  assert.equal(max.amount, 2_000_000_000n - max.fee);
  assert.equal(await c.send(d, M), 'Fz7FvqvHjYgg9bQb3k1ZQd9eJ8nLM5GSrxcLVkqfCvQX');
  await assert.rejects(c.draft(me, 1n), /your own address/);
});
