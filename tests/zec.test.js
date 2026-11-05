const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isZecAddress, zecHeightForDate } = require('../dist/main/zec');
const { WalletService } = require('../dist/main/service');
const { zecEngineAvailable } = require('../dist/main/zec-process');

const ENGINE = path.join(__dirname, 'fake-zec-engine.js');
const PW = 'correct horse battery';
const TRON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const U = 'u1' + 'q'.repeat(150);
const T = 't1' + 'a'.repeat(33);
const OTHER = 'u1' + 'p'.repeat(150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(40);
  }
}

test('addresses', () => {
  assert.ok(isZecAddress('t1VpYecBW4UudbGcy4ufh61eWxQCoFaUrPs'));
  assert.ok(isZecAddress(U));
  assert.ok(!isZecAddress('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'));
  assert.ok(!isZecAddress('ztestsapling1abc'));
});

test('a date becomes a height a month earlier, never before Sapling', () => {
  const h = zecHeightForDate(new Date('2025-06-01T00:00:00Z'));
  assert.ok(h > 2_900_000 && h < 3_000_000, String(h));
  assert.equal(zecHeightForDate(new Date('2010-01-01T00:00:00Z')), 419_200);
});

test('the engine is optional', () => {
  assert.equal(zecEngineAvailable('/nonexistent'), false);
  assert.equal(zecEngineAvailable(ENGINE), true);
});

async function wallet(t, env = {}, dev = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zec-'));
  const log = path.join(dir, 'engine.log');
  Object.assign(process.env, { FAKE_ZEC_LOG: log, FAKE_ZEC_FAIL_SYNC_ONCE: '' }, env);
  const moneroSeed = await new WalletService(fs.mkdtempSync(path.join(os.tmpdir(), 'z0-')), { N: 2 ** 10, r: 8, p: 1 }).generateSeeds().then((s) => s.moneroSeed);
  const open = async () => {
    const s = new WalletService(dir, { N: 2 ** 10, r: 8, p: 1 }, { tronHost: 'http://127.0.0.1:9', btcApi: 'http://127.0.0.1:9', ethRpc: 'http://127.0.0.1:9', dcrApi: 'http://127.0.0.1:9', dashApi: 'http://127.0.0.1:9', zecBin: ENGINE, zecServers: ['https://one', 'https://two'], priceUrl: 'http://127.0.0.1:9', ...dev });
    await s.init();
    return s;
  };
  const service = await open();
  t.after(async () => { await service.lock().catch(() => undefined); });
  const logged = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, service, open, logged, moneroSeed };
}

