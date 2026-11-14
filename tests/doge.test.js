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

const ID = (c) => c.repeat(32);
const { prevTx } = require('./prev-tx');
// Raw transactions the mock servers can hand out, by ID: a coin is only spent once it checks out against one.
const RAW = new Map();
const scriptOf = (a) => Buffer.from(btc.OutScript.encode(btc.Address(DOGE_NET).decode(a))).toString('hex');
function coinTx(address, vout, value) {
  const outs = Array.from({ length: vout + 1 }, (_, i) => (i === vout ? { value, script: scriptOf(address) } : { value: 1, script: '51' }));
  const t = prevTx(outs);
  RAW.set(t.txid, t.hex);
  return t.txid;
}
const AB = (a) => coinTx(a, 1, 500000000);
const fast = { paceMs: 0, verifyDelayMs: 1 };
const idOf = (hex) => btc.Transaction.fromRaw(Buffer.from(hex, 'hex'), { allowLegacyWitnessUtxo: true }).id;

// Fields as BlockCypher really answered for these addresses.
function funded(mine) {
  return {
    address: mine, balance: 500000000, unconfirmed_balance: 200000000, final_balance: 700000000, n_tx: 3, unconfirmed_n_tx: 1, final_n_tx: 3,
    txrefs: [
      { tx_hash: AB(mine), block_height: 100, tx_input_n: -1, tx_output_n: 1, value: 500000000, ref_balance: 500000000, spent: false, confirmations: 6, confirmed: '2026-10-28T18:40:09Z', double_spend: false },
      { tx_hash: ID('ee'), block_height: 90, tx_input_n: 0, tx_output_n: -1, value: 300000000, ref_balance: 0, confirmations: 20, confirmed: '2026-10-20T18:40:09Z', double_spend: false },
      { tx_hash: ID('ef'), block_height: 80, tx_input_n: -1, tx_output_n: 0, value: 300000000, ref_balance: 300000000, spent: true, spent_by: ID('ee'), confirmations: 30, confirmed: '2026-10-10T18:40:09Z', double_spend: false },
    ],
    unconfirmed_txrefs: [{ address: mine, tx_hash: ID('cd'), tx_input_n: -1, tx_output_n: 0, value: 200000000, spent: false, confirmations: 0, received: '2026-11-01T00:00:00Z', double_spend: false }],
  };
}
const empty = (a) => ({ address: a, balance: 0, unconfirmed_balance: 0, final_balance: 0, n_tx: 0, unconfirmed_n_tx: 0, final_n_tx: 0 });

function server(answers = {}, { push, seen } = {}) {
  const log = [];
  const posted = [];
  const known = new Set();
  const srv = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => { b += d; });
    q.on('end', () => {
      log.push(q.url);
      r.setHeader('content-type', 'application/json');
      if (q.url.startsWith('/chair/push/transaction')) {
        const tx = new URL(q.url, 'http://x').searchParams.get('data');
        posted.push(tx);
        known.add(idOf(tx));
        const a = push ? push(tx) : { status: 200, body: { data: { transaction_hash: idOf(tx) }, context: { code: 200 } } };
        r.statusCode = a.status;
        return r.end(JSON.stringify(a.body));
      }
      if (q.url.startsWith('/txs/push')) {
        const { tx } = JSON.parse(b);
        posted.push(tx);
        known.add(idOf(tx));
        const a = push ? push(tx) : { status: 201, body: { tx: { hash: idOf(tx) } } };
        r.statusCode = a.status;
        return r.end(JSON.stringify(a.body));
      }
      if (q.url.startsWith('/txs/') && q.url.includes('includeHex') && RAW.has(q.url.slice(5, 69))) return r.end(JSON.stringify({ hash: q.url.slice(5, 69), hex: RAW.get(q.url.slice(5, 69)) }));
      if (q.url.startsWith('/txs/')) {
        const id = q.url.slice(5, 69);
        if (seen === false || !known.has(id)) { r.statusCode = 404; return r.end('{}'); }
        return r.end(JSON.stringify({ hash: id }));
      }
      const addr = q.url.match(/^\/addrs\/(\w+)/)?.[1];
      const a = answers[addr];
      if (typeof a === 'function') { const out = a(q.url); r.statusCode = out.status ?? 200; return r.end(JSON.stringify(out.body)); }
      r.end(JSON.stringify(a ?? empty(addr)));
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, log, posted, known, url: `http://127.0.0.1:${srv.address().port}` })));
}
const close = (t, m) => t.after(() => { m.srv.close(); m.srv.closeAllConnections(); });

