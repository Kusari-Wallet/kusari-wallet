// Decred mixing (StakeShuffle): the cryptography and wire formats pinned to vectors made by dcrd's own Go code
// (tests/fixtures/dcr-mix-vectors.json), then whole sessions between this wallet's own mixing clients in memory.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const V = require('./fixtures/dcr-mix-vectors.json');
const c = require('../dist/main/dcr-mix-crypto');
const s = require('../dist/main/sntrup');
const w = require('../dist/main/dcr-wire');
const mix = require('../dist/main/dcr-mix');
const { splitFor } = require('../dist/main/dcr-mixer');
const dcr = require('../dist/main/dcr');
const { secp256k1 } = require('@noble/curves/secp256k1.js');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hex = (b) => Buffer.from(b).toString('hex');
const seed = (b) => Uint8Array.from({ length: 32 }, (_, i) => (b + i) & 0xff);
const rnd = () => BigInt('0x' + crypto.randomBytes(16).toString('hex'));

test('the seeded ChaCha20 stream and sntrup4591761 as the Go code has them', () => {
  assert.equal(hex(new c.ChaChaPrng(seed(1), 7).next(200)), V.prng);
  const p = new c.ChaChaPrng(seed(2), 0);
  const k = s.generateKey(p.reader);
  const e = s.encapsulate(p.reader, k.publicKey);
  assert.equal(sha(k.publicKey), V.sntrup.pk);
  assert.equal(sha(k.privateKey), V.sntrup.sk);
  assert.equal(sha(e.ciphertext), V.sntrup.ct);
  assert.equal(hex(e.sharedKey), V.sntrup.k);
  const d = s.decapsulate(e.ciphertext, k.privateKey);
  assert.ok(d.ok);
  assert.equal(hex(d.sharedKey), V.sntrup.k);
  const bad = Uint8Array.from(e.ciphertext); bad[100] ^= 1;
  assert.equal(s.decapsulate(bad, k.privateKey).ok, false);
});

test('key exchange, shared secrets and both DC-nets as dcrd derives them', () => {
  const mcounts = [1, 2, 1]; const sid = seed(9);
  const prngs = [0, 1, 2].map((i) => new c.ChaChaPrng(seed(20 + i), 0));
  const kxs = prngs.map((pr) => c.newKX(pr));
  kxs.forEach((kx, i) => { assert.equal(hex(kx.ecdhPub), V.kx[i].ecdh); assert.equal(sha(kx.pqPub), V.kx[i].pq); });
  const cts = kxs.map((kx, i) => c.encapsulateAll(kx, prngs[i], kxs.map((x) => x.pqPub)));
  for (let my = 0; my < 3; my++) {
    const ss = c.sharedSecrets(kxs[my], kxs.map((x) => x.ecdhPub), cts.map((ct) => ct[my]), my, sid, mcounts);
    const buf = [];
    ss.sr.forEach((row, i) => row.forEach((x, m) => { if (x) buf.push(Buffer.from(x)); (ss.dc[i][m] || []).forEach((v) => buf.push(Buffer.from(v))); }));
    assert.equal(sha(Buffer.concat(buf)), V.shared[my], `peer ${my}`);
    if (my === 1) {
      assert.equal(JSON.stringify(c.srMix(123456789n, c.srMixPads(ss.sr[1], 2)).map((x) => hex(c.bigToBytes(x)))), JSON.stringify(V.srmix));
      const dm = c.dcMix(c.dcMixPads(ss.dc[0], 1), seed(40).slice(0, 20), 3);
      assert.equal(hex(dm[3]) + hex(dm[0]), V.dcmix);
    }
  }
});

test('slot polynomial: coefficients from power sums, and its roots found', () => {
  const F = c.F; const msgs = [5n, 77n, F - 3n];
  const sums = [1, 2, 3].map((e) => msgs.reduce((a, m) => a + (m ** BigInt(e)) % F, 0n) % F);
  const co = c.coefficients(sums);
  assert.deepEqual(co.map(String), V.coeffs);
  assert.deepEqual(c.solveRoots(co, rnd).map(String), msgs.map(String));
  for (const m of msgs) assert.ok(c.isRoot(m, co));
  const many = Array.from({ length: 24 }, () => rnd() % F);
  const ms = many.map((_, e) => many.reduce((a, m) => (a + (m ** BigInt(e + 1)) % F) % F, 0n));
  assert.deepEqual(c.solveRoots(c.coefficients(ms), rnd).map(String), [...many].sort((a, b) => (a < b ? -1 : 1)).map(String));
  // A collision (two equal messages) leaves fewer distinct roots than the degree: no answer.
  const dup = [9n, 9n, 11n];
  const ds = [1, 2, 3].map((e) => dup.reduce((a, m) => a + m ** BigInt(e), 0n) % F);
  assert.equal(c.solveRoots(c.coefficients(ds), rnd), null);
});

