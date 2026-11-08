const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { AbiCoder } = require('ethers');
const { ARBITRUM, BSC, ETHEREUM, POLYGON, chainOf, EthClient } = require('../dist/main/eth');
const { SPL_TOKENS, tokenAccountOf, signSolUsdtTransfer, solAddress } = require('../dist/main/sol');
const { AAVE_MARKETS, aaveCall, readAave } = require('../dist/main/aave');
const { mirror } = require('../dist/main/prices');

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('each new token sits on its own chain with the contract and decimals from the public lists', () => {
  assert.equal(chainOf('USDTB'), BSC);
  assert.equal(chainOf('BNB'), BSC);
  assert.equal(BSC.id, 56n);
  assert.equal(BSC.tokens.USDTB.decimals, 18, 'USDT on BNB Smart Chain has 18 decimals');
  assert.equal(ETHEREUM.tokens.NEARE, undefined, 'NEAR is native now, not the Ethereum token');
  assert.equal(POLYGON.tokens.ETHP.contract, '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 'ETH on Polygon');
  assert.equal(chainOf('ETHP'), POLYGON);
  for (const a of ['UNI', 'PEPE', 'AAVE']) assert.equal(chainOf(a), ETHEREUM, a);
  assert.equal(SPL_TOKENS.JUP.decimals, 6);
  // Circle's native USDC on each chain, as the chains report it; BNB Smart Chain's has 18 decimals.
  assert.equal(chainOf('USDCE'), ETHEREUM); assert.equal(ETHEREUM.tokens.USDCE.contract, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'); assert.equal(ETHEREUM.tokens.USDCE.decimals, 6);
  assert.equal(chainOf('USDCB'), BSC); assert.equal(BSC.tokens.USDCB.contract, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'); assert.equal(BSC.tokens.USDCB.decimals, 18);
  assert.equal(chainOf('USDCP'), POLYGON); assert.equal(POLYGON.tokens.USDCP.contract, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359');
  assert.equal(chainOf('USDCA'), ARBITRUM); assert.equal(ARBITRUM.tokens.USDCA.contract, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
  assert.equal(SPL_TOKENS.USDCS.mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); assert.equal(SPL_TOKENS.USDCS.decimals, 6);
  assert.equal(SPL_TOKENS.RAY.mint, '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R');
});

test('a JUP send names the JUP mint, its decimals and JUP token accounts, never USDT\'s', () => {
  const to = 'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW';
  const draft = { to, toAccount: tokenAccountOf(to, SPL_TOKENS.JUP.mint), create: false, amount: 1234n, fee: 5000n, asset: 'JUP' };
  const { base64 } = signSolUsdtTransfer(M, draft, '11111111111111111111111111111111');
  const raw = Buffer.from(base64, 'base64');
  const has = (b58) => raw.includes(Buffer.from(require('@scure/base').base58.decode(b58)));
  assert.ok(has(SPL_TOKENS.JUP.mint));
  assert.ok(has(tokenAccountOf(solAddress(M), SPL_TOKENS.JUP.mint)));
  assert.ok(!has(SPL_TOKENS.USDTS.mint));
  assert.throws(() => signSolUsdtTransfer(M, { ...draft, toAccount: tokenAccountOf(to) }, '11111111111111111111111111111111'), /does not match/);
});

test('BNB Smart Chain history comes from an Etherscan-style API, real token only', async (tt) => {
  const me = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
  const server = http.createServer((q, r) => {
    r.setHeader('content-type', 'application/json');
    const u = new URL(q.url, 'http://x');
    if (u.searchParams.get('action') === 'tokentx') {
      return r.end(JSON.stringify({ status: '1', result: [
        { hash: '0x' + 'a'.repeat(64), from: '0x1111111111111111111111111111111111111111', to: me.toLowerCase(), value: '2000000000000000000', contractAddress: BSC.tokens.USDTB.contract.toLowerCase(), timeStamp: '1700000000' },
        { hash: '0x' + 'b'.repeat(64), from: '0x1111111111111111111111111111111111111111', to: me, value: '9000000000000000000', contractAddress: '0x2222222222222222222222222222222222222222', timeStamp: '1700000001' },
      ] }));
    }
    r.end(JSON.stringify({ status: '0', message: 'No transactions found', result: [] }));
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  tt.after(() => { server.close(); server.closeAllConnections(); });
  const c = new EthClient(['http://127.0.0.1:1'], `http://127.0.0.1:${server.address().port}/etherscan/api`, '', me, undefined, 5000, BSC);
  const h = await c.getHistory('USDTB');
  assert.deepEqual(h.map((x) => [x.direction, x.amount]), [['in', '2']], 'a look-alike token is left out');
  assert.deepEqual(await c.getHistory('BNB'), []);
});

test('Aave oracle: the call asks getAssetsPrices for the listed tokens, and answers are checked', () => {
  const eth = AAVE_MARKETS.find((m) => m.chain === 'eth');
  assert.ok(aaveCall(eth).startsWith('0x9d23d9f2'), 'getAssetsPrices(address[])');
  const coder = AbiCoder.defaultAbiCoder();
  const prices = eth.assets.map(([a]) => (a === 'USDT' ? 100_000_000n : a === 'BTC' ? 9_000_000_000_000n : 300_000_000_000n));
  const got = readAave(eth, coder.encode(['uint256[]'], [prices]));
  assert.equal(got.USDT.usd, 1);
  assert.equal(got.BTC.usd, 90_000);
  assert.equal(got.ETH.change, null);
  assert.throws(() => readAave(eth, coder.encode(['uint256[]'], [prices.slice(1)])), 'wrong length');
  assert.throws(() => readAave(eth, coder.encode(['uint256[]'], [prices.map(() => 0n)])), 'zero');
  assert.throws(() => readAave(eth, coder.encode(['uint256[]'], [prices.map((p, i) => (eth.assets[i][0] === 'USDT' ? 300_000_000n : p))])), 'a dollar token at $3');
});

test('the same coin under another name gets the same price', () => {
  const p = { POL: { usd: 0.2, change: 1 }, ETH: { usd: 3000, change: 2 }, SCRT: { usd: 0.3, change: 0 } };
  mirror(p);
  assert.equal(p.ETHP.usd, 3000, 'ETH on Polygon is ETH');
  assert.equal(p.ETHA.usd, 3000);
  assert.equal(p.SSCRT.usd, 0.3);
});
