const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Interface, Wallet } = require('ethers');
const d = require('../dist/main/dex');

const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
const ROUTER = d.UNIVERSAL_ROUTER[1];

const quoteBody = (over = {}) => ({
  routing: 'CLASSIC',
  quote: { chainId: 1, swapper: ME, input: { token: d.NATIVE, amount: '1000' }, output: { token: USDT, amount: '2000', minimumAmount: '1990', recipient: ME }, priceImpact: 0.1, gasUseEstimate: '120000', ...over },
  permitData: null,
  swapTransaction: { to: ROUTER, from: ME, data: '0x3593564c' + '00'.repeat(32), value: '1000', chainId: 1, gasLimit: '200000' },
});

async function api(tt, reply) {
  const seen = [];
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => { seen.push({ url: q.url, key: q.headers['x-api-key'], body: JSON.parse(b || '{}') }); const out = reply(q.url, JSON.parse(b || '{}')); r.statusCode = out.status ?? 200; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(out.body ?? out)); });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  tt.after(() => { server.close(); server.closeAllConnections(); });
  return { client: new d.UniswapClient('KEY', undefined, 5000, `http://127.0.0.1:${server.address().port}`), seen };
}

test('Uniswap: asks for pool routes only, with the key, and takes a matching answer', async (tt) => {
  const { client, seen } = await api(tt, () => quoteBody());
  const q = await client.quote(1n, d.NATIVE, USDT, 1000n, ME, 50);
  assert.equal(q.amountOut, 2000n);
  assert.equal(q.minOut, 1990n);
  assert.equal(seen[0].key, 'KEY');
  assert.deepEqual(seen[0].body.protocols, ['V2', 'V3', 'V4']);
  assert.equal(seen[0].body.slippageTolerance, 0.5);
  const tx = await client.swapTx(q);
  assert.equal(tx.value, 1000n);
  assert.equal(seen.length, 1, 'a ready transaction needs no second call');
});

test('Uniswap: answers that differ from the request are refused', async (tt) => {
  for (const [over, why] of [[{ swapper: USDT }, /wallet/], [{ output: { token: CAKE, amount: '2000', minimumAmount: '1990' } }, /coin received/], [{ output: { token: USDT, amount: '2000', minimumAmount: '1990', recipient: USDT } }, /receiver/], [{ input: { token: d.NATIVE, amount: '999' } }, /amount sent/], [{ output: { token: USDT, amount: '2000', minimumAmount: '1000', recipient: ME } }, /minimum/], [{ chainId: 56 }, /network/]]) {
    const { client } = await api(tt, () => quoteBody(over));
    await assert.rejects(client.quote(1n, d.NATIVE, USDT, 1000n, ME, 50), why);
  }
  const { client } = await api(tt, () => ({ ...quoteBody(), routing: 'DUTCH_V2' }));
  await assert.rejects(client.quote(1n, d.NATIVE, USDT, 1000n, ME, 50), /kind of route/);
});

test('the swap transaction must go to the pinned router with the right value', () => {
  const q = { chainId: 1n, tokenIn: d.NATIVE, amountIn: 1000n };
  const ok = { to: ROUTER, data: '0x3593564c00', value: '1000' };
  assert.equal(d.checkRouterTx(ok, q).to.toLowerCase(), ROUTER);
  assert.throws(() => d.checkRouterTx({ ...ok, to: USDT }, q), /unknown contract/);
  assert.throws(() => d.checkRouterTx({ ...ok, value: '1' }, q), /amount/);
  assert.throws(() => d.checkRouterTx({ ...ok, data: '0xa9059cbb00' }, q), /not a router call/);
  assert.throws(() => d.checkRouterTx({ ...ok, value: '1000' }, { ...q, tokenIn: USDT }), /amount/, 'selling a token sends no ETH');
});

