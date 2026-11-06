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
  assert.match(low.problem, /minimum amount is 5/);
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
  ['another receive address', { withdrawalAddress: 'T' + 'B'.repeat(33) }, /receiving address/],
  ['another refund address', { refundAddress: 'T' + 'B'.repeat(33) }, /refund address/],
  ['a different deposit amount', { amount: 11 }, /send amount/],
  ['less than quoted', { amountTo: 1000 }, /less than quoted/],
  ['a different coin', { coinTo: { coinCode: 'BTC' } }, /received coin/],
  ['a different network', { coinFrom: { coinCode: 'USDT', network: 'ETH' } }, /sending network/],
  ['a memo requirement', { depositExtraId: '123' }, /memo/],
  ['no deposit address', { depositAddress: '' }, /deposit address/],
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
  assert.match((await bad.quote('BTC', 'XMR', '1')).problem, /API key/);
});

for (const [name, override, pattern] of [
  ['another receive address', { addressTo: 'x' }, /receiving address/],
  ['another refund address', { userRefundAddress: 'x' }, /refund address/],
  ['a different deposit amount', { amountFrom: '11' }, /send amount/],
  ['less than quoted', { amountTo: '1000' }, /less than quoted/],
  ['a different coin', { tickerTo: 'btc' }, /received coin/],
  ['a different network', { networkFrom: 'eth' }, /sending network/],
  ['a memo requirement', { extraIdFrom: '77' }, /memo/],
  ['no deposit address', { addressFrom: '' }, /deposit address/],
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
  assert.match((await bad.quote('BTC', 'XMR', '1')).problem, /API key/);
});

for (const [name, override, pattern] of [
  ['another receive address', { payoutAddress: 'x' }, /receiving address/],
  ['another refund address', { refundAddress: 'x' }, /refund address/],
  ['a different deposit amount', { amountExpectedFrom: '11' }, /send amount/],
  ['less than quoted', { amountExpectedTo: '1000' }, /less than quoted/],
  ['a different coin', { to: 'btc' }, /received coin/],
  ['no deposit address', { payinAddress: '' }, /deposit address/],
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
  await assert.rejects(m.client.create('XMR', 'USDTE', '1', '1500', ME_ETH, ME_XMR), /receiving address/);
});

test('GhostSwap: USDT(Eth) ticker comes from their list', async (t) => {
  const m = await ghost(); closing(t, m.server);
  await m.client.quote('USDTE', 'XMR', '10');
  assert.equal(m.log.find((l) => l.path === '/v1/quotes').body.from, 'usdt20');
});

// ---- ETZ Swap ----
const { EtzSwapClient, CceCashClient } = require('../dist/main/swap');
function etz(override = {}) {
  const log = [];
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => {
      const u = new URL(q.url, 'http://x');
      log.push({ method: q.method, path: u.pathname, params: Object.fromEntries(u.searchParams), body: b && JSON.parse(b), headers: q.headers });
      r.setHeader('content-type', 'application/json');
      if (q.headers['x-api-key'] !== 'PUB' || q.headers['x-api-secret-key'] !== 'SEC' || q.headers['x-api-key-version'] !== '1') { r.statusCode = 401; return r.end(JSON.stringify({ data: null, errors: { notAuthenticated: { message: 'Not authenticated', args: {} } } })); }
      if (u.pathname.endsWith('/rate')) {
        if (u.searchParams.get('amountFrom') === '0.1') { r.statusCode = 400; return r.end(JSON.stringify({ data: null, errors: { amountTooSmall: { message: 'Rate amount too small', args: { actualAmount: 0.1, minAllowedAmount: 5 } } } })); }
        return r.end(JSON.stringify({ data: { amountFrom: 10, amountTo: 1500, minAmountFrom: 5, maxAmountFrom: 900, rate: 150 }, errors: {} }));
      }
      if (u.pathname.endsWith('/transaction')) {
        const p = JSON.parse(b);
        return r.end(JSON.stringify({ data: { transactionId: 'trA1', amount: p.amountFrom, amountTo: 1500, coinFrom: { coinCode: p.coinFrom, network: p.networkFrom }, coinTo: { coinCode: p.coinTo, network: p.networkTo }, deposit: { address: DEPOSIT, memo: '' }, withdraw: { address: p.withdrawalAddress, memo: '' }, refund: { address: p.refundAddress, memo: '' }, rate: 150, status: 'deposit', transactionSecurity: { type: 'secureToken', secureToken: 'token-1', isSecured: true }, ...override }, errors: {} }));
      }
      if (u.pathname.endsWith('/transactions/trA1')) return r.end(JSON.stringify({ data: { status: u.searchParams.get('secureToken') === 'token-1' ? 'sending' : 'wrong', inboundTransfer: { hash: 'aa' }, outboundTransfer: { hash: 'bb' } }, errors: {} }));
      r.statusCode = 404; r.end('{}');
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, log, client: new EtzSwapClient(`http://127.0.0.1:${server.address().port}`, 'PUB', 'SEC') })));
}

