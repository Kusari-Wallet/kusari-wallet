const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const btc = require('@scure/btc-signer');
const { sha256 } = require('@noble/hashes/sha2.js');
const { HDKey } = require('@scure/bip32');
const { mnemonicToSeedSync } = require('@scure/bip39');
const { BtcMixer, coordinatorTransport, COINJOIN_COORDINATORS } = require('../dist/main/btc-mix');
const { CoordinatorError } = require('../dist/main/wabisabi/client');
const { mockCoordinator } = require('./mock-wabisabi');

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MN));

test('coordinator requests: plain headers, JSON both ways, its errors read', async (t) => {
  const seen = [];
  const server = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', () => {
      seen.push({ url: q.url, headers: q.headers, body: b });
      r.setHeader('content-type', 'application/json; charset=utf-8');
      if (q.url.endsWith('/input-registration')) { r.statusCode = 500; return r.end(JSON.stringify({ type: 'wabisabi-protocol-violation', errorCode: 'InputBanned', description: 'banned', exceptionData: { Type: 'InputBannedExceptionData', BannedUntil: '2026-11-13T00:00:00+00:00' } })); }
      if (q.url.endsWith('/ready-to-sign')) return r.end('');
      r.end(JSON.stringify({ roundStates: [] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const tr = coordinatorTransport(`http://127.0.0.1:${server.address().port}`, () => undefined);
  assert.deepEqual(await tr.post('status', { RoundCheckpoints: [] }, 'status-1'), { roundStates: [] });
  assert.deepEqual(await tr.post('ready-to-sign', { RoundId: 'x' }, 'alice-1'), {}, 'an empty answer is fine');
  await assert.rejects(tr.post('input-registration', {}, 'alice-2'), (e) => e instanceof CoordinatorError && e.code === 'InputBanned' && e.data.Type === 'InputBannedExceptionData');
  const h = seen[0].headers;
  assert.equal(seen[0].url, '/wabisabi/status');
  assert.equal(seen[0].body, '{"RoundCheckpoints":[]}');
  assert.equal(h['content-type'], 'application/json; charset=utf-8');
  assert.equal(h['user-agent'], undefined, 'no user agent that would single this wallet out');
  assert.equal(h.accept, undefined);
  assert.equal(h['x-kusari-route'], undefined, 'route names stay inside the app');
  assert.ok(COINJOIN_COORDINATORS.every((c) => /^https:\/\/.+\/$/.test(c.url)));
});

test('the mixer: one round, outputs on fresh CoinJoin addresses never handed out twice, keys wiped afterwards', { timeout: 240_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-mix-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const acct = root.derive("m/86'/0'/0'/0");
  const coins = [700000, 300000].map((v, i) => ({ txid: Buffer.from(sha256(Buffer.from('m' + i))).toString('hex'), vout: 0, value: BigInt(v), script: btc.p2tr(acct.deriveChild(i).publicKey.slice(1)).script }));
  const keys = new Map(coins.map((c, i) => [`${c.txid}:0`, Uint8Array.from(acct.deriveChild(i).privateKey)]));
  const keyCopies = [...keys.values()];
  const mixedAccount = HDKey.fromExtendedKey(root.derive("m/86'/0'/1'").publicExtendedKey);
  fs.writeFileSync(path.join(dir, 'btc-coinjoin.json'), JSON.stringify({ next: 7 }));
  const coord = mockCoordinator({ utxos: new Map(coins.map((c) => [`${c.txid}:0`, { value: c.value, script: c.script }])), expectInputs: 2, others: 5, inputRegMs: 4000 });
  let mixed = 0;
  const mixer = new BtcMixer({
    dir, coordinator: () => 'unused', newAgent: () => undefined, coins: async () => coins, firstUnused: () => 3,
    maxFeePerK: async () => 10000n, canConnect: () => true, onMixed: () => { mixed++; }, transport: coord.transport,
    extra: { pollMs: 150, registrationMarginMs: 2000, minInputs: 3 },
  });
  const stages = [];
  mixer.onChange = () => stages.push(mixer.status.stage);
  await mixer.start({ coinKeys: keys, idKey: new Uint8Array(32).fill(1), mixedAccount });
  await assert.rejects(mixer.start({ coinKeys: new Map(), idKey: new Uint8Array(32), mixedAccount }), /already running/);
  for (let i = 0; i < 600 && mixer.status.running; i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal(mixer.status.stage, 'done');
  assert.equal(mixed, 1);
  assert.ok(mixer.status.last.ok && /^[0-9a-f]{64}$/.test(mixer.status.last.txid));
  for (const s of ['waiting', 'registering', 'confirming', 'outputs', 'signing']) assert.ok(stages.includes(s), s);
  // Outputs went to the CoinJoin account, starting at the saved index, and the next round starts after them.
  const ours = coord.state.outputs.filter((o) => Array.from({ length: 40 }, (_, i) => Buffer.from(btc.p2tr(mixedAccount.deriveChild(0).deriveChild(i).publicKey.slice(1)).script).toString('hex')).includes(Buffer.from(o.script).toString('hex')));
  assert.ok(ours.length >= 2);
  const first = Buffer.from(btc.p2tr(mixedAccount.deriveChild(0).deriveChild(7).publicKey.slice(1)).script).toString('hex');
  assert.ok(ours.some((o) => Buffer.from(o.script).toString('hex') === first), 'starts at the saved index, past what the account used');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'btc-coinjoin.json'), 'utf8'));
  assert.equal(saved.next, 7 + ours.length);
  assert.ok(saved.last.ok);
  assert.ok(keyCopies.every((k) => k.every((b) => b === 0)), 'private keys are wiped once done');
});

test('the mixer stops when asked and wipes its keys', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-mix-'));
  const key = new Uint8Array(32).fill(9);
  const mixer = new BtcMixer({
    dir, coordinator: () => 'x', newAgent: () => undefined, coins: async () => [{ txid: 'aa'.repeat(32), vout: 0, value: 100000n, script: new Uint8Array(34) }], firstUnused: () => 0,
    maxFeePerK: async () => 10000n, canConnect: () => true,
    mix: (_c, o) => new Promise((resolve) => o.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'Stopped.', signed: false }))),
  });
  await mixer.start({ coinKeys: new Map([['aa'.repeat(32) + ':0', key]]), idKey: new Uint8Array(32).fill(2), mixedAccount: { deriveChild: () => null } });
  assert.ok(mixer.status.running);
  mixer.stop();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!mixer.status.running);
  assert.ok(key.every((b) => b === 0));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scores: an output hides among the others of its amount, on top of its least hidden input', () => {
  const { outputScores } = require('../dist/main/btc-mix');
  const s = (n) => Uint8Array.from([0x51, 32, ...Array(32).fill(n)]);
  const result = {
    ok: true, roundId: 'r', txid: 'ab'.repeat(32), inputs: [{ txid: '01'.repeat(32), vout: 0 }, { txid: '02'.repeat(32), vout: 0 }],
    outputs: [{ value: 100000n, script: s(1), vout: 3 }, { value: 50000n, script: s(2), vout: 7 }],
    all: [{ value: 100000n, script: s(1) }, { value: 50000n, script: s(2) }, ...[9, 10, 11, 12].map((n) => ({ value: 100000n, script: s(n) })), { value: 50000n, script: s(20) }, { value: 777n, script: s(30) }],
  };
  assert.deepEqual(outputScores(result, (c) => (c.txid.startsWith('01') ? 3 : 1)), [{ id: `${'ab'.repeat(32)}:3`, anon: 5 }, { id: `${'ab'.repeat(32)}:7`, anon: 2 }]);
});

