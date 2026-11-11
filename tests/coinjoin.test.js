const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const btc = require('@scure/btc-signer');
const p2p = require('../dist/main/dash-p2p');
const cj = require('../dist/main/coinjoin');
const { DashMixer, MIX_ROUNDS } = require('../dist/main/dash-mix');
const { tcpDial } = require('../dist/main/dash-net');
const mock = require('./mock-dash');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5';

// A real mainnet coinbase (block 2570460), as Insight gave it.
const COINBASE_ID = '4fb364661dc3bd78bb2f5ef36d6b976dd973e67035e9aef11e9adc697a24c053';

test('envelope: framed and split back, damage and other networks refused', () => {
  const u = new p2p.Unframer();
  const a = p2p.frame('ping', Buffer.from('0102030405060708', 'hex'));
  const b = p2p.frame('verack');
  const both = Buffer.concat([a, b]);
  assert.deepEqual(u.push(both.subarray(0, 30)), []);
  const got = u.push(both.subarray(30));
  assert.deepEqual(got.map((m) => m.command), ['ping', 'verack']);
  assert.equal(got[0].payload.toString('hex'), '0102030405060708');
  const bad = Buffer.from(a); bad[bad.length - 1] ^= 1;
  assert.throws(() => new p2p.Unframer().push(bad), /damaged/);
  const btcMagic = Buffer.from(a); btcMagic.write('f9beb4d9', 0, 'hex');
  assert.throws(() => new p2p.Unframer().push(btcMagic), /not on the Dash network/);
});

test('transactions: special transactions read and written back byte for byte', () => {
  const tx = { version: 3, type: 5, inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff, script: Buffer.from('03dc3827', 'hex'), sequence: 0xffffffff }], outputs: [{ value: 123n, script: Buffer.from('6a', 'hex') }], lockTime: 0, payload: Buffer.from('0300dc382700', 'hex') };
  const raw = p2p.txBytes(tx);
  const back = p2p.readTx(new p2p.Reader(raw));
  assert.deepEqual(p2p.txBytes(back), raw);
  const plain = { version: 2, type: 0, inputs: [{ txid: 'ab'.repeat(32), vout: 1, script: Buffer.alloc(0), sequence: 0xffffffff }], outputs: [{ value: 5n, script: Buffer.from('76a914' + '22'.repeat(20) + '88ac', 'hex') }], lockTime: 0 };
  assert.equal(p2p.txId(plain), mock.txid(plain), 'same ID as an independent encoder');
});

test('masternode list: a real-shaped mnlistdiff verifies against the block, every address form read', () => {
  const c = mock.buildChain('203.0.113.7', 9999);
  const list = p2p.readMasternodeList(c.diff, { blockHash: c.blockHash, merkleRoot: c.merkleRoot });
  assert.equal(list.height, c.height);
  assert.equal(list.coinbase, c.coinbase);
  assert.equal(list.masternodes.length, 3);
  assert.deepEqual(list.masternodes.map((m) => [m.host, m.port]), [['203.0.113.7', 9999], ['203.0.113.7', 9999], ['203.0.113.7', 9999]]);
  assert.deepEqual(list.masternodes.map((m) => m.valid), [true, true, false]);
  assert.deepEqual(list.masternodes.map((m) => m.type), [0, 1, 0], 'an EvoNode with extended addresses');
  assert.throws(() => p2p.readMasternodeList(c.diff, { blockHash: c.blockHash, merkleRoot: '11'.repeat(32) }), /does not belong/);
  assert.throws(() => p2p.readMasternodeList(c.diff, { blockHash: '22'.repeat(32), merkleRoot: c.merkleRoot }), /different block/);
  // One changed byte inside an entry (an address) no longer matches the coinbase's root.
  const at = c.diff.indexOf(c.mns[0].wire) + 2 + 64 + 12;
  const bad = Buffer.from(c.diff); bad[at] ^= 1;
  assert.throws(() => p2p.readMasternodeList(bad, { blockHash: c.blockHash, merkleRoot: c.merkleRoot }), /does not match/);
});

test('partial merkle proofs: Bitcoin\'s format, at every tree size, tampering refused', () => {
  for (const n of [1, 2, 3, 5, 8, 13]) {
    const leaves = Array.from({ length: n }, () => crypto.randomBytes(32));
    for (const match of [0, n - 1]) {
      const proof = mock.partialTree(leaves, match);
      const r = new p2p.Reader(proof);
      const total = r.u32();
      const hashes = Array.from({ length: r.varint() }, () => Buffer.from(r.bytes(32)));
      const flags = r.varbytes();
      const out = p2p.partialMerkle(total, hashes, flags);
      assert.ok(out.root.equals(mock.merkle(leaves)), `root, ${n} leaves`);
      assert.deepEqual(out.matched.map((x) => x.toString('hex')), [leaves[match].toString('hex')]);
    }
  }
  assert.throws(() => p2p.partialMerkle(3, [crypto.randomBytes(32)], Buffer.from([0xff])), /not well formed/);
});

