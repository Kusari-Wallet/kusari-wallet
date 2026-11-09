const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Wallet, verifyTypedData } = require('ethers');
const {
  HlClient, hlAgent, signL1, signUser, actionHash, hlPrice, hlSize, liquidationPrice, builderFee, encodeDeposit, KUSARI_BUILDER, KUSARI_FEE, HL_BRIDGE, feeText,
} = require('../dist/main/hyperliquid');

// A public demo key. The expected values were made with Hyperliquid's own Python SDK (hyperliquid-python-sdk),
// so these pin our msgpack hashing and both signing schemes to theirs.
const K = new Wallet('0x4fd0a42218f3eae43a6ce26d22544e986139a01e5b34a62db53757ffca81bae1');
const B = KUSARI_BUILDER.toLowerCase();
const N = 1794222182305;
const rsv = (r, s, v) => ({ r, s, v });

test('L1 actions hash and sign exactly as the Hyperliquid SDK does', async () => {
  const order = { type: 'order', orders: [{ a: 0, b: true, p: '101240', s: '0.0012', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na', builder: { b: B, f: 35 } };
  assert.equal(actionHash(order, N), '0x23ce33f9aae35621253fda48cee3c07b20b3d171497ddacb88c919692c6f4c58');
  assert.deepEqual(await signL1(K, order, N), rsv('0xf692cc0785586fcf5c5da4845fa787ea34145467a5cccbe8cc2491076039989d', '0x55a24f86e817beb3c30e144437004247d086328721efdb0f3ddeb126e620f76e', 28));
  assert.deepEqual(await signL1(K, { type: 'updateLeverage', asset: 3, isCross: false, leverage: 25 }, N), rsv('0x4edea978e35f54f2886c8d630468f0771219ba1ff669a004087a190d74f6f59c', '0x63879f80b0d5a95f9baebc144ace397319d96b755c04b4a0be16190a4b71665d', 28));
  assert.deepEqual(await signL1(K, { type: 'cancel', cancels: [{ a: 1, o: 123456789 }] }, N), rsv('0xdbb20ebce6b9a27deeaf7990ef1e11af260374426a1091adb00eeefe76d0f20b', '0x2c8247fb7464b2f69700e9c34debc72f1dd22d9bfc4be1da5f58b1d7896e835b', 27));
});

test('wallet-signed actions match the SDK: trading key, Kusari fee cap, withdrawal', async () => {
  const u = (a) => signUser(K, { ...a, signatureChainId: '0xa4b1', hyperliquidChain: 'Mainnet' });
  assert.deepEqual(await u({ type: 'approveAgent', agentAddress: '0x21cf8ae13bb72632562c6fff438652ba1a151bb0', agentName: 'Kusari', nonce: N }), rsv('0xaa0432240eaca7e13af5010bc65ecfc345021a376c54e3679f47b90fd0d923c9', '0x5ec5e64b23ae65a37079379b9e70b1290e1c48e976ff1ab88d559bc56d9a3e4b', 28));
  assert.deepEqual(await u({ type: 'approveBuilderFee', maxFeeRate: '0.035%', builder: B, nonce: N }), rsv('0x7eaea5f54e4d4eaba6c4ec521d5478ac26b78e95cd05fb7ebe5d0ebed472a310', '0x3d460263e241925eb9a04a1bbcd2d8f273cb5df205aeebb9c78ebb7ef54431f1', 28));
  assert.deepEqual(await u({ type: 'spotSend', destination: '0x2222222222222222222222222222222222222222', token: 'HYPE:0x0d01dc56dcaaca66ad901c959b4011ec', amount: '1.5', time: N }), rsv('0x91816a494247382fb1120a088a4939831ccb9825492b18184dc5ae532473b62e', '0x72bb091b1ca32e949302d754309c986b737f55b796914ca7bde89fc646679344', 27));
  assert.deepEqual(await u({ type: 'withdraw3', destination: '0x63dd5acc6b1aa0f563956c0e534dd30b6dcf7c4e', amount: '12.5', time: N }), rsv('0xc752ba0dd847e56f1eb858575e2876e69bcb6b160218a4210a7e44832e43482b', '0x74de36c5ae6a57626dd9aa56a775dc0d9944e0c06289c3dd1c67403cc3cbb674', 27));
});

test('the trading key is fixed per wallet and is not the wallet key', () => {
  assert.equal(hlAgent(K.privateKey).address, hlAgent(K.privateKey).address);
  assert.notEqual(hlAgent(K.privateKey).address, K.address);
});

test('prices keep 5 significant figures and the market\'s decimals; sizes round down', () => {
  assert.equal(hlPrice(74130.4, 5), '74130');
  assert.equal(hlPrice(123456.7, 5), '123457');
  assert.equal(hlPrice(3912.66, 4), '3912.7');
  assert.equal(hlPrice(0.0123456, 0), '0.012346');
  assert.equal(hlPrice(1.234567, 2), '1.2346');
  assert.equal(hlPrice(77836.5, 5, 'up'), '77837');
  assert.equal(hlSize(0.00134999, 5), '0.00134');
  assert.equal(hlSize(12.9, 0), '12');
});

test('Kusari fee: post-only pays the maker rate, everything else the taker rate', () => {
  assert.equal(builderFee('Alo'), KUSARI_FEE.maker);
  assert.equal(builderFee('Gtc'), KUSARI_FEE.taker);
  assert.equal(builderFee('Ioc'), KUSARI_FEE.taker);
  assert.equal(feeText(KUSARI_FEE.max), '0.035%');
  assert.equal(feeText(KUSARI_FEE.maker), '0.01%');
});

test('liquidation estimate of an isolated position', () => {
  // 10x long of 0.1 BTC at 60000 on a 40x market: margin 600, maintenance 1/80 of the notional.
  const long = liquidationPrice('long', 60000, 0.1, 600, 40);
  assert.ok(long > 54500 && long < 54800, String(long));
  const short = liquidationPrice('short', 60000, 0.1, 600, 40);
  assert.ok(short > 65100 && short < 65400, String(short));
});

test('a deposit is a USDC transfer to the bridge', () => {
  const data = encodeDeposit(25_000_000n);
  assert.ok(data.startsWith('0xa9059cbb'));
  assert.ok(data.toLowerCase().includes(HL_BRIDGE.slice(2).toLowerCase()));
});

/** A stand-in for Hyperliquid that checks every signature the way Hyperliquid does. */
function mockHl() {
  const calls = [];
  const st = { agents: new Map(), builder: new Map(), orders: [] };
  const userDomain = (c) => ({ name: 'HyperliquidSignTransaction', version: '1', chainId: Number(c), verifyingContract: '0x0000000000000000000000000000000000000000' });
  const TYPES = {
    approveAgent: ['HyperliquidTransaction:ApproveAgent', [['hyperliquidChain', 'string'], ['agentAddress', 'address'], ['agentName', 'string'], ['nonce', 'uint64']]],
    approveBuilderFee: ['HyperliquidTransaction:ApproveBuilderFee', [['hyperliquidChain', 'string'], ['maxFeeRate', 'string'], ['builder', 'address'], ['nonce', 'uint64']]],
    withdraw3: ['HyperliquidTransaction:Withdraw', [['hyperliquidChain', 'string'], ['destination', 'string'], ['amount', 'string'], ['time', 'uint64']]],
  };
  const sig = (s) => require('ethers').Signature.from(s).serialized;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      calls.push({ path: req.url, body: j });
      const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (req.url === '/info') {
        if (j.type === 'extraAgents') return send([...st.agents.entries()].filter(([, u]) => u === j.user.toLowerCase()).map(([address]) => ({ address, name: 'Kusari', validUntil: Date.now() + 1e9 })));
        if (j.type === 'maxBuilderFee') return send(st.builder.get(j.user.toLowerCase()) ?? 0);
        if (j.type === 'metaAndAssetCtxs') return send([{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }] }, [{ markPx: '60000', midPx: '60000', prevDayPx: '59000', dayNtlVlm: '1000', funding: '0.0000125' }, { markPx: '3000', midPx: '3000', prevDayPx: '3100', dayNtlVlm: '500' }]]);
        if (j.type === 'userFees') return send({ userAddRate: '0.00015', userCrossRate: '0.00045' });
        if (j.type === 'clearinghouseState') return send({ marginSummary: { accountValue: '100', totalRawUsd: '100' }, withdrawable: '80', assetPositions: [{ position: { coin: 'BTC', szi: '-0.01', entryPx: '61000', positionValue: '600', unrealizedPnl: '10', liquidationPx: '66000', leverage: { type: 'isolated', value: 10 }, marginUsed: '61' } }] });
        if (j.type === 'frontendOpenOrders') return send([{ coin: 'BTC', side: 'B', limitPx: '55000', sz: '0.002', origSz: '0.002', oid: 7, timestamp: 1, reduceOnly: false, tif: 'Alo' }]);
        return send(null);
      }
      const a = j.action;
      if (TYPES[a.type]) {
        const [primary, fields] = TYPES[a.type];
        const who = verifyTypedData(userDomain(a.signatureChainId), { [primary]: fields.map(([name, type]) => ({ name, type })) }, a, sig(j.signature)).toLowerCase();
        if (a.type === 'approveAgent') st.agents.set(a.agentAddress, who);
        if (a.type === 'approveBuilderFee') st.builder.set(who, Math.round(parseFloat(a.maxFeeRate) * 1000));
        if (a.type === 'withdraw3') st.withdraw = { who, ...a };
        return send({ status: 'ok', response: { type: 'default' } });
      }
      // L1 actions: recover the trading key from the phantom agent, and it must be approved for some account.
      const { actionHash: h } = require('../dist/main/hyperliquid');
      const signer = verifyTypedData({ name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' }, { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] }, { source: 'a', connectionId: h(a, j.nonce) }, sig(j.signature)).toLowerCase();
      const user = st.agents.get(signer);
      if (!user) return send({ status: 'err', response: `User or API Wallet ${signer} does not exist.` });
      if (a.type === 'updateLeverage') return send({ status: 'ok', response: { type: 'default' } });
      if (a.type === 'order') {
        const o = a.orders[0];
        if (a.builder.f > (st.builder.get(user) ?? -1)) return send({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Builder fee has not been approved.' }] } } });
        st.orders.push(a);
        return send({ status: 'ok', response: { type: 'order', data: { statuses: [o.t.limit.tif === 'Ioc' ? { filled: { oid: 42, avgPx: '60010', totalSz: o.s } } : { resting: { oid: 43 } }] } } });
      }
      if (a.type === 'cancel') return send({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } });
      send({ status: 'err', response: 'unknown' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, st, url: `http://127.0.0.1:${server.address().port}` })));
}

test('turn on trading, read the account, place and cancel orders against a strict stand-in', async () => {
  const m = await mockHl();
  try {
    const main = Wallet.createRandom();
    const agent = hlAgent(main.privateKey);
    const c = new HlClient(main.address, { api: m.url });
    assert.deepEqual(await c.status(agent), { agent: false, builder: false, until: 0 });
    await assert.rejects(c.order({ asset: 0, buy: true, price: '61000', size: '0.001', tif: 'Ioc' }, agent), /does not know the trading key/);
    await c.enable(main, agent);
    const s = await c.status(agent);
    assert.equal(s.agent && s.builder, true);

    const acct = await c.account();
    assert.deepEqual([acct.available, acct.positions[0].side, acct.positions[0].size, acct.orders[0].postOnly], [80, 'short', '0.01', true]);
    await c.setLeverage(0, 10, agent);
    assert.equal((await c.order({ asset: 0, buy: true, price: '63000', size: '0.001', tif: 'Ioc' }, agent)).status, 'FILLED');
    assert.equal((await c.order({ asset: 0, buy: true, price: '55000', size: '0.001', tif: 'Alo' }, agent)).status, 'NEW');
    assert.deepEqual(m.st.orders.map((o) => [o.builder.b, o.builder.f]), [[B, 35], [B, 10]]);
    await c.cancel(0, 7, agent);
    await c.withdraw(main, '5');
    assert.equal(m.st.withdraw.who, main.address.toLowerCase());
    assert.equal(m.st.withdraw.destination, main.address.toLowerCase());

    const markets = await c.markets();
    assert.deepEqual([markets[0].symbol, markets[0].maxLeverage, markets[0].asset], ['BTC', 40, 0]);
    const nonces = m.calls.filter((x) => x.path === '/exchange').map((x) => x.body.nonce);
    assert.equal(new Set(nonces).size, nonces.length);
  } finally { m.server.close(); }
});

test('a wallet key that is not the account\'s cannot approve anything', async () => {
  const c = new HlClient(K.address, { api: 'http://127.0.0.1:1' });
  await assert.rejects(c.enable(Wallet.createRandom(), hlAgent(K.privateKey)), /does not match/);
});

const { weightedMedian, spotOf, kusariIndex } = require('../dist/main/kindex');

test('Kusari index: weighted median, per-thousand coins, broken books left out', async () => {
  assert.equal(weightedMedian([{ price: 1, weight: 3 }, { price: 2, weight: 2 }, { price: 3, weight: 2 }]), 2);
  assert.equal(weightedMedian([{ price: 1, weight: 1 }, { price: 3, weight: 1 }]), 2);
  assert.equal(weightedMedian([{ price: 100, weight: 3 }, { price: 1, weight: 1 }, { price: 2, weight: 1 }]), 100, 'Binance outweighs two small venues');
  assert.deepEqual(spotOf('kPEPE'), { base: 'PEPE', scale: 1000 });
  assert.deepEqual(spotOf('BTC'), { base: 'BTC', scale: 1 });
  assert.equal(spotOf('@107'), null);
  const books = { Binance: { bidPrice: '100', askPrice: '102' }, OKX: { data: [{ bidPx: '100', askPx: '100.2' }] }, Gate: [{ highest_bid: '50', lowest_ask: '90' }], MEXC: { bidPrice: '101', askPrice: '101.4' } };
  const server = http.createServer((req, res) => {
    const name = req.url.split('/')[1];
    res.setHeader('content-type', 'application/json');
    if (!books[name]) { res.statusCode = 404; return res.end('{}'); }
    res.end(JSON.stringify(books[name]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const root = `http://127.0.0.1:${server.address().port}`;
    const base = Object.fromEntries(['Binance', 'OKX', 'Bybit', 'Kraken', 'KuCoin', 'Gate', 'MEXC'].map((n) => [n, `${root}/${n}`]));
    const k = await kusariIndex('BTC', { base });
    assert.deepEqual(k.quotes.map((q) => q.name), ['Binance', 'OKX', 'MEXC']);
    assert.ok(k.failed.includes('Gate'), 'a book 80% wide is broken, not a price');
    assert.equal(k.price, 101, 'Binance ×3 of 6 total, with OKX below it and MEXC above');
    const pepe = await kusariIndex('kPEPE', { base });
    assert.equal(pepe.quotes[0].price, 101000);
  } finally { server.close(); }
});
