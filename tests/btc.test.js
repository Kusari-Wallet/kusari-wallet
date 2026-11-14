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
  assert.throws(() => selectCoins([utxo(1000n)], 5000n, 10n), /enough/);
  assert.throws(() => selectCoins([], 5000n, 10n), /No |Nothing/);
  assert.throws(() => selectCoins([utxo(100000n)], 100n, 1n), /minimum/);
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
  await assert.rejects(client.draft('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', 1000n), /abnormal/);
});

test('signing refuses an input or change that is not mine', () => {
  const c = new BtcClient(xpub, []);
  const good = { to: c.addressAt(0, 5), amount: 1000n, fee: 200n, change: 800n, changeAddress: c.addressAt(1, 0), changePath: [1, 0], inputs: [{ txid: 'ab'.repeat(32), vout: 0, value: 2000n, address: c.addressAt(0, 0), chain: 0, index: 0, confirmed: true }] };
  assert.ok(signBtcDraft(good, MNEMONIC).hex);
  assert.throws(() => signBtcDraft({ ...good, inputs: [{ ...good.inputs[0], address: c.addressAt(0, 9) }] }, MNEMONIC), /input address/);
  assert.throws(() => signBtcDraft({ ...good, changeAddress: c.addressAt(0, 9) }, MNEMONIC), /change address/);
  assert.throws(() => signBtcDraft({ ...good, fee: 100n }, MNEMONIC), /do not add up/);
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
  await assert.rejects(client.refresh(true), /limiting requests/);
  const after = a.hits.length + b.hits.length;
  await assert.rejects(client.refresh(true), /limiting requests/);
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

test('a server that is down is skipped for the rest of the scan, and each failure asks for a new route', async (t) => {
  const a = await counting(() => null);
  const b = await counting(() => null);
  t.after(() => { for (const m of [a, b]) { m.server.close(); m.server.closeAllConnections(); } });
  let renewed = 0;
  const client = new BtcClient(xpub, [a.url, b.url], undefined, 30_000, undefined, () => { renewed++; });
  client.spacingMs = 0;
  a.fail.status = 403; // a blocked route
  await client.refresh(true);
  assert.equal(a.hits.length, 1, 'not asked again during this scan');
  assert.ok(b.hits.length > 10);
  assert.equal(renewed, 1);
  // A "not found" is an answer: that server stays in use.
  a.fail.status = 0;
  const c = new BtcClient(xpub, [a.url, b.url]);
  c.spacingMs = 0;
  b.hits.length = 0; a.hits.length = 0;
  a.fail.status = 404;
  await c.refresh(true);
  assert.ok(a.hits.length > 10, 'still asked first on every address');
});

test('a scan that broke off resumes where it stopped', async (t) => {
  const c = new BtcClient(xpub, []);
  const used = c.addressAt(0, 0);
  let left = 6;
  const m = await counting((a) => (a === used ? { chain_stats: { tx_count: 1, funded_txo_sum: 9000, spent_txo_sum: 0 }, mempool_stats: {} } : null));
  t.after(() => { m.server.close(); m.server.closeAllConnections(); });
  const fail = { on: true };
  const flaky = http.createServer((q, r) => {
    if (fail.on && left-- <= 0) { r.statusCode = 503; return r.end('{}'); }
    http.get(m.url + q.url, (x) => { r.statusCode = x.statusCode; x.pipe(r); });
  });
  await new Promise((res) => flaky.listen(0, '127.0.0.1', res));
  t.after(() => { flaky.close(); flaky.closeAllConnections(); });
  const client = new BtcClient(xpub, [`http://127.0.0.1:${flaky.address().port}`]);
  client.spacingMs = 0;
  let hints = null;
  client.onHints = (h) => { hints = JSON.parse(JSON.stringify(h)); };
  await assert.rejects(client.refresh(true));
  const before = m.hits.length;
  assert.equal(before, 6);
  fail.on = false;
  await client.refresh(true);
  const resumed = m.hits.length - before;
  const clean = new BtcClient(xpub, [m.url]);
  clean.spacingMs = 0;
  const start = m.hits.length;
  await clean.refresh(true);
  assert.equal(resumed, m.hits.length - start - 6, 'the addresses already looked up are not asked again');
  assert.equal(hints.balance, undefined, 'no balance in this plain file: the encrypted cache keeps it');
});

test('over several routes: addresses are spread, an address and its coins share one, and the spread changes per scan', async (t) => {
  const c = new BtcClient(xpub, []);
  const used = c.addressAt(0, 0);
  const m = await counting((a) => (a === used ? { chain_stats: { tx_count: 1, funded_txo_sum: 5000, spent_txo_sum: 0 }, mempool_stats: {} } : null));
  t.after(() => { m.server.close(); m.server.closeAllConnections(); });
  const seen = [];
  const route = (n) => { const agent = new http.Agent(); const orig = agent.addRequest.bind(agent); agent.addRequest = (req, o) => { seen.push([n, req.path]); return orig(req, o); }; return { agent, renew: () => {} }; };
  const client = new BtcClient(xpub, [m.url]);
  client.spacingMs = 0;
  client.lookupRoutes = [route(0), route(1), route(2), route(3)];
  await client.refresh(true);
  const byAddress = new Map();
  for (const [n, p] of seen) {
    const a = /\/address\/([^/]+)/.exec(p)[1];
    if (byAddress.has(a)) assert.equal(byAddress.get(a), n, 'an address and its coins on one route');
    byAddress.set(a, n);
  }
  assert.ok(new Set(byAddress.values()).size >= 3, 'spread over the routes');
  const first = new Map(byAddress);
  seen.length = 0; byAddress.clear();
  await client.refresh(true);
  for (const [n, p] of seen) byAddress.set(/\/address\/([^/]+)/.exec(p)[1], n);
  assert.ok([...first].some(([a, n]) => byAddress.get(a) !== n), 'a different spread next time');
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

/** A stand-in Blockbook with the same coins as the Esplora stand-in above. */
function blockbook() {
  const c = new BtcClient(xpub, []);
  const addr0 = c.addressAt(0, 0);
  const state = { sent: [], asked: [] };
  const server = http.createServer((q, r) => {
    state.asked.push(q.url);
    const send = (o, code = 200) => { r.statusCode = code; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
    const u = new URL(q.url, 'http://x');
    let m = /^\/api\/v2\/address\/([^/]+)$/.exec(u.pathname);
    if (m) {
      if (m[1] !== addr0) return send({ address: m[1], balance: '0', totalReceived: '0', totalSent: '0', unconfirmedBalance: '0', unconfirmedTxs: 0, txs: 0, transactions: [] });
      if (u.searchParams.get('details') === 'txs') return send({ address: addr0, transactions: [{ txid: 'ab'.repeat(32), confirmations: 3, blockTime: 1700000000, vin: [{ addresses: ['bc1qother'], value: '600000' }], vout: [{ addresses: [addr0], value: '500000' }] }] });
      return send({ address: addr0, balance: '500000', totalReceived: '500000', totalSent: '0', unconfirmedBalance: '40000', unconfirmedTxs: 1, txs: 2 });
    }
    m = /^\/api\/v2\/utxo\/([^/]+)$/.exec(u.pathname);
    if (m) return send(m[1] === addr0 ? [{ txid: 'ab'.repeat(32), vout: 1, value: '500000', confirmations: 3 }, { txid: 'cd'.repeat(32), vout: 0, value: '40000', confirmations: 0 }] : []);
    if (u.pathname === '/api/v2/estimatefee/3') return send({ result: '0.00007' });
    m = /^\/api\/v2\/sendtx\/([0-9a-f]+)$/.exec(u.pathname);
    if (m) { state.sent.push(m[1]); return send({ result: btc.Transaction.fromRaw(Buffer.from(m[1], 'hex')).id }); }
    send({ error: 'nope' }, 404);
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, state, base: `blockbook+http://127.0.0.1:${server.address().port}` })));
}

test('a Blockbook server stands in when the Esplora one is down: balance, fee, send and history', async (t) => {
  const { server, state, base } = await blockbook();
  t.after(() => { server.close(); server.closeAllConnections(); });
  const client = new BtcClient(xpub, ['http://127.0.0.1:1', base]);
  const bal = await client.getBalance(8000);
  assert.deepEqual(bal, { total: 540000n, spendable: 500000n });
  const draft = await client.draft('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', 100000n);
  assert.equal(draft.fee, estimateVbytes(1, 2) * 7n, '0.00007 per kB is 7 sat/vB');
  const id = await client.send(draft, MNEMONIC);
  assert.equal(btc.Transaction.fromRaw(Buffer.from(state.sent[0], 'hex')).id, id);
  const hist = await client.getHistory();
  assert.deepEqual(hist.map((h) => [h.direction, h.amount, h.status]), [['in', '0.005', 'confirmed']]);
});

test('your own server: https, .onion or your own network only; local ones are reached directly', () => {
  const { checkOwnServer, isLocalServer } = require('../dist/main/service');
  assert.equal(checkOwnServer(' https://mempool.example/api/ '), 'https://mempool.example/api');
  assert.equal(checkOwnServer('http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion/api'), 'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion/api');
  assert.equal(checkOwnServer('http://umbrel.local:3006/api'), 'http://umbrel.local:3006/api');
  assert.equal(checkOwnServer('http://192.168.1.20:3006/api'), 'http://192.168.1.20:3006/api');
  assert.equal(checkOwnServer(''), '');
  assert.throws(() => checkOwnServer('http://mempool.example/api'), /https/);
  assert.throws(() => checkOwnServer('ftp://x.example'), /full address/);
  assert.throws(() => checkOwnServer('https://user:pw@x.example/api'), /login/);
  assert.ok(isLocalServer('http://10.0.0.2:3000') && isLocalServer('http://[::1]:3000') && isLocalServer('http://172.20.1.1'));
  assert.ok(!isLocalServer('https://mempool.space/api') && !isLocalServer('http://172.40.1.1'));
});

test('coin control: chosen coins are all spent, frozen ones are left out, waiting or gone ones refused', async (t) => {
  const c0 = new BtcClient(xpub, []);
  const addr0 = c0.addressAt(0, 0);
  const A = 'ab'.repeat(32), B = 'cd'.repeat(32), W = 'ef'.repeat(32);
  const server = http.createServer((q, r) => {
    const send = (o) => r.end(typeof o === 'string' ? o : JSON.stringify(o));
    if (q.url === '/v1/fees/recommended') return send({ halfHourFee: 5 });
    if (q.url === `/address/${addr0}`) return send({ chain_stats: { tx_count: 2, funded_txo_sum: 800000, spent_txo_sum: 0 }, mempool_stats: { tx_count: 1, funded_txo_sum: 10000, spent_txo_sum: 0 } });
    if (q.url === `/address/${addr0}/utxo`) return send([{ txid: A, vout: 0, value: 500000, status: { confirmed: true } }, { txid: B, vout: 3, value: 300000, status: { confirmed: true } }, { txid: W, vout: 0, value: 10000, status: { confirmed: false } }]);
    if (q.url.endsWith('/utxo') || q.url.endsWith('/txs')) return send([]);
    if (q.url.startsWith('/address/')) return send({ chain_stats: {}, mempool_stats: {} });
    r.statusCode = 404; send('nope');
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const client = new BtcClient(xpub, [`http://127.0.0.1:${server.address().port}`]);
  const to = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g';
  assert.equal((await client.coins()).length, 3);
  const auto = await client.draft(to, 100000n);
  assert.deepEqual(auto.inputs.map((u) => u.txid), [B], 'left alone, the smallest coin that covers it pays, on its own');
  const frozen = await client.draft(to, 100000n, { frozen: new Set([`${A}:0`]) });
  assert.deepEqual(frozen.inputs.map((u) => u.txid), [B], 'a frozen coin is not picked');
  const both = await client.draft(to, 100000n, { use: [`${A}:0`, `${B}:3`] });
  assert.deepEqual(both.inputs.map((u) => u.txid).sort(), [A, B].sort(), 'every chosen coin goes in');
  assert.equal(both.change, 800000n - 100000n - both.fee);
  assert.equal(both.fee, estimateVbytes(2, 2) * 5n);
  const max = await client.draft(to, 'max', { use: [`${B}:3`], frozen: new Set([`${B}:3`]) });
  assert.equal(max.amount + max.fee, 300000n, 'max with chosen coins is all of them; choosing a frozen coin spends it');
  await assert.rejects(client.draft(to, 400000n, { use: [`${B}:3`] }), /don't cover/);
  await assert.rejects(client.draft(to, 1000n, { use: [`${W}:0`] }), /waiting/);
  await assert.rejects(client.draft(to, 1000n, { use: [`${'00'.repeat(32)}:0`] }), /no longer/);
  await assert.rejects(client.draft(to, 'max', { frozen: new Set([`${A}:0`, `${B}:3`]) }), /No BTC available/);
});

test('coin labels and freezing are kept per wallet and checked', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { WalletService } = require('../dist/main/service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-coins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new WalletService(dir, { N: 2 ** 10, r: 8, p: 1 });
  s.session = () => ({});
  s.dir = dir;
  const id = `${'ab'.repeat(32)}:1`;
  await s.btcCoinSet(id, { label: '  from the exchange\n ', frozen: true });
  let notes = JSON.parse(fs.readFileSync(path.join(dir, 'btc-coins.json'), 'utf8'));
  assert.deepEqual(notes, { labels: { [id]: 'from the exchange' }, frozen: [id] });
  await s.btcCoinSet(id, { frozen: true });
  await s.btcCoinSet(id, { label: '', frozen: false });
  notes = JSON.parse(fs.readFileSync(path.join(dir, 'btc-coins.json'), 'utf8'));
  assert.deepEqual(notes, { labels: {}, frozen: [] });
  await assert.rejects(s.btcCoinSet('../x', { label: 'a' }), /Not a coin/);
});

test('speeding up: a send replaced with a higher fee from its change (RBF), a payment pulled along (CPFP)', async () => {
  const c = new BtcClient(xpub, []);
  const answers = { '/v1/fees/recommended': { halfHourFee: 20 } };
  c.get = async (p) => { if (p in answers) return answers[p]; throw new Error(`unexpected ${p}`); };
  const input = { txid: 'ab'.repeat(32), vout: 0, value: 100000n, address: c.addressAt(0, 0), chain: 0, index: 0, confirmed: true };
  const first = { to: c.addressAt(0, 7), amount: 50000n, fee: 1000n, change: 49000n, changeAddress: c.addressAt(1, 0), changePath: [1, 0], inputs: [input] };
  const signed = signBtcDraft(first, MNEMONIC);
  const tx = btc.Transaction.fromRaw(Buffer.from(signed.hex, 'hex'));
  assert.strictEqual(tx.getInput(0).sequence, 0xfffffffd, 'every send says it may be replaced');
  // A send made here is remembered, kept as plain data, and found again.
  c.rememberSent(signed.id, first, signed.hex);
  const again = new BtcClient(xpub, []); again.get = c.get; again.loadSent(JSON.parse(JSON.stringify(c.sentList())));
  assert.ok(again.canReplace(signed.id));
  answers[`/tx/${signed.id}/status`] = { confirmed: false };
  const bump = await again.bumpDraft(signed.id);
  const vsize = BigInt(tx.vsize);
  assert.strictEqual(bump.fee, 20n * vsize, 'today\'s rate for the same size');
  assert.strictEqual(bump.change, 49000n - (bump.fee - 1000n), 'paid from the change');
  assert.deepStrictEqual([bump.to, bump.amount, bump.replaces], [first.to, first.amount, signed.id], 'same payment');
  assert.ok(signBtcDraft(bump, MNEMONIC).hex, 'signs');
  answers['/v1/fees/recommended'] = { halfHourFee: 2 };
  assert.strictEqual((await again.bumpDraft(signed.id)).fee, 1250n, 'at least a quarter more than before, whatever the rate');
  answers[`/tx/${signed.id}/status`] = { confirmed: true };
  await assert.rejects(again.bumpDraft(signed.id), /already confirmed/);
  await assert.rejects(new BtcClient(xpub, []).bumpDraft(signed.id), /made from this wallet/);

  // CPFP: two waiting coins from one payment, its fee and weight from the server.
  answers['/v1/fees/recommended'] = { halfHourFee: 30 };
  const pay = 'cd'.repeat(32);
  c.refresh = async () => {};
  c.state = { at: Date.now(), utxos: [{ txid: pay, vout: 0, value: 40000n, address: c.addressAt(0, 2), chain: 0, index: 2, confirmed: false }, { txid: pay, vout: 1, value: 5000n, address: c.addressAt(0, 3), chain: 0, index: 3, confirmed: false }, input], total: 0n, spendable: 0n, nextReceive: 4, nextChange: 1, addresses: new Map(), used: new Set() };
  answers[`/tx/${pay}`] = { fee: 200, weight: 800, status: { confirmed: false } };
  const child = await c.cpfpDraft(pay);
  const childVsize = estimateVbytes(2, 1);
  assert.strictEqual(child.fee, 30n * (200n + childVsize) - 200n, 'enough for both at today\'s rate');
  assert.deepStrictEqual([child.inputs.length, child.to, child.change, child.cpfpOf], [2, c.addressAt(1, 1), 0n, pay], 'to a fresh change address of this wallet');
  assert.strictEqual(child.amount, 45000n - child.fee);
  assert.ok(signBtcDraft(child, MNEMONIC).hex);
  await assert.rejects(c.cpfpDraft('ef'.repeat(32)), /no waiting coins/);
});

test('coin selection: one coin when one is enough (the smallest), several only when needed', () => {
  const coins = [utxo(500000n, 0), utxo(120000n, 1), utxo(90000n, 2), utxo(40000n, 3)];
  assert.deepEqual(selectCoins(coins, 100000n, 2n).inputs.map((u) => u.value), [120000n], 'the smallest single coin that covers it');
  assert.deepEqual(selectCoins(coins, 30000n, 2n).inputs.map((u) => u.value), [40000n]);
  assert.deepEqual(selectCoins(coins, 600000n, 2n).inputs.map((u) => u.value), [500000n, 120000n], 'largest first once no single coin is enough');
  const s = selectCoins(coins, 100000n, 2n);
  assert.strictEqual(s.inputs[0].value - s.amount - s.fee, s.change);
});

test('delayed send: signed now, kept, its coins reserved, sent at its time, and picked up again after a lock', async (t) => {
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const { WalletService } = require('../dist/main/service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new WalletService(dir, undefined, { tronHost: 'http://x' });
  const sent = [];
  const fake = { reserved: new Set(), sign: () => ({ hex: 'aa', id: 'f'.repeat(64) }), sendSigned: async (d, hex, id) => { sent.push(id); return id; } };
  Object.assign(s, { tron: {}, monero: {}, btc: fake, eth: {}, dash: {}, firo: {} });
  const input = { txid: 'ab'.repeat(32), vout: 1, value: 5000n, address: 'a', chain: 0, index: 0, confirmed: true };
  const preview = { id: 'p', asset: 'BTC', to: 'bc1qx', amount: 4000n, fee: 1000n, expires: Date.now() + 60_000, btc: { to: 'bc1qx', amount: 4000n, fee: 1000n, change: 0n, changeAddress: 'c', changePath: [1, 0], inputs: [input] } };
  await assert.rejects(s.scheduleSend(preview, 'words', 7), /Choose when/);
  const res = await s.scheduleSend(preview, 'words', 10);
  assert.ok(res.scheduledAt > Date.now() && res.scheduledAt <= Date.now() + 10 * 60_000);
  assert.ok(fake.reserved.has(`${input.txid}:1`), 'its coin is kept out of other sends');
  assert.deepEqual((await s.delayedSends()).map((d) => [d.amount, d.to]), [['0.00004', 'bc1qx']]);
  assert.equal(sent.length, 0, 'nothing out yet');
  // Locked: the timer stops, the signed send stays. Unlocked later, past its time: it goes out.
  s.onLock();
  const list = await s.delayedList();
  list[0].at = Date.now() - 1000;
  await s.records.write(s.delayedPath, list);
  fake.reserved.clear();
  await s.fireDelayed(list[0].id, fake, preview.btc, 'aa');
  assert.deepEqual(sent, ['f'.repeat(64)]);
  assert.deepEqual(await s.delayedSends(), [], 'done and forgotten');
});
