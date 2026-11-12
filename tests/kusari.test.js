const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const coin = require('../native/kusari-coin/lib');
const { isKusariAddress, kusariKeys, parseRpc, KusariClient, KUS_PREFIXES } = require('../dist/main/kusari');
const { parseChallenge, digestHeader, kusariRpc, startKusariEngine } = require('../dist/main/kusari-process');

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const MONERO = '888tNkZrPN6JsEgekjMnABU4TBzc2Dt29EPAvkRxbANsAnjyPbb3iQ1YBRk1UXcdRsiKc9dhwMVgN5S9cQUiyoogDavup3H';
// Binaries from native/kusari-coin. Without them the end-to-end test is skipped.
const BIN = process.env.KUSARI_BIN_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the prefixes are the ones the chain was made with', () => {
  const params = JSON.parse(fs.readFileSync(path.join(__dirname, '../native/kusari-coin/params.json'), 'utf8'));
  assert.deepStrictEqual(KUS_PREFIXES, params.mainnet.prefixes);
});

test('Kusari addresses are told apart from Monero ones', () => {
  for (const [kind, prefix] of Object.entries(KUS_PREFIXES)) {
    const a = kind === 'integrated'
      ? coin.cnBase58((() => { const b = Buffer.concat([coin.varint(prefix), crypto.randomBytes(72)]); return Buffer.concat([b, coin.keccak256(b).subarray(0, 4)]); })())
      : coin.encodeAddress(prefix, crypto.randomBytes(32), crypto.randomBytes(32));
    assert.ok(isKusariAddress(a), `${kind} ${a}`);
    const broken = a.slice(0, 20) + (a[20] === 'z' ? 'y' : 'z') + a.slice(21);
    assert.ok(!isKusariAddress(broken), `checksum ${kind}`);
  }
  assert.ok(!isKusariAddress(MONERO));
  // Monero's own prefixes with a valid checksum.
  assert.ok(!isKusariAddress(coin.encodeAddress(18, crypto.randomBytes(32), crypto.randomBytes(32))));
  assert.ok(!isKusariAddress(''));
  assert.ok(!isKusariAddress('K' + '1'.repeat(94)));
});

test('keys come from the BIP39 seed and never change', () => {
  const a = kusariKeys(SEED, 'vault-secret');
  const b = kusariKeys(SEED, 'other-secret');
  assert.strictEqual(a.address, b.address); // the address follows the seed alone
  assert.notStrictEqual(a.pass, b.pass);
  assert.notStrictEqual(a.address, kusariKeys(OTHER_SEED, 'vault-secret').address);
  assert.ok(isKusariAddress(a.address));
  assert.strictEqual(a.address[0], 'K');
  assert.match(a.spend, /^[0-9a-f]{64}$/);
  assert.match(a.view, /^[0-9a-f]{64}$/);
  // Fixed forever: a change here would show people an empty wallet.
  assert.strictEqual(a.spend, kusariKeys(SEED, 'x').spend);
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const le = (h) => BigInt('0x' + Buffer.from(h, 'hex').reverse().toString('hex'));
  assert.ok(le(a.spend) < L && le(a.view) < L);
  assert.strictEqual(le(a.view), le(coin.keccak256(Buffer.from(a.spend, 'hex')).toString('hex')) % L);
});

test('digest login matches the RFC 2617 example', () => {
  const c = parseChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  const h = digestHeader(c, 'Mufasa', 'Circle Of Life', 'GET', '/dir/index.html', 1, '0a4f113b');
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(h, /nc=00000001/);
  assert.match(h, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test('the RPC client answers a digest challenge and refuses a wrong login', async () => {
  const pass = 'right';
  let seen = 0;
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    if (!auth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="abc",stale=false' });
      return res.end();
    }
    const c = parseChallenge(auth);
    const ha1 = crypto.createHash('md5').update(`kusari:monero-rpc:${pass}`).digest('hex');
    const ha2 = crypto.createHash('md5').update(`POST:/json_rpc`).digest('hex');
    const want = crypto.createHash('md5').update(`${ha1}:abc:${c.nc}:${c.cnonce}:auth:${ha2}`).digest('hex');
    if (c.response !== want) { res.writeHead(401, { 'WWW-Authenticate': 'Digest qop="auth",realm="monero-rpc",nonce="abc"' }); return res.end(); }
    seen++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"result":{"balance":123456789012345678901}}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ok = kusariRpc(port, 'kusari', pass);
  assert.strictEqual(parseRpc(await ok('{}')).result.balance, '123456789012345678901');
  await ok('{}');
  assert.strictEqual(seen, 2);
  await assert.rejects(kusariRpc(port, 'kusari', 'wrong')('{}'), /401/);
  server.close();
});

test('amounts past 2^53 stay exact', () => {
  const r = parseRpc('{"result":{"balance":18446744073709551615,"unlocked_balance":9007199254740993,"amount_list":[9007199254740993, 1],"fee_list":[],"tx_hash":"ab"}}').result;
  assert.strictEqual(r.balance, '18446744073709551615');
  assert.strictEqual(r.unlocked_balance, '9007199254740993');
  assert.deepStrictEqual(r.amount_list, ['9007199254740993', '1']);
  assert.deepStrictEqual(r.fee_list, []);
});

test('no node set means a clear message, not a start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kus-'));
  const fake = path.join(dir, 'kusari-wallet-rpc');
  fs.writeFileSync(fake, '');
  await assert.rejects(startKusariEngine(fake, dir, { node: '' }), /Set a Kusari node/);
  await assert.rejects(startKusariEngine(path.join(dir, 'missing'), dir, { node: '127.0.0.1:1' }), /no Kusari engine/);
  fs.rmSync(dir, { recursive: true, force: true });
});