test('the Permit2 message is narrowed to this amount for an hour, and checked first', async () => {
  const q = { chainId: 1n, tokenIn: USDT, amountIn: 5_000_000n };
  const permit = { domain: { name: 'Permit2', chainId: 1, verifyingContract: d.PERMIT2 }, types: { PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }], PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] }, values: { details: { token: USDT, amount: (2n ** 160n - 1n).toString(), expiration: '9999999999', nonce: '0' }, spender: ROUTER, sigDeadline: '9999999999' } };
  const n = d.narrowPermit(permit, q, 1_000_000);
  assert.equal(n.values.details.amount, '5000000');
  assert.equal(n.values.details.expiration, '1003600');
  assert.equal(n.values.sigDeadline, '1001800');
  await new Wallet('0x' + '11'.repeat(32)).signTypedData(n.domain, { PermitSingle: n.types.PermitSingle, PermitDetails: n.types.PermitDetails }, n.values);
  assert.throws(() => d.narrowPermit({ ...permit, values: { ...permit.values, spender: USDT } }, q, 0), /spender/);
  assert.throws(() => d.narrowPermit({ ...permit, domain: { ...permit.domain, verifyingContract: USDT } }, q, 0), /Permit2/);
  assert.throws(() => d.narrowPermit({ ...permit, values: { ...permit.values, details: { ...permit.values.details, token: CAKE } } }, q, 0), /coin/);
});

test('approvals: exactly the amount, none when enough, Tether reset to zero first', () => {
  const erc = new Interface(['function approve(address,uint256)']);
  assert.deepEqual(d.approvalCalls(CAKE, d.PERMIT2, 100n, 100n), []);
  const one = d.approvalCalls(CAKE, d.PERMIT2, 100n, 5n);
  assert.deepEqual(one.map((c) => c.label), ['approve']);
  assert.deepEqual(erc.decodeFunctionData('approve', one[0].data).map(String), [d.PERMIT2, '100']);
  assert.deepEqual(d.approvalCalls(USDT, d.PERMIT2, 100n, 5n).map((c) => c.label), ['reset', 'approve']);
  assert.deepEqual(d.approvalCalls(USDT, d.PERMIT2, 100n, 0n).map((c) => c.label), ['approve']);
});

test('PancakeSwap: the best of the direct and hub paths, and the right router call for each direction', async () => {
  const p = new Interface(['function getAmountsOut(uint256,address[]) view returns (uint256[])', 'function swapExactETHForTokens(uint256,address[],address,uint256)', 'function swapExactTokensForETH(uint256,uint256,address[],address,uint256)', 'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)']);
  const call = async (to, data) => {
    assert.equal(to, d.PANCAKE_ROUTER);
    const [, path] = p.decodeFunctionData('getAmountsOut', data);
    if (path.length === 2) return p.encodeFunctionResult('getAmountsOut', [[1000n, 300n]]);
    if (path[1].toLowerCase() === '0x55d398326f99059ff775485246999027b3197955') throw new Error('no pool');
    return p.encodeFunctionResult('getAmountsOut', [[1000n, 1n, 500n]]);
  };
  const q = await d.pancakeQuote(call, CAKE, '0x000Ae314E2A2172a039B26378814C252734f556A', 1000n, 100);
  assert.equal(q.amountOut, 500n, 'through BNB pays more here');
  assert.equal(q.minOut, 495n);
  assert.equal(q.path.length, 3);
  const deadline = 1234;
  assert.equal(p.parseTransaction({ data: d.pancakeSwapCall(q, ME, deadline).data }).name, 'swapExactTokensForTokens');
  const buy = await d.pancakeQuote(call, d.NATIVE, CAKE, 1000n, 50);
  const c = d.pancakeSwapCall(buy, ME, deadline);
  assert.equal(p.parseTransaction({ data: c.data }).name, 'swapExactETHForTokens');
  assert.equal(c.value, 1000n);
  const sell = d.pancakeSwapCall(await d.pancakeQuote(call, CAKE, d.NATIVE, 1000n, 50), ME, deadline);
  assert.equal(p.parseTransaction({ data: sell.data }).name, 'swapExactTokensForETH');
  assert.equal(sell.value, 0n);
  assert.equal(p.parseTransaction({ data: sell.data }).args[3], ME, 'paid to this wallet');
});

test('slippage limits stay between 0.05% and 5%', () => {
  assert.equal(d.minAfterSlippage(10_000n, 50), 9_950n);
  assert.throws(() => d.minAfterSlippage(10_000n, 1));
  assert.throws(() => d.minAfterSlippage(10_000n, 1000));
});
