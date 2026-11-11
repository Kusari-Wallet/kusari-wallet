const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startSparkEngine, readAnswer } = require('../dist/main/spark-process');
const { SparkClient, sparkKey, isSparkAddress, signFiroMint, SPARK_INDEX } = require('../dist/main/spark');
const { startSparkMock, mintCoin } = require('./mock-spark');
const btc = require('@scure/btc-signer');

// Real engine, real Spark coins and proofs; only the server is a stand-in. The verifier is a test build that checks
// spends as a Firo node does (scripts/build-spark.sh verify).
const ENGINE = path.join(__dirname, '..', 'native-bin', 'spark-linux', 'spark-bridge');
const VERIFY = path.join(__dirname, '..', 'native-bin', 'spark-linux', 'spark-verify');
const skip = !fs.existsSync(ENGINE) || !fs.existsSync(VERIFY) ? 'the Spark engine is not built (scripts/build-spark.sh linux verify)' : false;
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FIRO = 100_000_000;

function verify(hex, mock) {
  const sets = Object.entries(mock.state.groups).map(([id, recs]) => ({
    id: Number(id),
    coins: [...recs].reverse().map((r) => Buffer.concat([r.coin, r.tx, Buffer.from([r.ctx.length]), r.ctx]).toString('hex')),
    setHash: require('node:crypto').createHash('sha256').update(`set-${id}-${recs.length}`).digest('hex'),
  }));
  return JSON.parse(execFileSync(VERIFY, { input: JSON.stringify({ tx: hex, sets }) }).toString());
}

function client(mock, dir, pins = {}, extra = {}) {
  return new SparkClient({
    engine: () => startSparkEngine(ENGINE), dir, servers: [{ host: '127.0.0.1', port: mock.port }],
    pins: () => pins, savePin: (h, f) => { pins[h] = f; }, canConnect: () => true, onChange: () => undefined, ...extra,
  }, sparkKey(MNEMONIC));
}

test('engine answers are read as {id, r} or {id, e}', () => {
  assert.deepEqual(readAnswer('{"id":3,"r":"pong"}'), { id: 3, ok: true, value: 'pong' });
  assert.deepEqual(readAnswer('{"id":4,"e":"no"}'), { id: 4, ok: false, value: 'no' });
  assert.equal(readAnswer('junk'), null);
});

test('Spark keys and addresses match Firo\'s published vector', { skip }, async () => {
  const e = startSparkEngine(ENGINE);
  try {
    const a = await e.call('address', { key: 'cb02b05c71a69080b083484f1cdf407677fac00ced6438df16925e2a29b4eebf', index: 1, diversifier: 0 });
    assert.equal(a, 'sm1shqukway59rq5nefgywyrrmmt8eswgjqdgnsdn4ysrsfl2rna60l2drelf6nfe0pamyxh3w8ypa7y35znhf4c6w44d7lw8xu3kjra4sg2v0zn508hawuul5596fm2h4e2csa9egk4ks3a');
    assert.ok(isSparkAddress(a));
    assert.equal(await e.call('valid', { address: a }), true);
    assert.equal(await e.call('valid', { address: a.slice(0, -1) + 'q' }), false);
  } finally { e.close(); }
});

