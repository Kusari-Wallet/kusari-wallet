const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Transaction } = require('ethers');
const { EthClient, deriveEthAccount, isEthAddress, encodeUsdtTransfer } = require('../dist/main/eth');

const PHRASE = 'test test test test test test test test test test test junk';
const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

function node(over = {}) {
  const log = { raw: [], calls: [] };
  const v = { chain: '0x1', eth: 10n ** 18n, usdt: 5_000_000n, base: 2_000_000_000n, tip: 1_000_000_000n, gas: 50_000n, code: '0x', items: [], ...over };
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.method === 'GET') return r.end(JSON.stringify({ items: v.items }));
      const { method, params, id } = JSON.parse(b);
      log.calls.push({ method, params });
      const ok = (result) => r.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      if (v.fail?.[method]) return r.end(JSON.stringify({ jsonrpc: '2.0', id, error: { message: v.fail[method] } }));
      if (method === 'eth_chainId') return ok(v.chain);
      if (method === 'eth_getBalance') return ok('0x' + v.eth.toString(16));
      if (method === 'eth_call') return ok('0x' + v.usdt.toString(16));
      if (method === 'eth_getBlockByNumber') return ok({ baseFeePerGas: '0x' + v.base.toString(16) });
      if (method === 'eth_maxPriorityFeePerGas') return ok('0x' + v.tip.toString(16));
      if (method === 'eth_getCode') return ok(v.code);
      if (method === 'eth_estimateGas') return ok('0x' + v.gas.toString(16));
      if (method === 'eth_getTransactionCount') return ok('0x5');
      if (method === 'eth_sendRawTransaction') { log.raw.push(params[0]); return ok('0x' + 'cd'.repeat(32)); }
      r.statusCode = 404; r.end('{}');
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    res({ server, log, v, base, client: new EthClient([base], base, USDT, ME) });
  }));
}
const closing = (t, s) => t.after(() => s.close());

test('derives the standard MetaMask first account', () => {
  assert.equal(deriveEthAccount(PHRASE).address, ME);
  assert.equal(deriveEthAccount(`  ${PHRASE.toUpperCase()} `).address, ME);
  assert.throws(() => deriveEthAccount('not a real phrase'));
});

test('address check: checksum, format, zero address', () => {
  assert.ok(isEthAddress(ME));
  assert.ok(isEthAddress(ME.toLowerCase()));
  assert.equal(isEthAddress(ME.replace('f39F', 'F39F')), false, 'bad checksum');
  assert.equal(isEthAddress('0x' + '0'.repeat(40)), false);
  assert.equal(isEthAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), false);
  assert.equal(isEthAddress(ME.slice(2)), false);
});

test('USDT transfer encoding matches the ERC-20 layout', () => {
  assert.equal(encodeUsdtTransfer(TO, 2_000_000n), '0xa9059cbb' + '0'.repeat(24) + TO.slice(2).toLowerCase() + '1e8480'.padStart(64, '0'));
});

test('ETH send: signed for mainnet by my key, exact values', async (t) => {
  const m = await node(); closing(t, m.server);
  const d = await m.client.draft('ETH', TO, 10n ** 17n);
  assert.equal(d.gas, 21000n);
  assert.equal(d.expectedFee, 21000n * 3_000_000_000n);
  assert.equal(d.maxCost, 21000n * 5_000_000_000n);
  const hash = await m.client.send(d, deriveEthAccount(PHRASE).wallet);
  const tx = Transaction.from(m.log.raw[0]);
  assert.equal(tx.hash, hash);
  assert.equal(tx.from, ME);
  assert.equal(tx.to, TO);
  assert.equal(tx.value, 10n ** 17n);
  assert.equal(tx.chainId, 1n);
  assert.equal(tx.nonce, 5);
  assert.equal(tx.type, 2);
  assert.equal(tx.maxFeePerGas, 5_000_000_000n);
});

test('ETH max leaves the worst case fee, never more than the balance', async (t) => {
  const m = await node(); closing(t, m.server);
  const d = await m.client.draft('ETH', TO, 'max');
  assert.equal(d.amount + d.maxCost, 10n ** 18n);
});

test('USDT send goes to the contract with no ETH value', async (t) => {
  const m = await node(); closing(t, m.server);
  const d = await m.client.draft('USDTE', TO, 2_000_000n);
  assert.equal(d.gas, 65000n, '30% margin on the estimate');
  await m.client.send(d, deriveEthAccount(PHRASE).wallet);
  const tx = Transaction.from(m.log.raw[0]);
  assert.equal(tx.to, USDT);
  assert.equal(tx.value, 0n);
  assert.equal(tx.data, encodeUsdtTransfer(TO, 2_000_000n));
});

