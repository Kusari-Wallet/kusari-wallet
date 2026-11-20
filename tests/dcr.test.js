const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { HDKey } = require('@scure/bip32');
const { mnemonicToSeedSync } = require('@scure/bip39');
const { blake256 } = require('@noble/hashes/blake1.js');
const {
  DcrClient, dcrAccountXpub, dcrAddressOf, isDcrAddress, dcrScript, signDcrDraft, serializeDcrTx, dcrTxid,
  dcrSignatureHash, verifyDcrInput, typicalDcrFee,
} = require('../dist/main/dcr');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const xpub = dcrAccountXpub(PHRASE);
// dcrd's own address vectors (dcrutil address tests): a pubkey hash and a script hash on mainnet.
const DCRD_PKH = ['DsUZxxoHJSty8DCfwfartwTYbuhmVct7tJu', '2789d58cfa0957d206f025c2af056fc8a77cebb0'];
const DCRD_SH = ['DcuQKx8BES9wU7C6Q5VmLBjw436r27hayjS', 'f0b4e85100aee1a996f22915eb3c3f764d53779a'];

test('BLAKE-256, and addresses as dcrd writes them; anything else refused', () => {
  assert.equal(Buffer.from(blake256(new Uint8Array())).toString('hex'), '716f6e863f744b9ac22c97ec7b76ea5f5908bc5b2f67c61510bfc4751384ea7a');
  assert.ok(isDcrAddress(DCRD_PKH[0]));
  assert.ok(isDcrAddress(DCRD_SH[0]));
  assert.equal(Buffer.from(dcrScript(DCRD_PKH[0])).toString('hex'), `76a914${DCRD_PKH[1]}88ac`);
  assert.equal(Buffer.from(dcrScript(DCRD_SH[0])).toString('hex'), `a914${DCRD_SH[1]}87`);
  assert.equal(isDcrAddress(DCRD_PKH[0].slice(0, -1) + (DCRD_PKH[0].endsWith('u') ? 'v' : 'u')), false, 'bad checksum');
  assert.equal(isDcrAddress('TsfDLrRkk9ciUuwfp2b8PawwnukYD7yAjGd'), false, 'testnet');
  assert.equal(isDcrAddress('XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5'), false, 'Dash');
  assert.equal(isDcrAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), false);
  assert.equal(isDcrAddress('Ds'), false);
});

test('BIP44 m/44\'/42\'/0\' from the 12 words; an address round-trips through its script', () => {
  const c = new DcrClient(xpub, []);
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(PHRASE)).derive("m/44'/42'/0'/0/0");
  const a = c.addressAt(0, 0);
  assert.equal(a, dcrAddressOf(key.publicKey));
  assert.match(a, /^Ds/);
  assert.ok(isDcrAddress(a));
  assert.notEqual(c.addressAt(1, 0), a);
  assert.ok(typicalDcrFee() > 0n && typicalDcrFee() < 10_000n);
});

/** A transaction's ID worked out the way dcrd does, from the raw bytes: the prefix, hashed. */
function idOf(raw) {
  let at = 4; const n = raw[at++]; at += 41 * n;
  const m = raw[at++]; for (let i = 0; i < m; i++) at += 11 + raw[at + 10];
  at += 8;
  return Buffer.from(blake256(Buffer.concat([Buffer.from([1, 0, 1, 0]), raw.subarray(4, at)]))).reverse().toString('hex');
}

const draftFor = (c, inputs, to, amount, fee) => {
  const total = inputs.reduce((s, u) => s + u.value, 0n);
  return { to, amount, fee, change: total - amount - fee, changeAddress: c.addressAt(1, 0), changeIndex: 0, inputs };
};

