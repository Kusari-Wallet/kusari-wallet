const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { scrtAddress, scrtPublicKey, isScrtAddress, signScrtTransfer, ScrtClient } = require('../dist/main/scrt');

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ME = 'secret1gkle2qetd47g4qlruxu8kx4m97875t66qsgr0p';
const OTHER = 'secret1f955dd4z2ugeenxksglm06v6dv6khqsfykxgpd'; // m/44'/529'/0'/0/1, from CosmJS
// Produced by CosmJS 0.32 (DirectSecp256k1HdWallet.signDirect + TxRaw) for the same transfer.
const COSMJS_TX = '0a93010a90010a1c2f636f736d6f732e62616e6b2e763162657461312e4d736753656e6412700a2d73656372657431676b6c65327165746434376734716c72757875386b78346d3937383735743636717367723070122d73656372657431676b6c65327165746434376734716c72757875386b78346d39373837357436367173677230701a100a05757363727412073132333435363712670a500a460a1f2f636f736d6f732e63727970746f2e736563703235366b312e5075624b657912230a210217fead3b69ef9460a38635f342d9714c2e183965a5a6f250de20f4f0178db58712040a020801180712130a0d0a05757363727412043530303010a09c011a40fe009f76616909d9923b89f7b4a766f6bd2ee0232bb7beef8feef2d8c6dcbbd243dcc38eaade6c329b08d46c4670decd6105e280ce3e0cf7391d194671c2acad';

test('address from coin type 529, as Keplr and CosmJS give it', () => {
  assert.equal(scrtAddress(M), ME);
  assert.ok(isScrtAddress(ME) && isScrtAddress(OTHER));
  assert.ok(!isScrtAddress('cosmos1gkle2qetd47g4qlruxu8kx4m97875t66l0yqu4'), 'another chain');
  assert.ok(!isScrtAddress(ME.slice(0, -1) + 'q'), 'bad checksum');
  assert.ok(!isScrtAddress('secret1'));
});

test('signed bytes match CosmJS exactly', () => {
  const r = signScrtTransfer(M, { to: ME, amount: 1234567n, fee: 5000n, gas: 20000n, accountNumber: 12345n, sequence: 7n });
  assert.equal(Buffer.from(r.bytes).toString('hex'), COSMJS_TX);
  assert.equal(r.hash, crypto.createHash('sha256').update(Buffer.from(COSMJS_TX, 'hex')).digest('hex').toUpperCase());
  assert.throws(() => signScrtTransfer(M, { to: 'secret1xyz', amount: 1n, fee: 1n, gas: 1n, accountNumber: 0n, sequence: 0n }));
  assert.throws(() => signScrtTransfer(M, { to: OTHER, amount: 0n, fee: 1n, gas: 1n, accountNumber: 0n, sequence: 0n }));
});

