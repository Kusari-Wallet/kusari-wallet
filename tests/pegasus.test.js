// PegasusSwap: every request signed as their docs say, and an order refused whenever its answer differs from the request.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { PegasusClient } = require('../dist/main/swap');

const XMR = '87bsQNEnRRe56A6ERMLmwDCanjkoN6Q2eFwCFqi5tLAQcwzvxDj6rxZUAa2rRPqvX8a6fdpoerpxnNSRTPyAFt4zJsDvZcB';
const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
function server(answer) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const name = new URL(req.url, 'http://x').pathname.replace('/api/private/', '');
      const good = req.headers['x-api-public-key'] === 'pub' && req.headers['x-api-payload'] === name
        && req.headers['x-api-signature'] === crypto.createHmac('sha512', 'sec').update(name).digest('hex');
      seen.push({ name, url: req.url, body: body ? JSON.parse(body) : null, good });
      const [status, out] = good ? answer(name, body ? JSON.parse(body) : null) : [401, { message: 'bad signature' }];
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ s, seen, base: `http://127.0.0.1:${s.address().port}` })));
}
const order = (o = {}) => ({
  orderNumber: 'F723NT', status: 9, refundAddress: BTC,
  pairs: { deposit: { coin: { name: 'BTC', value: 0.01, network: 'BTC' }, address: 'bc1qdeposit000000000000000000000000000000', memo: '' }, receive: { coin: { name: 'XMR', value: 1.5, network: 'XMR' }, address: XMR, memo: '' } },
  ...o,
});

test('PegasusSwap: signed quote, order checked, status read', async () => {
  let made = order();
  const { s, seen, base } = await server((name) => {
    if (name === 'exchange-coin') return [200, { pair: 'BTC_XMR', amount: '0.01', exchangeRate: 150, receive: 1.5, minAmount: 0.001, maxAmount: 5 }];
    if (name === 'create-transaction') return [200, made];
    if (name === 'get-transaction') return [200, { ...order(), status: 4, txId: 'in1', receiveTransaction: { txId: 'out1' } }];
    return [404, {}];
  });
  try {
    const c = new PegasusClient(base, 'pub', 'sec');
    const q = await c.quote('BTC', 'XMR', '0.01');
    assert.equal(q.problem, null); assert.equal(q.receive, '1.5'); assert.equal(q.min, '0.001');
    assert.match(seen[0].url, /coinFrom=BTC&coinTo=XMR&networkFrom=BTC&networkTo=XMR&lastSource=deposit&typeSwap=2/);
    const o = await c.create('BTC', 'XMR', '0.01', '1.5', XMR, BTC);
    assert.deepEqual([o.id, o.depositAddress], ['F723NT', 'bc1qdeposit000000000000000000000000000000']);
    assert.deepEqual(seen[1].body, { depositCoin: 'BTC', depositNetwork: 'BTC', depositAmount: 0.01, receiveCoin: 'XMR', receiveNetwork: 'XMR', receiveAddress: XMR, refundAddress: BTC, typeSwap: 2, lastSource: 'deposit' });
    assert.deepEqual(await c.status('F723NT'), { status: 'success', hashIn: 'in1', hashOut: 'out1' });
    assert.ok(seen.every((x) => x.good), 'every request signed');
    for (const [why, bad] of [
      ['receiving address', order({ pairs: { ...order().pairs, receive: { ...order().pairs.receive, address: '4' + XMR.slice(1) } } })],
      ['memo', order({ pairs: { ...order().pairs, deposit: { ...order().pairs.deposit, memo: '123' } } })],
      ['send amount', order({ pairs: { ...order().pairs, deposit: { ...order().pairs.deposit, coin: { name: 'BTC', value: 0.02, network: 'BTC' } } } })],
      ['receive amount', order({ pairs: { ...order().pairs, receive: { ...order().pairs.receive, coin: { name: 'XMR', value: 1.2, network: 'XMR' } } } })],
      ['received coin', order({ pairs: { ...order().pairs, receive: { ...order().pairs.receive, coin: { name: 'BTC', value: 1.5, network: 'BTC' } } } })],
      ['refund address', order({ refundAddress: 'bc1qsomeoneelse0000000000000000000000000' })],
    ]) {
      made = bad;
      await assert.rejects(c.create('BTC', 'XMR', '0.01', '1.5', XMR, BTC), new RegExp(why), why);
    }
    assert.match((await c.quote('ZANO', 'XMR', '1')).problem, /doesn't offer/);
  } finally { s.close(); }
});

test('PegasusSwap: an unavailable pair or a low amount reads as such', async () => {
  const { s, base } = await server(() => [200, { status: 522, message: 'Such exchange pair is not available', receive: 0, minAmount: 0.002 }]);
  try {
    const c = new PegasusClient(base, 'pub', 'sec');
    assert.equal((await c.quote('BTC', 'XMR', '0.01')).problem, 'Such exchange pair is not available');
    assert.equal((await c.quote('BTC', 'XMR', '0.001')).problem, 'The minimum amount is 0.002 BTC.');
  } finally { s.close(); }
});