test('signing: dcrd\'s signature hash, low-S signatures that verify, the wire format, and every check', () => {
  const c = new DcrClient(xpub, []);
  const inputs = [
    { txid: 'aa'.repeat(32), vout: 1, value: 150_000_000n, address: c.addressAt(0, 0), chain: 0, index: 0 },
    { txid: 'bb'.repeat(32), vout: 0, value: 20_000_000n, address: c.addressAt(1, 3), chain: 1, index: 3 },
  ];
  const d = draftFor(c, inputs, DCRD_PKH[0], 100_000_000n, 3_000n);
  const { hex, id } = signDcrDraft(d, PHRASE);
  const raw = Buffer.from(hex, 'hex');
  // Version 1, serialization type 0 (full).
  assert.equal(raw.readUInt32LE(0), 1);
  // Read it back by hand: prefix, then witness.
  let at = 4;
  assert.equal(raw[at++], 2);
  const ins = [];
  for (let i = 0; i < 2; i++) { ins.push({ txid: Buffer.from(raw.subarray(at, at + 32)).reverse().toString('hex'), vout: raw.readUInt32LE(at + 32), tree: raw[at + 36], sequence: raw.readUInt32LE(at + 37) }); at += 41; }
  assert.deepEqual(ins.map((x) => [x.txid, x.vout, x.tree, x.sequence]), [['aa'.repeat(32), 1, 0, 0xffffffff], ['bb'.repeat(32), 0, 0, 0xffffffff]]);
  assert.equal(raw[at++], 2);
  const outs = [];
  for (let i = 0; i < 2; i++) { const value = raw.readBigInt64LE(at); const version = raw.readUInt16LE(at + 8); const len = raw[at + 10]; outs.push({ value, version, script: raw.subarray(at + 11, at + 11 + len).toString('hex') }); at += 11 + len; }
  // The change takes a random place; the outputs are otherwise as approved.
  const want = [{ value: 100_000_000n, version: 0, script: `76a914${DCRD_PKH[1]}88ac` }, { value: d.change, version: 0, script: Buffer.from(dcrScript(d.changeAddress)).toString('hex') }];
  const key = (o) => `${o.value}:${o.script}`;
  assert.deepEqual(outs.map(key).sort(), want.map(key).sort());
  assert.equal(raw.readUInt32LE(at), 0); assert.equal(raw.readUInt32LE(at + 4), 0); at += 8; // lock time, expiry
  const prefixEnd = at;
  assert.equal(raw[at++], 2);
  const sigScripts = [];
  for (let i = 0; i < 2; i++) {
    assert.equal(raw.readBigInt64LE(at), inputs[i].value, 'the coin\'s amount in the witness');
    assert.equal(raw.readUInt32LE(at + 8), 0); assert.equal(raw.readUInt32LE(at + 12), 0xffffffff);
    const len = raw[at + 16]; sigScripts.push(raw.subarray(at + 17, at + 17 + len)); at += 17 + len;
  }
  assert.equal(at, raw.length);
  // The ID is BLAKE-256 of the prefix with serialization type 1.
  const prefix = Buffer.concat([Buffer.from([1, 0, 1, 0]), raw.subarray(4, prefixEnd)]);
  assert.equal(id, Buffer.from(blake256(prefix)).reverse().toString('hex'));
  // The signature hash, built independently from dcrd's description, and the signatures against it.
  const tx = { version: 1, inputs: inputs.map((u, i) => ({ txid: u.txid, vout: u.vout, tree: 0, sequence: 0xffffffff, value: u.value, blockHeight: 0, blockIndex: 0xffffffff, sigScript: sigScripts[i] })), outputs: outs.map((o) => ({ value: o.value, version: 0, script: Buffer.from(o.script, 'hex') })), lockTime: 0, expiry: 0 };
  assert.equal(dcrTxid(tx), id);
  assert.equal(Buffer.from(serializeDcrTx(tx)).toString('hex'), hex);
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(PHRASE)).derive("m/44'/42'/0'");
  for (let i = 0; i < 2; i++) {
    const key = root.deriveChild(inputs[i].chain).deriveChild(inputs[i].index);
    const sub = dcrScript(inputs[i].address);
    const witness = Buffer.concat([Buffer.from([1, 0, 3, 0]), Buffer.from([2]), ...[0, 1].map((j) => (j === i ? Buffer.concat([Buffer.from([sub.length]), Buffer.from(sub)]) : Buffer.from([0])))]);
    const expected = blake256(Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from(blake256(prefix.fill(1, 2, 3) && Buffer.concat([Buffer.from([1, 0, 1, 0]), raw.subarray(4, prefixEnd)]))), Buffer.from(blake256(witness))]));
    assert.equal(Buffer.from(dcrSignatureHash(tx, i, sub)).toString('hex'), Buffer.from(expected).toString('hex'));
    assert.ok(verifyDcrInput(tx, i, sub, key.publicKey), `input ${i} verifies`);
    assert.equal(sigScripts[i].at(-34), 33, 'compressed key pushed');
    assert.equal(sigScripts[i][sigScripts[i][0]], 1, 'SigHashAll');
    // Signed for one input, the signature doesn't fit the other.
    assert.equal(verifyDcrInput(tx, i, dcrScript(inputs[1 - i].address), key.publicKey), false);
  }
  // A changed output breaks every signature.
  const tampered = { ...tx, outputs: [{ ...tx.outputs[0], value: tx.outputs[0].value + 1n }, tx.outputs[1]] };
  assert.equal(verifyDcrInput(tampered, 0, dcrScript(inputs[0].address), root.deriveChild(0).deriveChild(0).publicKey), false);

  assert.throws(() => signDcrDraft({ ...d, fee: d.fee + 1n }, PHRASE), /do not add up/);
  assert.throws(() => signDcrDraft({ ...d, to: 'XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5' }, PHRASE), /not a Decred address/);
  assert.throws(() => signDcrDraft({ ...d, inputs: [{ ...inputs[0], index: 9 }, inputs[1]] }, PHRASE), /input address does not match/);
  assert.throws(() => signDcrDraft({ ...d, changeAddress: DCRD_PKH[0] }, PHRASE), /change address does not match/);
});

