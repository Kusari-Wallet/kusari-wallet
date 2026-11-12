const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const lib = require('../native/kusari-coin/lib');
const { load, edits, apply } = require('../native/kusari-coin/prepare');

const DIR = path.join(__dirname, '..', 'native', 'kusari-coin');
const PARAMS = path.join(DIR, 'params.json');
const MONERO_GENESIS = '013c01ff0001ffffffffffff03029b2e4c0281c0b02e7c53291a94d1d0cbff8883f8024f5142ee494ffbbd08807121017767aafcde9be00dcfd098715ebcf7f410daebc582fda69d24a28e9d0bc890d1';
const MONERO_DONATION = '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H';
const MONERO_PREFIXES = [18, 19, 42, 53, 54, 63, 24, 25, 36];
const NETS = ['mainnet', 'testnet', 'stagenet'];

test('keccak-256 matches the published vectors', () => {
  assert.strictEqual(lib.keccak256(Buffer.alloc(0)).toString('hex'), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.strictEqual(lib.keccak256(Buffer.from('abc')).toString('hex'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  // Longer than one 136-byte block.
  assert.strictEqual(lib.keccak256(Buffer.alloc(200, 0x61)).length, 32);
});

test('address encoding round-trips a real Monero address', () => {
  const d = lib.decodeAddress(MONERO_DONATION);
  assert.strictEqual(d.prefix, 42);
  assert.strictEqual(lib.encodeAddress(42, d.spendPub, d.viewPub), MONERO_DONATION);
  const broken = MONERO_DONATION.slice(0, -1) + (MONERO_DONATION.endsWith('H') ? 'J' : 'H');
  assert.throws(() => lib.decodeAddress(broken));
});

test('the genesis builder reproduces Monero\'s own genesis transaction', () => {
  const g = lib.parseGenesisTx(MONERO_GENESIS);
  assert.strictEqual(g.amount, 17592186044415n);
  assert.strictEqual(lib.genesisTx(g.amount, g.outKey, g.txPub), MONERO_GENESIS);
});

test('params give fixed leading characters that no Monero address uses', () => {
  const p = load(PARAMS);
  const seen = new Set();
  for (const n of NETS) {
    for (const [kind, prefix] of Object.entries(p[n].prefixes)) {
      assert.ok(!MONERO_PREFIXES.includes(prefix), `${n}.${kind} reuses a Monero prefix`);
      assert.ok(!seen.has(prefix), `${n}.${kind} reuses a prefix`);
      seen.add(prefix);
      assert.strictEqual(lib.leadingChar(prefix), p[n].leading[kind]);
      for (let i = 0; i < 20; i++) {
        const a = lib.encodeAddress(prefix, crypto.randomBytes(32), crypto.randomBytes(32));
        assert.strictEqual(a.length, 95);
        assert.strictEqual(a[0], p[n].leading[kind]);
        assert.strictEqual(lib.decodeAddress(a).prefix, prefix);
      }
    }
  }
  assert.strictEqual(p.mainnet.leading.address, 'K');
});

test('params are a separate chain from Monero', () => {
  const p = load(PARAMS);
  const ports = new Set();
  for (const n of NETS) {
    const c = p[n];
    assert.notStrictEqual(c.genesisTx, MONERO_GENESIS);
    assert.ok(!c.networkId.startsWith('1230f17161044161173100821'), `${n} keeps Monero's network id`);
    lib.parseGenesisTx(c.genesisTx);
    for (const port of Object.values(c.ports)) {
      assert.ok(![18080, 18081, 18082, 18083, 28080, 28081, 28082, 38080, 38081, 38082].includes(port), `${n} port ${port} is Monero's`);
      assert.ok(!ports.has(port));
      ports.add(port);
    }
  }
  assert.deepStrictEqual(p.hardForks.map((f) => [f.version, f.height]), Array.from({ length: 16 }, (_, i) => [i + 1, i + 1]));
});

test('params that would break the chain are refused', () => {
  const good = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kusari-params-'));
  const tryParams = (change) => {
    const p = structuredClone(good);
    change(p);
    const f = path.join(dir, 'p.json');
    fs.writeFileSync(f, JSON.stringify(p));
    return () => load(f);
  };
  assert.throws(tryParams((p) => { p.mainnet.prefixes.address = 200; }), /fixed first character/);
  assert.throws(tryParams((p) => { p.mainnet.prefixes.address = 5; }), /fixed first character/);
  assert.throws(tryParams((p) => { p.testnet.networkId = p.mainnet.networkId; }), /differ/);
  assert.throws(tryParams((p) => { p.mainnet.genesisTx = p.mainnet.genesisTx + '00'; }), /trailing/);
  assert.throws(tryParams((p) => { p.hardForks[1].height = 1; }), /increase/);
  assert.throws(tryParams((p) => { p.hardForks.splice(1, 14); p.hardForks[1].height = 2; }), /without gaps/);
  assert.throws(tryParams((p) => { p.hardForks.pop(); }), /version 16/);
  assert.throws(tryParams((p) => { p.mainnet.seedNodes = ['1.2.3.4:21080"); evil("']; }), /seed node/);
  assert.throws(tryParams((p) => { p.binaryPrefix = 'a b'; }), /names/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every edit must match exactly once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kusari-apply-'));
  fs.writeFileSync(path.join(dir, 'a.h'), 'x = 1;\nx = 1;\n');
  assert.throws(() => apply(dir, [{ file: 'a.h', from: 'x = 1;', to: 'x = 2;' }]), /found 2/);
  assert.throws(() => apply(dir, [{ file: 'a.h', from: 'y = 1;', to: 'y = 2;' }]), /found 0/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.h'), 'utf8'), 'x = 1;\nx = 1;\n');
  fs.writeFileSync(path.join(dir, 'b.h'), 'name = "a$&b";\n');
  apply(dir, [{ file: 'b.h', from: 'name = "a$&b";', to: 'name = "$1$&";' }]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'b.h'), 'utf8'), 'name = "$1$&";\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the edit list covers what a new chain has to change', () => {
  const list = edits(load(PARAMS));
  const files = new Set(list.map((e) => e.file));
  for (const f of ['src/cryptonote_config.h', 'src/hardforks/hardforks.cpp', 'src/checkpoints/checkpoints.cpp',
    'src/blocks/blocks.cpp', 'src/p2p/net_node.h', 'src/p2p/net_node.inl', 'src/common/updates.cpp']) {
    assert.ok(files.has(f), `${f} is not changed`);
  }
  const text = list.map((e) => e.to).join('\n');
  assert.ok(!/moneropulse|moneroseeds|\.onion|\.i2p/.test(text));
});
