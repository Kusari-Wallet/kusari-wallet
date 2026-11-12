const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const btc = require('@scure/btc-signer');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { sha256 } = require('@noble/hashes/sha2.js');
const { Strobe128, StrobeHasher } = require('../dist/main/wabisabi/strobe');
const C = require('../dist/main/wabisabi/credentials');
const M = require('../dist/main/wabisabi/messages');
const R = require('../dist/main/wabisabi/round');
const { decompose, denominations } = require('../dist/main/wabisabi/decompose');
const { mixOnce, unsuitable } = require('../dist/main/wabisabi/client');
const { mockCoordinator } = require('./mock-wabisabi');

const fixture = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));
const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const seeded = (seed) => { let i = 0; return (n) => { const out = Buffer.alloc(n); for (let o = 0; o < n; o += 32) Buffer.from(sha256(Buffer.concat([Buffer.from(seed), Buffer.from([i & 255, (i >> 8) & 255, 0, 0])]))).copy(out, o); i++; return Uint8Array.from(out); }; };

test('round IDs computed here match live coordinators', () => {
  for (const f of ['wabisabi-status-noderunners.json', 'wabisabi-status-opencoordinator.json']) {
    for (const r of fixture(f).roundStates) {
      const s = R.readRound(r);
      assert.ok(R.idMatches(s), `${f} ${r.id}`);
      s.params.feePerK += 1n;
      assert.ok(!R.idMatches(s), 'any changed parameter changes the ID');
    }
  }
});

test('credentials: requests are byte for byte what was checked against the reference issuer, and its answers verify', () => {
  const ref = fixture('wabisabi-reference.json');
  for (const v of ref.credentials) {
    const c = new C.WabiSabiClient(M.readIssuerParams(v.iparams), BigInt(v.max), seeded(v.seed));
    let creds;
    for (const step of v.steps) {
      const r = step.kind === 'zero' ? c.zeroRequest() : c.request(step.amounts.map(BigInt), creds);
      assert.deepEqual(M.requestJson(r.request), step.request, `${v.name} ${step.kind} request`);
      creds = c.handle(M.readResponse(step.response), r.pending);
      if (step.amounts) assert.deepEqual(creds.map((x) => String(x.value)).slice(0, step.amounts.length), step.amounts);
    }
  }
});

test('credentials: a response that was changed, or meant for another request, is refused', () => {
  const v = fixture('wabisabi-reference.json').credentials[0];
  const c = new C.WabiSabiClient(M.readIssuerParams(v.iparams), BigInt(v.max), seeded(v.seed));
  const z = c.zeroRequest();
  const bad = JSON.parse(JSON.stringify(v.steps[0].response));
  bad.issuedCredentials[0].T = bad.issuedCredentials[1].T;
  assert.throws(() => c.handle(M.readResponse(bad), z.pending), /proofs are wrong/);
  const other = new C.WabiSabiClient(M.readIssuerParams(v.iparams), BigInt(v.max));
  const z2 = other.zeroRequest();
  assert.throws(() => other.handle(M.readResponse(v.steps[0].response), z2.pending), /proofs are wrong/);
  const short = { ...v.steps[0].response, issuedCredentials: v.steps[0].response.issuedCredentials.slice(0, 1) };
  assert.throws(() => c.handle(M.readResponse(short), c.zeroRequest().pending), /different number/);
});

test('credentials: values out of range, a credential shown twice, and odd input are refused', () => {
  const v = fixture('wabisabi-reference.json').credentials[1];
  const c = new C.WabiSabiClient(M.readIssuerParams(v.iparams), 255n);
  const fake = { value: 0n, randomness: 1n, mac: { t: 2n, V: C.G.Gg } };
  assert.throws(() => c.request([256n], [fake, { ...fake, randomness: 3n, mac: { t: 3n, V: C.G.Gh } }]), /out of range/);
  assert.throws(() => c.request([1n], [fake, fake]), /twice/);
  assert.throws(() => c.request([1n, 2n, 3n], [fake, fake]), /Too many/);
  assert.throws(() => M.readResponse({ issuedCredentials: [{ T: 'zz', V: '00' }], proofs: [] }), /hex/);
  assert.throws(() => C.pointFrom(hex('05' + '00'.repeat(32))), /group element/);
});