const key = () => { const k = crypto.randomBytes(32); const pub = require('@noble/curves/secp256k1.js').secp256k1.getPublicKey(k, true); return { k, pub, script: Buffer.from(btc.p2pkh(pub, mock.DASH_NET).script) }; };

test('signatures: the legacy hash with and without ANYONECANPAY matches @scure/btc-signer, and verifies', () => {
  const a = key(); const b = key();
  const tx = { version: 1, type: 0, lockTime: 0,
    inputs: [{ txid: 'aa'.repeat(32), vout: 0, script: Buffer.alloc(0), sequence: 0xffffffff }, { txid: 'bb'.repeat(32), vout: 3, script: Buffer.alloc(0), sequence: 0xffffffff }],
    outputs: [{ value: 100_001n, script: a.script }, { value: 100_001n, script: b.script }] };
  const t = btc.Transaction.fromRaw(p2p.txBytes(tx), { allowLegacyWitnessUtxo: true, disableScriptCheck: true });
  for (const ht of [0x01, 0x81]) for (const i of [0, 1]) assert.ok(Buffer.from(t.preimageLegacy(i, b.script, ht)).equals(cj.legacySighash(tx, i, b.script, ht)), `hash type ${ht}, input ${i}`);
  const coin = { txid: 'bb'.repeat(32), vout: 3, value: 100_001n, script: b.script, privateKey: b.k, publicKey: b.pub };
  const signed = { ...tx, inputs: tx.inputs.map((i) => ({ ...i })) };
  signed.inputs[1].script = cj.signInput(tx, 1, coin, 0x81);
  assert.ok(mock.verifyInput(signed, 1, b.script, 0x81));
  signed.outputs = [...tx.outputs].reverse();
  assert.equal(mock.verifyInput(signed, 1, b.script, 0x81), false, 'the outputs are committed to');
});

test('collateral: pays the masternode fee from a small coin, or burns a tiny one', () => {
  const a = key();
  const coin = (value) => ({ txid: 'cc'.repeat(32), vout: 0, value, script: a.script, privateKey: a.k, publicKey: a.pub });
  const big = cj.collateralTx(coin(40_000n), a.script);
  assert.equal(big.outputs[0].value, 30_000n);
  assert.ok(mock.verifyInput(big, 0, a.script, 0x01));
  const small = cj.collateralTx(coin(15_000n), a.script);
  assert.deepEqual([small.outputs[0].value, small.outputs[0].script.toString('hex')], [0n, '6a']);
  assert.throws(() => cj.collateralTx(coin(9_999n), a.script), /collateral/);
});