test('balance, history and sending, one address at a time', async (t) => {
  const mine = new DogeClient(xpub, []).addressAt(0, 1);
  const m = await server({ [mine]: funded(mine) });
  close(t, m);
  const c = new DogeClient(xpub, [m.url], undefined, 5000, fast);
  assert.deepEqual(await c.getBalance(), { total: 700000000n, spendable: 500000000n }, 'spent and unconfirmed coins are told apart');
  assert.equal(c.receiveAddress, new DogeClient(xpub, []).addressAt(0, 2));
  assert.ok(m.log.every((u) => !/xpub|dgub/.test(u)), 'the account key is never sent');
  const history = await c.getHistory();
  assert.deepEqual(history.map((h) => [h.hash, h.direction, h.amount, h.status]), [
    [ID('cd'), 'in', '2', 'pending'], [AB(mine), 'in', '5', 'confirmed'], [ID('ee'), 'out', '3', 'confirmed'], [ID('ef'), 'in', '3', 'confirmed'],
  ]);
  const draft = await c.draft(OTHER, 100000000n);
  assert.equal(draft.fee, typicalDogeFee());
  assert.equal(draft.inputs.length, 1, 'an unconfirmed coin is not spent');
  assert.equal(draft.change, 500000000n - 100000000n - draft.fee);
  const id = await c.send(draft, PHRASE);
  const tx = btc.Transaction.fromRaw(Buffer.from(m.posted[0], 'hex'), { allowLegacyWitnessUtxo: true });
  assert.equal(tx.id, id);
  assert.equal(tx.getOutput(0).amount, 100000000n);
  assert.equal(btc.Address(DOGE_NET).encode(btc.OutScript.decode(tx.getOutput(0).script)), OTHER);
  await assert.rejects(c.draft(OTHER, 900000000n), /enough/);
  await assert.rejects(c.draft(OTHER, 1000n), /minimum/);
});

test('stays inside the free request limit', async (t) => {
  const m = await server();
  close(t, m);
  const c = new DogeClient(xpub, [m.url], undefined, 5000, fast);
  await c.getBalance();
  assert.equal(m.log.length, 7, 'an unused wallet costs 7 requests');
  await c.getBalance();
  await c.getHistory();
  assert.equal(m.log.length, 7, 'reads reuse the scan');
  await c.refresh(true);
  assert.equal(m.log.length, 14);

  const used = new DogeClient(xpub, []).addressAt(0, 2);
  const n = await server({ [used]: funded(used) });
  close(t, n);
  const d = new DogeClient(xpub, [n.url], undefined, 5000, fast);
  await d.getBalance();
  assert.equal(new Set(n.log).size, n.log.length, 'finding a used address does not ask again about the others');
  assert.equal(n.log.length, 10, '3 addresses further');
});

test('requests are spaced out', async (t) => {
  const m = await server();
  close(t, m);
  const at = Date.now();
  await new DogeClient(xpub, [m.url], undefined, 5000, { paceMs: 30, verifyDelayMs: 1 }).getBalance();
  assert.ok(Date.now() - at >= 6 * 30 - 5);
});

test('a retry after a rate limit asks only for what is missing', async (t) => {
  const third = new DogeClient(xpub, []).addressAt(0, 3);
  let limited = true;
  const m = await server({ [third]: () => (limited ? { status: 429, body: { error: 'Limits reached.' } } : { body: empty(third) }) });
  close(t, m);
  const c = new DogeClient(xpub, [m.url], undefined, 5000, fast);
  await assert.rejects(c.getBalance(), /429/);
  assert.equal(m.log.length, 4, 'stops at the first refusal');
  limited = false;
  await c.getBalance();
  assert.equal(m.log.length, 4 + 4, 'the three answered addresses are not asked again');
});

