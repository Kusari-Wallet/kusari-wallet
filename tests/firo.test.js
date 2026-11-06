const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const btc = require('@scure/btc-signer');
const { HDKey } = require('@scure/bip32');
const { mnemonicToSeedSync } = require('@scure/bip39');
const { FiroClient, FIRO_NET, firoAccountXpub, isFiroAddress, signFiroDraft, typicalFiroFee } = require('../dist/main/firo');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const xpub = firoAccountXpub(PHRASE);
const OTHER = 'a1bW3sVVUsLqgKuTMXtSaAHGvpxKwugxPH'; // the standard BIP44 path, coin type 136
const script = (chain, i) => Buffer.from(btc.p2pkh(HDKey.fromMasterSeed(mnemonicToSeedSync(PHRASE)).derive("m/44'/136'/0'").deriveChild(chain).deriveChild(i).publicKey, FIRO_NET).script).toString('hex');

test('addresses: standard BIP44 result, other coins refused', () => {
  const c = new FiroClient(xpub, []);
  assert.equal(c.addressAt(0, 0), OTHER);
  assert.ok(isFiroAddress(OTHER));
  assert.equal(isFiroAddress(OTHER.slice(0, -1) + 'x'), false, 'bad checksum');
  assert.equal(isFiroAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), false);
  assert.equal(isFiroAddress('DsUZxxoHJSty8DCfwfartwTYbuhmVct7tJu'), false);
  assert.equal(isFiroAddress('XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5'), false, 'Dash');
  assert.equal(isFiroAddress('sm1' + 'q'.repeat(100)), false, 'Spark addresses are not supported');
});

test('balance and sending through the shared Insight logic', async (t) => {
  const c = new FiroClient(xpub, []);
  const mine = c.addressAt(0, 1);
  const posted = [];
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => { b += d; });
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.includes('/utxo')) return r.end(JSON.stringify([{ address: mine, txid: 'ab'.repeat(32), vout: 1, satoshis: 2000000, confirmations: 6 }, { address: mine, txid: 'cd'.repeat(32), vout: 0, satoshis: 7000, confirmations: 0 }]));
      if (q.url.includes('/txs')) return r.end('{"items":[]}');
      posted.push(JSON.parse(b).rawtx); r.end('{}');
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const client = new FiroClient(xpub, [`http://127.0.0.1:${server.address().port}`]);
  assert.deepEqual(await client.getBalance(), { total: 2007000n, spendable: 2000000n });
  assert.equal(client.receiveAddress, c.addressAt(0, 2));
  const draft = await client.draft(OTHER, 500000n);
  assert.equal(draft.fee, (10n + 148n + 34n * 2n) * 2n);
  assert.equal(draft.change, 2000000n - 500000n - draft.fee);
  const id = await client.send(draft, PHRASE);
  assert.equal(id.length, 64);
  const tx = btc.Transaction.fromRaw(Buffer.from(posted[0], 'hex'), { allowLegacyWitnessUtxo: true });
  assert.equal(tx.id, id);
  assert.equal(tx.getOutput(0).amount, 500000n);
  assert.equal(btc.Address(FIRO_NET).encode(btc.OutScript.decode(tx.getOutput(0).script)), OTHER);
  await assert.rejects(client.draft(OTHER, 5000000n), /부족/);
  await assert.rejects(client.draft(OTHER, 100n), /최소/);
  assert.equal(typicalFiroFee(), 452n);
});

test('signing refuses wrong sums, addresses not mine, a bad recipient', () => {
  const c = new FiroClient(xpub, []);
  const good = { to: OTHER, amount: 100000n, fee: 500n, change: 99500n, changeAddress: c.addressAt(1, 0), changeIndex: 0, inputs: [{ txid: 'ab'.repeat(32), vout: 0, value: 200000n, address: c.addressAt(0, 0), chain: 0, index: 0 }] };
  assert.ok(signFiroDraft(good, PHRASE).hex);
  assert.throws(() => signFiroDraft({ ...good, fee: 100n }, PHRASE), /금액 계산/);
  assert.throws(() => signFiroDraft({ ...good, inputs: [{ ...good.inputs[0], address: c.addressAt(0, 9) }] }, PHRASE), /입력 주소/);
  assert.throws(() => signFiroDraft({ ...good, changeAddress: c.addressAt(0, 9) }, PHRASE), /잔돈 주소/);
  assert.throws(() => signFiroDraft({ ...good, to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' }, PHRASE), /FIRO 주소/);
});

// Dash's legacy P2PKH script rules are Bitcoin's, so Bitcoin Core's consensus code can judge them.
test('a real script interpreter accepts the signatures and rejects tampering', { skip: !process.env.PBK_PATH }, () => {
  const c = new FiroClient(xpub, []);
  const inputs = [
    { txid: 'ab'.repeat(32), vout: 1, value: 700000n, address: c.addressAt(0, 0), chain: 0, index: 0 },
    { txid: 'cd'.repeat(32), vout: 0, value: 400000n, address: c.addressAt(1, 3), chain: 1, index: 3 },
  ];
  const { hex } = signFiroDraft({ to: OTHER, amount: 900000n, fee: 2000n, change: 198000n, changeAddress: c.addressAt(1, 4), changeIndex: 4, inputs }, PHRASE);
  const input = JSON.stringify({ hex, inputs: [{ script: script(0, 0), value: 700000 }, { script: script(1, 3), value: 400000 }], legacy: true });
  const res = JSON.parse(execFileSync('python3', [path.join(__dirname, 'btc_consensus.py')], { input, env: { ...process.env, PYTHONPATH: process.env.PBK_PATH } }).toString());
  assert.deepEqual(res.valid, [true, true]);
  assert.equal(res.wrong_script, false, 'signature is bound to the key');
});