async function lcd(tt, handler) {
  const seen = [];
  const server = http.createServer((q, r) => {
    let body = '';
    q.on('data', (c) => { body += c; });
    q.on('end', () => {
      seen.push({ url: q.url, method: q.method, body: body ? JSON.parse(body) : null });
      r.setHeader('content-type', 'application/json');
      const out = handler(q.url, body ? JSON.parse(body) : null);
      r.statusCode = out.status ?? 200;
      r.end(JSON.stringify(out.body ?? out));
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  tt.after(() => { server.close(); server.closeAllConnections(); });
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

const account = { account: { '@type': '/cosmos.auth.v1beta1.BaseAccount', address: ME, account_number: '12345', sequence: '7' } };

test('draft: gas from a simulation, fee at 0.25 uscrt, max leaves the fee', async (tt) => {
  const { base, seen } = await lcd(tt, (url) => {
    if (url.includes('/bank/')) return { balances: [{ denom: 'ibc/ABC', amount: '99' }, { denom: 'uscrt', amount: '1000000' }] };
    if (url.includes('/auth/')) return account;
    if (url.endsWith('/simulate')) return { gas_info: { gas_used: '70000' } };
    return { status: 404, body: {} };
  });
  const c = new ScrtClient(scrtPublicKey(M), [base]);
  assert.equal(await c.getBalance(), 1000000n);
  const d = await c.draft(OTHER, 'max');
  assert.equal(d.gas, 92000n);
  assert.equal(d.fee, 23000n);
  assert.equal(d.amount, 977000n);
  assert.equal(d.sequence, 7n);
  assert.equal(d.accountNumber, 12345n);
  const sim = seen.find((s) => s.url.endsWith('/simulate'));
  assert.ok(sim.body.tx_bytes.length > 100, 'simulates the real transfer');
  await assert.rejects(c.draft(OTHER, 990000n), /Not enough SCRT/);
  await assert.rejects(c.draft(ME, 1n), /own address/);
  await assert.rejects(c.draft('cosmos1gkle2qetd47g4qlruxu8kx4m97875t66l0yqu4', 1n), /secret1/);
});

test('draft refuses a server that answers for another account, or wants silly gas', async (tt) => {
  let gas = '70000';
  const { base } = await lcd(tt, (url) => {
    if (url.includes('/bank/')) return { balances: [{ denom: 'uscrt', amount: '1000000' }] };
    if (url.includes('/auth/')) return gas === 'other' ? { account: { ...account.account, address: OTHER } } : account;
    return { gas_info: { gas_used: gas } };
  });
  const c = new ScrtClient(scrtPublicKey(M), [base]);
  gas = '900000';
  await assert.rejects(c.draft(OTHER, 1n), /abnormal amount of gas/);
  gas = 'other';
  await assert.rejects(c.draft(OTHER, 1n), /unexpected answer/);
});

test('send: broadcasts the signed bytes and checks the returned hash', async (tt) => {
  let reply = null;
  const { base, seen } = await lcd(tt, (url, body) => {
    if (url.endsWith('/txs') && body) return reply(body);
    return { status: 404, body: {} };
  });
  const c = new ScrtClient(scrtPublicKey(M), [base]);
  const draft = { to: OTHER, amount: 1000n, fee: 23000n, gas: 92000n, accountNumber: 12345n, sequence: 7n };
  const { hash } = signScrtTransfer(M, draft);
  reply = () => ({ tx_response: { txhash: hash, code: 0 } });
  assert.equal(await c.send(draft, M), hash);
  const post = seen.find((s) => s.method === 'POST');
  assert.equal(post.body.mode, 'BROADCAST_MODE_SYNC');
  assert.equal(Buffer.from(post.body.tx_bytes, 'base64').toString('hex'), Buffer.from(signScrtTransfer(M, draft).bytes).toString('hex'));
  reply = () => ({ tx_response: { txhash: hash, code: 5, raw_log: 'insufficient funds' } });
  await assert.rejects(c.send(draft, M), /insufficient funds/);
  reply = () => ({ tx_response: { txhash: 'AB'.repeat(32), code: 0 } });
  await assert.rejects(c.send(draft, M), /different transaction ID/);
  const otherSeed = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  await assert.rejects(c.send(draft, otherSeed), /does not match/);
});

test('history: sent and received, merged, with falls back to the older search form', async (tt) => {
  const tx = (hash, from, to, amount, ts) => ({ txhash: hash, code: 0, timestamp: ts, tx: { body: { messages: [{ '@type': '/cosmos.bank.v1beta1.MsgSend', from_address: from, to_address: to, amount: [{ denom: 'uscrt', amount }] }] } } });
  const { base } = await lcd(tt, (url) => {
    if (url.includes('query=')) return { status: 400, body: { message: 'unknown field' } };
    const q = decodeURIComponent(url);
    if (q.includes('message.sender')) return { tx_responses: [tx('A'.repeat(64), ME, OTHER, '1500000', '2026-01-02T00:00:00Z')] };
    return { tx_responses: [tx('B'.repeat(64), OTHER, ME, '2000000', '2026-01-03T00:00:00Z'), tx('A'.repeat(64), ME, OTHER, '1500000', '2026-01-02T00:00:00Z')] };
  });
  const h = await new ScrtClient(scrtPublicKey(M), [base]).getHistory();
  assert.deepEqual(h.map((i) => [i.hash[0], i.direction, i.amount]), [['B', 'in', '2'], ['A', 'out', '1.5']]);
});
