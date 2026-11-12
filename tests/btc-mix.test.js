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