test('the final mix is refused unless it is fair to us', () => {
  const a = key(); const b = key();
  const d = cj.DENOMS[3];
  const mine = { inputs: [{ txid: '11'.repeat(32), vout: 0 }], outputs: [{ value: d, script: a.script }] };
  const base = () => {
    const tx = { version: 1, type: 0, lockTime: 0,
      inputs: [{ txid: '11'.repeat(32), vout: 0, script: Buffer.alloc(0), sequence: 0xffffffff }, { txid: '22'.repeat(32), vout: 0, script: Buffer.alloc(0), sequence: 0xffffffff }],
      outputs: [{ value: d, script: a.script }, { value: d, script: b.script }] };
    tx.outputs.sort(p2p.bip69Out);
    return tx;
  };
  const bit = cj.denomBit(d);
  assert.doesNotThrow(() => cj.checkFinal(base(), mine, bit));
  const missing = base(); missing.outputs = missing.outputs.filter((o) => !o.script.equals(a.script)); missing.outputs.push({ value: d, script: key().script }); missing.outputs.sort(p2p.bip69Out);
  assert.throws(() => cj.checkFinal(missing, mine, bit), /missing one of this wallet's outputs/);
  const odd = base(); odd.outputs[1] = { ...odd.outputs[1], value: d + 1n }; odd.outputs.sort(p2p.bip69Out);
  assert.throws(() => cj.checkFinal(odd, mine, bit), /wrong kind/);
  const order = base(); order.inputs.reverse();
  assert.throws(() => cj.checkFinal(order, mine, bit), /out of order/);
  const alone = base(); alone.inputs = [alone.inputs[0]]; alone.outputs = alone.outputs.filter((o) => o.script.equals(a.script));
  assert.throws(() => cj.checkFinal(alone, mine, bit), /No one else/);
  const twice = base(); twice.outputs[1] = { value: d, script: twice.outputs[0].script };
  assert.throws(() => cj.checkFinal(twice, mine, bit), /twice/);
});

test('splitting: the standard sizes, largest first', () => {
  assert.deepEqual(DashMixer.split(1_234_567_890n).map(String), ['1000010000', '100001000', '100001000', '10000100', '10000100', '10000100', '1000010', '1000010', '1000010', '1000010', '100001', '100001', '100001', '100001', '100001']);
  assert.deepEqual(DashMixer.split(100_000n), []);
});

async function setup(t) {
  const m = await mock.startDashMock();
  t.after(() => m.close());
  m.state.mnProTx = m.state.chain.valid[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = tcpDial();
  const dial = (host, port) => { m.state.dialed = [...(m.state.dialed ?? []), `${host}:${port}`]; return real('127.0.0.1', m.port); };
  const mixer = new DashMixer({ apis: [m.api], dir, dial, seeds: ['seed.example:9999'], timeoutMs: 5000 }, DashMixer.account(PHRASE));
  // Only the masternode the mock plays may be picked.
  const listOf = mixer.masternodes.bind(mixer);
  mixer.masternodes = async () => (await listOf()).filter((x) => x.proTxHash === m.state.mnProTx);
  return { m, mixer, dir };
}

/** Plans a split and takes its addresses, as confirming it in the wallet does. */
async function split(mixer, amount, collateral = true) {
  const plan = await mixer.planSplit(amount, collateral);
  await mixer.commitSplit(plan);
  return plan;
}

/** Pays the planned split outputs straight into the mock chain, as a confirmed split transaction would. */
function fund(m, outputs) {
  const id = crypto.randomBytes(32).toString('hex');
  outputs.forEach((o, vout) => m.state.utxos.push({ address: o.address, txid: id, vout, satoshis: Number(o.value), confirmations: 1 }));
}

test('mixing: rounds with a masternode until the coins count as mixed, then a private send', async (t) => {
  const { m, mixer } = await setup(t);
  const preview = await mixer.planSplit(cj.DENOMS[3] * 2n + 5n);
  assert.deepEqual((await mixer.planSplit(cj.DENOMS[3] * 2n + 5n)).outputs.map((o) => o.address).sort(), preview.outputs.map((o) => o.address).sort(), 'a preview takes no addresses');
  await mixer.commitSplit(preview);
  await assert.rejects(mixer.commitSplit(preview), /expired/, 'the same addresses are never handed out twice');
  const plan = preview;
  assert.equal(plan.mixable, cj.DENOMS[3] * 2n);
  assert.equal(plan.outputs.length, 2 + 3, 'two coins and three collateral coins');
  assert.equal(new Set(plan.outputs.map((o) => o.address)).size, 5, 'every output on its own address');
  assert.ok(plan.outputs.every((o) => o.address.startsWith('X')));
  fund(m, plan.outputs);
  await mixer.refresh();
  assert.equal(mixer.status.mixing, '0.0200002');
  assert.equal(mixer.status.collateral, '0.0012');

  // Each session takes some of the coins at the fewest rounds, so two coins need four to eight sessions.
  let sessions = 0;
  while (await mixer.round()) assert.ok(++sessions <= 2 * MIX_ROUNDS, 'finishes');
  assert.ok(sessions >= MIX_ROUNDS);
  assert.equal(m.state.sessions.length, sessions);
  assert.equal(m.state.versions.filter((v) => v.masternode).length, sessions, 'mixing connections say they are for a masternode');
  assert.ok(m.state.versions.every((v) => v.version === 70233 && v.ua === '/Kusari:1.0/'));
  assert.ok(m.state.calls.includes('getmnlistd'));
  await mixer.refresh();
  assert.equal(mixer.status.mixed, '0.0200002');
  assert.equal(mixer.status.progress, 100);
  const s = m.state.sessions[0];
  assert.equal(s.denom, cj.denomBit(cj.DENOMS[3]));
  assert.equal(s.ours.inputs.length, s.ours.outputs.length);
  assert.ok(s.tx.inputs.length > s.ours.inputs.length, 'others were in the mix');

  // Private send: no change, the overshoot within the limit is fee.
  const draft = await mixer.draftPrivate(OTHER, 1_950_020n);
  assert.equal(draft.coins.length, 2);
  assert.equal(draft.fee, 50_000n);
  await assert.rejects(mixer.draftPrivate(OTHER, 1_500_000n), /overpay/, 'at most the smallest coin size goes to fee');
  await assert.rejects(mixer.draftPrivate(OTHER, 3_000_000n), /Not enough/);
  const id = await mixer.sendPrivate(draft);
  const sent = m.state.sent.at(-1).tx;
  assert.equal(p2p.txId({ ...sent, type: 0 }), id);
  assert.equal(sent.outputs.length, 1, 'no change output');
  assert.equal(btc.Address(mock.DASH_NET).encode(btc.OutScript.decode(sent.outputs[0].script)), OTHER);
  assert.equal(sent.outputs[0].value, 1_950_020n);
});

test('mixing: a final transaction without our output is never signed', async (t) => {
  const { m, mixer } = await setup(t);
  fund(m, (await split(mixer, cj.DENOMS[4])).outputs);
  m.state.tamper = (tx, ours) => ({ ...tx, outputs: tx.outputs.map((o) => (o.script.equals(ours.outputs[0].script) ? { ...o, script: Buffer.from('76a914' + '99'.repeat(20) + '88ac', 'hex') } : o)).sort(p2p.bip69Out) });
  await assert.rejects(mixer.round(), /not signed/);
  assert.ok(!m.state.calls.includes('dss'), 'no signature was sent');
  assert.equal(m.state.sessions.length, 0);
});

test('mixing: a refusal, a mix nobody else joins, or a doctored masternode list stops the round', async (t) => {
  const { m, mixer } = await setup(t);
  fund(m, (await split(mixer, cj.DENOMS[4])).outputs);
  m.state.refuse = cj.PoolMessage.ERR_RECENT;
  await assert.rejects(mixer.round(), /mixed too recently/);
  const after = mixer.store.next1;
  await assert.rejects(mixer.round(), /mixed too recently/);
  assert.equal(mixer.store.next1, after, 'a failed session hands its addresses back, and collateral change keeps one address');
  m.state.refuse = null;
  m.state.others = 0;
  await assert.rejects(mixer.round(), /No one else/);
  assert.ok(!m.state.calls.includes('dss'));

  const fresh = await setup(t);
  fund(fresh.m, (await split(fresh.mixer, cj.DENOMS[4])).outputs);
  fresh.m.state.tamperList = (d) => { const b = Buffer.from(d); b[b.length - 40] ^= 1; return b; };
  await assert.rejects(fresh.mixer.round(), /masternode list/);
});

test('mixing: no collateral coin, no session; addresses are never reused', async (t) => {
  const { m, mixer } = await setup(t);
  const plan = await split(mixer, cj.DENOMS[4], false);
  assert.equal(plan.outputs.length, 1);
  fund(m, plan.outputs);
  await assert.rejects(mixer.round(), /collateral/);
  const again = await split(mixer, cj.DENOMS[4]);
  assert.ok(!again.outputs.some((o) => plan.outputs[0].address === o.address));
});

test('restoring from the seed finds mixed coins by scanning the CoinJoin account', async (t) => {
  const { m, mixer, dir } = await setup(t);
  const plan = await split(mixer, cj.DENOMS[2]);
  fund(m, plan.outputs);
  // A mixed coin on the mixing chain, past a few unused addresses.
  const k = DashMixer.account(PHRASE).deriveChild(1).deriveChild(7);
  m.state.utxos.push({ address: btc.p2pkh(k.publicKey, mock.DASH_NET).address, txid: 'ef'.repeat(32), vout: 0, satoshis: Number(cj.DENOMS[1]), confirmations: 9 });
  fs.rmSync(path.join(dir, 'coinjoin.json'));
  const restored = new DashMixer({ apis: [m.api], dir, dial: () => { throw new Error('no'); } }, DashMixer.account(PHRASE));
  await restored.refresh();
  assert.equal(restored.balance().total, cj.DENOMS[1] + cj.DENOMS[2] + 3n * cj.MAX_COLLATERAL);
});

test('Tor: connections go through the SOCKS proxy by name, each with its own login', async (t) => {
  const { mockSocks } = require('./mock-socks');
  const net = require('node:net');
  const echo = net.createServer((c) => c.pipe(c));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const s = await mockSocks({ 'node.example': '127.0.0.1' });
  t.after(() => { s.close(); echo.close(); });
  const dial = tcpDial(s.uri);
  for (let i = 0; i < 2; i++) {
    const link = await dial('node.example', echo.address().port);
    const got = new Promise((r) => link.onData(r));
    link.write(Buffer.from('hi'));
    assert.equal((await got).toString(), 'hi');
    link.close();
  }
  assert.deepEqual(s.log.map((l) => [l.host, l.type]), [['node.example', 'domain'], ['node.example', 'domain']], 'the name reaches Tor unresolved');
  assert.notEqual(s.log[0].user, s.log[1].user, 'separate Tor routes');
});
