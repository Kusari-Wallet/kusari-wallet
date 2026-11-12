const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../native/kusari-coin/lib');
const { load, edits, loadGenesis } = require('../native/kusari-zano/prepare');

const DIR = path.join(__dirname, '..', 'native', 'kusari-zano');
const PARAMS = path.join(DIR, 'params.json');
const ZANO_PREFIXES = [0xc5, 0x3678, 0x36f8, 0x98c8, 0x8a49, 0x656e, 0x14276e];

test('params give Kusari its own addresses, ports and network', () => {
  const p = load(PARAMS);
  for (const [kind, prefix] of Object.entries(p.prefixes)) {
    assert.ok(!ZANO_PREFIXES.includes(prefix), `${kind} reuses a Zano prefix`);
    assert.strictEqual(lib.leadingChar(prefix), p.leading[kind]);
  }
  assert.strictEqual(p.leading.address, 'K');
  for (const port of [...Object.values(p.ports), ...Object.values(p.testnetPorts)]) {
    assert.ok(![11121, 11211, 11777, 12111, 11888].includes(port), `port ${port} is Zano's`);
  }
  assert.notStrictEqual(p.networkId, p.testnetNetworkId);
  assert.strictEqual(lib.decodeAddress(p.genesis.burnAddress).prefix, p.prefixes.address);
  assert.match(p.zano.commit, /^[0-9a-f]{40}$/);
  assert.match(p.randomx.commit, /^[0-9a-f]{40}$/);
});

test('the genesis pays one ordinary output and carries the proof phrase', () => {
  const p = load(PARAMS);
  const tx = Buffer.from(fs.readFileSync(path.join(DIR, 'genesis', 'genesis.txt'), 'utf8').trim(), 'hex');
  // version 1, one coinbase input at height 0, one output.
  assert.strictEqual(tx.subarray(0, 5).toString('hex'), '0101000001');
  const amount = lib.varint(BigInt(p.genesis.amount) * 10n ** 12n);
  assert.ok(tx.subarray(5, 5 + amount.length).equals(amount), 'the amount is the one in params.json');
  // 0x03 is an output to one key. 0x04 would be a multisig output, which Zano's unpatched tool makes: one that
  // needs no signature, so anyone could spend it.
  assert.strictEqual(tx[5 + amount.length], 0x03);
  assert.ok(tx.includes(Buffer.from(p.genesis.proof)), 'proof phrase');
  const zeros = Buffer.alloc(32);
  assert.ok(!tx.includes(zeros), 'no empty key');
});

test('the C++ genesis is exactly the genesis transaction', () => {
  const g = loadGenesis(path.join(DIR, 'genesis'));
  const tx = Buffer.from(fs.readFileSync(path.join(DIR, 'genesis', 'genesis.txt'), 'utf8').trim(), 'hex');
  const words = g.cpp.match(/0x[0-9a-f]{16}/g).map((w) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(w)); return b; });
  const tail = Buffer.from(g.cpp.slice(g.cpp.lastIndexOf('{ 0x')).match(/0x[0-9a-f]{2}\b/g).map((x) => Number(x)));
  assert.ok(Buffer.concat([...words, tail]).equals(tx));
  assert.strictEqual(g.words * 8 + g.tail, tx.length);
  assert.strictEqual(g.entries, 1);
  assert.match(g.acc, /ggenesis_dict\[1\]/);
});

test('the edits cover what a new chain on Zano has to change', () => {
  const p = load(PARAMS);
  const list = edits(p, loadGenesis(path.join(DIR, 'genesis')));
  const files = new Set(list.map((e) => e.file));
  for (const f of ['src/currency_core/currency_config.h', 'src/p2p/net_node.inl', 'src/currency_core/checkpoints_create.h', 'src/common/pre_download.h',
    'src/currency_core/genesis.cpp', 'src/currency_core/genesis_acc.cpp', 'src/currency_core/genesis.h', 'src/currency_core/basic_pow_helpers.cpp',
    'src/currency_core/miner.h', 'src/connectivity_tool/conn_tool.cpp', 'contrib/CMakeLists.txt']) {
    assert.ok(files.has(f), `${f} is not changed`);
  }
  const text = list.map((e) => e.to ?? e.whole).join('\n');
  assert.ok(!/zano\.org|backblazeb2|95\.217\.|94\.130\./.test(text), 'nothing points at Zano\'s servers');
  assert.match(text, /randomx_calculate_hash/);
  assert.ok(!/progpow::hash/.test(text));
  assert.match(text, /#define CPU_MINING_ENABLED/);
  assert.match(text, /ZANO_HARDFORK_05_AFTER_HEIGHT\s+0\b/);
  assert.match(text, /ZANO_HARDFORK_06_AFTER_HEIGHT\s+999999999999999999/);
  // Without a genesis yet, only the identity edits apply.
  const boot = edits(p, null).map((e) => e.file);
  assert.ok(!boot.includes('src/currency_core/genesis.cpp') && !boot.includes('src/currency_core/basic_pow_helpers.cpp'));
  assert.ok(boot.includes('src/connectivity_tool/conn_tool.cpp'), 'the genesis tool fix is part of the bootstrap');
});

test('params that would break the chain are refused', () => {
  const good = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kusari-zano-params-'));
  const tryParams = (change) => {
    const p = structuredClone(good);
    change(p);
    const f = path.join(dir, 'p.json');
    fs.writeFileSync(f, JSON.stringify(p));
    return () => load(f);
  };
  assert.throws(tryParams((p) => { p.prefixes.address = 0xc5; }), /fixed first character/);
  assert.throws(tryParams((p) => { p.prefixes.integrated = p.prefixes.address; }), /used twice/);
  assert.throws(tryParams((p) => { p.testnetNetworkId = p.networkId; }), /differ/);
  assert.throws(tryParams((p) => { p.genesis.burnAddress = lib.encodeAddress(18, Buffer.alloc(32, 1), Buffer.alloc(32, 2)); }), /Kusari address/);
  assert.throws(tryParams((p) => { p.genesis.proof = 'a"b'; }), /proof/);
  assert.throws(tryParams((p) => { p.seedNodes = ['1.2.3.4", 0); system("x'] ; }), /seed node/);
  assert.throws(tryParams((p) => { p.maintainersPubKey = 'zz'; }), /32 bytes/);
  fs.rmSync(dir, { recursive: true, force: true });
});
