const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { SwapClient, SimpleSwapClient, GhostSwapClient } = require('../dist/main/swap');

const ME_TRON = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
const ME_XMR = '4' + 'A'.repeat(94);
const DEPOSIT = 'TUJ2YbSDGtCqzRz7quPQidRCMC98jDAPXc';

function mock(override = {}) {
  const log = [];
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => {
      log.push({ method: q.method, url: q.url, body: b && JSON.parse(b) });
      const u = new URL(q.url, 'http://x');
      r.setHeader('content-type', 'application/json');
      if (u.pathname.endsWith('/networks')) return r.end(JSON.stringify([{ network: 'ETH', shortName: 'ERC20' }, { network: 'TRXNET', shortName: 'TRC20', name: 'Tron' }]));
      if (u.pathname === '/rate') {
        if (Number(u.searchParams.get('amount')) < 5) { r.statusCode = 422; return r.end(JSON.stringify({ message: 'Amount too low', minAmount: 5, maxAmount: 900 })); }
        return r.end(JSON.stringify({ fromAmount: 10, toAmount: 1500, rate: 150, minAmount: 5, maxAmount: 900 }));
      }
      if (q.method === 'POST' && u.pathname === '/transactions') {
        const req = JSON.parse(b);
        if (override.status) { r.statusCode = override.status; return r.end(JSON.stringify({ message: 'nope' })); }
        return r.end(JSON.stringify({ id: 'ABC123', amount: req.amount, amountTo: 1500, depositAddress: DEPOSIT, withdrawalAddress: req.withdrawalAddress, refundAddress: req.refundAddress, coinFrom: { coinCode: req.coinFrom, network: req.networkFrom }, coinTo: { coinCode: req.coinTo, network: req.networkTo }, rate: 150, status: 'wait', ...override.order }));
      }
      if (u.pathname === '/transactions/ABC123') return r.end(JSON.stringify({ status: 'success', hashOut: { hash: 'ff'.repeat(32) } }));
      r.statusCode = 404; r.end('{}');
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, log, client: new SwapClient(`http://127.0.0.1:${server.address().port}`) })));
}

const closing = (t, s) => t.after(() => { s.close(); s.closeAllConnections(); });

test('quote uses the provider network code and reports limits', async (t) => {
  const m = await mock(); closing(t, m.server);
  const q = await m.client.quote('USDT', 'XMR', '10');
  assert.equal(q.receive, '1500');
  assert.equal(q.problem, null);
  const url = m.log.find((l) => l.url.startsWith('/rate')).url;
  assert.match(url, /networkFrom=TRXNET/);
  assert.match(url, /coinFrom=USDT/);
  assert.match(url, /rateType=fixed/);
  const low = await m.client.quote('USDT', 'XMR', '1');
  assert.match(low.problem, /최소 금액은 5/);
});

test('order is created with my addresses and returns the deposit', async (t) => {
  const m = await mock(); closing(t, m.server);
  const o = await m.client.create('USDT', 'XMR', '10', '1500', ME_XMR, ME_TRON);
  assert.equal(o.depositAddress, DEPOSIT);
  const post = m.log.find((l) => l.method === 'POST').body;
  assert.equal(post.withdrawalAddress, ME_XMR);
  assert.equal(post.refundAddress, ME_TRON);
  assert.equal(post.amount, 10);
  assert.equal((await m.client.status('ABC123')).hashOut, 'ff'.repeat(32));
  await assert.rejects(m.client.status('../secret'));
});

for (const [name, order, pattern] of [
  ['another receive address', { withdrawalAddress: 'T' + 'B'.repeat(33) }, /받는 주소/],
  ['another refund address', { refundAddress: 'T' + 'B'.repeat(33) }, /환불 주소/],
  ['a different deposit amount', { amount: 11 }, /보낼 금액/],
  ['less than quoted', { amountTo: 1000 }, /견적보다 적음/],
  ['a different coin', { coinTo: { coinCode: 'BTC' } }, /받는 코인/],
  ['a different network', { coinFrom: { coinCode: 'USDT', network: 'ETH' } }, /보내는 네트워크/],
  ['a memo requirement', { depositExtraId: '123' }, /메모/],
  ['no deposit address', { depositAddress: '' }, /입금 주소/],
]) {
  test(`order is refused when the provider returns ${name}`, async (t) => {
    const m = await mock({ order }); closing(t, m.server);
    await assert.rejects(m.client.create('USDT', 'XMR', '10', '1500', ME_XMR, ME_TRON), pattern);
  });
}