test('ETZ Swap: keys, Tron USDT network, private order, status by its code', async (t) => {
  const m = await etz(); closing(t, m.server);
  const q = await m.client.quote('USDT', 'XMR', '10');
  assert.deepEqual([q.receive, q.min, q.max, q.problem, q.providerId], ['1500', '5', '900', null, 'etzswap']);
  const rate = m.log[0].params;
  assert.deepEqual([rate.coinFrom, rate.networkFrom, rate.coinTo, rate.networkTo, rate.rateType], ['USDT', 'TRX', 'XMR', 'XMR', 'float']);
  const o = await m.client.create('USDT', 'XMR', '10', q.receive, ME_XMR, ME_TRON);
  assert.deepEqual([o.id, o.depositAddress, o.statusKey], ['trA1', DEPOSIT, 'token-1']);
  const body = m.log.find((l) => l.method === 'POST').body;
  assert.deepEqual([body.securityType, body.withdrawalAddress, body.refundAddress, body.amountFrom], ['secureToken', ME_XMR, ME_TRON, 10]);
  assert.deepEqual(await m.client.status('trA1', o.statusKey), { status: 'sending', hashIn: 'aa', hashOut: 'bb' });
});

test('ETZ Swap: limits, a bad key and coins it lacks are explained', async (t) => {
  const m = await etz(); closing(t, m.server);
  const small = await m.client.quote('USDT', 'XMR', '0.1');
  assert.match(small.problem, /minimum amount is 5 USDT/);
  assert.match((await m.client.quote('FIRO', 'XMR', '1')).problem, /doesn't offer/);
  assert.match((await m.client.quote('XMR', 'ARRR', '1')).problem, /doesn't offer/);
  const bad = new EtzSwapClient(`http://127.0.0.1:${m.server.address().port}`, 'x', 'y');
  assert.match((await bad.quote('BTC', 'XMR', '1')).problem, /API key/);
});

for (const [name, override, pattern] of [
  ['another receive address', { withdraw: { address: 'x' } }, /receiving address/],
  ['another refund address', { refund: { address: 'x' } }, /refund address/],
  ['a different amount', { amount: 11 }, /send amount/],
  ['less than quoted', { amountTo: 1000 }, /less than quoted/],
  ['a different coin', { coinTo: { coinCode: 'BTC', network: 'XMR' } }, /received coin/],
  ['a different network', { coinFrom: { coinCode: 'USDT', network: 'ETH' } }, /sending network/],
  ['a memo requirement', { deposit: { address: DEPOSIT, memo: '77' } }, /memo/],
  ['no deposit address', { deposit: { address: '' } }, /deposit address/],
  ['no private code', { transactionSecurity: { type: 'standard' } }, /private order code/],
]) {
  test(`ETZ Swap: refused when it returns ${name}`, async (t) => {
    const m = await etz(override); closing(t, m.server);
    await assert.rejects(m.client.create('USDT', 'XMR', '10', '1500', ME_XMR, ME_TRON), pattern);
  });
}

// ---- CCECash ----
const crypto = require('node:crypto');
function cce({ read = {}, child = {}, staleTimes = 0, code403 = 0 } = {}) {
  const log = [];
  let order = null;
  let stale = staleTimes;
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => {
      const u = new URL(q.url, 'http://x');
      r.setHeader('content-type', 'application/json');
      const h = q.headers;
      const signed = crypto.createHmac('sha256', 'SEC').update(`KEY${h['x-api-nonce']}${h['x-api-timestamp']}${u.search.slice(1)}${b}`).digest('hex');
      log.push({ method: q.method, path: u.pathname, body: b && JSON.parse(b), headers: h, signed: signed === h['x-api-signature'] });
      if (code403) { r.statusCode = 403; return r.end(JSON.stringify({ code: code403, msg: 'no' })); }
      if (h['x-api-key'] !== 'KEY' || signed !== h['x-api-signature'] || !/^[0-9a-f]{32}$/.test(h['x-api-nonce']) || !/^\d{10}$/.test(h['x-api-timestamp'])) { r.statusCode = 400; return r.end(JSON.stringify({ code: 400009, msg: 'Incorrect signature' })); }
      if (stale > 0) { stale--; r.statusCode = 400; return r.end(JSON.stringify({ code: 400003, msg: 'Invalid header: x-api-timestamp' })); }
      if (u.pathname.endsWith('/order/calculate')) {
        const p = JSON.parse(b);
        if (p.from_quantity < 5) return r.end(JSON.stringify({ code: 1, msg: 'from quantity too small', data: { max_from_quantity: 900, min_from_quantity: 5 } }));
        return r.end(JSON.stringify({ code: 0, msg: 'success', data: { min_from_quantity: 5, max_from_quantity: 900, to: [{ to_abbr: p.to_address[0].to_abbr, to_chain: p.to_address[0].to_chain, to_quantity: 1500, to_ratio: 1 }] } }));
      }
      if (u.pathname.endsWith('/order/place')) {
        order = JSON.parse(b);
        return r.end(JSON.stringify({ code: 0, msg: 'success', data: { order_no: 'ORD1', address: DEPOSIT, query_code: 'QC1' } }));
      }
      if (u.pathname.endsWith('/order/query')) {
        if (u.searchParams.get('query_code') !== 'QC1') return r.end(JSON.stringify({ code: 1, msg: 'not found' }));
        const to = order?.to_address?.[0] ?? {};
        return r.end(JSON.stringify({ code: 0, msg: 'success', data: { no: 'ORD1', abbr: order?.from_abbr, chain: order?.from_chain, address: DEPOSIT, odr_volume: order?.from_quantity, status: 3, children: [{ abbr: to.to_abbr, chain: to.to_chain, address: to.to_address, volume_origin: 1500, ...child }], input: [{ txid: 'aa' }], output: [{ txid: 'bb' }], ...read } }));
      }
      r.statusCode = 404; r.end('{}');
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, log, client: new CceCashClient(`http://127.0.0.1:${server.address().port}`, 'KEY', 'SEC', 'REF') })));
}

