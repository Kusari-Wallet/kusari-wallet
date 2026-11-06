const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isZanoAddress, zanoKeys, ZanoClient } = require('../dist/main/zano');
const { startZanoEngine, zanoEngineAvailable } = require('../dist/main/zano-process');

const ENGINE = path.join(__dirname, 'fake-zano-engine.js');
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ME = 'Zx' + 'C'.repeat(95);
const OTHER = 'Zx' + 'D'.repeat(95);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(30);
  }
}

test('addresses', () => {
  assert.ok(isZanoAddress(ME));
  assert.ok(!isZanoAddress('t1VpYecBW4UudbGcy4ufh61eWxQCoFaUrPs'));
  assert.equal(zanoEngineAvailable('/nonexistent'), false);
});

test('the key is fixed for a seed, because changing it would lose wallets', () => {
  const a = zanoKeys(SEED, 'vault-a');
  // Pinned on purpose. If this ever fails, wallets made before the change no longer come back from their seed.
  assert.equal(a.secret, zanoKeys(SEED, 'vault-b').secret);
  assert.equal(a.secret.length, 64);
  assert.notEqual(a.pass, zanoKeys(SEED, 'vault-b').pass);
  assert.notEqual(a.file, zanoKeys(SEED, 'vault-b').file);
  assert.ok(!a.file.includes(a.secret.slice(0, 8)));
  assert.equal(a.secret, 'e7ba1cefe904f75c8ef1e83f64fcb1ae9972db6920e0423b7c1558d8766dee40');
});

function client(dir, extra = {}) {
  return new ZanoClient({ engine: () => startZanoEngine(ENGINE, dir), node: '1.2.3.4:10500', canConnect: () => true, onChange: () => {}, ...extra }, zanoKeys(SEED, 'vault'));
}

test('restore, balance past 2^53, exact send, reopen', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zano-'));
  const log = path.join(dir, 'log');
  const files = path.join(dir, 'files');
  Object.assign(process.env, { FAKE_ZANO_LOG: log, FAKE_ZANO_FILES: files });
  const lines = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const c = client(dir);
  t.after(() => c.stop());
  await c.start();
  await until(() => c.balance());
  assert.equal(c.receive, ME);
  const [total, spendable] = c.balance();
  assert.equal(total, 20000000000000000n);
  assert.equal(spendable, 15000000000000000n);
  const restored = lines().find((l) => l.m === 'restore');
  assert.equal(restored.secret, zanoKeys(SEED, 'vault').secret);
  assert.equal(restored.auditable, false);
  assert.equal(restored.stamp, Date.UTC(2026, 10, 1) / 1000);
  assert.equal(lines().find((l) => l.m === 'init').socks, '');
  assert.equal(c.keys.secret, '', 'the key is dropped once the file holds it');

  await assert.rejects(c.draft('bad', 1n), /Zano 주소가 아니/);
  await assert.rejects(c.draft(OTHER, 20000000000000000n), /잔액이 부족/);
  const max = await c.draft(OTHER, 'max');
  assert.equal(max.value, 15000000000000000n - 10000000000n);
  const d = await c.draft(OTHER, 9007199254740993n);
  const hash = await c.send(d);
  assert.equal(hash, 'ab'.repeat(32));
  assert.match(lines().find((l) => l.m === 'transfer').raw, /"amount":9007199254740993\}/, 'no rounding in the request');
  assert.match(lines().find((l) => l.m === 'transfer').raw, /"fee":10000000000,"mixin":15/);

  const h = await c.getHistory();
  assert.deepEqual(h.map((x) => [x.direction, x.amount, x.status]), [['out', '9007.199254740993', 'pending'], ['in', '20000', 'confirmed']]);
  await c.stop();
  assert.ok(lines().some((l) => l.m === 'close'));

  const again = client(dir);
  await again.start();
  await until(() => again.balance());
  assert.equal(lines().filter((l) => l.m === 'restore').length, 1, 'the saved file is opened, not restored over');
  await again.stop();
});

test.after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 200); });

test('Tor: every start carries the port, and nothing goes out before Tor is up', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zano-'));
  const log = path.join(dir, 'log');
  Object.assign(process.env, { FAKE_ZANO_LOG: log, FAKE_ZANO_FILES: path.join(dir, 'files') });
  let up = false;
  const c = client(dir, { socks: 9150, canConnect: () => up });
  await c.start();
  await sleep(300);
  assert.equal(fs.existsSync(log), false, 'silent until Tor is ready');
  assert.equal(c.phase, 'Tor 연결 대기');
  up = true;
  await until(() => c.balance());
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').map((l) => l && JSON.parse(l)).find((l) => l.m === 'init').socks, '9150');
  await c.stop();
});