test('provider errors are shown, not hidden', async (t) => {
  const m = await mock({ status: 400 }); closing(t, m.server);
  await assert.rejects(m.client.create('USDT', 'XMR', '10', '1500', ME_XMR, ME_TRON), /nope/);
});

// ---- SimpleSwap ----
function simple(override = {}, wrap = true) {
  const log = [];
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => {
      const u = new URL(q.url, 'http://x');
      log.push({ method: q.method, path: u.pathname, params: Object.fromEntries(u.searchParams), body: b && JSON.parse(b), key: q.headers['x-api-key'] });
      r.setHeader('content-type', 'application/json');
      const send = (o) => r.end(JSON.stringify(wrap ? { result: o } : o));
      if (q.headers['x-api-key'] !== 'KEY') { r.statusCode = 401; return r.end('{}'); }
      if (u.pathname === '/v3/estimates') return send({ estimatedAmount: '1500' });
      if (q.method === 'POST') { const p = JSON.parse(b); return send({ publicId: 'pub1', addressFrom: DEPOSIT, addressTo: p.addressTo, userRefundAddress: p.userRefundAddress, amountFrom: p.amount + '.00', amountTo: '1490', tickerFrom: p.tickerFrom, tickerTo: p.tickerTo, networkFrom: p.networkFrom, networkTo: p.networkTo, ...override }); }
      if (u.pathname === '/v3/exchanges/pub1') return send({ status: 'exchanging', txTo: 'ab'.repeat(32) });
      r.statusCode = 404; r.end('{}');
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, log, client: new SimpleSwapClient(`http://127.0.0.1:${server.address().port}`, 'KEY') })));
}

test('SimpleSwap: key, TRC20 network, exact order fields', async (t) => {
  const m = await simple(); closing(t, m.server);
  const q = await m.client.quote('USDT', 'XMR', '10');
  assert.equal(q.receive, '1500');
  assert.equal(q.providerId, 'simpleswap');
  const est = m.log.find((l) => l.path === '/v3/estimates');
  assert.equal(est.key, 'KEY');
  assert.deepEqual([est.params.tickerFrom, est.params.networkFrom, est.params.tickerTo, est.params.networkTo, est.params.fixed], ['usdt', 'trx', 'xmr', 'xmr', 'false']);
  const o = await m.client.create('USDT', 'XMR', '10', q.receive, ME_XMR, ME_TRON);
  assert.equal(o.id, 'pub1');
  assert.equal(o.depositAddress, DEPOSIT);
  const post = m.log.find((l) => l.method === 'POST').body;
  assert.equal(post.addressTo, ME_XMR);
  assert.equal(post.userRefundAddress, ME_TRON);
  assert.equal(post.amount, '10');
  const st = await m.client.status('pub1');
  assert.equal(st.status, 'exchanging');
  assert.equal(st.hashOut, 'ab'.repeat(32));
});

test('SimpleSwap: unwrapped answers work and a bad key is explained', async (t) => {
  const m = await simple({}, false); closing(t, m.server);
  assert.equal((await m.client.quote('BTC', 'XMR', '1')).receive, '1500');
  const bad = new SimpleSwapClient(`http://127.0.0.1:${m.server.address().port}`, 'WRONG');
  assert.match((await bad.quote('BTC', 'XMR', '1')).problem, /API 키/);
});

for (const [name, override, pattern] of [
  ['another receive address', { addressTo: 'x' }, /받는 주소/],
  ['another refund address', { userRefundAddress: 'x' }, /환불 주소/],
  ['a different deposit amount', { amountFrom: '11' }, /보낼 금액/],
  ['less than quoted', { amountTo: '1000' }, /견적보다 적음/],
  ['a different coin', { tickerTo: 'btc' }, /받는 코인/],
  ['a different network', { networkFrom: 'eth' }, /보내는 네트워크/],
  ['a memo requirement', { extraIdFrom: '77' }, /메모/],
  ['no deposit address', { addressFrom: '' }, /입금 주소/],
]) {
  test(`SimpleSwap: refused when it returns ${name}`, async (t) => {
    const m = await simple(override); closing(t, m.server);
    await assert.rejects(m.client.create('USDT', 'XMR', '10', '1500', ME_XMR, ME_TRON), pattern);
  });
}

