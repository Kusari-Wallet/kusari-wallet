const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { WalletService } = require('../dist/main/service');

async function make(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new WalletService(dir, undefined, { tronHost: 'http://x' });
  const v = { fail: false, calls: 0 };
  s.tron = {
    address: 'T', getTrxBalance: async () => { v.calls++; if (v.fail) throw new Error('Request failed with status code 429'); return 5_000_000n; },
    getUsdtBalance: async () => { if (v.fail) throw new Error('429'); return 7_000_000n; },
  };
  s.monero = { state: {}, getBalance: async () => ({ total: 1n, unlocked: 1n }), getPrimaryAddress: async () => '4x', close: async () => {} };
  s.btc = { receiveAddress: 'bc1p', getBalance: async () => ({ total: 1n, spendable: 1n }) };
  s.eth = { address: '0x', getEthBalance: async () => 1n, getUsdtBalance: async () => 1n };
  s.dcr = { receiveAddress: 'Ds', getBalance: async () => ({ total: 1n, spendable: 1n }) };
  s.dash = { receiveAddress: 'X', getBalance: async () => ({ total: 1n, spendable: 1n }) };
  s.firo = { receiveAddress: 'a', getBalance: async () => ({ total: 1n, spendable: 1n }) };
  return { s, v };
}

test('Tron balances are reused for a short while, so polling makes few requests', async (t) => {
  const { s, v } = await make(t);
  await s.overview(); await s.overview(); await s.overview();
  assert.equal(v.calls, 1);
});

test('a refused request keeps the last balance, marked; it recovers by itself', async (t) => {
  const { s, v } = await make(t);
  assert.equal((await s.overview()).balances.TRX.total, '5');
  s.balanceMemo.get('TRX').at -= 60_000; // past the short reuse window
  s.balanceMemo.get('USDT').at -= 60_000;
  v.fail = true;
  const bad = await s.overview();
  assert.equal(bad.balances.TRX.ok, true);
  assert.equal(bad.balances.TRX.total, '5');
  assert.equal(bad.balances.TRX.stale, true);
  assert.equal(bad.balances.USDT.stale, true);
  assert.equal(bad.balances.XMR.stale, undefined, 'others are unaffected');
  v.fail = false;
  const good = await s.overview();
  assert.equal(good.balances.TRX.stale, undefined);
});

test('one refusal is retried before anything shows as failed', async (t) => {
  const { s, v } = await make(t);
  let n = 0;
  s.tron.getTrxBalance = async () => { if (n++ === 0) throw new Error('429'); return 9_000_000n; };
  assert.equal((await s.overview()).balances.TRX.total, '9');
  void v;
});

test('never known and still failing says so; too old a value is not shown', async (t) => {
  const { s, v } = await make(t);
  v.fail = true;
  const first = await s.overview();
  assert.equal(first.balances.TRX.ok, false);
  v.fail = false;
  await s.overview();
  s.balanceMemo.get('TRX').at -= 31 * 60_000;
  v.fail = true;
  assert.equal((await s.overview()).balances.TRX.ok, false);
});

test('with Tor down no old number hides it; locking forgets balances', async (t) => {
  const { s, v } = await make(t);
  await s.overview();
  s.balanceMemo.get('TRX').at -= 60_000;
  v.fail = true;
  s.settings.torEnabled = true;
  assert.equal((await s.overview()).balances.TRX.ok, false);
  s.settings.torEnabled = false;
  await s.lock();
  assert.equal(s.balanceMemo.size, 0);
});

test('while Tor is still starting: no requests, balances wait, sends and quotes say why', async (t) => {
  const { s, v } = await make(t);
  let btcAsked = 0;
  s.btc.getBalance = async () => { btcAsked++; return { total: 1n, spendable: 1n }; };
  s.settings.torEnabled = true;
  s.tor.state = { ...s.tor.state, phase: 'starting' };
  const o = await s.overview();
  assert.equal(o.balances.TRX.pending, true);
  assert.equal(o.balances.BTC.pending, true);
  assert.equal(o.balances.XMR.ok, true, 'XMR is read from the wallet itself');
  assert.equal(v.calls, 0);
  assert.equal(btcAsked, 0);
  await assert.rejects(s.prepareSend('TRX', 'T', '1'), /Tor 연결 중/);
  await assert.rejects(s.swapQuote('TRX', 'XMR', '1'), /Tor 연결 중/);
  s.tor.state = { ...s.tor.state, phase: 'ready' };
  const ready = await s.overview();
  assert.equal(ready.balances.TRX.total, '5');
  assert.equal(btcAsked, 1);
});

test('a refused local Tor port reads as a Tor problem, not a raw error', async (t) => {
  const { s, v } = await make(t);
  s.settings.torEnabled = true;
  s.tor.state = { ...s.tor.state, phase: 'ready' };
  s.btc.getBalance = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:57065'); };
  s.tron.getTrxBalance = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:57065'); };
  const o = await s.overview();
  assert.match(o.balances.BTC.error, /Tor에 연결되지 않았어/);
  assert.match(o.balances.TRX.error, /Tor에 연결되지 않았어/);
  void v;
});
