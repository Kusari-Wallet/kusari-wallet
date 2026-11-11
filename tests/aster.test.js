const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Wallet, verifyTypedData } = require('ethers');
const {
  AsterClient, asterAgent, signAsterMessage, signAsterAction, signAsterWithdraw, floorToStep, roundToStep, stepDecimals,
  liquidationPrice, bracketFor, builderFee, KUSARI_BUILDER, KUSARI_FEE, encodeDeposit,
} = require('../dist/main/aster');

// Aster's public demo key from its docs. The expected signatures were made with Python eth_account, the library
// Aster's own examples use, so these pin our signing to theirs.
const DEMO = new Wallet('0x4fd0a42218f3eae43a6ce26d22544e986139a01e5b34a62db53757ffca81bae1');
const USER = '0x63DD5aCC6b1aa0f563956C0e534DD30B6dcF7C4e';

test('signatures match Aster\'s reference implementation', async () => {
  const msg = `symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.001&builder=${KUSARI_BUILDER}&feeRate=0.00035&user=${USER}&signer=0x21cF8Ae13Bb72632562c6Fff438652Ba1a151bb0&nonce=1748310859508867`;
  assert.equal(await signAsterMessage(DEMO, msg), '0xed4089f8aa2dfb227cf8a7d156502f6ebdd6c9fe5344fcf10f69a09d9011a5786ddf44aaaf4e87fcd50e51606014e42e48a3d03d4cd081e3080641f3be7ea95b1b');
  assert.equal(await signAsterMessage(DEMO, 'hello', 56), '0x9ecbfea22687f080fc1c365d15decca67a02158b8161ed210a942f865eeb8f5d7ac592795435f3d147d88309a60b85c048d7ee9850130eb2bca4d4b7cc24ff891c');
  assert.equal(await signAsterAction(DEMO, 'ApproveBuilder', [['builder', KUSARI_BUILDER], ['maxFeeRate', '0.00035'], ['builderName', 'Kusari'], ['asterChain', 'Mainnet'], ['user', USER], ['nonce', 1748310859508867n]]),
    '0x4b5d10eedbbddd956a0543699ae76943c6fc10d80f91e69277237a75d75f2e8b4d12e3eb08221e2ba24ac296c697371a062e80c7c7c5fc38e46e588cc8e8b23c1c');
  assert.equal(await signAsterWithdraw(DEMO, { destination: USER, chainId: 56, token: 'USDT', amount: '12.5', fee: '0.3', nonce: 1748310859508000000n }),
    '0x6b008c098fcc09b648bc12ad6da93169679a7d968d5abf86d6a9828e928d4a9274f07ac78ddcaade9b6070440ca13fe6c28f3315a032977a809548ac8613b6281c');
});

test('the trading key is fixed per wallet and is not the wallet key', () => {
  const a = asterAgent(DEMO.privateKey);
  assert.equal(a.address, asterAgent(DEMO.privateKey).address);
  assert.notEqual(a.address, DEMO.address);
  assert.notEqual(a.address, asterAgent(Wallet.createRandom().privateKey).address);
});

test('sizes and prices round to the market\'s steps without floating point', () => {
  assert.equal(floorToStep('0.123456', '0.001'), '0.123');
  assert.equal(floorToStep('12.99', '1'), '12');
  assert.equal(floorToStep('0.3', '0.1'), '0.3');
  assert.equal(floorToStep('1000', '0.0010'), '1000');
  assert.equal(roundToStep('75980.26', '0.1'), '75980.3');
  assert.equal(stepDecimals('0.0010'), 3);
  assert.equal(stepDecimals('1'), 0);
});

test('Kusari fee: post-only pays the maker rate, everything else the taker rate', () => {
  assert.equal(builderFee({ type: 'LIMIT', postOnly: true }), KUSARI_FEE.maker);
  assert.equal(builderFee({ type: 'LIMIT', postOnly: false }), KUSARI_FEE.taker);
  assert.equal(builderFee({ type: 'MARKET' }), KUSARI_FEE.taker);
  assert.ok(Number(KUSARI_FEE.taker) <= Number(KUSARI_FEE.max));
});

test('liquidation price of an isolated position', () => {
  const b = { initialLeverage: 50, notionalCap: 50000, notionalFloor: 0, maintMarginRatio: 0.004, cum: 0 };
  // 10x long of 0.1 BTC at 60000: margin 600.
  const long = liquidationPrice('long', 60000, 0.1, 600, b);
  assert.ok(Math.abs(long - (600 - 6000) / (0.1 * 0.004 - 0.1)) < 1e-6);
  assert.ok(long > 54000 && long < 54300);
  const short = liquidationPrice('short', 60000, 0.1, 600, b);
  assert.ok(short > 65700 && short < 66000);
  assert.equal(bracketFor([b, { ...b, notionalFloor: 50000, notionalCap: 1e9 }], 70000).notionalFloor, 50000);
});