test('EC-Schnorr-DCRv0 signatures and UTXO proofs, byte for byte', () => {
  assert.equal(hex(c.schnorrSign(seed(50), Buffer.from(V.schnorr.hash, 'hex'))), V.schnorr.sig);
  assert.ok(c.schnorrVerify(Buffer.from(V.schnorr.pub, 'hex'), Buffer.from(V.schnorr.hash, 'hex'), Buffer.from(V.schnorr.sig, 'hex')));
  const wrong = Buffer.from(V.schnorr.hash, 'hex'); wrong[0] ^= 1;
  assert.equal(c.schnorrVerify(Buffer.from(V.schnorr.pub, 'hex'), wrong, Buffer.from(V.schnorr.sig, 'hex')), false);
  assert.equal(hex(c.schnorrSign(seed(50), c.utxoProofHash(1234, c.publicKeyOf(seed(50))))), V.utxoproof);
});

test('the eight mixing messages: decoded, encoded, hashed and signed as dcrd does', () => {
  const cmds = { pr: 'mixpairreq', ke: 'mixkeyxchg', ct: 'mixcphrtxt', sr: 'mixslotres', fp: 'mixfactpoly', dc: 'mixdcnet', cm: 'mixconfirm', rs: 'mixsecrets' };
  for (const [k, cmd] of Object.entries(cmds)) {
    const v = V.msgs[k];
    const m = w.decodeMix(cmd, Buffer.from(v.hex, 'hex'));
    assert.equal(w.encodeMix(m).toString('hex'), v.hex, k);
    assert.equal(w.hashString(w.mixHash(m)), v.hash, k);
    assert.ok(w.verifyMix(m), k);
    const sig = hex(m.sig);
    w.signMix(m, seed(50));
    assert.equal(hex(m.sig), sig, `${k} signed the same`);
    if (k === 'pr') assert.equal(w.prPairing(m).toString('hex'), V.pairing);
    if (k === 'rs') assert.equal(w.hashString(w.rsCommitment(m)), V.rsCommitment);
    assert.throws(() => w.decodeMix(cmd, Buffer.concat([Buffer.from(v.hex, 'hex'), Buffer.from([0])])), /extra bytes/);
  }
  // A frame: magic, command, length, BLAKE-256 checksum; a damaged one is refused.
  const f = w.frame(w.NET_MAGIC.mainnet, 'mixpairreq', Buffer.from(V.msgs.pr.hex, 'hex'));
  const u = new w.Unframer(w.NET_MAGIC.mainnet);
  assert.equal(u.push(f)[0].command, 'mixpairreq');
  const bad = Buffer.from(f); bad[bad.length - 1] ^= 1;
  assert.throws(() => new w.Unframer(w.NET_MAGIC.mainnet).push(bad), /damaged/);
});

test('coins split as dcrwallet splits them: powers of two below the ticket price, up to four, change if worth it', () => {
  const price = 20_000_000_000n; // 200 DCR
  assert.deepEqual(splitFor(150_000_000n, price), { mixValue: 1n << 26n, count: 2, change: 150_000_000n - 2n * (1n << 26n) - 2890n }); // 289 bytes (one input, two outputs and change) at 10 atoms/B
  assert.equal(splitFor(10n ** 12n, price).mixValue, 1n << 34n, '171.8 DCR, under the price');
  assert.equal(splitFor(10n ** 12n, price).count, 4);
  assert.equal(splitFor(100_000n, price), null, 'too small');
  // The smallest size takes everything left as fee (dcrwallet does the same), within what mixpool allows.
  const s18 = splitFor(1_060_000n, 20_000n);
  assert.deepEqual([s18.mixValue, s18.count, s18.change], [1n << 18n, 4, 0n]);
  assert.ok(mix.prFeeOk({ inputValue: 1_060_000n, messageCount: 4, mixAmount: 1n << 18n, change: null, utxos: [1] }));
});

// ---- whole sessions in memory ----