test('a rate limit after a good read keeps the last balance and waits before asking again', async (t) => {
  const mine = new DogeClient(xpub, []).addressAt(0, 1);
  let limited = false;
  const m = await server({ [mine]: () => (limited ? { status: 429, body: { error: 'Limits reached.' } } : { body: funded(mine) }) });
  close(t, m);
  const c = new DogeClient(xpub, [m.url], undefined, 5000, fast);
  assert.deepEqual(await c.getBalance(), { total: 700000000n, spendable: 500000000n });
  limited = true;
  c.state.at -= 11 * 60_000; // the scan has expired
  const asked = m.log.length;
  assert.deepEqual(await c.getBalance(), { total: 700000000n, spendable: 500000000n }, 'the last good read is shown');
  assert.equal((await c.getHistory()).length, 4);
  const afterFailure = m.log.length;
  assert.ok(afterFailure > asked, 'it did try');
  await c.getBalance();
  assert.equal(m.log.length, afterFailure, 'no new requests right after a failure');
  await assert.rejects(c.draft(OTHER, 100000000n), /429/, 'a send never uses an old read');
  c.state.at -= 61 * 60_000;
  c.failedAt = 0;
  await assert.rejects(c.getBalance(), /429/, 'a read over an hour old is not shown');
});

test('an address with long history gets its coins from a second request', async (t) => {
  const mine = new DogeClient(xpub, []).addressAt(0, 0);
  const page = { ...empty(mine), balance: 500000000, final_balance: 500000000, n_tx: 80, final_n_tx: 80, hasMore: true, txrefs: funded(mine).txrefs.slice(1) };
  const all = { ...page, hasMore: false, txrefs: [funded(mine).txrefs[0]] };
  const m = await server({ [mine]: (u) => ({ body: u.includes('unspentOnly=true') ? all : page }) });
  close(t, m);
  const c = new DogeClient(xpub, [m.url], undefined, 5000, fast);
  assert.deepEqual(await c.getBalance(), { total: 500000000n, spendable: 500000000n });
});

test('coins that do not add up to the balance are refused', async (t) => {
  const mine = new DogeClient(xpub, []).addressAt(0, 0);
  const { unconfirmed_txrefs, ...settled } = funded(mine);
  const m = await server({ [mine]: { ...settled, unconfirmed_n_tx: 0, final_balance: 900000000 } });
  close(t, m);
  await assert.rejects(new DogeClient(xpub, [m.url], undefined, 5000, fast).getBalance(), /incomplete/);
  const other = await server({ [mine]: { ...settled, address: OTHER } });
  close(t, other);
  await assert.rejects(new DogeClient(xpub, [other.url], undefined, 5000, fast).getBalance(), /unexpected/);
});

async function wallet(t, opts = {}) {
  const mine = new DogeClient(xpub, []).addressAt(0, 0);
  const m = await server({ [mine]: funded(mine) }, opts);
  close(t, m);
  return m;
}

test('a refused or different broadcast is reported', async (t) => {
  const m = await wallet(t, { push: () => ({ status: 400, body: { error: 'dust' } }) });
  const c = new DogeClient(xpub, [m.url], undefined, 5000, fast);
  await assert.rejects(c.send(await c.draft(OTHER, 100000000n), PHRASE), /rejected: dust/);
  const n = await wallet(t, { push: () => ({ status: 200, body: { success: 0, error: 'bad' } }) });
  const d = new DogeClient(xpub, [n.url], undefined, 5000, fast);
  await assert.rejects(d.send(await d.draft(OTHER, 100000000n), PHRASE), /rejected: bad/);
  const o = await wallet(t, { push: () => ({ status: 201, body: { tx: { hash: 'ff'.repeat(32) } } }) });
  const e = new DogeClient(xpub, [o.url], undefined, 5000, fast);
  await assert.rejects(e.send(await e.draft(OTHER, 100000000n), PHRASE), /different transaction/);
});