test('a send through a stand-in dcrdata: coins found, fee for the size, the raw transaction posted', async (t) => {
  const c0 = new DcrClient(xpub, []);
  const mine = c0.addressAt(0, 2);
  const posted = [];
  const asked = [];
  const server = http.createServer((q, r) => {
    let b = ''; q.on('data', (x) => { b += x; });
    q.on('end', () => {
      asked.push(q.url);
      r.setHeader('content-type', 'application/json');
      if (q.method === 'POST' && q.url === '/tx/send') { const hex = JSON.parse(b).rawtx; posted.push(hex); return r.end(JSON.stringify({ txid: idOf(Buffer.from(hex, 'hex')) })); }
      if (q.url.includes('/utxo')) return r.end(JSON.stringify(q.url.includes(mine) ? [{ address: mine, txid: 'cd'.repeat(32), vout: 0, atoms: 300_000_000, amount: 3, confirmations: 12 }] : []));
      if (q.url.includes('/txs')) return r.end(JSON.stringify({ items: q.url.includes(mine) ? [{ txid: 'cd'.repeat(32), time: 1700000000, confirmations: 12, vin: [{ addr: 'DsSomeoneElse', value: 3 }], vout: [{ value: 3, scriptPubKey: { addresses: [mine] } }] }] : [], totalItems: 0 }));
      r.statusCode = 404; r.end('{}');
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const c = new DcrClient(xpub, [`http://127.0.0.1:${server.address().port}`]);
  assert.deepEqual(await c.getBalance(), { total: 300_000_000n, spendable: 300_000_000n });
  // Every address asked about on its own: no request names two, so the server can't group them.
  const lookups = asked.filter((u) => /utxo|txs/.test(u));
  assert.ok(lookups.length >= 2 * (10 + 4), `${lookups.length} lookups`);
  for (const u of lookups) assert.equal((u.match(/D[sc][1-9A-HJ-NP-Za-km-z]{33}/g) ?? []).length, 1, u);
  assert.ok(!lookups.some((u) => u.includes(',')));
  // Found at index 2, so the scan looked further; each address only once per scan.
  const perAddress = new Map(); for (const u of lookups.filter((x) => x.includes('/utxo'))) { const a = u.match(/D[sc]\w+/)[0]; perAddress.set(a, (perAddress.get(a) ?? 0) + 1); }
  assert.ok([...perAddress.values()].every((n) => n === 1), 'no address asked twice in one scan');
  assert.ok(perAddress.has(c0.addressAt(0, 12)), 'the gap counted from the used address');
  const d = await c.draft(DCRD_PKH[0], 100_000_000n);
  assert.equal(d.inputs[0].address, mine);
  const size = 15n + 165n + 36n * 2n;
  assert.equal(d.fee, size * 10n, 'dcrd\'s relay rate for the size');
  const id = await c.send(d, PHRASE);
  assert.equal(posted.length, 1);
  const raw = Buffer.from(posted[0], 'hex');
  assert.ok(Math.abs(raw.length - Number(size)) <= 2, `estimated ${size}, real ${raw.length}`);
  assert.match(id, /^[0-9a-f]{64}$/);
  const max = await c.draft(DCRD_PKH[0], 'max');
  assert.equal(max.change, 0n);
  assert.equal(max.amount + max.fee, 300_000_000n);
});

test('lookups survive a flaky route: a failed request is retried, a later failure falls back to the last answer', { timeout: 120_000 }, async (t) => {
  const c0 = new DcrClient(xpub, []);
  const mine = c0.addressAt(0, 0);
  let mode = 'flaky';
  const tries = new Map();
  const server = http.createServer((q, r) => {
    r.setHeader('content-type', 'application/json');
    const n = (tries.get(q.url) ?? 0) + 1; tries.set(q.url, n);
    // Every first request fails (a dropped Tor route); then, in "down", the server fails for one address always.
    if ((mode === 'flaky' && n === 1) || (mode === 'down' && q.url.includes(mine))) { r.statusCode = 503; return r.end('{}'); }
    if (q.url.includes('/utxo')) return r.end(JSON.stringify(q.url.includes(mine) ? [{ address: mine, txid: 'ab'.repeat(32), vout: 0, atoms: 50_000_000, amount: 0.5, confirmations: 3 }] : []));
    if (q.url.includes('/txs')) return r.end(JSON.stringify({ items: q.url.includes(mine) ? [{ txid: 'ab'.repeat(32), time: 1700000000, confirmations: 3, vin: [{ addr: 'DsSomeoneElse', value: 0.5 }], vout: [{ value: 0.5, scriptPubKey: { addresses: [mine] } }] }] : [], totalItems: 0 }));
    r.statusCode = 404; r.end('{}');
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const c = new DcrClient(xpub, [`http://127.0.0.1:${server.address().port}`], undefined, 5_000);
  assert.deepEqual(await c.getBalance(), { total: 50_000_000n, spendable: 50_000_000n });
  mode = 'down';
  await c.refresh(true);
  assert.deepEqual(await c.getBalance(), { total: 50_000_000n, spendable: 50_000_000n }, 'the last answer for the address that keeps failing');
  // A fresh client with nothing to fall back on reports the failure instead of a zero balance.
  const empty = new DcrClient(xpub, [`http://127.0.0.1:${server.address().port}`], undefined, 5_000);
  await assert.rejects(empty.getBalance());
});

// ---- staking ----

const stake = require('../dist/main/dcr-stake');
const dcr = require('../dist/main/dcr');
const { ed25519 } = require('@noble/curves/ed25519.js');

function onSimnet(t) { dcr.useDcrNetwork('simnet'); t.after(() => dcr.useDcrNetwork('mainnet')); }

test('a ticket as dcrwallet makes one: rebuilt byte for byte from a simnet ticket, same ID', (t) => {
  onSimnet(t);
  const tx = stake.ticketTx({
    input: { txid: 'c69c369e0023775087b9b6d5ac722f8ecc154fbd53f0b812632db92ee98ebb67', vout: 3, value: 22_980n },
    price: 20_000n, votingHash: Buffer.from('5669a63c3c223976000c821af00b52f3753cb509', 'hex'),
    commitmentHash: Buffer.from('e01a96909a2949a3eb6b4e3953222871ff5e1986', 'hex'), expiry: 208,
  });
  const dcrwallet = '010000000167bb8ee92eb92d6312b8f053bd4f15cc8e2f72acd5b6b987507723009e369cc60300000000ffffffff03204e00000000000000001aba76a9145669a63c3c223976000c821af00b52f3753cb50988ac00000000000000000000206a1ee01a96909a2949a3eb6b4e3953222871ff5e1986c459000000000000004e000000000000000000001abd76a914000000000000000000000000000000000000000088ac00000000d000000001c459000000000000ffffff7fffffffff';
  assert.equal(Buffer.from(serializeDcrTx(tx)).toString('hex'), `${dcrwallet}00`, 'everything up to the signature script');
  assert.equal(dcrTxid(tx), '9dfdf2765fa03b4a9c5f63fe613300386e34b2e47f2091525dfa90d91f183ebc');
  assert.equal(stake.TICKET_FEE, 22_980n - 20_000n, 'the same ticket fee');
});

test('signed messages as dcrwallet signs them; Decred WIF', (t) => {
  onSimnet(t);
  // signmessage from dcrwallet on simnet.
  const addr = 'SsWKp7wtdTZYabYFYSc9cnxhwFEjA5g4pFc';
  const sig = 'H7A6a/qVdRRpMrm9+/TOfRq4OS++0oPwh1aWKEYzGXoELzOg424RnmFv/xXTdixTMA4dxCHz1PrpjK3C687zV40=';
  assert.ok(stake.verifyDcrMessage(addr, sig, 'Kusari test message'));
  assert.ok(!stake.verifyDcrMessage(addr, sig, 'Kusari test messagE'));
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(PHRASE)).derive("m/44'/42'/0'/1/0");
  const mine = dcrAddressOf(key.publicKey);
  const s = stake.signDcrMessage(key.privateKey, '{"a":1}');
  assert.ok(stake.verifyDcrMessage(mine, s, '{"a":1}'));
  assert.ok(!stake.verifyDcrMessage(addr, s, '{"a":1}'));
  const wif = stake.dcrWif(key.privateKey);
  assert.match(wif, /^Ps/);
  const { base58 } = require('@scure/base');
  const raw = base58.decode(wif);
  assert.deepEqual([...raw.slice(0, 3)], [0x23, 0x07, 0]);
  assert.deepEqual([...raw.slice(3, 35)], [...key.privateKey]);
  assert.deepEqual([...raw.slice(35)], [...blake256(raw.slice(0, 35)).slice(0, 4)]);
});

test('ticket expiry and the VSP fee as dcrwallet and vspd work them out', () => {
  const sim = dcr.DCR_SIMNET;
  assert.equal(stake.ticketExpiry(202, sim), 208);
  assert.equal(stake.ticketExpiry(206, sim), null, 'the window ends before a ticket could be mined');
  assert.equal(stake.ticketExpiry(207, sim), 216, 'the next block starts a new window');
  // Hand-worked from txrules.StakePoolTicketFee: simnet, height 202 (interval 1), DCP-0012, one adjustment.
  const s = ((50_000_000_000n * 100n / 101n) * 89n / 500n) * 100n / 101n;
  assert.equal(stake.vspFee(20_000n, 202, 3, sim), (300n * s * 30_000n) / ((s + 20_000n) * 10_000n));
  const main = stake.vspFee(20_000_000_000n, 1_050_000, 1, dcr.DCR_MAINNET);
  assert.ok(main > 500_000n && main < 5_000_000n, `about 1% of a vote's reward: ${main}`);
});

test('stake outputs: a ticket\'s reward is spent from the stake tree once mature; other stake rows left out', () => {
  const pkh = Buffer.from(dcrScript(DCRD_PKH[0])).toString('hex');
  assert.deepEqual(dcr.dcrCoinKind({ scriptPubKey: pkh }), { tree: 0, script: pkh, mature: true });
  assert.deepEqual(dcr.dcrCoinKind({ scriptPubKey: `bb${pkh}`, confirmations: 256 }), { tree: 1, script: `bb${pkh}`, mature: false });
  assert.equal(dcr.dcrCoinKind({ scriptPubKey: `bc${pkh}`, confirmations: 257 }).mature, true);
  assert.equal(dcr.dcrCoinKind({ scriptPubKey: `bd${pkh}` }), null, 'stake change');
  assert.equal(dcr.dcrCoinKind({ scriptPubKey: `ba${pkh}` }), null, 'a ticket');
  assert.equal(dcr.dcrCoinKind({ scriptPubKey: '6a1e' + '00'.repeat(30) }), null, 'a commitment');

  const c = new DcrClient(xpub, []);
  const from = c.addressAt(1, 3);
  const script = `bb${Buffer.from(dcrScript(from)).toString('hex')}`;
  const draft = { to: DCRD_PKH[0], amount: 90_000n, fee: 2_160n, change: 0n, changeAddress: c.addressAt(1, 4), changeIndex: 4, inputs: [{ txid: 'ab'.repeat(32), vout: 2, value: 92_160n, address: from, chain: 1, index: 3, tree: 1, script }] };
  const { hex } = signDcrDraft(draft, PHRASE);
  const raw = Buffer.from(hex, 'hex');
  assert.equal(raw[4 + 1 + 32 + 4], 1, 'the input is in the stake tree');
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(PHRASE)).derive("m/44'/42'/0'/1/3");
  const tx = { version: 1, lockTime: 0, expiry: 0, inputs: [{ txid: 'ab'.repeat(32), vout: 2, tree: 1, sequence: 0xffffffff, value: 92_160n, blockHeight: 0, blockIndex: 0xffffffff, sigScript: raw.subarray(raw.length - 107) }], outputs: [{ value: 90_000n, version: 0, script: dcrScript(DCRD_PKH[0]) }] };
  assert.ok(verifyDcrInput(tx, 0, Buffer.from(script, 'hex'), key.publicKey), 'signed over the tagged script');
  assert.throws(() => signDcrDraft({ ...draft, inputs: [{ ...draft.inputs[0], script: `bb${Buffer.from(dcrScript(DCRD_PKH[0])).toString('hex')}` }] }, PHRASE), /did not match/);
});

test('a purchase: the split pays each seat and fee fund to this wallet, each ticket commits back here and signs', (t) => {
  const c = new DcrClient(xpub, []);
  const addresses = Array.from({ length: 7 }, (_, i) => ({ address: c.addressAt(1, 5 + i), index: 5 + i }));
  const coins = [{ txid: 'aa'.repeat(32), vout: 1, value: 50_000_000_000n, address: c.addressAt(0, 0), chain: 0, index: 0 }];
  const price = 15_000_000_000n;
  const fund = stake.feeFundFor(stake.vspFee(price, 1_050_000, 2, dcr.DCR_MAINNET));
  const plan = stake.planTickets({ mnemonic: PHRASE, coins, price, count: 3, expiry: 1_050_048, feeFund: fund, addresses, votingFirst: 4 });
  const split = Buffer.from(plan.split.hex, 'hex');
  assert.equal(plan.tickets.length, 3);
  const outs = 3 * 2 + (plan.change > 0n ? 1 : 0);
  assert.equal(3n * (price + stake.TICKET_FEE + fund) + plan.fee + plan.change, coins[0].value);
  assert.equal(plan.fee, (15n + 165n + 36n * BigInt(outs)) * 10n);
  const seen = new Set();
  for (const tk of plan.tickets) {
    const raw = Buffer.from(tk.hex, 'hex');
    assert.equal(Buffer.from(raw.subarray(5, 37)).reverse().toString('hex'), plan.split.id, 'spends the split');
    assert.ok(tk.commitment.index >= 5 && tk.commitment.index < 8);
    assert.ok(tk.fund.index >= 8 && tk.fund.index < 11);
    // The commitment names the seat's own address and the whole seat.
    const hash = Buffer.from(dcr.decodeDcrAddress(tk.commitment.address).hash).toString('hex');
    assert.ok(tk.hex.includes(`6a1e${hash}`), 'commitment to this wallet');
    assert.ok(!seen.has(tk.voting)); seen.add(tk.voting);
    assert.ok(split.includes(Buffer.from(dcrScript(tk.fund.address))), 'the fee fund is in the split');
  }
  // The VSP's fee from one ticket's fund: the fee, and change back when it's worth an output.
  const tk = plan.tickets[0];
  const exact = stake.feeTx({ mnemonic: PHRASE, fund: tk.fund, feeAddress: DCRD_PKH[0], amount: fund - 1_000n - 2_520n - fund / 51n, change: addresses[6] });
  assert.match(exact.id, /^[0-9a-f]{64}$/);
  assert.throws(() => stake.feeTx({ mnemonic: PHRASE, fund: tk.fund, feeAddress: DCRD_PKH[0], amount: fund, change: addresses[6] }), /more than was set aside/);
  const changed = stake.feeTx({ mnemonic: PHRASE, fund: tk.fund, feeAddress: DCRD_PKH[0], amount: fund / 2n, change: addresses[6] });
  assert.ok(Buffer.from(changed.hex, 'hex').includes(Buffer.from(dcrScript(addresses[6].address))), 'change back');
  assert.throws(() => stake.planTickets({ mnemonic: PHRASE, coins, price, count: 4, expiry: 1, feeFund: fund, addresses, votingFirst: 0 }), /addresses|Not enough/);
  assert.throws(() => stake.planTickets({ mnemonic: PHRASE, coins: [{ ...coins[0], value: price }], price, count: 1, expiry: 1, feeFund: fund, addresses, votingFirst: 0 }), /Not enough/);
});

test('the VSP\'s answers must be signed with its key and echo the request', async (t) => {
  const priv = ed25519.utils.randomSecretKey();
  const pub = Buffer.from(ed25519.getPublicKey(priv)).toString('base64');
  let mode = 'good';
  let lastSig = '';
  const server = http.createServer((q, r) => {
    let b = ''; q.on('data', (x) => { b += x; });
    q.on('end', () => {
      lastSig = q.headers['vsp-client-signature'] ?? '';
      const body = q.url === '/api/v3/vspinfo'
        ? { apiversions: [3], timestamp: 1, pubkey: pub, feepercentage: 2, vspclosed: false, network: 'mainnet', voting: 5 }
        : { timestamp: 1, feeaddress: DCRD_PKH[0], feeamount: 12345, expiration: 2, request: Buffer.from(mode === 'other' ? '{}' : b).toString('base64') };
      const text = JSON.stringify(body);
      const sig = mode === 'unsigned' ? '' : Buffer.from(ed25519.sign(Buffer.from(text), mode === 'wrongkey' ? ed25519.utils.randomSecretKey() : priv)).toString('base64');
      if (sig) r.setHeader('VSP-Server-Signature', sig);
      r.setHeader('content-type', 'application/json');
      r.end(text);
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = stake.vspOrigin(`http://127.0.0.1:${server.address().port}/`);
  const v = new stake.VspClient(url, null, () => ({}));
  const info = await v.info();
  assert.equal(info.pubkey, pub);
  assert.equal(info.feePercentage, 2);
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(PHRASE)).derive("m/44'/42'/0'/1/0");
  const fee = await v.feeAddress({ hash: 'ab'.repeat(32), hex: '00', parentHex: '00' }, key.privateKey);
  assert.deepEqual([fee.address, fee.amount], [DCRD_PKH[0], 12345n]);
  assert.ok(lastSig.length > 80, 'the request was signed');
  for (const m of ['unsigned', 'wrongkey']) {
    mode = m;
    await assert.rejects(v.feeAddress({ hash: 'ab'.repeat(32), hex: '00', parentHex: '00' }, key.privateKey), /not signed/);
  }
  mode = 'other';
  await assert.rejects(v.feeAddress({ hash: 'ab'.repeat(32), hex: '00', parentHex: '00' }, key.privateKey), /different request/);
  assert.throws(() => stake.vspOrigin('http://vsp.example.com'), /https/);
  assert.equal(stake.vspOrigin('stakey.net'), 'https://stakey.net');
  const list = stake.parseVspList({ 'a.example': { network: 'mainnet', apiversions: [3], feepercentage: 1 }, 'b.example': { network: 'testnet', apiversions: [3] }, 'c.example': { network: 'mainnet', closed: true } });
  assert.deepEqual(list.map((x) => x.url), ['https://a.example']);
  const doctored = stake.parseVspList({ 'x.example': { network: 'mainnet', apiversions: [3], url: 'http://127.0.0.1:9050' }, 'y.example': { network: 'mainnet', apiversions: [3], url: 'https://10.0.0.1' }, 'z.example': { network: 'mainnet', apiversions: [3], url: 'http://abcdefghijklmnop.onion' }, 'w.example': { network: 'mainnet', apiversions: [3], url: 'https://localhost:8800' } });
  assert.deepEqual(doctored, [], 'no list entry reaches this machine, a bare IP or plain http');
});

test('a send from the mixed account puts its change in the regular account, checked against that account\'s keys', () => {
  const mixedXpub = dcr.dcrAccountXpub(PHRASE, dcr.DCR_MIXED_PATH);
  const mixed = new DcrClient(mixedXpub, [], undefined, 30_000, undefined, dcr.DCR_MIXED_PATH);
  const regular = new DcrClient(xpub, []);
  const from = mixed.addressAt(0, 2);
  assert.notEqual(from, regular.addressAt(0, 2), 'its own account');
  const draft = { to: DCRD_PKH[0], amount: 100_000n, fee: 2_520n, change: 397_480n, changeAddress: regular.addressAt(1, 7), changeIndex: 7, changePath: dcr.DCR_PATH, inputs: [{ txid: 'cd'.repeat(32), vout: 0, value: 500_000n, address: from, chain: 0, index: 2 }] };
  const { hex } = signDcrDraft(draft, PHRASE, dcr.DCR_MIXED_PATH);
  assert.ok(Buffer.from(hex, 'hex').includes(Buffer.from(dcrScript(regular.addressAt(1, 7)))), 'change to the regular account');
  assert.throws(() => signDcrDraft({ ...draft, changePath: undefined }, PHRASE, dcr.DCR_MIXED_PATH), /change address does not match/);
  assert.throws(() => signDcrDraft({ ...draft, changeAddress: mixed.addressAt(1, 7) }, PHRASE, dcr.DCR_MIXED_PATH), /change address does not match/);
});