test('refuses: not enough funds, no fee money, USDT contract as recipient', async (t) => {
  const m = await node(); closing(t, m.server);
  await assert.rejects(m.client.draft('ETH', TO, 10n ** 18n), /enough/);
  await assert.rejects(m.client.draft('USDTE', TO, 6_000_000n), /Not enough USDT/);
  await assert.rejects(m.client.draft('ETH', USDT, 1n), /contract/);
  m.v.eth = 1000n;
  await assert.rejects(m.client.draft('USDTE', TO, 1n), /Not enough ETH for the fee/);
  m.v.eth = 0n;
  await assert.rejects(m.client.draft('USDTE', TO, 1n), /No ETH for the fee/);
  await assert.rejects(m.client.draft('ETH', TO, 'max'), /No ETH left to send/);
});

test('refuses broken node answers: wrong chain, absurd fee, absurd gas', async (t) => {
  const wrong = await node({ chain: '0x38' }); closing(t, wrong.server);
  await assert.rejects(wrong.client.getEthBalance(), /mainnet/);
  const fee = await node({ base: 900n * 1_000_000_000n }); closing(t, fee.server);
  await assert.rejects(fee.client.draft('ETH', TO, 1n), /abnormal/);
  const gas = await node({ gas: 5_000_000n }); closing(t, gas.server);
  await assert.rejects(gas.client.draft('USDTE', TO, 1n), /abnormal/);
  const tip = await node({ tip: 900n * 1_000_000_000n }); closing(t, tip.server);
  assert.equal((await tip.client.draft('ETH', TO, 1n)).tip, 5_000_000_000n, 'tip is capped');
});

test('a node that fails is skipped; a wrong-chain node is never used', async (t) => {
  const bad = await node({ chain: '0x89', eth: 1n }); closing(t, bad.server);
  const good = await node({ eth: 42n }); closing(t, good.server);
  const client = new EthClient([bad.base, good.base], good.base, USDT, ME);
  assert.equal(await client.getEthBalance(), 42n);
});

test('wallet key that is not this wallet cannot sign', async (t) => {
  const m = await node(); closing(t, m.server);
  const d = await m.client.draft('ETH', TO, 1n);
  const other = deriveEthAccount('legal winner thank year wave sausage worth useful legal winner thank yellow').wallet;
  await assert.rejects(m.client.send(d, other), /does not match/);
  assert.equal(m.log.raw.length, 0);
});

test('history: direction, failed flag, fake tokens and zero transfers dropped', async (t) => {
  const base = { timestamp: '2026-01-01T00:00:00Z', status: 'ok', result: 'success' };
  const h = (c) => '0x' + c.repeat(64);
  const m = await node({ items: [
    { ...base, hash: h('a'), from: { hash: TO }, to: { hash: ME.toLowerCase() }, value: '1000000000000000000' },
    { ...base, hash: h('b'), from: { hash: ME }, to: { hash: TO }, value: '5', status: 'error', result: 'reverted' },
    { ...base, hash: h('c'), from: { hash: TO }, to: { hash: ME }, value: '0' },
    { ...base, hash: h('d'), from: { hash: TO }, to: { hash: USDT }, value: '1' },
  ] }); closing(t, m.server);
  const eth = await m.client.getHistory('ETH');
  assert.equal(eth.length, 2);
  assert.equal(eth[0].direction, 'in');
  assert.equal(eth[0].amount, '1');
  assert.equal(eth[0].status, 'confirmed');
  assert.equal(eth[1].status, 'failed');
  assert.ok(eth[1].direction === 'out');

  m.v.items = [
    { ...base, transaction_hash: h('1'), from: { hash: TO }, to: { hash: ME }, total: { value: '2500000', decimals: '6' }, token: { address_hash: USDT } },
    { ...base, transaction_hash: h('2'), from: { hash: TO }, to: { hash: ME }, total: { value: '2500000', decimals: '6' }, token: { address_hash: TO } },
    { ...base, transaction_hash: h('3'), from: { hash: TO }, to: { hash: ME }, total: { value: '10', decimals: '6' }, token: { address: USDT } },
  ];
  const usdt = await m.client.getHistory('USDTE');
  assert.equal(usdt.length, 2, 'look-alike token removed');
  assert.equal(usdt[0].amount, '2.5');
  assert.equal(usdt[1].dust, true);
});