test('remixing: mixed coins go round again until hidden among the target, with keys from the CoinJoin account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-remix-'));
  const mixedPriv = root.derive("m/86'/0'/1'");
  const mixedPub = HDKey.fromExtendedKey(mixedPriv.publicExtendedKey);
  const s = (n) => Uint8Array.from([0x51, 32, ...Array(32).fill(n)]);
  const pub = { txid: '11'.repeat(32), vout: 0, value: 500000n, script: s(1) };
  const wallet = { mixed: [] };
  const rounds = [];
  const mix = async (coins, o) => {
    rounds.push(coins.map((c) => `${c.txid}:${c.vout}`));
    for (const c of coins) assert.ok(o.keyFor(c).length === 32);
    const dest = o.destinations(1)[0];
    const txid = ['aa', 'bb', 'cc', 'dd'][rounds.length - 1].repeat(32);
    // Each round puts the output among 2 others of the same amount.
    const out = { value: 400000n, script: dest, vout: 0 };
    wallet.mixed = [{ txid, vout: 0, value: 400000n, script: dest, chain: 0, index: 0 }];
    return { ok: true, roundId: 'r', txid, inputs: coins, outputs: [out], all: [out, { value: 400000n, script: s(8) }, { value: 400000n, script: s(9) }] };
  };
  let mixedCalls = 0;
  const mixer = new BtcMixer({
    dir, coordinator: () => 'x', newAgent: () => undefined, coins: async () => [pub].filter(() => rounds.length === 0), firstUnused: () => 0,
    mixedCoins: async () => { mixedCalls++; return wallet.mixed; }, maxFeePerK: async () => 1000n, canConnect: () => true, mix,
  });
  const done = new Promise((r) => { mixer.onChange = () => { if (process.env.DBG) console.log(JSON.stringify(mixer.status)); if (!mixer.status.running) r(); }; });
  await mixer.start({ coinKeys: new Map([[`${pub.txid}:0`, new Uint8Array(32).fill(3)]]), idKey: new Uint8Array(32), mixedAccount: mixedPub, mixedPrivate: mixedPriv, target: 5 });
  await Promise.race([done, new Promise((r) => setTimeout(r, 30_000))]);
  // Public coin: 1 + 2 = 3; again: 3 + 2 = 5, which meets the target.
  assert.equal(rounds.length, 2, JSON.stringify(rounds));
  assert.deepEqual(rounds[1], [`${'aa'.repeat(32)}:0`], 'the second round mixes the first round\'s output');
  assert.equal(await mixer.scoreOf(`${'bb'.repeat(32)}:0`), 5);
  assert.equal(mixer.status.stage, 'done');
  assert.ok(mixedCalls >= 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
