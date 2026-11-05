const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const btc = require('@scure/btc-signer');
const { HDKey } = require('@scure/bip32');
const { mnemonicToSeedSync } = require('@scure/bip39');
const { BtcClient, btcAccountXpub, isBtcAddress, selectCoins, signBtcDraft, estimateVbytes } = require('../dist/main/btc');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const xpub = btcAccountXpub(MNEMONIC);
BtcClient.defaultSpacingMs = 0;
const utxo = (value, i = 0) => ({ txid: String(i + 1).padStart(64, '0'), vout: 0, value, address: 'x', chain: 0, index: i, confirmed: true });

test('addresses match the published BIP86 test vectors; there is no native segwit left', () => {
  const c = new BtcClient(xpub, []);
  assert.equal(xpub, 'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ');
  assert.equal(c.addressAt(0, 0), 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
  assert.equal(c.addressAt(0, 1), 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh');
  assert.equal(c.addressAt(1, 0), 'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7');
  assert.equal(c.legacyAddressAt, undefined);
  assert.equal(require('../dist/main/btc').btcLegacyXpub, undefined);
});

test('address validation', () => {
  assert.ok(isBtcAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));
  assert.ok(isBtcAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'));
  assert.ok(isBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'));
  assert.ok(isBtcAddress('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'));
  for (const bad of ['bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '0x0000000000000000000000000000000000000000', '']) {
    assert.ok(!isBtcAddress(bad), bad);
  }
});

test('coin selection: fee, change, dust, max, shortage', () => {
  const a = selectCoins([utxo(100000n)], 50000n, 10n);
  assert.equal(a.fee, estimateVbytes(1, 2) * 10n);
  assert.equal(a.change, 100000n - 50000n - a.fee);
  const b = selectCoins([utxo(50000n + estimateVbytes(1, 1) * 10n + 100n)], 50000n, 10n);
  assert.equal(b.change, 0n, 'dust goes to the fee');
  assert.equal(b.fee, estimateVbytes(1, 1) * 10n + 100n);
  const c = selectCoins([utxo(100000n, 0), utxo(200000n, 1)], 'max', 10n);
  assert.equal(c.inputs.length, 2);
  assert.equal(c.amount + c.fee, 300000n);
  assert.equal(c.change, 0n);
  assert.throws(() => selectCoins([utxo(1000n)], 5000n, 10n), /부족/);
  assert.throws(() => selectCoins([], 5000n, 10n), /없어/);
  assert.throws(() => selectCoins([utxo(100000n)], 100n, 1n), /최소/);
});

function esplora() {
  const c = new BtcClient(xpub, []);
  const addr0 = c.addressAt(0, 0);
  const state = { posted: [], fee: 7 };
  const server = http.createServer((q, r) => {
    let body = '';
    q.on('data', (d) => { body += d; });
    q.on('end', () => {
      const send = (o) => r.end(typeof o === 'string' ? o : JSON.stringify(o));
      if (q.method === 'POST' && q.url === '/tx') { state.posted.push(body); return send(btc.Transaction.fromRaw(Buffer.from(body, 'hex')).id); }
      if (q.url === '/v1/fees/recommended') return send({ halfHourFee: state.fee });
      if (q.url === `/address/${addr0}`) return send({ chain_stats: { tx_count: 1, funded_txo_sum: 500000, spent_txo_sum: 0 }, mempool_stats: { tx_count: 1, funded_txo_sum: 40000, spent_txo_sum: 0 } });
      if (q.url === `/address/${addr0}/utxo`) return send([{ txid: 'ab'.repeat(32), vout: 1, value: 500000, status: { confirmed: true } }, { txid: 'cd'.repeat(32), vout: 0, value: 40000, status: { confirmed: false } }]);
      if (q.url === `/address/${addr0}/txs`) return send([{ txid: 'ab'.repeat(32), status: { confirmed: true, block_time: 1700000000 }, vin: [{ prevout: { scriptpubkey_address: 'bc1qother', value: 600000 } }], vout: [{ scriptpubkey_address: addr0, value: 500000 }] }]);
      if (q.url.endsWith('/utxo') || q.url.endsWith('/txs')) return send([]);
      if (q.url.startsWith('/address/')) return send({ chain_stats: {}, mempool_stats: {} });
      r.statusCode = 404; send('nope');
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, state, client: new BtcClient(xpub, [`http://127.0.0.1:${server.address().port}`]) })));
}

test('balance, unconfirmed coins are not spent, signed transaction is what was approved', async (t) => {
  const { server, state, client } = await esplora();
  t.after(() => { server.close(); server.closeAllConnections(); });
  const bal = await client.getBalance(5000);
  assert.equal(bal.total, 540000n);
  assert.equal(bal.spendable, 500000n);
  assert.equal(client.receiveAddress, client.addressAt(0, 1), 'next unused address');
  const to = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';
  const draft = await client.draft(to, 100000n);
  assert.equal(draft.inputs.length, 1);
  assert.equal(draft.inputs[0].confirmed, true);
  assert.equal(draft.fee, estimateVbytes(1, 2) * 7n);
  const id = await client.send(draft, MNEMONIC);
  const tx = btc.Transaction.fromRaw(Buffer.from(state.posted[0], 'hex'));
  assert.equal(tx.id, id);
  assert.equal(tx.outputsLength, 2);
  assert.equal(tx.getOutput(0).amount, 100000n);
  assert.equal(btc.Address().encode(btc.OutScript.decode(tx.getOutput(0).script)), to);
  assert.equal(btc.Address().encode(btc.OutScript.decode(tx.getOutput(1).script)), client.addressAt(1, 0));
  assert.equal(tx.getOutput(1).amount, 500000n - 100000n - draft.fee);
  const hist = await client.getHistory();
  assert.deepEqual(hist.map((h) => [h.direction, h.amount, h.status]), [['in', '0.005', 'confirmed']]);
});

test('an absurd fee rate from the server is refused', async (t) => {
  const { server, state, client } = await esplora();
  t.after(() => { server.close(); server.closeAllConnections(); });
  state.fee = 5000;
  await assert.rejects(client.draft('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', 1000n), /비정상/);
});

test('signing refuses an input or change that is not mine', () => {
  const c = new BtcClient(xpub, []);
  const good = { to: c.addressAt(0, 5), amount: 1000n, fee: 200n, change: 800n, changeAddress: c.addressAt(1, 0), changePath: [1, 0], inputs: [{ txid: 'ab'.repeat(32), vout: 0, value: 2000n, address: c.addressAt(0, 0), chain: 0, index: 0, confirmed: true }] };
  assert.ok(signBtcDraft(good, MNEMONIC).hex);
  assert.throws(() => signBtcDraft({ ...good, inputs: [{ ...good.inputs[0], address: c.addressAt(0, 9) }] }, MNEMONIC), /입력 주소/);
  assert.throws(() => signBtcDraft({ ...good, changeAddress: c.addressAt(0, 9) }, MNEMONIC), /잔돈 주소/);
  assert.throws(() => signBtcDraft({ ...good, fee: 100n }, MNEMONIC), /금액 계산/);
});

test('fee size is taproot size', () => {
  assert.equal(estimateVbytes(1, 2), 154n);
});

function counting(addressInfo) {
  const hits = [];
  const fail = { status: 0 };
  const server = http.createServer((q, r) => {
    hits.push(q.url);
    if (fail.status) { r.statusCode = fail.status; return r.end('{}'); }
    if (q.url.endsWith('/utxo')) return r.end('[]');
    if (q.url.endsWith('/txs')) return r.end('[]');
    const a = q.url.split('/')[2];
    r.end(JSON.stringify(addressInfo(a) ?? { chain_stats: {}, mempool_stats: {} }));
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, hits, fail, url: `http://127.0.0.1:${server.address().port}` })));
}

test('requests stay low: a first scan is bounded and rechecks only touch what is used', async (t) => {
  const c = new BtcClient(xpub, []);
  const used = c.addressAt(0, 2);
  const m = await counting((a) => (a === used ? { chain_stats: { tx_count: 1, funded_txo_sum: 1000, spent_txo_sum: 1000 }, mempool_stats: {} } : null));
  t.after(() => { m.server.close(); m.server.closeAllConnections(); });
  const client = new BtcClient(xpub, [m.url]);
  client.spacingMs = 0;
  await client.refresh(true);
  assert.ok(m.hits.length <= 30, `first scan used ${m.hits.length} requests`);
  m.hits.length = 0;
  await client.refresh(true);
  assert.ok(m.hits.length <= 8, `recheck used ${m.hits.length} requests`);
  assert.ok(m.hits.includes(`/address/${used}`), 'used address is still checked');
  assert.equal(client.receiveAddress, client.addressAt(0, 3));
});

test('a recheck notices a deposit on the next address', async (t) => {
  const c = new BtcClient(xpub, []);
  let funded = false;
  const next = c.addressAt(0, 0);
  const m = await counting((a) => (funded && a === next ? { chain_stats: { tx_count: 1, funded_txo_sum: 5000, spent_txo_sum: 0 }, mempool_stats: {} } : null));
  t.after(() => { m.server.close(); m.server.closeAllConnections(); });
  const client = new BtcClient(xpub, [m.url]);
  client.spacingMs = 0;
  await client.refresh(true);
  funded = true;
  await client.refresh(true);
  assert.equal((await client.getBalance(100)).total, 5000n);
});

test('rate limit: switches server, then waits; a known balance survives it', async (t) => {
  const a = await counting(() => null);
  const b = await counting(() => null);
  t.after(() => { for (const m of [a, b]) { m.server.close(); m.server.closeAllConnections(); } });
  const client = new BtcClient(xpub, [a.url, b.url]);
  client.spacingMs = 0;
  a.fail.status = 429;
  await client.refresh(true);
  assert.equal(a.hits.length, 1, 'the limited server is left alone after one answer');
  assert.ok(b.hits.length > 10);
  b.fail.status = 429;
  await assert.rejects(client.refresh(true), /제한 중/);
  const after = a.hits.length + b.hits.length;
  await assert.rejects(client.refresh(true), /제한 중/);
  assert.equal(a.hits.length + b.hits.length, after, 'no requests at all while both are cooling down');
  assert.deepEqual(await client.getBalance(100), { total: 0n, spendable: 0n }, 'last known balance stays');
});

test('a new launch with saved hints skips the first full scan, and still finds coins', async (t) => {
  const c = new BtcClient(xpub, []);
  const used = c.addressAt(0, 1);
  const m = await counting((a) => (a === used ? { chain_stats: { tx_count: 1, funded_txo_sum: 7000, spent_txo_sum: 0 }, mempool_stats: {} } : null));
  t.after(() => { m.server.close(); m.server.closeAllConnections(); });
  const first = new BtcClient(xpub, [m.url]);
  let saved = null;
  first.onHints = (h) => { saved = JSON.parse(JSON.stringify(h)); };
  await first.refresh(true);
  assert.ok(saved.used.includes(used));

  m.hits.length = 0;
  const second = new BtcClient(xpub, [m.url]);
  second.importHints(saved);
  assert.equal((await second.getBalance(3000)).total, 7000n);
  assert.ok(m.hits.length <= 10, `started with ${m.hits.length} requests`);
  assert.equal(second.receiveAddress, second.addressAt(0, 2));

  // Old hints mean a full scan again; junk is ignored
  m.hits.length = 0;
  const third = new BtcClient(xpub, [m.url]);
  third.importHints({ ...saved, lastFullScan: Date.now() - 7 * 60 * 60_000 });
  await third.refresh(true);
  assert.ok(m.hits.length > 20);
  const junk = new BtcClient(xpub, [m.url]);
  junk.importHints({ used: 'x' });
  junk.importHints(null);
});

// Run with PBK_PATH pointing at an unpacked py-bitcoinkernel wheel.
test("Bitcoin Core's consensus code accepts taproot signatures and rejects tampering", { skip: !process.env.PBK_PATH }, () => {
  const c = new BtcClient(xpub, []);
  const hexOf = (p) => Buffer.from(p.script).toString('hex');
  const tap = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/86'/0'/0'");
  const tapScript = (chain, i) => hexOf(btc.p2tr(tap.deriveChild(chain).deriveChild(i).publicKey.slice(1)));
  const inputs = [
    { txid: 'ab'.repeat(32), vout: 1, value: 700000n, address: c.addressAt(0, 0), chain: 0, index: 0, confirmed: true },
    { txid: 'cd'.repeat(32), vout: 0, value: 400000n, address: c.addressAt(1, 3), chain: 1, index: 3, confirmed: true },
  ];
  const { hex, id } = signBtcDraft({ to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', amount: 900000n, fee: 2000n, change: 198000n, changeAddress: c.addressAt(1, 4), changePath: [1, 4], inputs }, MNEMONIC);
  assert.equal(id.length, 64);
  const input = JSON.stringify({ hex, inputs: [{ script: tapScript(0, 0), value: 700000 }, { script: tapScript(1, 3), value: 400000 }] });
  const res = JSON.parse(execFileSync('python3', [path.join(__dirname, 'btc_consensus.py')], { input, env: { ...process.env, PYTHONPATH: process.env.PBK_PATH } }).toString());
  assert.deepEqual(res.valid, [true, true], 'all inputs valid');
  assert.equal(res.wrong_amount, false, 'signature commits to the amount');
  assert.equal(res.wrong_script, false, 'signature is bound to the key');
  assert.equal(res.tampered, false, 'changed output fails');
});