// ---- GhostSwap ----
function ghost(override = {}) {
  const log = [];
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => {
      const u = new URL(q.url, 'http://x');
      log.push({ method: q.method, path: u.pathname, body: b && JSON.parse(b), auth: q.headers.authorization, idem: q.headers['idempotency-key'] });
      r.setHeader('content-type', 'application/json');
      if (q.headers.authorization !== 'Bearer pub:sec') { r.statusCode = 401; return r.end('{"error":{"message":"bad key"}}'); }
      if (u.pathname === '/v1/currencies') return r.end(JSON.stringify({ currencies: [{ ticker: 'usdtrx', blockchain: 'tron' }, { ticker: 'usdt20', blockchain: 'ethereum', enabled: true }] }));
      if (u.pathname === '/v1/quotes') return r.end(JSON.stringify({ quote: { amountTo: '1510', networkFee: '10', amountUserReceives: '1500', rate: '150', min: '1', max: '500' } }));
      if (q.method === 'POST' && u.pathname === '/v1/swaps') { const p = JSON.parse(b); return r.end(JSON.stringify({ swap: { id: 'g1', status: 'waiting', from: p.from, to: p.to, amountFrom: p.amountFrom, amountExpectedFrom: p.amountFrom, amountExpectedTo: '1505', networkFee: '10', payinAddress: DEPOSIT, payoutAddress: p.address, refundAddress: p.refundAddress, rate: '150', ...override } })); }
      if (u.pathname === '/v1/swaps/g1') return r.end(JSON.stringify({ swap: { id: 'g1', status: 'hold', payoutHash: null } }));
      r.statusCode = 404; r.end('{}');
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, log, client: new GhostSwapClient(`http://127.0.0.1:${server.address().port}`, 'pub:sec') })));
}

test('GhostSwap: bearer, usdtrx ticker, net amount, idempotency key', async (t) => {
  const m = await ghost(); closing(t, m.server);
  const q = await m.client.quote('USDT', 'XMR', '10');
  assert.equal(q.receive, '1500');
  assert.equal(m.log[0].body.from, 'usdtrx');
  assert.equal(m.log[0].body.mode, 'float');
  const o = await m.client.create('USDT', 'XMR', '10', q.receive, ME_XMR, ME_TRON);
  assert.equal(o.receive, '1495', 'gross minus network fee');
  const post = m.log.find((l) => l.path === '/v1/swaps');
  assert.equal(post.body.address, ME_XMR);
  assert.equal(post.body.refundAddress, ME_TRON);
  assert.match(post.idem, /^[0-9a-f-]{36}$/);
  assert.equal((await m.client.status('g1')).status, 'hold');
});

test('GhostSwap: a bad key is explained', async (t) => {
  const m = await ghost(); closing(t, m.server);
  const bad = new GhostSwapClient(`http://127.0.0.1:${m.server.address().port}`, 'x:y');
  assert.match((await bad.quote('BTC', 'XMR', '1')).problem, /API 키/);
});

for (const [name, override, pattern] of [
  ['another receive address', { payoutAddress: 'x' }, /받는 주소/],
  ['another refund address', { refundAddress: 'x' }, /환불 주소/],
  ['a different deposit amount', { amountExpectedFrom: '11' }, /보낼 금액/],
  ['less than quoted', { amountExpectedTo: '1000' }, /견적보다 적음/],
  ['a different coin', { to: 'btc' }, /받는 코인/],
  ['no deposit address', { payinAddress: '' }, /입금 주소/],
]) {
  test(`GhostSwap: refused when it returns ${name}`, async (t) => {
    const m = await ghost(override); closing(t, m.server);
    await assert.rejects(m.client.create('USDT', 'XMR', '10', '1500', ME_XMR, ME_TRON), pattern);
  });
}

// ---- Ethereum assets ----
const ME_ETH = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

test('SimpleSwap: USDT(Eth) uses the eth network and accepts a lowercased address', async (t) => {
  const m = await simple({ addressTo: ME_ETH.toLowerCase() }); closing(t, m.server);
  const q = await m.client.quote('XMR', 'USDTE', '1');
  const est = m.log.find((l) => l.path === '/v3/estimates');
  assert.deepEqual([est.params.tickerTo, est.params.networkTo], ['usdt', 'eth']);
  const o = await m.client.create('XMR', 'USDTE', '1', q.receive, ME_ETH, ME_XMR);
  assert.equal(o.id, 'pub1');
});

test('swap: another Ethereum address is still refused, whatever its case', async (t) => {
  const m = await simple({ addressTo: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' }); closing(t, m.server);
  await assert.rejects(m.client.create('XMR', 'USDTE', '1', '1500', ME_ETH, ME_XMR), /받는 주소/);
});

test('GhostSwap: USDT(Eth) ticker comes from their list', async (t) => {
  const m = await ghost(); closing(t, m.server);
  await m.client.quote('USDTE', 'XMR', '10');
  assert.equal(m.log.find((l) => l.path === '/v1/quotes').body.from, 'usdt20');
});