test('ownership proofs: the same bytes as the reference for taproot, its segwit proofs verify, others are refused', () => {
  const o = fixture('wabisabi-reference.json').ownership;
  const commit = hex(o.commitment);
  assert.equal(Buffer.from(R.ownershipProofTaproot(hex(o.key), hex(o.taproot.script), hex(o.idKey), commit)).toString('hex'), o.taproot.proof);
  assert.ok(R.verifyOwnership(hex(o.taproot.proof), hex(o.taproot.script), commit));
  assert.ok(R.verifyOwnership(hex(o.segwit.proof), hex(o.segwit.script), commit));
  const otherRound = R.commitment('CoinJoinCoordinatorIdentifier', 'ab'.repeat(32));
  assert.ok(!R.verifyOwnership(hex(o.taproot.proof), hex(o.taproot.script), otherRound), 'bound to its round');
  assert.ok(!R.verifyOwnership(hex(o.segwit.proof), hex(o.taproot.script), commit), 'bound to its script');
  const flipped = hex(o.taproot.proof); flipped[flipped.length - 1] ^= 1;
  assert.ok(!R.verifyOwnership(flipped, hex(o.taproot.script), commit));
  const noConfirm = hex(o.taproot.proof); noConfirm[4] = 0;
  assert.ok(!R.verifyOwnership(noConfirm, hex(o.taproot.script), commit), 'the user-confirmation flag is required');
});

test('scripts: NBitcoin text read and written', () => {
  const tr = '1 ' + 'ab'.repeat(32), wp = '0 ' + 'cd'.repeat(20);
  assert.equal(R.scriptText(R.parseScript(tr)), tr);
  assert.equal(R.scriptText(R.parseScript(wp)), wp);
  assert.equal(R.parseScript('OP_DUP OP_HASH160 ' + '11'.repeat(20) + ' OP_EQUALVERIFY OP_CHECKSIG').length, 25);
  assert.equal(R.parseScript('OP_HASH160 ' + '11'.repeat(20) + ' OP_EQUAL').length, 23);
  assert.equal(R.outputVsize(R.parseScript(tr)), 43);
  assert.equal(R.outputVsize(R.parseScript(wp)), 31);
  assert.throws(() => R.parseScript('OP_RETURN 00'), /does not use/);
  assert.equal(R.fee(150n, 58), 8n);
  assert.equal(R.fee(1n, 58), 1n, 'never below one satoshi');
});

test('strobe: the reference transcript gives the same challenge every time', () => {
  const a = new Strobe128('WabiSabi_v1.0'), b = new Strobe128('WabiSabi_v1.0');
  a.meta(new Uint8Array([1, 2, 3]), false); b.meta(new Uint8Array([1, 2, 3]), false);
  assert.deepEqual(a.prf(32, false), b.prf(32, false));
  assert.notDeepEqual(new StrobeHasher('x').str('a', 'b').hash(), new StrobeHasher('x').str('a', 'c').hash());
});

test('amounts: standard denominations, never more than registered, little left over', () => {
  const d = denominations(5000n, 100000000n);
  for (const x of [5000n, 6561n, 8192n, 10000n, 20000n, 50000n, 100000000n]) assert.ok(d.includes(x), String(x));
  for (let k = 0; k < 20; k++) {
    const all = Array.from({ length: 40 }, (_, i) => BigInt(30000 + ((i * 7919 + k * 104729) % 5000000)));
    const mine = BigInt(100000 + k * 123457);
    all.push(mine);
    const out = decompose({ feePerK: 1000n, outputMin: 5000n, outputMax: 100000000n, availableVsize: 172 * 2, mine, all });
    const used = out.reduce((s, o) => s + o.effectiveCost, 0n);
    assert.ok(used <= mine && mine - used < 5000n + 43n, `${mine} → ${used}`);
    assert.ok(out.length * 43 <= 172 * 2);
  }
});

// ---- a whole round against a stand-in coordinator ----

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
function wallet(values) {
  const { HDKey } = require('@scure/bip32');
  const { mnemonicToSeedSync } = require('@scure/bip39');
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MN)).derive("m/86'/0'/0'/0");
  const coins = values.map((v, i) => {
    const k = root.deriveChild(i);
    return { txid: Buffer.from(sha256(Buffer.from('coin' + i))).toString('hex'), vout: i, value: BigInt(v), script: btc.p2tr(k.publicKey.slice(1)).script, priv: k.privateKey };
  });
  const outRoot = HDKey.fromMasterSeed(mnemonicToSeedSync(MN)).derive("m/86'/0'/1'/0");
  let next = 0;
  return {
    coins,
    utxos: new Map(coins.map((c) => [`${c.txid}:${c.vout}`, { value: c.value, script: c.script }])),
    keyFor: (c) => coins.find((x) => x.txid === c.txid && x.vout === c.vout).priv,
    destinations: (n) => Array.from({ length: n }, () => btc.p2tr(outRoot.deriveChild(next++).publicKey.slice(1)).script),
  };
}
const run = (w, coord, extra = {}) => mixOnce(w.coins.map(({ priv, ...c }) => c), {
  transport: coord.transport, keyFor: w.keyFor, destinations: w.destinations, idKey: new Uint8Array(32).fill(5),
  maxFeePerK: 10000n, minInputs: 3, pollMs: 150, registrationMarginMs: 2000, ...extra,
});