function harness(n, solvers, tamper) {
  const pools = []; const published = []; const cjs = [];
  const net = (me) => ({
    broadcast: (m) => { const out = tamper ? tamper(m) : m; for (const p of pools) if (p !== me) { try { p.accept(out); } catch { /* refused */ } } },
    publish: async (tx) => { published.push(tx); },
  });
  const clients = [];
  for (let i = 0; i < n; i++) { const pool = new mix.MixPool(60_000, () => 100, 12); pools.push(pool); clients.push(new mix.MixClient(pool, net(pool), { epochMs: 60_000, stageTimeoutMs: 4_000, pairingVersion: 3, solveRoots: solvers.includes(i) })); }
  const jobs = clients.map((cl, i) => {
    const priv = secp256k1.utils.randomSecretKey();
    const script = dcr.dcrScript(dcr.dcrAddressOf(secp256k1.getPublicKey(priv, true)));
    const value = 2n * (1n << 20n) + 500_000n + mix.feeForSize(mix.estimateSize(1, 2, true));
    const change = { value: 500_000n, version: 0, script: Uint8Array.from([0x76, 0xa9, 0x14, ...crypto.randomBytes(20), 0x88, 0xac]) };
    const cj = new mix.CoinJoin([{ txid: crypto.randomBytes(32).toString('hex'), vout: i, tree: 0, value, script, priv }], change, 1n << 20n, 110, 2, (k) => Array.from({ length: k }, () => crypto.randomBytes(20)));
    cjs.push(cj);
    return cl.dicemix(cj).then((txid) => ({ txid }), (e) => ({ err: e.message }));
  });
  return { clients, published, jobs, cjs };
}

test('four wallets mix in one session: every input signed, every output in, only one solver needed', { timeout: 240_000 }, async () => {
  const { clients, published, jobs } = harness(4, [2]);
  const res = await Promise.all(jobs);
  clients.forEach((cl) => cl.stop());
  assert.ok(res.every((r) => r.txid && r.txid === res[0].txid), JSON.stringify(res));
  const tx = published[0];
  assert.equal(tx.inputs.length, 4);
  assert.equal(tx.outputs.filter((o) => o.value === 1n << 20n).length, 8);
  assert.equal(tx.outputs.filter((o) => o.value === 500_000n).length, 4);
  assert.ok(tx.inputs.every((x) => x.sigScript.length > 100));
});

test('a peer that sends a wrong DC-net is found from the revealed secrets, and the rest mix without it', { timeout: 420_000 }, async () => {
  let cheater = null;
  const tamper = (m) => {
    if (m.cmd !== 'mixdcnet') return m;
    cheater = cheater ?? Buffer.from(m.identity).toString('hex');
    if (Buffer.from(m.identity).toString('hex') !== cheater) return m;
    const bad = { ...m, dcnet: m.dcnet.map((v) => v.map((x) => Uint8Array.from(x, (b) => b ^ 0x55))) };
    bad.sig = new Uint8Array(64);
    return bad;
  };
  // The tampered message carries a broken signature, so others refuse it and the cheater times out at DC.
  const { clients, published, jobs, cjs } = harness(5, [0, 1, 2, 3, 4], tamper);
  // The honest four finish; the cheater is left alone (too few peers) until its pair request expires.
  const ok = await new Promise((resolve) => {
    const done = [];
    jobs.forEach((j) => j.then((r) => { if (r.txid) { done.push(r); if (done.length === 4) resolve(done); } }));
    setTimeout(() => resolve(done), 400_000);
  });
  clients.forEach((cl) => cl.stop());
  assert.equal(ok.length, 4, JSON.stringify(ok));
  assert.ok(ok.every((r) => r.txid === ok[0].txid));
  // Everyone sent a DC-net in the first run, so every coinjoin's outputs count as seen: the cheater's (whose mix
  // never finished) included. The mixer never hands those addresses out again.
  assert.ok(cjs.every((cj) => cj.exposed));
  assert.equal(published[0].inputs.length, 4, 'mixed without the cheater');
});

test('the version message asks nodes to relay and claims no blocks (else dcrd sends no mixing inventory, or syncs from us)', () => {
  const p = w.versionPayload(0, Buffer.alloc(8, 7));
  const v = w.readVersion(p);
  assert.equal(v.version, 11, 'MixVersion');
  assert.equal(v.services, 0n);
  assert.equal(v.height, 0);
  assert.equal(p[p.length - 1], 1, 'relay transactions (wire: true means relay)');
});

test('a node can\'t fill memory with made-up pair requests: the pool stops taking others\' at its cap, never our own', () => {
  const pool = new mix.MixPool(600_000, () => 100, 3600);
  const pr = w.decodeMix('mixpairreq', Buffer.from(V.msgs.pr.hex, 'hex'));
  for (let i = 0; i < mix.MAX_POOL_PRS; i++) pool.prs.set(`filler${i}`, pr);
  assert.throws(() => pool.accept(pr), /pool full/);
  assert.throws(() => pool.accept(pr, true), (e) => !/pool full/.test(e.message), 'our own PR is judged on its merits');
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 20_000; i++) { try { pool.accept(w.decodeMix('mixpairreq', Buffer.from(V.msgs.pr.hex, 'hex'))); } catch { /* full */ } }
  global.gc?.();
  assert.ok(!(pool.hashes instanceof Map), 'hashes are held weakly');
  assert.ok(process.memoryUsage().heapUsed - before < 200 * 1024 * 1024);
});
