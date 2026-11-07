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
  s.pol = { address: '0x', balanceOf: async () => 1n }; s.arb = { address: '0x', balanceOf: async () => 1n };
  s.dash = { receiveAddress: 'X', getBalance: async () => ({ total: 1n, spendable: 1n }) };
  s.firo = { receiveAddress: 'a', getBalance: async () => ({ total: 1n, spendable: 1n }) };
  s.doge = { receiveAddress: 'D', refresh: async () => {}, getBalance: async () => ({ total: 1n, spendable: 1n }) }; s.ltc = { receiveAddress: 'ltc1', coin: { symbol: 'LTC' }, refresh: async () => {}, getBalance: async () => ({ total: 1n, spendable: 1n }) }; s.bch = { receiveAddress: 'bitcoincash:q', refresh: async () => {}, getBalance: async () => ({ total: 1n, spendable: 1n }) }; s.sol = { receiveAddress: 'S', getBalance: async () => ({ total: 1n, spendable: 1n }), getUsdtBalance: async () => 1n };
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
  await assert.rejects(s.prepareSend('TRX', 'T', '1'), /Tor is connecting/);
  await assert.rejects(s.swapQuote('TRX', 'XMR', '1'), /Tor is connecting/);
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
  assert.match(o.balances.BTC.error, /Not connected to Tor/);
  assert.match(o.balances.TRX.error, /Not connected to Tor/);
  void v;
});

test('the connection log has what went wrong, no addresses or links, and locking clears it', async (t) => {
  const { s, v } = await make(t);
  v.fail = true;
  s.tron.getTrxBalance = async () => { throw new Error('Timed out https://api.example.org/v1/accounts/TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE for TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'); };
  const failed = await s.overview();
  assert.equal(failed.balances.TRX.ok, false);
  const log = s.connectionLog();
  assert.match(log, /TRX after \d+\.\ds: Timed out/);
  assert.doesNotMatch(log, /example\.org|TQn9Y2/);
  await s.overview();
  assert.notEqual((await s.overview()).balances.TRX.error, 'Retrying shortly.', 'the real reason stays visible while waiting to retry');
  await s.lock();
  assert.match(s.connectionLog(), /Failed lookups:\nnone/);
});

test('over Tor a quick refusal moves that coin to new routes; its neighbors keep theirs', async (t) => {
  const { socksAgent } = require('../dist/main/request');
  const { s, v } = await make(t);
  s.settings.torEnabled = true;
  s.tor.state.phase = 'ready';
  s.torProxy = 'socks5h://127.0.0.1:1';
  const tron = s.torRoute('tron');
  const dash = s.torRoute('dash');
  const dashUser = dash.proxy.userId;
  const seen = [];
  s.tron.getTrxBalance = async () => {
    seen.push(tron.proxy.userId);
    if (seen.length < 3) throw new Error('Request failed with status code 403');
    return 5_000_000n;
  };
  const o = await s.overview();
  assert.equal(o.balances.TRX.total, '5');
  assert.equal(new Set(seen).size, 3, 'each try used a different route');
  assert.equal(dash.proxy.userId, dashUser, 'other coins stay where they are');
  assert.equal(typeof socksAgent, 'function');
});

test('over Tor a slow timeout isn\'t repeated, repeats slow down, and the reason is plain', async (t) => {
  const { lookupRetryDelay } = require('../dist/main/service');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(lookupRetryDelay), [30000, 60000, 120000, 240000, 300000, 300000, 300000]);
  const { s } = await make(t);
  s.settings.torEnabled = true;
  s.tor.state.phase = 'ready';
  let calls = 0;
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  t.after(() => { Date.now = realNow; });
  s.dash.getBalance = async () => { calls++; offset += 120_000; throw new Error('Timed out'); };
  for (let i = 0; i < 3; i++) await s.overview();
  assert.equal(calls, 6, 'two tries a round, no more');
  const o = await s.overview();
  assert.match(o.balances.DASH.error, /isn't answering over Tor/);
});

test('one failed lookup that many callers waited on is one log line', async (t) => {
  const { s } = await make(t);
  for (let i = 0; i < 5; i++) s.noteFailure('DASH', Date.now(), new Error('Timed out'));
  assert.equal(s.connectionLog().match(/DASH after/g).length, 1);
});

test('each coin gets its own balance', async (t) => {
  const { s } = await make(t);
  const coins = { btc: 'BTC', dash: 'DASH', firo: 'FIRO', doge: 'DOGE', sol: 'SOL', bch: 'BCH', ltc: 'LTC' };
  const expected = {};
  Object.entries(coins).forEach(([key, symbol], i) => {
    s[key].getBalance = async () => ({ total: BigInt(i + 1) * 100000000n, spendable: BigInt(i + 1) * 100000000n });
    expected[symbol] = i + 1;
  });
  s.eth.getEthBalance = async () => 11n * 10n ** 18n;
  s.eth.getUsdtBalance = async () => 12_000_000n;
  s.tron.getTrxBalance = async () => 13_000_000n;
  s.tron.getUsdtBalance = async () => 14_000_000n;
  s.sol.getUsdtBalance = async () => 16_000_000n;
  s.monero.getBalance = async () => ({ total: 15n * 10n ** 12n, unlocked: 15n * 10n ** 12n });
  const { balances } = await s.overview();
  for (const [symbol, n] of Object.entries({ ...expected, ETH: 11, USDTE: 12, TRX: 13, USDT: 14, XMR: 15, USDTS: 16 })) assert.equal(balances[symbol].total, String(symbol === 'SOL' ? n / 10 : n), symbol);
});
