const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const btc = require('@scure/btc-signer');
const { DogeClient, DOGE_NET, dogeAccountXpub, isDogeAddress, signDogeDraft, typicalDogeFee } = require('../dist/main/doge');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const xpub = dogeAccountXpub(PHRASE);
const FIRST = 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC'; // the standard BIP44 result for this phrase
const OTHER = 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L';

test('addresses: standard BIP44 result, other coins refused', () => {
  const c = new DogeClient(xpub, []);
  assert.equal(c.addressAt(0, 0), FIRST);
  assert.ok(isDogeAddress(FIRST));
  assert.equal(isDogeAddress(FIRST.slice(0, -1) + 'x'), false, 'bad checksum');
  assert.equal(isDogeAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), false, 'Bitcoin');
  assert.equal(isDogeAddress('XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5'), false, 'Dash');
  assert.equal(isDogeAddress('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'), false, 'Solana');
});

function blockbook(mine, { answer } = {}) {
  const log = [];
  const posted = [];
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => { b += d; });
    q.on('end', () => {
      log.push(q.url);
      r.setHeader('content-type', 'application/json');
      if (q.url.startsWith('/api/v2/sendtx')) { posted.push(b); return r.end(JSON.stringify(answer ? answer(b) : { result: btc.Transaction.fromRaw(Buffer.from(b, 'hex'), { allowLegacyWitnessUtxo: true }).id })); }
      if (q.url.startsWith(`/api/v2/utxo/${mine}`)) return r.end(JSON.stringify([{ txid: 'ab'.repeat(32), vout: 1, value: '500000000', confirmations: 6 }, { txid: 'cd'.repeat(32), vout: 0, value: '200000000', confirmations: 0 }]));
      if (q.url.startsWith(`/api/v2/address/${mine}?details=txs`)) return r.end(JSON.stringify({ transactions: [{ txid: 'ab'.repeat(32), confirmations: 6, blockTime: 1700000000, vin: [{ addresses: [OTHER], value: '600000000' }], vout: [{ addresses: [mine], value: '500000000' }] }] }));
      if (q.url.startsWith(`/api/v2/address/${mine}?details=basic`)) return r.end(JSON.stringify({ txs: 2 }));
      if (q.url.includes('details=basic')) return r.end(JSON.stringify({ txs: 0 }));
      r.statusCode = 404; r.end('{}');
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, log, posted, url: `http://127.0.0.1:${server.address().port}` })));
}

test('balance, history and sending through Blockbook, one address at a time', async (t) => {
  const mine = new DogeClient(xpub, []).addressAt(0, 1);
  const m = await blockbook(mine);
  t.after(() => { m.server.close(); m.server.closeAllConnections(); });
  const c = new DogeClient(xpub, [m.url]);
  assert.deepEqual(await c.getBalance(), { total: 700000000n, spendable: 500000000n });
  assert.equal(c.receiveAddress, new DogeClient(xpub, []).addressAt(0, 2));
  assert.ok(m.log.every((u) => !/xpub|dgub/.test(u)), 'the account key is never sent');
  const [h] = await c.getHistory();
  assert.deepEqual([h.asset, h.direction, h.amount, h.status], ['DOGE', 'in', '5', 'confirmed']);
  const draft = await c.draft(OTHER, 100000000n);
  assert.equal(draft.fee, typicalDogeFee());
  assert.equal(draft.change, 500000000n - 100000000n - draft.fee);
  const id = await c.send(draft, PHRASE);
  const tx = btc.Transaction.fromRaw(Buffer.from(m.posted[0], 'hex'), { allowLegacyWitnessUtxo: true });
  assert.equal(tx.id, id);
  assert.equal(tx.getOutput(0).amount, 100000000n);
  assert.equal(btc.Address(DOGE_NET).encode(btc.OutScript.decode(tx.getOutput(0).script)), OTHER);
  await assert.rejects(c.draft(OTHER, 900000000n), /enough/);
  await assert.rejects(c.draft(OTHER, 1000n), /minimum/);
});

test('a refused or different broadcast is reported', async (t) => {
  const mine = new DogeClient(xpub, []).addressAt(0, 0);
  const m = await blockbook(mine, { answer: () => ({ error: { message: 'dust' } }) });
  t.after(() => { m.server.close(); m.server.closeAllConnections(); });
  const c = new DogeClient(xpub, [m.url]);
  await assert.rejects(c.send(await c.draft(OTHER, 100000000n), PHRASE), /dust/);
  const n = await blockbook(mine, { answer: () => ({ result: 'ff'.repeat(32) }) });
  t.after(() => { n.server.close(); n.server.closeAllConnections(); });
  const d = new DogeClient(xpub, [n.url]);
  await assert.rejects(d.send(await d.draft(OTHER, 100000000n), PHRASE), /different transaction/);
});

test('signing refuses wrong sums, addresses not mine, a bad recipient', () => {
  const c = new DogeClient(xpub, []);
  const good = { to: OTHER, amount: 100000000n, fee: 500000n, change: 99500000n, changeAddress: c.addressAt(1, 0), changeIndex: 0, inputs: [{ txid: 'ab'.repeat(32), vout: 0, value: 200000000n, address: c.addressAt(0, 0), chain: 0, index: 0 }] };
  assert.ok(signDogeDraft(good, PHRASE).hex);
  assert.throws(() => signDogeDraft({ ...good, fee: 100n }, PHRASE), /do not add up/);
  assert.throws(() => signDogeDraft({ ...good, inputs: [{ ...good.inputs[0], address: c.addressAt(0, 9) }] }, PHRASE), /input address/);
  assert.throws(() => signDogeDraft({ ...good, changeAddress: c.addressAt(0, 9) }, PHRASE), /change address/);
  assert.throws(() => signDogeDraft({ ...good, to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' }, PHRASE), /DOGE address/);
});
