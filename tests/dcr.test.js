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
