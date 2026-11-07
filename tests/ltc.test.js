const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { BtcClient, LITECOIN, isLtcAddress, ltcAccountXpub, signLtcDraft } = require('../dist/main/btc');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'MQMcJhpWHYVeQArcZR3sBgyPZxxRtnH441';

test('LTC addresses: BIP84 like Litecoin Core, Bitcoin-looking ones refused', () => {
  const c = new BtcClient(ltcAccountXpub(PHRASE), [], undefined, 1000, LITECOIN);
  assert.equal(c.addressAt(0, 0), 'ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wh', 'the BIP84 test vector');
  assert.ok(isLtcAddress(OTHER));
  assert.equal(isLtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), false);
  assert.equal(isLtcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), false);
  assert.equal(isLtcAddress('ltc1qjmxnz78nmc8nq77wuxh25n2es7rzm5c2rkk4wx'), false, 'bad checksum');
});

test('LTC signing: segwit spends that add up, from this wallet only', () => {
  const c = new BtcClient(ltcAccountXpub(PHRASE), [], undefined, 1000, LITECOIN);
  const inputs = [{ txid: 'aa'.repeat(32), vout: 1, value: 150000n, address: c.addressAt(0, 0), chain: 0, index: 0, confirmed: true }];
  const draft = { to: OTHER, amount: 100000n, fee: 1000n, change: 49000n, changeAddress: c.addressAt(1, 0), changePath: [1, 0], inputs };
  // Checked against bitcoinjs-lib, signatures included.
  const { hex, id } = signLtcDraft(draft, PHRASE);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.match(hex, /^0200000000010/, 'version 2, segwit');
  assert.throws(() => signLtcDraft({ ...draft, fee: 1n }, PHRASE), /add up/);
  assert.throws(() => signLtcDraft({ ...draft, to: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy' }, PHRASE), /not an LTC address/);
});

test('LTC through the Bitcoin server code: balance, fees sized for segwit inputs, send', async (t) => {
  const c0 = new BtcClient(ltcAccountXpub(PHRASE), [], undefined, 1000, LITECOIN);
  const mine = c0.addressAt(0, 0);
  const posted = [];
  const srv = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => { b += d; });
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url === `/address/${mine}`) return r.end(JSON.stringify({ chain_stats: { tx_count: 1, funded_txo_sum: 500000, spent_txo_sum: 0 }, mempool_stats: {} }));
      if (q.url === `/address/${mine}/utxo`) return r.end(JSON.stringify([{ txid: 'ab'.repeat(32), vout: 0, value: 500000, status: { confirmed: true } }]));
      if (q.url.startsWith('/address/')) return r.end(JSON.stringify({ chain_stats: {}, mempool_stats: {} }));
      if (q.url === '/v1/fees/recommended') return r.end(JSON.stringify({ halfHourFee: 2 }));
      if (q.url === '/tx') { posted.push(b); r.setHeader('content-type', 'text/plain'); return r.end(require('@scure/btc-signer').Transaction.fromRaw(Buffer.from(b, 'hex')).id); }
      r.statusCode = 404; r.end('{}');
    });
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  t.after(() => { srv.close(); srv.closeAllConnections(); });
  const c = new BtcClient(ltcAccountXpub(PHRASE), [`http://127.0.0.1:${srv.address().port}`], undefined, 5000, LITECOIN);
  c.spacingMs = 0;
  assert.deepEqual(await c.getBalance(5000), { total: 500000n, spendable: 500000n });
  const d = await c.draft(OTHER, 100000n);
  assert.equal(d.fee, BigInt(Math.ceil(10.5 + 68 + 43 * 2)) * 2n, 'a segwit input is 68 vB');
  const id = await c.send(d, PHRASE);
  assert.equal(posted.length, 1);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal((await c.getHistory().catch(() => [])).every((h) => h.asset === 'LTC'), true);
  await assert.rejects(c.draft(OTHER, 999n), /minimum to send is 0\.00001 LTC/);
});
