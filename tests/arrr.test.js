const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isArrrAddress, ArrrClient } = require('../dist/main/arrr');
const { startArrrEngine, arrrEngineAvailable } = require('../dist/main/arrr-process');

const ENGINE = path.join(__dirname, 'fake-arrr-engine.js');
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'zs1' + 'p'.repeat(75);
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
const lines = (log) => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
function setup(extra = {}, date) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrr-'));
  const log = path.join(dir, 'log');
  Object.assign(process.env, { FAKE_ARRR_LOG: log, FAKE_ARRR_STATE: path.join(dir, 'state') });
  const make = (seed = SEED) => new ArrrClient({ engine: () => startArrrEngine(ENGINE), dir, secret: 'vault', servers: ['https://one', 'https://two'], canConnect: () => true, onChange: () => {}, ...extra }, seed, date);
  return { dir, log, make };
}

test('addresses', () => {
  assert.ok(isArrrAddress(OTHER));
  assert.ok(isArrrAddress('pirate1' + 'q'.repeat(60)));
  assert.ok(!isArrrAddress('t1VpYecBW4UudbGcy4ufh61eWxQCoFaUrPs'));
  assert.equal(arrrEngineAvailable('/nonexistent'), false);
});

test('first start, balance, send, reopen without the seed', { timeout: 30000 }, async () => {
  const { log, make } = setup();
  const c = make();
  await c.start();
  await until(() => c.balance());
  const restored = lines(log).find((l) => l.m === 'restore');
  assert.equal(restored.words, 12);
  assert.equal(restored.birthday, 5000000 - 100);
  assert.equal(c.seed, null, 'the seed is dropped once the wallet exists');
  assert.equal(c.receive, 'zs1' + 'q'.repeat(75));
  assert.deepEqual(c.balance(), [300000000n, 200000000n]);
  await assert.rejects(c.draft('zs1x', 900000000n), /Not a Pirate Chain address|enough/);
  await assert.rejects(c.draft(OTHER, 900000000n), /enough/);
  const d = await c.draft(OTHER, 50000000n);
  assert.deepEqual([d.value, d.fee], [50000000n, 10000n]);
  assert.equal(await c.send(d), 'ab'.repeat(32));
  assert.deepEqual(lines(log).find((l) => l.m === 'send'), { m: 'send', to: OTHER, value: 50000000, maxFee: 10000 });
  const max = await c.draft(OTHER, 'max');
  assert.equal(max.value, 200000000n - 50010000n - 10000n);
  const h = await c.getHistory();
  assert.deepEqual(h.map((x) => [x.direction, x.amount, x.status]), [['in', '3', 'confirmed'], ['out', '0.5', 'pending']]);
  await c.stop();

  const again = make(null);
  await again.start();
  await until(() => again.balance());
  assert.equal(lines(log).filter((l) => l.m === 'restore').length, 1, 'no second restore');
  await again.stop();
});

test('a restore date reaches back further than the date, with margin', { timeout: 30000 }, async () => {
  const { log, make } = setup({}, new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
  const c = make();
  await c.start();
  await until(() => c.balance());
  const b = lines(log).find((l) => l.m === 'restore').birthday;
  assert.ok(b < 5000000 - 31 * 1440 + 100 && b > 5000000 - 33 * 1440, String(b));
  await c.rescan('2026-01-01');
  assert.ok(lines(log).some((l) => l.m === 'rescan'));
  await c.stop();
});

test('a dead server gives way to the next', { timeout: 30000 }, async () => {
  const { log, make } = setup();
  process.env.FAKE_ARRR_DOWN = 'https://one';
  const c = make();
  await c.start();
  await until(() => c.balance());
  delete process.env.FAKE_ARRR_DOWN;
  assert.deepEqual(lines(log).filter((l) => l.m === 'tip').map((l) => l.server), ['https://one', 'https://two']);
  assert.equal(lines(log).find((l) => l.m === 'use').server, 'https://two');
  await c.stop();
});

test('Tor: the port goes in, and nothing leaves before Tor is up', { timeout: 30000 }, async () => {
  let up = false;
  const { log, make } = setup({ socks: 9150, canConnect: () => up });
  const c = make();
  await c.start();
  await sleep(300);
  assert.equal(fs.existsSync(log), false);
  assert.equal(c.phase, 'Waiting for Tor');
  up = true;
  await until(() => c.balance());
  assert.equal(lines(log).find((l) => l.m === 'open').socks, 9150);
  await c.stop();
});

test.after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 200); });