test('sync finds our coins among decoys, spends them in a way a node accepts, and follows the change', { skip, timeout: 600_000 }, async () => {
  const mock = await startSparkMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-'));
  const helper = startSparkEngine(ENGINE);
  try {
    const mine = await helper.call('address', { key: sparkKey(MNEMONIC), index: SPARK_INDEX, diversifier: 0 });
    const other = await helper.call('address', { key: 'cb02b05c71a69080b083484f1cdf407677fac00ced6438df16925e2a29b4eebf', index: 1, diversifier: 0 });
    const g = mock.state.groups[1];
    for (let i = 0; i < 6; i++) g.push(await mintCoin(helper, other, (i + 1) * FIRO));
    g.push(await mintCoin(helper, mine, 1.5 * FIRO));
    for (let i = 0; i < 3; i++) g.push(await mintCoin(helper, other, 2 * FIRO));
    g.push(await mintCoin(helper, mine, 0.7 * FIRO));

    const pins = {};
    const c = client(mock, dir, pins);
    await c.start();
    await c.sync();
    assert.equal(c.lastError, null);
    assert.equal(pins['127.0.0.1'], mock.state.fingerprint, 'the certificate is pinned on first use');
    assert.deepEqual(c.balance(), { total: 220_000_000n, spendable: 220_000_000n });
    assert.equal(c.receiveAddress, mine);

    // More coins arrive: only the new ones are fetched, the cache lines up with the server.
    g.push(await mintCoin(helper, mine, 0.3 * FIRO));
    await c.sync();
    assert.equal(c.balance().total, 250_000_000n);

    // Private to public: the transparent output is exact, and the proof verifies against the set.
    const to = btc.p2pkh(Buffer.alloc(33, 2), { bech32: 'firo', pubKeyHash: 82, scriptHash: 7, wif: 210 }).address;
    const d = await c.draft(to, 1n * BigInt(FIRO));
    assert.equal(d.amount, 100_000_000n);
    assert.ok(d.fee > 0n && d.fee < 1_000_000n, `fee ${d.fee}`);
    const v = verify(d.hex, mock);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.type, 11);
    assert.equal(v.vout, 100_000_000);
    assert.equal(BigInt(v.fee), d.fee);
    assert.equal(d.hex.slice(0, 8), '03000b00', 'version 3, type 11');

    assert.equal(await c.send(d), d.txid);
    assert.equal(mock.state.sent[0], d.hex);
    assert.equal(c.balance().total, 250_000_000n - d.used.reduce((s, t) => s + BigInt((c.coins.find((x) => x.lTagHash === t)).value), 0n), 'coins in the send are held back');
    mock.mine(d.hex, v);
    await c.sync();
    assert.equal(c.balance().total, 150_000_000n - d.fee, 'spent coins drop out and the change comes back');
    const hist = c.history();
    assert.ok(hist.some((h) => h.hash === d.txid && h.direction === 'out' && h.amount === (1 + Number(d.fee) / FIRO).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')));

    // Private to private, everything: the fee comes off the amount.
    const p = await c.draft(other, 'max');
    assert.equal(p.amount + p.fee, 150_000_000n - d.fee);
    assert.equal(verify(p.hex, mock).ok, true);
    assert.equal(verify(p.hex, mock).vout, 0);

    // A tampered spend fails the same check.
    const bad = p.hex.slice(0, -10) + (p.hex.slice(-10, -8) === '00' ? '01' : '00') + p.hex.slice(-8);
    assert.equal(verify(bad, mock).ok, false);

    await assert.rejects(c.draft(mine, 1000n), /your own address/);
    await assert.rejects(c.draft(other.slice(0, -1) + 'q', 1000n), /valid Spark address/);
    c.close();
  } finally {
    helper.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a server whose certificate changed is refused; a reorganised set is fetched again', { skip, timeout: 300_000 }, async () => {
  const a = await startSparkMock();
  const b = await startSparkMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-'));
  const helper = startSparkEngine(ENGINE);
  try {
    const mine = await helper.call('address', { key: sparkKey(MNEMONIC), index: SPARK_INDEX, diversifier: 0 });
    for (const m of [a, b]) for (let i = 0; i < 3; i++) m.state.groups[1].push(await mintCoin(helper, mine, FIRO));
    const pins = { '127.0.0.1': a.state.fingerprint };
    const c = client(b, dir, pins);
    await c.start();
    await c.sync();
    assert.match(c.lastError, /certificate .* changed/);
    assert.equal(c.balance(), null);
    c.close();

    const c2 = client(a, dir, {});
    await c2.start();
    await c2.sync();
    assert.equal(c2.balance().total, 300_000_000n);
    // The newest coin is replaced, as after a reorganisation: the cache starts over and stays right.
    a.state.groups[1][2] = await mintCoin(helper, mine, 2 * FIRO);
    a.state.groups[1].push(await mintCoin(helper, mine, FIRO));
    a.state.noTxHashes = true; // a server with only the plain tag list
    await c2.sync();
    assert.equal(c2.lastError, null);
    assert.equal(c2.balance().total, 500_000_000n);
    c2.close();
  } finally {
    helper.close();
    await a.close();
    await b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Outputs of a legacy raw transaction. */
function sparkMints(raw) {
  let at = 4;
  const varint = () => { const c = raw[at++]; if (c < 0xfd) return c; const v = raw.readUInt16LE(at); at += 2; return v; };
  const nIn = varint();
  for (let i = 0; i < nIn; i++) { at += 36; const l = varint(); at += l + 4; }
  const n = varint();
  const outs = [];
  for (let i = 0; i < n; i++) { const value = raw.readBigUInt64LE(at); at += 8; const l = varint(); outs.push({ value, script: raw.subarray(at, at + l) }); at += l; }
  return outs;
}

test('the hand-written legacy signer makes byte for byte the transaction the general signer makes', () => {
  const { signFiroDraft } = require('../dist/main/firo');
  const { signLegacy } = require('../dist/main/spark');
  const { HDKey } = require('@scure/bip32');
  const { mnemonicToSeedSync } = require('@scure/bip39');
  const NET = { bech32: 'firo', pubKeyHash: 82, scriptHash: 7, wif: 210 };
  const acct = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/44'/136'/0'");
  const k0 = acct.deriveChild(0).deriveChild(0), k1 = acct.deriveChild(0).deriveChild(3), ch = acct.deriveChild(1).deriveChild(0);
  const a0 = btc.p2pkh(k0.publicKey, NET).address, a1 = btc.p2pkh(k1.publicKey, NET).address, change = btc.p2pkh(ch.publicKey, NET).address;
  const to = btc.p2pkh(acct.deriveChild(7).deriveChild(7).publicKey, NET).address;
  const inputs = [{ txid: '11'.repeat(32), vout: 0, value: 30_000_000n, address: a0, chain: 0, index: 0 }, { txid: '22'.repeat(31) + '33', vout: 5, value: 40_000_000n, address: a1, chain: 0, index: 3 }];
  const draft = { to, amount: 50_000_000n, fee: 1_000n, change: 19_999_000n, changeAddress: change, changeIndex: 0, inputs };
  const ref = signFiroDraft(draft, MNEMONIC);
  const mine = signLegacy(
    [{ txid: inputs[0].txid, vout: 0, script: btc.p2pkh(k0.publicKey, NET).script, key: k0.privateKey, pub: k0.publicKey }, { txid: inputs[1].txid, vout: 5, script: btc.p2pkh(k1.publicKey, NET).script, key: k1.privateKey, pub: k1.publicKey }],
    [{ script: btc.OutScript.encode(btc.Address(NET).decode(to)), value: 50_000_000n }, { script: btc.OutScript.encode(btc.Address(NET).decode(change)), value: 19_999_000n }],
    1, 0, 0xffffffff,
  );
  assert.equal(mine.hex, ref.hex);
  assert.equal(mine.id, ref.id);
});

test('a mint signs public coins into Spark outputs only, with Firo\'s sequence and lock time', { skip }, async () => {
  const { HDKey } = require('@scure/bip32');
  const { mnemonicToSeedSync } = require('@scure/bip39');
  const NET = { bech32: 'firo', pubKeyHash: 82, scriptHash: 7, wif: 210 };
  const acct = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/44'/136'/0'");
  const address = btc.p2pkh(acct.deriveChild(0).deriveChild(0).publicKey, NET).address;
  const inputs = [{ txid: 'aa'.repeat(32), vout: 1, value: 50_000_000n, address, chain: 0, index: 0 }];
  const e = startSparkEngine(ENGINE);
  try {
    const mine = await e.call('address', { key: sparkKey(MNEMONIC), index: SPARK_INDEX, diversifier: 0 });
    const c = new SparkClient({ engine: () => e, dir: os.tmpdir(), pins: () => ({}), savePin: () => undefined, canConnect: () => false, onChange: () => undefined }, sparkKey(MNEMONIC));
    c.engine = e; c.ready = true; c.receiveAddress = mine; c.height = 1_400_123;
    const d = await c.mintDraft(inputs);
    assert.equal(d.amount + d.fee, 50_000_000n);
    const { hex } = signFiroMint(d, MNEMONIC);
    const raw = Buffer.from(hex, 'hex');
    assert.equal(raw.readUInt32LE(0), 1, 'version 1');
    assert.equal(raw.readUInt32LE(raw.length - 4), 1_400_123, 'lock time');
    assert.equal(raw[4], 1, 'one input');
    const scriptLen = raw[4 + 1 + 36];
    assert.equal(raw.readUInt32LE(4 + 1 + 36 + 1 + scriptLen), 0xfffffffe, 'sequence');
    const outs = sparkMints(raw);
    assert.equal(outs.length, 1);
    assert.equal(outs[0].value, d.amount);
    assert.equal(outs[0].script.toString('hex'), d.outputs[0].script);
    // The fee is at least 2 atoms per byte of the signed transaction.
    assert.ok(d.fee >= BigInt(raw.length) * 2n, `fee ${d.fee} for ${raw.length} bytes`);
    assert.throws(() => signFiroMint({ ...d, fee: d.fee + 1n }, MNEMONIC), /do not add up/);
  } finally { e.close(); }
});
