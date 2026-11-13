const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { WalletService } = require('../dist/main/service');
const { balanceCacheKey, readBalanceCache, writeBalanceCache } = require('../dist/main/balance-cache');

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('saved balances: encrypted, only readable with the same seed, old or broken entries dropped', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'balances.enc');
  const key = balanceCacheKey(SEED);
  const now = Date.now();
  await writeBalanceCache(file, key, new Map([['BTC', { at: now, total: '0.5', spendable: '0.4' }], ['XMR', { at: now - 8 * 24 * 3600_000, total: '1', spendable: '1' }]]));
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /BTC|0\.5/, 'nothing readable on disk');
  const back = await readBalanceCache(file, key);
  assert.deepEqual(back.get('BTC'), { at: now, total: '0.5', spendable: '0.4' });
  assert.equal(back.has('XMR'), false, 'over a week old');
  assert.equal((await readBalanceCache(file, balanceCacheKey(SEED.replace('about', 'abandon')))).size, 0, 'another seed reads nothing');
  const j = JSON.parse(raw);
  j.data = Buffer.from(Buffer.from(j.data, 'base64').map((b, i) => (i === 3 ? b ^ 1 : b))).toString('base64');
  fs.writeFileSync(file, JSON.stringify(j));
  assert.equal((await readBalanceCache(file, key)).size, 0, 'a changed file is refused');
  assert.equal((await readBalanceCache(path.join(dir, 'none'), key)).size, 0);
});

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
  s.pol = { address: '0x', balanceOf: async () => 1n }; s.arb = { address: '0x', balanceOf: async () => 1n }; s.bsc = { address: '0x', balanceOf: async () => 1n };
  s.dash = { receiveAddress: 'X', getBalance: async () => ({ total: 1n, spendable: 1n }) };
  s.scrt = { address: 'secret1', getBalance: async () => 1n };
  s.firo = { receiveAddress: 'a', getBalance: async () => ({ total: 1n, spendable: 1n }) };
  s.ada = { receiveAddress: 'addr1', getBalance: async () => ({ total: 1n, spendable: 1n }) };
  s.doge = { receiveAddress: 'D', refresh: async () => {}, getBalance: async () => ({ total: 1n, spendable: 1n }) }; s.ltc = { receiveAddress: 'ltc1', coin: { symbol: 'LTC' }, refresh: async () => {}, getBalance: async () => ({ total: 1n, spendable: 1n }) }; s.bch = { receiveAddress: 'bitcoincash:q', refresh: async () => {}, getBalance: async () => ({ total: 1n, spendable: 1n }) }; s.sol = { receiveAddress: 'S', getBalance: async () => ({ total: 1n, spendable: 1n }), getUsdtBalance: async () => 1n };
  return { s, v };
}


test('after a lock or restart the last balances show at once, marked as recent, until fresh ones arrive', async (t) => {
  const { s } = await make(t);
  await s.loadSavedBalances(SEED);
  assert.equal((await s.overview()).balances.TRX.total, '5');
  await s.saveBalancesNow();
  const file = s.balancesFile;
  assert.ok(fs.existsSync(file));

  // The next start: TRX can't be reached at all, nothing in memory.
  const { s: next, v } = await make(t);
  next.dir = s.dir;
  v.fail = true;
  await next.loadSavedBalances(SEED);
  const first = await next.overview();
  assert.equal(first.balances.TRX.ok, true);
  assert.equal(first.balances.TRX.total, '5');
  assert.equal(first.balances.TRX.stale, true);
  v.fail = false;
  next.balanceRetryAt.clear(); next.balanceMemo.clear();
  const fresh = await next.overview();
  assert.equal(fresh.balances.TRX.stale, undefined, 'replaced by the fresh value');

  // Locked: the key is wiped and nothing stays in memory.
  const key = next.balanceKey;
  await next.lock().catch(() => undefined);
  assert.ok(key.every((b) => b === 0));
  assert.equal(next.savedBalances.size, 0);
});