test('CCECash: signs every request, sends the referral code, reads the order back', async (t) => {
  const m = await cce(); closing(t, m.server);
  const q = await m.client.quote('USDT', 'XMR', '10');
  assert.deepEqual([q.receive, q.min, q.max, q.problem, q.providerId], ['1500', '5', '900', null, 'ccecash']);
  const calc = m.log[0].body;
  assert.deepEqual([calc.exchange_mode, calc.from_abbr, calc.from_chain, calc.from_quantity, calc.to_address[0].to_chain], ['float', 'USDT', 'TRON', 10, 'Monero']);
  const o = await m.client.create('USDT', 'XMR', '10', q.receive, ME_XMR, ME_TRON);
  assert.deepEqual([o.id, o.depositAddress, o.statusKey, o.receive], ['ORD1', DEPOSIT, 'QC1', '1500']);
  const place = m.log.find((l) => l.path.endsWith('/order/place'));
  assert.equal(place.headers['ref-code'], 'REF');
  assert.equal(place.body.to_address[0].to_address, ME_XMR);
  assert.ok(m.log.some((l) => l.path.endsWith('/order/query')), 'the order is read back before anything moves');
  assert.ok(m.log.every((l) => l.signed));
  assert.deepEqual(await m.client.status('ORD1', o.statusKey), { status: 'exchanging', hashIn: 'aa', hashOut: 'bb' });
});