test('deposits credit the futures account of the wallet itself', () => {
  const data = encodeDeposit('0x55d398326f99059fF775485246999027B3197955', USER, 10n ** 18n);
  assert.ok(data.startsWith('0x'));
  assert.ok(data.toLowerCase().includes(USER.slice(2).toLowerCase()));
  assert.ok(data.endsWith('0'.repeat(64))); // broker 0 = futures
});

/** A stand-in for Aster that checks every signature the way Aster does. */
function mockAster() {
  const calls = [];
  const agents = new Map();
  let builderCap = null;
  const domain = (chainId) => ({ name: 'AsterSignTransaction', version: '1', chainId, verifyingContract: '0x0000000000000000000000000000000000000000' });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const raw = req.method === 'POST' ? body : url.search.slice(1);
      const params = new URLSearchParams(raw);
      const send = (code, json) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(json)); };
      calls.push({ method: req.method, path: url.pathname, params: Object.fromEntries(params) });
      const p = url.pathname;
      if (p === '/fapi/v3/time') return send(200, { serverTime: Date.now() });
      if (p === '/fapi/v3/exchangeInfo') return send(200, { symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'BTC', quoteAsset: 'USDT', filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' }, { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] }] });
      if (p === '/fapi/v3/ticker/24hr') return send(200, [{ symbol: 'BTCUSDT', lastPrice: '60000', priceChangePercent: '1.5', quoteVolume: '1000000' }]);
      if (p === '/fapi/v3/premiumIndex') return send(200, [{ symbol: 'BTCUSDT', markPrice: '60010', indexPrice: '60005', lastFundingRate: '0.0001' }]);
      if (p === '/fapi/v3/depth') return send(200, { bids: [['59999.9', '1.5'], ['59999.0', '2']], asks: [['60000.1', '0.4']] });
      if (p === '/fapi/v3/klines') return send(200, [[1, '1', '3', '0.5', '2', '10', 2], [3, '2', '4', '1', '3', '11', 4]]);
      if (p === '/fapi/v3/registerAndApproveAgent') {
        const msg = raw.split('&signature=')[0].split('&').map((kv) => kv.split('=').map(decodeURIComponent).join('=')).join('&');
        const who = verifyTypedData(domain(56), { Message: [{ name: 'msg', type: 'string' }] }, { msg }, params.get('signature'));
        if (who !== params.get('user')) return send(400, { code: -1022, msg: 'bad signature' });
        if (params.get('canWithdraw') !== 'false' || params.get('canSpotTrade') !== 'false') return send(400, { code: -1, msg: 'too much' });
        agents.set(params.get('agentAddress'), params.get('user'));
        return send(200, { code: 200, msg: 'success' });
      }
      if (p === '/fapi/v3/approveBuilder') {
        const keys = [...params.keys()].filter((k) => !['signature', 'signatureChainId'].includes(k));
        const cap = (k) => k[0].toUpperCase() + k.slice(1);
        const types = { ApproveBuilder: keys.map((k) => ({ name: cap(k), type: k === 'nonce' ? 'uint256' : 'string' })) };
        const message = Object.fromEntries(keys.map((k) => [cap(k), k === 'nonce' ? BigInt(params.get(k)) : params.get(k)]));
        if (verifyTypedData(domain(56), types, message, params.get('signature')) !== params.get('user')) return send(400, { code: -1022, msg: 'bad signature' });
        builderCap = params.get('maxFeeRate');
        return send(200, { code: 200, msg: 'success' });
      }
      // Everything else is signed by a trading key over the exact parameter text.
      const [msg, sig] = raw.split('&signature=');
      const signer = verifyTypedData(domain(1666), { Message: [{ name: 'msg', type: 'string' }] }, { msg }, sig ?? '0x');
      if (signer !== params.get('signer') || agents.get(signer) !== params.get('user')) return send(401, { code: -1022, msg: 'Signature for this request is not valid.' });
      if (p === '/fapi/v3/builder') return send(200, builderCap ? [{ builderAddress: KUSARI_BUILDER, maxFeeRate: builderCap }] : []);
      if (p === '/fapi/v3/account') return send(200, { totalWalletBalance: '100', availableBalance: '80', totalUnrealizedProfit: '2.5', totalMarginBalance: '102.5' });
      if (p === '/fapi/v3/positionRisk') return send(200, [{ symbol: 'BTCUSDT', positionAmt: '-0.010', entryPrice: '61000', markPrice: '60000', unRealizedProfit: '10', liquidationPrice: '66000', leverage: '10', marginType: 'isolated', isolatedWallet: '61', notional: '-600' }, { symbol: 'ETHUSDT', positionAmt: '0' }]);
      if (p === '/fapi/v3/openOrders') return send(200, [{ orderId: 7, symbol: 'BTCUSDT', side: 'BUY', origType: 'LIMIT', price: '55000', origQty: '0.002', executedQty: '0', timeInForce: 'GTX', time: 1 }]);
      if (p === '/fapi/v3/marginType') return send(400, { code: -4046, msg: 'No need to change margin type.' });
      if (p === '/fapi/v3/leverage') return send(200, { leverage: Number(params.get('leverage')) });
      if (p === '/fapi/v3/order' && req.method === 'POST') {
        if (params.get('builder') !== KUSARI_BUILDER || Number(params.get('feeRate')) > Number(builderCap ?? -1)) return send(400, { code: -2031, msg: 'Invalid builder parameter.' });
        return send(200, { orderId: 42, status: params.get('type') === 'MARKET' ? 'FILLED' : 'NEW' });
      }
      if (p === '/fapi/v3/order' && req.method === 'DELETE') return send(200, { orderId: Number(params.get('orderId')), status: 'CANCELED' });
      send(404, { code: -1, msg: 'unknown' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('enable trading, read the account, place and cancel orders against a strict stand-in', async () => {
  const m = await mockAster();
  try {
    const main = Wallet.createRandom();
    const agent = asterAgent(main.privateKey);
    const c = new AsterClient(main.address, { api: m.url, bapi: m.url });
    await assert.rejects(c.account(agent), /signature/);
    await c.registerAgent(main, agent, Date.now() + 86400_000);
    assert.equal(await c.builderCap(agent), null);
    await assert.rejects(c.order({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.001' }, agent), /Kusari fee/);
    await c.approveBuilder(main);
    assert.equal(await c.builderCap(agent), KUSARI_FEE.max);

    const acct = await c.account(agent);
    assert.equal(acct.available, 80);
    assert.equal(acct.positions.length, 1);
    assert.deepEqual([acct.positions[0].side, acct.positions[0].size, acct.positions[0].liquidation], ['short', '0.010', 66000]);
    assert.equal(acct.orders[0].postOnly, true);

    await c.prepareSymbol('BTCUSDT', 5, agent);
    assert.equal((await c.order({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: '0.001' }, agent)).status, 'FILLED');
    await c.order({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: '0.001', price: '50000', postOnly: true }, agent);
    const orders = m.calls.filter((x) => x.path === '/fapi/v3/order' && x.method === 'POST');
    assert.equal(orders.at(-2).params.feeRate, KUSARI_FEE.taker);
    assert.equal(orders.at(-1).params.feeRate, KUSARI_FEE.maker);
    assert.equal(orders.at(-1).params.timeInForce, 'GTX');
    await c.cancel('BTCUSDT', 7, agent);

    const markets = await c.markets();
    assert.equal(markets[0].symbol, 'BTCUSDT');
    assert.equal(markets[0].stepSize, '0.001');
    assert.deepEqual([markets[0].mark, markets[0].oracle, markets[0].funding], [60010, 60005, 0.0001]);
    const book = await c.book('BTCUSDT');
    assert.deepEqual(book.bids[0], { px: 59999.9, sz: 1.5 });
    assert.equal(book.asks.length, 1);
    const cs = await c.candles('BTCUSDT', '1h', 2);
    assert.deepEqual(cs[1], { t: 3, o: 2, h: 4, l: 1, c: 3, v: 11 });
    await assert.rejects(c.candles('BTCUSDT', '7m'), /interval/);

    // Nonces never repeat, even within the same microsecond.
    const seen = m.calls.filter((x) => x.params.nonce).map((x) => x.params.nonce);
    assert.equal(new Set(seen).size, seen.length);
  } finally { m.server.close(); }
});

test('a wallet key that is not the account\'s cannot register a trading key', async () => {
  const c = new AsterClient(USER, { api: 'http://127.0.0.1:1' });
  await assert.rejects(c.registerAgent(Wallet.createRandom(), asterAgent(DEMO.privateKey), 1), /does not match/);
});

test('the highest leverage is found from Aster\'s public check, even an unusual one', async () => {
  for (const max of [200, 88, 1, 1000]) {
    const calls = [];
    const server = http.createServer((req, res) => {
      const lev = Number(new URL(req.url, 'http://x').searchParams.get('leverage'));
      calls.push(lev);
      res.setHeader('content-type', 'application/json');
      if (lev >= 1 && lev <= max) res.end(JSON.stringify({ remainingOpenableNotionalValue: '1' }));
      else { res.statusCode = 400; res.end(JSON.stringify({ code: -4028, msg: 'Invalid leverage' })); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const c = new AsterClient(USER, { api: `http://127.0.0.1:${server.address().port}` });
      assert.equal(await c.maxLeverage('BTCUSDT'), max);
      assert.ok(calls.length <= 12, `${calls.length} checks for ${max}`);
    } finally { server.close(); }
  }
});