test('restore from a date, scan, send, shield, reopen', { timeout: 60000 }, async (t) => {
  const { dir, service, open, logged, moneroSeed } = await wallet(t);
  await service.restore(PW, TRON, moneroSeed, '2025-06-01');
  const zec = () => service.zec;
  await until(() => zec().balance());
  assert.equal(logged().find((l) => l.m === 'account').birthday, zecHeightForDate(new Date('2025-06-01T00:00:00Z')));
  assert.equal(logged().find((l) => l.m === 'account').seedWords, 12);
  const a = await service.addresses();
  assert.equal(a.ZEC, U);
  assert.equal(a.ZEC_T, T);

  // Nothing readable on disk, and the seed nowhere near it.
  const raw = fs.readFileSync(path.join(dir, 'zec-state.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(parsed.ct && parsed.iv);
  assert.ok(!raw.includes('abandon') && !Buffer.from(parsed.ct, 'base64').toString().includes('total'));

  await assert.rejects(service.prepareSend('ZEC', U, '1'), /내 주소/);
  await assert.rejects(service.prepareSend('ZEC', T, '1'), /내 주소/);
  await assert.rejects(service.prepareSend('ZEC', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', '1'), /Zcash 주소가 아니/);
  await assert.rejects(service.prepareSend('ZEC', OTHER, '5'), /투명 잔액은 먼저 쉴드/);

  const p = await service.prepareSend('ZEC', OTHER, '0.5');
  assert.equal(p.amount, '0.5');
  assert.equal(p.fee, '0.00015');
  assert.equal(p.feeAsset, 'ZEC');
  assert.equal(p.feeIsEstimate, false);
  await assert.rejects(service.confirmSend(p.id, 'wrong password!!'));
  const again = await service.prepareSend('ZEC', OTHER, '0.5');
  const sent = await service.confirmSend(again.id, PW);
  assert.deepEqual(sent.hashes, ['ab'.repeat(32)]);
  const line = logged().find((l) => l.m === 'send');
  assert.deepEqual([line.value, line.maxFee, line.seedWords], [50000000, 15000, 12]);

  const max = await service.prepareSend('ZEC', OTHER, 'max');
  assert.equal(max.amount, '0.49970000'.replace(/0+$/, ''));
  service.cancelSend(max.id);

  const overview = await service.overview();
  assert.equal(overview.balances.ZEC.ok, true);
  assert.equal(overview.zec.canShield, true);
  assert.equal(overview.zec.transparent, '0.5');
  await assert.rejects(service.zecShield('wrong password!!'));
  const shielded = await service.zecShield(PW);
  assert.deepEqual(shielded.hashes, ['cd'.repeat(32)]);
  assert.equal((await service.overview()).zec.canShield, false);

  const hist = await service.history('ZEC');
  assert.deepEqual(hist.map((h) => [h.direction, h.amount, h.status]).sort(), [['in', '1', 'confirmed'], ['out', '0.5', 'confirmed']]);
  assert.ok(service.explorerUrl('ZEC', 'ab'.repeat(32)).includes('zcash'));

  await service.lock();
  assert.equal(service.zec, null);
  const count = logged().filter((l) => l.m === 'account').length;
  const second = await open();
  await second.unlock(PW);
  await until(() => second.zec.balance());
  assert.equal(logged().filter((l) => l.m === 'account').length, count, 'the saved account is reused');
  assert.equal(logged().filter((l) => l.m === 'open').at(-1).hasDb, true);
  assert.equal((await second.overview()).zec.transparent, '0');
  await second.lock();
});

test('a failed server gives way to the next, keeping the state', { timeout: 60000 }, async (t) => {
  const { service, logged, moneroSeed } = await wallet(t, { FAKE_ZEC_FAIL_SYNC_ONCE: '1' });
  await service.restore(PW, TRON, moneroSeed, '');
  await until(() => logged().filter((l) => l.m === 'open').length >= 2);
  const opens = logged().filter((l) => l.m === 'open');
  assert.equal(opens[0].server, 'https://one');
  assert.equal(opens[1].server, 'https://two');
  assert.equal(opens[1].hasDb, true);
  assert.match(service.zec.lastError, /Zcash 서버에 연결하지 못했어/);
  assert.equal(logged().find((l) => l.m === 'account').birthday, null, 'no date, so it starts from now');
});

test('rescan needs the password and starts over from the date', { timeout: 60000 }, async (t) => {
  const { service, logged, moneroSeed } = await wallet(t);
  await service.restore(PW, TRON, moneroSeed, '');
  await until(() => service.zec.balance());
  await assert.rejects(service.zecRescan('2024-01-01', 'wrong password!!'));
  await assert.rejects(service.zecRescan('soon', PW), /YYYY-MM-DD/);
  await service.zecRescan('2024-01-01', PW);
  await until(() => logged().filter((l) => l.m === 'account').length === 2);
  assert.equal(logged().filter((l) => l.m === 'account')[1].birthday, zecHeightForDate(new Date('2024-01-01T00:00:00Z')));
});

test('Tor mode: every connection carries the Tor port, and nothing leaves until Tor is ready', { timeout: 60000 }, async (t) => {
  const { service, logged, moneroSeed } = await wallet(t, {}, { socks: 'socks5h://127.0.0.1:59999' });
  service.settings.torEnabled = true;
  await service.restore(PW, TRON, moneroSeed, '').catch(() => undefined);
  await until(() => logged().some((l) => l.m === 'open'));
  assert.ok(logged().filter((l) => l.m === 'open').every((l) => l.socks === 59999));
  await sleep(300);
  if (service.tor.state.phase !== 'ready') assert.equal(logged().some((l) => l.m === 'account'), false, 'no request before Tor is up');
});

test('no engine: no ZEC anywhere, and the other coins carry on', { timeout: 60000 }, async (t) => {
  const { service, moneroSeed } = await wallet(t, {}, { zecBin: '/nonexistent' });
  await service.restore(PW, TRON, moneroSeed, '');
  const o = await service.overview();
  assert.equal(o.balances.ZEC, undefined);
  assert.equal(o.zec, null);
  assert.ok(o.balances.BTC);
  await assert.rejects(service.prepareSend('ZEC', OTHER, '1'), /쓸 수 없어/);
  assert.deepEqual(await service.history('ZEC'), []);
});

// A Monero worker from generating seeds keeps the process alive; every result is in by now.
test.after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 200); });