test('a whole round: inputs registered and confirmed, standard outputs, signed only after the checks', { timeout: 240_000 }, async () => {
  const w = wallet([600000, 250000]);
  const coord = mockCoordinator({ utxos: w.utxos, expectInputs: 2, others: 5, inputRegMs: 4000 });
  const res = await run(w, coord);
  assert.ok(res.ok, res.reason);
  assert.equal(coord.state.phase, 4);
  assert.equal(coord.state.witnesses.size, 2, 'both inputs signed, each signature checked by the coordinator');
  const mine = res.outputs;
  assert.ok(mine.length >= 2);
  const d = new Set(denominations(5000n, 2n ** 27n));
  assert.ok(mine.filter((o) => d.has(o.value)).length >= mine.length - 1, 'all but at most one are standard amounts');
  const total = mine.reduce((s, o) => s + o.value, 0n);
  assert.ok(total < 850000n && total > 850000n - 20000n, `outputs ${total}`);
  // Every input request on its own route, and every output-side request on a fresh one.
  const byPath = (p) => coord.state.log.filter((l) => l.path === p).map((l) => l.identity);
  const aliceIds = new Set(byPath('input-registration'));
  assert.equal(aliceIds.size, 2);
  const bobIds = [...byPath('credential-issuance'), ...byPath('output-registration')];
  assert.equal(new Set(bobIds).size, bobIds.length, 'no two output-side requests share a route');
  assert.ok(bobIds.every((id) => !aliceIds.has(id)));
  assert.ok(byPath('status').every((id) => !aliceIds.has(id) && !bobIds.includes(id)));
});

test('a coordinator that drops an output, keeps fees, lies about the round or adds a foreign input gets no signature', { timeout: 600_000 }, async () => {
  for (const [tamper, why] of [[{ dropOutput: true }, /missing or short/], [{ skimFee: true }, /missing or short|keeping part of the fee|more than the inputs/], [{ foreignProof: true }, /not bound to this round/]]) {
    const w = wallet([400000]);
    const coord = mockCoordinator({ utxos: w.utxos, expectInputs: 1, others: 4, inputRegMs: 4000, tamper });
    const res = await run(w, coord);
    assert.ok(!res.ok);
    assert.match(res.reason, why, JSON.stringify(tamper));
    assert.equal(coord.state.witnesses.size, 0, 'nothing signed');
  }
  const w = wallet([400000]);
  const coord = mockCoordinator({ utxos: w.utxos, expectInputs: 1, tamper: { badId: true } });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1500);
  await assert.rejects(run(w, coord, { signal: ac.signal }), /Stopped/);
  assert.ok(!coord.state.log.some((l) => l.path === 'input-registration'), 'a round whose ID does not match is never joined');
});

test('rounds that charge a fee, are too expensive or have no taproot are passed over', () => {
  const r = R.readRound(fixture('wabisabi-status-noderunners.json').roundStates[0]);
  const coins = [{ txid: '11'.repeat(32), vout: 0, value: 500000n, script: R.parseScript('1 ' + '22'.repeat(32)) }];
  const t = r.inputRegistrationStart + 1000;
  assert.equal(unsuitable(r, coins, { maxFeePerK: 10000n }, t), null);
  assert.equal(unsuitable(r, coins, { maxFeePerK: 100n }, t), 'mining fee too high');
  assert.equal(unsuitable({ ...r, params: { ...r.params, coordinationFee: 0.003 } }, coins, { maxFeePerK: 10000n }, t), 'charges a coordination fee');
  assert.equal(unsuitable({ ...r, params: { ...r.params, inputTypes: [4] } }, coins, { maxFeePerK: 10000n }, t), 'no taproot');
  assert.equal(unsuitable(r, coins, { maxFeePerK: 10000n }, r.inputRegistrationEnd - 60_000), 'registration closing');
  assert.equal(unsuitable(r, [{ ...coins[0], value: 1000n }], { maxFeePerK: 10000n }, t), 'coins outside the allowed amounts');
});

test('a real round from a live coordinator: ID, every participant\'s proof, and the transaction that went on chain', () => {
  const s = R.readRound(fixture('wabisabi-round-broadcast.json'));
  assert.equal(s.phase, R.Phase.Ended);
  assert.equal(s.end, R.EndRoundState.TransactionBroadcasted);
  assert.ok(R.idMatches(s));
  const commit = R.commitment(s.params.coordinationId, s.id);
  assert.ok(s.inputs.length > 20);
  assert.ok(s.inputs.every((c) => R.verifyOwnership(c.proof, c.script, commit)), 'segwit and taproot proofs from real wallets verify');
  // The unsigned transaction built here has the ID of the coinjoin that was mined (checked on a block explorer).
  assert.equal(R.unsignedTransaction(s).id, '5a3aa44b8f2c35098d284c382a4ae86565b8c10b99fbe2621bb3588f9c8379ae');
  assert.ok(R.effectiveFeePerK(s) >= s.params.feePerK);
});
