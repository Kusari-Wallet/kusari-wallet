const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isKsrAddress, isZanoAddress, ksrKeys, zanoKeys, ZanoClient, KSR_CHAIN, KSR_FEE } = require('../dist/main/zano');
const { startKsrEngine, ksrEngineAvailable } = require('../dist/main/zano-process');

const ENGINE = path.join(__dirname, 'fake-ksr-engine.js');
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ME = 'K' + 'C'.repeat(96);
const OTHER = 'K' + 'D'.repeat(96);
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

test('KSR addresses: K and L, never Zano\'s', () => {
  assert.ok(isKsrAddress(ME));
  assert.ok(isKsrAddress('L' + 'C'.repeat(96)));
  assert.ok(!isKsrAddress('Zx' + 'C'.repeat(95)));
  assert.ok(!isKsrAddress('M' + 'C'.repeat(96)), 'gateway addresses can\'t receive directly');
  assert.ok(!isZanoAddress(ME));
  assert.equal(ksrEngineAvailable('/nonexistent'), false);
});

test('the KSR key, file and password are its own, so a K... address can\'t be tied to the Zano one', () => {
  const k = ksrKeys(SEED, 'vault-a');
  const z = zanoKeys(SEED, 'vault-a');
  assert.notEqual(k.secret, z.secret);
  assert.notEqual(k.pass, z.pass);
  assert.notEqual(k.file, z.file);
  assert.match(k.file, /^ksr-[0-9a-f]{16}$/);
  assert.match(z.file, /^kusari-[0-9a-f]{16}$/);
  // Fixed for a seed (the vault doesn't change it), and pinned: a change would lose KSR wallets made before it.
  assert.equal(k.secret, ksrKeys(SEED, 'vault-b').secret);
  assert.notEqual(k.pass, ksrKeys(SEED, 'vault-b').pass);
  // HMAC-SHA512 of the BIP39 seed with "kusari/ksr/v1", first 32 bytes (checked by hand against Python's hmac).
  assert.equal(k.secret, 'bcc7f640287f87c624f409ee846fb5ffe522def8131f530fa4313192bbca921d');
  assert.equal(z.secret, 'e7ba1cefe904f75c8ef1e83f64fcb1ae9972db6920e0423b7c1558d8766dee40', 'Zano\'s key is unchanged');
  assert.ok(!k.file.includes(k.secret.slice(0, 8)));
});

function client(dir, extra = {}) {
  return new ZanoClient({ engine: () => startKsrEngine(ENGINE, dir), node: '1.2.3.4:21081', canConnect: () => true, onChange: () => {}, chain: KSR_CHAIN, ...extra }, ksrKeys(SEED, 'vault'));
}

test('KSR on the Zano client: its own engine folder, key and file; exact amounts; Kusari in its messages', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksr-'));
  const log = path.join(dir, 'log');
  Object.assign(process.env, { FAKE_KSR_LOG: log, FAKE_KSR_FILES: path.join(dir, 'files') });
  const lines = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  const c = client(dir);
  t.after(() => c.stop());
  await c.start();
  await until(() => c.balance());
  assert.equal(c.receive, ME);
  assert.ok(fs.existsSync(path.join(dir, 'ksr')), 'the engine works in a folder of its own');
  const init = lines().find((l) => l.m === 'init');
  assert.equal(init.node, '1.2.3.4:21081');
  assert.equal(path.basename(init.dir), 'ksr');
  const restored = lines().find((l) => l.m === 'restore');
  assert.equal(restored.secret, ksrKeys(SEED, 'vault').secret);
  assert.notEqual(restored.secret, zanoKeys(SEED, 'vault').secret);
  assert.match(restored.path, /^ksr-/);

  await assert.rejects(c.draft('Zx' + 'D'.repeat(95), 1n), /Not a Kusari address/);
  const max = await c.draft(OTHER, 'max');
  assert.equal(max.value, 15000000000000000n - KSR_FEE);
  const hash = await c.send(await c.draft(OTHER, 9007199254740993n));
  assert.equal(hash, 'ab'.repeat(32));
  assert.match(lines().find((l) => l.m === 'transfer').raw, /"amount":9007199254740993\}/);
  const h = await c.getHistory();
  assert.ok(h.every((x) => x.asset === 'KSR'));
  await c.stop();
});

test('KSR over Tor: the engine gets the port, and nothing goes out before Tor is up', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksr-'));
  const log = path.join(dir, 'log');
  Object.assign(process.env, { FAKE_KSR_LOG: log, FAKE_KSR_FILES: path.join(dir, 'files') });
  let up = false;
  const c = client(dir, { socks: 9150, canConnect: () => up });
  await c.start();
  await sleep(300);
  assert.equal(fs.existsSync(log), false, 'silent until Tor is ready');
  up = true;
  await until(() => c.balance());
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').map((l) => l && JSON.parse(l)).find((l) => l.m === 'init').socks, '9150');
  await c.stop();
});

test.after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 200); });