test('an accepted send has to show up, or the wallet says so', async (t) => {
  const m = await wallet(t, { seen: false });
  const c = new DogeClient(xpub, [m.url], undefined, 5000, fast);
  const draft = await c.draft(OTHER, 100000000n);
  await assert.rejects(c.send(draft, PHRASE), /doesn't show on the network yet\. Don't send again/);
});

test('Blockchair: asked with a GET, its answers understood', async (t) => {
  const m = await wallet(t);
  const c = new DogeClient(xpub, [m.url], undefined, 5000, { ...fast, pushUrls: [`${m.url}/chair/push/transaction`] });
  assert.equal(await c.send(await c.draft(OTHER, 100000000n), PHRASE), idOf(m.posted[0]));
  const n = await wallet(t, { push: () => ({ status: 400, body: { data: null, context: { code: 400, error: 'Invalid transaction' } } }) });
  const d = new DogeClient(xpub, [n.url], undefined, 5000, { ...fast, pushUrls: [`${n.url}/chair/push/transaction`] });
  await assert.rejects(d.send(await d.draft(OTHER, 100000000n), PHRASE), /Invalid transaction/);
});

test('the second sending server is used when the first fails or stays unseen', async (t) => {
  const m = await wallet(t);
  const dead = await wallet(t, { push: () => ({ status: 500, body: {} }) });
  const c = new DogeClient(xpub, [m.url], undefined, 5000, { ...fast, pushUrls: [`${dead.url}/txs/push`, `${m.url}/txs/push`] });
  assert.equal(await c.send(await c.draft(OTHER, 100000000n), PHRASE), idOf(m.posted[0]));
  assert.equal(dead.posted.length, 1);
  assert.equal(m.posted.length, 1);
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

test('when BlockCypher is down, the backup server gives the balance and coins', async (t) => {
  const mine = new DogeClient(xpub, []).addressAt(0, 1);
  const down = await server(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [new DogeClient(xpub, []).addressAt(i < 20 ? 0 : 1, i % 20), () => ({ status: 500, body: {} })])));
  close(t, down);
  const asked = [];
  const backup = http.createServer((q, r) => {
    asked.push(q.url);
    r.setHeader('content-type', 'application/json');
    const raw = /^\/raw\/(\w{64})$/.exec(q.url);
    if (raw) return r.end(JSON.stringify({ data: { [raw[1]]: { raw_transaction: RAW.get(raw[1]) } } }));
    const m = /^\/address\/(transactions|unspent)\/(\w+)$/.exec(q.url);
    if (!m) { r.statusCode = 404; return r.end('{}'); }
    const used = m[2] === mine;
    if (m[1] === 'transactions') return r.end(JSON.stringify({ success: 1, transactions: used ? [{ hash: ID('ab') }] : [] }));
    r.end(JSON.stringify({ success: 1, unspent_outputs: used ? [{ address: mine, tx_hash: coinTx(mine, 0, 500000000), tx_output_n: 0, value: 500000000, confirmations: 4 }, { address: mine, tx_hash: ID('cd'), tx_output_n: 1, value: 200000000, confirmations: 0 }] : [] }));
  });
  await new Promise((res) => backup.listen(0, '127.0.0.1', res));
  t.after(() => { backup.close(); backup.closeAllConnections(); });
  const c = new DogeClient(xpub, [down.url], undefined, 5000, { ...fast, backup: `http://127.0.0.1:${backup.address().port}`, rawUrls: [`http://127.0.0.1:${backup.address().port}/raw/`] });
  assert.deepEqual(await c.getBalance(), { total: 700000000n, spendable: 500000000n });
  assert.equal(c.receiveAddress, new DogeClient(xpub, []).addressAt(0, 2), 'a used address is known as used');
  assert.ok(asked.some((u) => u.includes(mine)));
  assert.deepEqual(await c.getHistory(), [], 'the backup has no amounts per transaction, so no made-up history');
  const draft = await c.draft(OTHER, 100000000n);
  assert.equal(draft.inputs.length, 1);
  // Once BlockCypher has failed, the next reads go straight to the backup instead of waiting on it again.
  const before = down.log.length;
  await c.refresh(true);
  assert.equal(down.log.length, before, 'BlockCypher not asked again for a while');
});
