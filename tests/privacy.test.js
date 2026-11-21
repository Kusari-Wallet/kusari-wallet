const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { WalletService } = require('../dist/main/service');

const ETH_ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ETH_OUT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ETH_DEPOSIT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const BTC_OUT = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const BTC_ME = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const XMR_ME = '4' + 'A'.repeat(94);
const XMR_DEPOSIT = '8' + 'D'.repeat(94);

async function setup(t) {
  const orders = [];
  const v = { status: {} };
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => {
      const u = new URL(q.url, 'http://x');
      const json = b ? JSON.parse(b) : {};
      const send = (o) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
      // Exolix
      if (u.pathname === '/ex/rate') return send({ fromAmount: 1, toAmount: Number(u.searchParams.get('amount')) * 2, rate: 2, minAmount: 0, maxAmount: 1000 });
      if (u.pathname.startsWith('/ex/currencies/')) return send([]);
      if (u.pathname === '/ex/transactions' && q.method === 'POST') {
        orders.push({ provider: 'exolix', ...json });
        return send({ id: `EX${orders.length}`, amount: json.amount, amountTo: json.amount * 2, depositAddress: json.coinFrom === 'XMR' ? XMR_DEPOSIT : json.coinFrom === 'BTC' ? BTC_OUT : ETH_DEPOSIT, withdrawalAddress: json.withdrawalAddress, refundAddress: json.refundAddress, rate: 2, status: 'wait' });
      }
      if (u.pathname.startsWith('/ex/transactions/')) return send({ id: u.pathname.split('/').pop(), status: v.status[u.pathname.split('/').pop()] ?? 'exchanging' });
      // SimpleSwap
      if (u.pathname === '/ss/v3/estimates') return send({ result: { estimatedAmount: String(Number(u.searchParams.get('amount')) * 1.9) } });
      if (u.pathname === '/ss/v3/exchanges' && q.method === 'POST') {
        orders.push({ provider: 'simpleswap', ...json });
        return send({ result: { publicId: `SS${orders.length}`, addressFrom: json.tickerFrom === 'xmr' ? XMR_DEPOSIT : ETH_DEPOSIT, addressTo: json.addressTo, userRefundAddress: json.userRefundAddress, amountFrom: json.amount, amountTo: String(Number(json.amount) * 1.9), tickerFrom: json.tickerFrom, tickerTo: json.tickerTo, networkFrom: json.networkFrom, networkTo: json.networkTo } });
      }
      if (u.pathname.startsWith('/ss/v3/exchanges/')) return send({ result: { status: v.status[u.pathname.split('/').pop()] ?? 'exchanging' } });
      r.statusCode = 404; r.end('{}');
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new WalletService(dir, undefined, { swapBase: `${base}/ex`, simpleSwapBase: `${base}/ss` });
  s.settings.simpleSwapKey = 'K';
  const sent = [];
  let subs = 0;
  v.received = { total: 0n, unlocked: 0n };
  s.tron = { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' };
  s.btc = { receiveAddress: BTC_ME, refresh: async () => {}, draft: async (to, amount) => ({ to, amount, fee: 1n }), send: async () => 'ab'.repeat(32) };
  s.eth = { address: ETH_ME, draft: async (asset, to, amount) => ({ asset, to, amount, expectedFee: 1n }), send: async (d) => { sent.push(d); return '0x' + 'cd'.repeat(32); } };
  s.dash = { receiveAddress: 'X', refresh: async () => {} };
  s.firo = { receiveAddress: 'a', refresh: async () => {} };
  s.doge = { receiveAddress: 'D', refresh: async () => {}, getBalance: async () => ({ total: 1n, spendable: 1n }) }; s.sol = { receiveAddress: 'S', getBalance: async () => ({ total: 1n, spendable: 1n }) };
  s.monero = {
    getPrimaryAddress: async () => XMR_ME,
    isValidAddress: async (a) => /^[48][A-Za-z]{94}$/.test(a),
    createSubaddress: async () => `8${String(++subs).repeat(1)}${'S'.repeat(93)}`,
    receivedBy: async () => v.received,
    draft: async (to, amount, extra) => ({ to, amount, fee: 1n, ...(extra ? { extra } : {}) }),
    relay: async (d) => { sent.push(d); return ['ef'.repeat(32)]; },
  };
  s.vault.open = async () => ({ tronMnemonic: 'test test test test test test test test test test test junk' });
  return { s, orders, sent, v };
}

test('swap to an outside address: checked for the target coin, sent in the order', async (t) => {
  const { s, orders } = await setup(t);
  await assert.rejects(s.swapPrepare('ETH', 'BTC', '1', 'exolix', ETH_OUT), /not a BTC address/);
  await assert.rejects(s.swapPrepare('BTC', 'USDTE', '1', 'exolix', '0xdAC17F958D2ee523a2206206994597C13D831ec7'), /contract/);
  assert.equal(orders.length, 0, 'no order for a bad address');
  const p = await s.swapPrepare('ETH', 'BTC', '1', 'exolix', BTC_OUT);
  assert.equal(p.swap.external, true);
  assert.equal(p.swap.receiveAddress, BTC_OUT);
  assert.equal(orders[0].withdrawalAddress, BTC_OUT);
  assert.equal(orders[0].refundAddress, ETH_ME, 'refunds still come home');
  const res = await s.swapConfirm(p.id, 'pw');
  assert.equal(res.record.withdrawalAddress, BTC_OUT);
});

test('swap without an address still goes to my wallet', async (t) => {
  const { s, orders } = await setup(t);
  const p = await s.swapPrepare('ETH', 'BTC', '1', 'exolix');
  assert.equal(p.swap.external, false);
  assert.equal(orders[0].withdrawalAddress, BTC_ME);
});

test('privacy: every coin but XMR and KSR, destination required, own address refused', async (t) => {
  const { s, orders } = await setup(t);
  await assert.rejects(s.privacyQuote('XMR', 'BTC', '1'), /can't go through a privacy swap/);
  await assert.rejects(s.privacyPrepare('ETH', 'XMR', '1', 'exolix', XMR_ME), /can't go through a privacy swap/);
  await assert.rejects(s.privacyQuote('KSR', 'BTC', '1'), /can't go through a privacy swap/);
  await assert.rejects(s.privacyPrepare('ETH', 'BTC', '1', 'exolix', ' '), /requires/);
  await assert.rejects(s.privacyPrepare('ETH', 'ETH', '1', 'exolix', ETH_ME.toLowerCase()), /no privacy benefit/);
  assert.equal(orders.length, 0);
});

test('privacy quote uses a different service on each side', async (t) => {
  const { s } = await setup(t);
  const q = await s.privacyQuote('ETH', 'BTC', '1');
  assert.notEqual(q.first.providerId, q.second.providerId);
  assert.equal(q.sameProvider, false);
  s.settings.simpleSwapKey = '';
  const one = await s.privacyQuote('ETH', 'BTC', '1');
  assert.equal(one.sameProvider, true, 'said plainly when only one service exists');
});

test('privacy: full path, two orders, nothing moves in step two without approval', async (t) => {
  const { s, orders, sent, v } = await setup(t);
  const a = await s.privacyPrepare('ETH', 'ETH', '1', 'exolix', ETH_OUT);
  const via = orders[0].withdrawalAddress;
  assert.match(via, /^81S/, 'fresh subaddress, not the primary address');
  assert.notEqual(via, XMR_ME);
  assert.equal(orders[0].refundAddress, ETH_ME);
  const { privacy: p } = await s.swapConfirm(a.id, 'pw');
  assert.equal(p.stage, 'first');
  assert.equal(p.to, 'ETH');
  assert.equal(sent.length, 1);

  await assert.rejects(s.privacySecond(p.id, '1', 'simpleswap'), /unlocks/);
  v.received = { total: 2_000_000_000_000n, unlocked: 0n };
  let now = await s.privacyRefresh(p.id);
  assert.equal(now.stage, 'first', 'arrived but locked');
  assert.equal(now.received, '2');
  v.received = { total: 2_000_000_000_000n, unlocked: 2_000_000_000_000n };
  now = await s.privacyRefresh(p.id);
  assert.equal(now.stage, 'ready');
  assert.equal(sent.length, 1, 'arrival alone sends nothing');

  await assert.rejects(s.privacySecond(p.id, '2.5', 'simpleswap'), /up to 2 XMR/);
  const offers = await s.privacySecondQuote(p.id, '1.5');
  assert.equal(offers[0].providerId, 'simpleswap', 'other service offered first');
  const b = await s.privacySecond(p.id, '1.5', 'simpleswap');
  assert.equal(orders[1].addressTo, ETH_OUT);
  assert.equal(orders[1].userRefundAddress, via, 'refund returns to the same subaddress');
  assert.equal(orders[1].tickerFrom, 'xmr');
  assert.equal(orders[1].tickerTo, 'eth');
  assert.equal(b.swap.external, true);
  // Kusari Wallet's 0.3% leaves in the same Monero transaction; the service gets the rest.
  assert.equal(orders[1].amount, '1.4955');
  assert.equal(b.amount, '1.4955');
  assert.ok(b.warnings.some((w) => /Kusari Wallet's fee: 0.0045 XMR \(0.3%\)/.test(w)));
  const done = await s.swapConfirm(b.id, 'pw');
  assert.equal(done.privacy.stage, 'second');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].extra, { address: '46ZEpH2zBmjCu1cRXiN6DYbwZDvw5LUrRNKKeketbJNv7f8thMEbFABSoZVYT6nJ2CGQfPvAXcEficrwZXN35mdZLTBHVNL', amount: 4_500_000_000n });
  assert.equal(sent[0].extra, undefined, 'step one carries no fee');
  v.status[done.privacy.secondId] = 'finished';
  assert.equal((await s.privacyRefresh(p.id)).stage, 'done');
  assert.equal((await s.privacyList())[0].stage, 'done', 'saved');
});

test('privacy: a refunded step stops the flow and says why', async (t) => {
  const { s, v } = await setup(t);
  const a = await s.privacyPrepare('ETH', 'BTC', '1', 'exolix', BTC_OUT);
  const { privacy: p } = await s.swapConfirm(a.id, 'pw');
  v.status[p.firstId] = 'refunded';
  const now = await s.privacyRefresh(p.id);
  assert.equal(now.stage, 'failed');
  assert.match(now.note, /refund/);
  await assert.rejects(s.privacySecond(p.id, '1', 'simpleswap'), /unlocks/);
});

test('privacy: a tampered order in step one stops before any signing', async (t) => {
  const { s, sent } = await setup(t);
  const realCreate = s.swapClients;
  s.swapClients = function () {
    const c = realCreate.call(this);
    const q = c.exolix.create.bind(c.exolix);
    c.exolix.create = async (...args) => { const o = await q(...args); throw new Error(`The provider's answer differs from the request, so this was stopped: ${o.id}`); };
    return c;
  };
  await assert.rejects(s.privacyPrepare('ETH', 'BTC', '1', 'exolix', BTC_OUT), /stopped/);
  assert.equal(sent.length, 0);
  assert.equal((await s.privacyList()).length, 0);
});
