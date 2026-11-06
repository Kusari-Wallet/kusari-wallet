const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const dcr = require('dcr-ts');
const { DcrClient, dcrAccount, isDcrAddress, estimateDcrSize, signDcrDraft, typicalDcrFee } = require('../dist/main/dcr');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = dcrAccount(PHRASE);
const OTHER = 'DsUZxxoHJSty8DCfwfartwTYbuhmVct7tJu';

function mock(over = {}) {
  const v = { utxos: [], items: [], posted: [], hits: 0, ...over };
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', () => {
      v.hits++;
      const send = (o, code = 200) => { r.statusCode = code; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
      if (q.url.includes('/utxo')) return send(v.utxos);
      if (q.url.includes('/txs')) return send({ totalItems: v.items.length, items: v.items });
      if (q.url === '/tx/send') { const { rawtx } = JSON.parse(b); v.posted.push(rawtx); return v.reject ? send({ message: 'rejected' }, 400) : send({ txid: v.txid }); }
      send({}, 404);
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, v, client: new DcrClient(account, [`http://127.0.0.1:${server.address().port}`]) })));
}
const closing = (t, s) => t.after(() => { s.close(); s.closeAllConnections(); });

test('addresses: Ds form, checksum, other chains and testnet refused', () => {
  const c = new DcrClient(account, []);
  const a = c.addressAt(0, 0);
  assert.equal(a, 'Dso5BhFYjnymYwAzsCDEUENmmh7Y9TA4FM7');
  assert.notEqual(a, c.addressAt(1, 0));
  assert.ok(isDcrAddress(a));
  assert.ok(isDcrAddress(OTHER));
  assert.equal(isDcrAddress(a.slice(0, -1) + (a.endsWith('7') ? '8' : '7')), false, 'bad checksum');
  assert.equal(isDcrAddress('TsZ5wmd7yJ8sVGNAtzQ8YEyPmEMXvyVpFqN'), false);
  assert.equal(isDcrAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'), false);
});

test('balance from one request per kind; unconfirmed coins are not spendable; next address moves on', async (t) => {
  const c = new DcrClient(account, []);
  const m = await mock({ utxos: [
    { address: c.addressAt(0, 2), txid: 'ab'.repeat(32), vout: 1, satoshis: 500000, confirmations: 3 },
    { address: c.addressAt(1, 0), txid: 'cd'.repeat(32), vout: 0, satoshis: 40000, confirmations: 0 },
  ] }); closing(t, m.server);
  const b = await m.client.getBalance();
  assert.equal(b.total, 540000n);
  assert.equal(b.spendable, 500000n);
  assert.equal(m.client.receiveAddress, c.addressAt(0, 3));
  assert.ok(m.v.hits <= 4, `${m.v.hits} requests`);
  m.v.hits = 0;
  await m.client.getBalance();
  assert.equal(m.v.hits, 0, 'cached');
});

test('selection: fee, change, dust to fee, max, shortage', async (t) => {
  const c = new DcrClient(account, []);
  const u = (value, i = 0) => ({ address: c.addressAt(0, i), txid: String(i + 1).padStart(64, '0'), vout: 0, satoshis: value, confirmations: 2 });
  const m = await mock({ utxos: [u(1000000), u(300000, 1)] }); closing(t, m.server);
  const d = await m.client.draft(OTHER, 500000n);
  assert.equal(d.inputs.length, 1);
  assert.equal(d.fee, estimateDcrSize(1, 2) * 20n);
  assert.equal(d.change, 1000000n - 500000n - d.fee);
  const max = await m.client.draft(OTHER, 'max');
  assert.equal(max.amount + max.fee, 1300000n);
  assert.equal(max.change, 0n);
  await assert.rejects(m.client.draft(OTHER, 5000000n), /enough/);
  await assert.rejects(m.client.draft(OTHER, 100n), /minimum/);
  m.v.utxos = [];
  await assert.rejects(m.client.draft(OTHER, 500000n), /No |Nothing/);
  assert.equal(typicalDcrFee(), estimateDcrSize(1, 2) * 20n);
});

test('signature checks out against the public key and sighash; values are the approved ones', () => {
  const c = new DcrClient(account, []);
  const a0 = c.addressAt(0, 0);
  const a1 = c.addressAt(1, 3);
  const draft = {
    to: OTHER, amount: 900000n, fee: 2000n, change: 298000n, changeAddress: c.addressAt(1, 4), changeIndex: 4,
    inputs: [
      { txid: 'ab'.repeat(32), vout: 1, value: 700000n, address: a0, chain: 0, index: 0 },
      { txid: 'cd'.repeat(32), vout: 0, value: 500000n, address: a1, chain: 1, index: 3 },
    ],
  };
  const { hex, id } = signDcrDraft(draft, PHRASE);
  assert.match(hex, /^[0-9a-f]+$/);
  assert.equal(id.length, 64);
  const bytes = BigInt(hex.length / 2);
  assert.ok(bytes <= estimateDcrSize(2, 2), `size ${bytes} fits the estimate ${estimateDcrSize(2, 2)}`);
  assert.ok(bytes >= estimateDcrSize(2, 2) - 12n, `size ${bytes} close to the estimate`);

  // Rebuilt by hand, unsigned, so the signature can be checked with the library's own sighash.
  const tx = new dcr.Transaction();
  tx.addInput(dcr.outPointFromTxid(draft.inputs[0].txid, 1), { valueIn: 700000n });
  tx.addInput(dcr.outPointFromTxid(draft.inputs[1].txid, 0), { valueIn: 500000n });
  tx.addOutput(900000n, dcr.addressToScript(OTHER, dcr.mainnet));
  tx.addOutput(298000n, dcr.addressToScript(draft.changeAddress, dcr.mainnet));
  assert.equal(tx.txid(), id, 'the id is the unsigned prefix');
  const script = dcr.addressToScript(a0, dcr.mainnet);
  const hash = dcr.calcSignatureHash(script, dcr.SigHashType.All, tx, 0);
  const key = dcr.mnemonicToMasterKey(PHRASE, dcr.mainnet).derivePath("m/44'/42'/0'").derive(0).derive(0);
  const sigScript = (() => { const copy = new dcr.Transaction(); copy.addInput(dcr.outPointFromTxid(draft.inputs[0].txid, 1), { valueIn: 700000n }); copy.addInput(dcr.outPointFromTxid(draft.inputs[1].txid, 0), { valueIn: 500000n }); copy.addOutput(900000n, dcr.addressToScript(OTHER, dcr.mainnet)); copy.addOutput(298000n, dcr.addressToScript(draft.changeAddress, dcr.mainnet)); dcr.signP2PKHInput(copy, 0, script, key.privateKeyBytes()); return copy.inputs[0].signatureScript; })();
  assert.ok(hex.includes(Buffer.from(sigScript).toString('hex')), 'same signature as the reference call, deterministic');
  const sigLen = sigScript[0];
  const der = sigScript.slice(1, sigLen); // without the sighash type byte
  assert.equal(dcr.verifyHash(hash, der, key.publicKey()), true);
  assert.equal(dcr.verifyHash(hash.map((b, i) => (i === 0 ? b ^ 1 : b)), der, key.publicKey()), false, 'a changed transaction fails');
});

test('signing refuses wrong sums, an input or change that is not mine, and a bad recipient', () => {
  const c = new DcrClient(account, []);
  const good = { to: OTHER, amount: 1000n, fee: 200n, change: 800n, changeAddress: c.addressAt(1, 0), changeIndex: 0, inputs: [{ txid: 'ab'.repeat(32), vout: 0, value: 2000n, address: c.addressAt(0, 0), chain: 0, index: 0 }] };
  assert.ok(signDcrDraft(good, PHRASE).hex);
  assert.throws(() => signDcrDraft({ ...good, fee: 100n }, PHRASE), /do not add up/);
  assert.throws(() => signDcrDraft({ ...good, inputs: [{ ...good.inputs[0], address: c.addressAt(0, 9) }] }, PHRASE), /input address/);
  assert.throws(() => signDcrDraft({ ...good, changeAddress: c.addressAt(0, 9) }, PHRASE), /change address/);
  assert.throws(() => signDcrDraft({ ...good, to: 'TsZ5wmd7yJ8sVGNAtzQ8YEyPmEMXvyVpFqN' }, PHRASE), /DCR address/);
});

test('send: broadcast, server disagreement and rejection are reported; history reads directions', async (t) => {
  const c = new DcrClient(account, []);
  const mine = c.addressAt(0, 0);
  const m = await mock({
    utxos: [{ address: mine, txid: 'ab'.repeat(32), vout: 0, satoshis: 1000000, confirmations: 5 }],
    items: [
      { txid: 'aa'.repeat(32), time: 1700000002, confirmations: 3, vin: [{ addr: OTHER, value: 1 }], vout: [{ value: 0.01, scriptPubKey: { addresses: [mine] } }] },
      { txid: 'bb'.repeat(32), time: 1700000003, confirmations: 0, vin: [{ addr: mine, value: 0.01 }], vout: [{ value: 0.004, scriptPubKey: { addresses: [OTHER] } }, { value: 0.0059, scriptPubKey: { addresses: [c.addressAt(1, 0)] } }] },
    ],
  }); closing(t, m.server);
  const hist = await m.client.getHistory();
  assert.deepEqual(hist.map((h) => [h.direction, h.amount, h.status]), [['out', '0.0041', 'pending'], ['in', '0.01', 'confirmed']]);
  const d = await m.client.draft(OTHER, 200000n);
  const id = await m.client.send(d, PHRASE);
  assert.equal(m.v.posted.length, 1);
  assert.equal(id.length, 64);
  m.v.txid = 'ff'.repeat(32);
  await assert.rejects(m.client.send(await m.client.draft(OTHER, 200000n), PHRASE), /different transaction ID/);
  m.v.txid = undefined;
  m.v.reject = true;
  await assert.rejects(m.client.send(await m.client.draft(OTHER, 200000n), PHRASE), /Send rejected/);
});

test('a server error stays an error', async (t) => {
  const server = http.createServer((q, r) => { r.statusCode = 500; r.end('{}'); });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  closing(t, server);
  const client = new DcrClient(account, [`http://127.0.0.1:${server.address().port}`]);
  await assert.rejects(client.getBalance());
});