test('CCECash: an expired signature is signed again, then explained', async (t) => {
  const m = await cce({ staleTimes: 2 }); closing(t, m.server);
  assert.equal((await m.client.quote('USDT', 'XMR', '10')).problem, null);
  assert.equal(m.log.length, 3);
  assert.notEqual(m.log[0].headers['x-api-nonce'], m.log[1].headers['x-api-nonce']);
  const n = await cce({ staleTimes: 9 }); closing(t, n.server);
  await assert.rejects(n.client.quote('USDT', 'XMR', '10'), /clock/);
  assert.equal(n.log.length, 3);
});

test('CCECash: limits, keys, IP refusals and coins it lacks are explained', async (t) => {
  const m = await cce(); closing(t, m.server);
  assert.match((await m.client.quote('USDT', 'XMR', '1')).problem, /minimum amount is 5 USDT/);
  assert.match((await m.client.quote('ZANO', 'XMR', '10')).problem, /doesn't offer/);
  const bad = new CceCashClient(`http://127.0.0.1:${m.server.address().port}`, 'KEY', 'WRONG');
  assert.match((await bad.quote('BTC', 'XMR', '10')).problem, /API key/);
  const ip = await cce({ code403: 700100 }); closing(t, ip.server);
  assert.match((await ip.client.quote('BTC', 'XMR', '10')).problem, /IP address/);
});

for (const [name, opts, pattern] of [
  ['another receive address', { child: { address: 'x' } }, /receiving address/],
  ['two receivers', { read: { children: [{}, {}] } }, /receiving address/],
  ['a different deposit address', { read: { address: 'x' } }, /deposit address differs/],
  ['a different amount', { read: { odr_volume: 11 } }, /send amount/],
  ['less than quoted', { child: { volume_origin: 1000 } }, /less than quoted/],
  ['a different sent chain', { read: { chain: 'Ethereum' } }, /sent coin/],
  ['a different received coin', { child: { abbr: 'BTC' } }, /received coin/],
]) {
  test(`CCECash: refused when the order reads back with ${name}`, async (t) => {
    const m = await cce(opts); closing(t, m.server);
    await assert.rejects(m.client.create('USDT', 'XMR', '10', '1500', ME_XMR, ME_TRON), pattern);
  });
}

test('CCECash: every order state has a wallet word', async (t) => {
  for (const [code, word] of [[1, 'wait'], [2, 'confirming'], [3, 'exchanging'], [4, 'success'], [5, 'refunded'], [7, 'hold'], [8, 'expired'], [9, 'failed'], [6, 'unknown']]) {
    const m = await cce({ read: { status: code } }); closing(t, m.server);
    assert.equal((await m.client.status('ORD1', 'QC1')).status, word);
  }
});

test('wallet: a swap keeps its private code for status checks and keeps it from the screen', async (t) => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { WalletService } = require('../dist/main/service');
  const server = http.createServer((q, r) => {
    r.setHeader('content-type', 'application/json');
    const ok = q.headers['x-api-secret-key'] === 'etz-secret' && new URL(q.url, 'http://x').searchParams.get('secureToken') === 'token-9';
    r.end(JSON.stringify({ data: { status: ok ? 'success' : 'wrong', inboundTransfer: {}, outboundTransfer: { hash: 'cc' } }, errors: {} }));
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  closing(t, server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etz-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const s = new WalletService(dir, undefined, { swapBase: `${base}/ex`, etzSwapBase: base });
  Object.assign(s, { tron: {}, monero: {}, btc: {}, eth: {}, dash: {}, firo: {} });
  fs.writeFileSync(path.join(s.dir, 'swaps.json'), JSON.stringify([{ id: 'trA9', from: 'BTC', to: 'XMR', amount: '1', receive: '1', rate: '1', createdAt: 1, providerId: 'etzswap', provider: 'ETZ Swap', statusKey: 'token-9', status: 'wait' }]));
  const record = await s.swapRefresh('trA9');
  assert.equal(record.status, 'success');
  assert.equal(record.hashOut, 'cc');
  assert.deepEqual(Object.keys(s.swapClients()).sort(), ['etzswap', 'exolix']);
});