function rpc(port, method, params = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/json_rpc', method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 600000 }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { const j = JSON.parse(s); j.error ? reject(new Error(j.error.message)) : resolve(j.result); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function until(what, fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

test('a real Kusari wallet syncs, sends and shows its history', { skip: !BIN && 'set KUSARI_BIN_DIR to the built native/kusari-coin binaries', timeout: 900000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kus-e2e-'));
  const dport = 30000 + Math.floor(Math.random() * 20000);
  const daemon = spawn(path.join(BIN, 'kusarid'), ['--regtest', '--fixed-difficulty', '1', '--offline', '--no-igd', '--non-interactive',
    '--data-dir', path.join(dir, 'chain'), '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(dport), '--p2p-bind-ip', '127.0.0.1',
    '--p2p-bind-port', String(dport + 1), '--zmq-rpc-bind-port', String(dport + 2)], { stdio: 'ignore' });
  const clients = [];
  try {
    await until('daemon', () => rpc(dport, 'get_info'), 60000);
    const make = (seed, name) => {
      let changes = 0;
      const keys = kusariKeys(seed, name);
      const c = new KusariClient({
        engine: () => startKusariEngine(path.join(BIN, 'kusari-wallet-rpc'), path.join(dir, name), { node: `127.0.0.1:${dport}`, extraArgs: ['--allow-mismatched-daemon-version'] }),
        canConnect: () => true,
        onChange: () => { changes++; },
      }, keys);
      clients.push(c);
      return { c, address: keys.address, changes: () => changes };
    };
    const me = make(SEED, 'me');
    const them = make(OTHER_SEED, 'them');
    await rpc(dport, 'generateblocks', { amount_of_blocks: 80, wallet_address: me.address });
    await me.c.start();
    await them.c.start();
    // generate_from_keys refuses keys that don't match the address, so getting here checks the derivation.
    await until('my coinbase', () => (me.c.balance()?.[1] ?? 0n) > 0n, 120000);
    assert.ok(me.changes() > 0);
    assert.ok(!me.c.isScanning);

    await assert.rejects(me.c.draft(MONERO, 1n), /Not a Kusari address/);
    const draft = await me.c.draft(them.address, 1_000_000_000_000n);
    assert.strictEqual(draft.value, 1_000_000_000_000n);
    assert.ok(draft.fee > 0n && draft.fee < 10_000_000_000n, `fee ${draft.fee}`);
    // A draft is only signed, not sent: nothing reaches the pool yet.
    assert.strictEqual(((await rpc(dport, 'get_info')).tx_pool_size), 0);
    const [hash] = await me.c.send(draft);
    assert.match(hash, /^[0-9a-f]{64}$/);
    await until('the pool', async () => (await rpc(dport, 'get_info')).tx_pool_size === 1, 30000);
    await rpc(dport, 'generateblocks', { amount_of_blocks: 1, wallet_address: me.address });
    await until('them to receive', () => (them.c.balance()?.[0] ?? 0n) === 1_000_000_000_000n, 120000);
    const mine = await me.c.getHistory();
    const sent = mine.find((t) => t.hash === hash);
    assert.ok(sent, 'sent transfer in history');
    assert.strictEqual(sent.direction, 'out');
    assert.strictEqual(sent.amount, '1');
    assert.strictEqual(sent.counterparty, them.address);
    const got = (await them.c.getHistory()).find((t) => t.hash === hash);
    assert.strictEqual(got.direction, 'in');
    assert.strictEqual(got.status, 'confirmed');

    // Received coins wait 10 blocks, and saying so beats the engine's own wording.
    await assert.rejects(them.c.draft(me.address, 'max'), /after 10 confirmations/);
    await rpc(dport, 'generateblocks', { amount_of_blocks: 10, wallet_address: me.address });
    await until('them to unlock', () => (them.c.balance()?.[1] ?? 0n) === 1_000_000_000_000n, 120000);
    // Sending everything: one or more transactions, all built before any is sent.
    const all = await them.c.draft(me.address, 'max');
    assert.ok(all.value > 0n && all.value + all.fee === 1_000_000_000_000n, `${all.value} + ${all.fee}`);

    // Reopening uses the saved file and finds the same wallet.
    await them.c.stop();
    const again = make(OTHER_SEED, 'them');
    await again.c.start();
    await until('reopened balance', () => (again.c.balance()?.[0] ?? 0n) === 1_000_000_000_000n, 120000);
  } finally {
    await Promise.allSettled(clients.map((c) => c.stop()));
    daemon.kill('SIGTERM');
    await sleep(1500);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
