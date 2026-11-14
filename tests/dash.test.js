const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const btc = require('@scure/btc-signer');
const { prevTx } = require('./prev-tx');
const { HDKey } = require('@scure/bip32');
const { mnemonicToSeedSync } = require('@scure/bip39');
const { DashClient, DASH_NET, dashAccountXpub, isDashAddress, signDashDraft, typicalDashFee } = require('../dist/main/dash');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const xpub = dashAccountXpub(PHRASE);
const OTHER = 'XoJA8qE3N2Y3jMLEtZ3vcN42qseZ8LvFf5';
const script = (chain, i) => Buffer.from(btc.p2pkh(HDKey.fromMasterSeed(mnemonicToSeedSync(PHRASE)).derive("m/44'/5'/0'").deriveChild(chain).deriveChild(i).publicKey, DASH_NET).script).toString('hex');

test('addresses: standard BIP44 result, other coins refused', () => {
  const c = new DashClient(xpub, []);
  assert.equal(c.addressAt(0, 0), OTHER);
  assert.ok(isDashAddress(OTHER));
  assert.equal(isDashAddress(OTHER.slice(0, -1) + 'x'), false, 'bad checksum');
  assert.equal(isDashAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), false);
  assert.equal(isDashAddress('DsUZxxoHJSty8DCfwfartwTYbuhmVct7tJu'), false);
  assert.equal(isDashAddress('Xo'), false);
});

test('balance and sending through the shared Insight logic', async (t) => {
  const c = new DashClient(xpub, []);
  const mine = c.addressAt(0, 1);
  const posted = [];
  const made = prevTx([{ value: 1, script: '51' }, { value: 2000000, script: Buffer.from(btc.OutScript.encode(btc.Address(DASH_NET).decode(mine))).toString('hex') }]);
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => { b += d; });
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.startsWith('/rawtx/')) return r.end(JSON.stringify({ rawtx: q.url === `/rawtx/${made.txid}` ? made.hex : '' }));
      if (q.url.includes('/utxo')) return r.end(JSON.stringify([{ address: mine, txid: made.txid, vout: 1, satoshis: 2000000, confirmations: 6 }, { address: mine, txid: 'cd'.repeat(32), vout: 0, satoshis: 7000, confirmations: 0 }]));
      if (q.url.includes('/txs')) return r.end('{"items":[]}');
      posted.push(JSON.parse(b).rawtx); r.end('{}');
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const client = new DashClient(xpub, [`http://127.0.0.1:${server.address().port}`]);
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
  assert.equal(btc.Address(DASH_NET).encode(btc.OutScript.decode(tx.getOutput(0).script)), OTHER);
  await assert.rejects(client.draft(OTHER, 5000000n), /enough/);
  await assert.rejects(client.draft(OTHER, 100n), /minimum/);
  assert.equal(typicalDashFee(), 452n);
});

test('signing refuses wrong sums, addresses not mine, a bad recipient', () => {
  const c = new DashClient(xpub, []);
  const good = { to: OTHER, amount: 100000n, fee: 500n, change: 99500n, changeAddress: c.addressAt(1, 0), changeIndex: 0, inputs: [{ txid: 'ab'.repeat(32), vout: 0, value: 200000n, address: c.addressAt(0, 0), chain: 0, index: 0 }] };
  assert.ok(signDashDraft(good, PHRASE).hex);
  assert.throws(() => signDashDraft({ ...good, fee: 100n }, PHRASE), /do not add up/);
  assert.throws(() => signDashDraft({ ...good, inputs: [{ ...good.inputs[0], address: c.addressAt(0, 9) }] }, PHRASE), /input address/);
  assert.throws(() => signDashDraft({ ...good, changeAddress: c.addressAt(0, 9) }, PHRASE), /change address/);
  assert.throws(() => signDashDraft({ ...good, to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' }, PHRASE), /DASH address/);
});

// Dash's legacy P2PKH script rules are Bitcoin's, so Bitcoin Core's consensus code can judge them.
test('a real script interpreter accepts the signatures and rejects tampering', { skip: !process.env.PBK_PATH }, () => {
  const c = new DashClient(xpub, []);
  const inputs = [
    { txid: 'ab'.repeat(32), vout: 1, value: 700000n, address: c.addressAt(0, 0), chain: 0, index: 0 },
    { txid: 'cd'.repeat(32), vout: 0, value: 400000n, address: c.addressAt(1, 3), chain: 1, index: 3 },
  ];
  const { hex } = signDashDraft({ to: OTHER, amount: 900000n, fee: 2000n, change: 198000n, changeAddress: c.addressAt(1, 4), changeIndex: 4, inputs }, PHRASE);
  const input = JSON.stringify({ hex, inputs: [{ script: script(0, 0), value: 700000 }, { script: script(1, 3), value: 400000 }], legacy: true });
  const res = JSON.parse(execFileSync('python3', [path.join(__dirname, 'btc_consensus.py')], { input, env: { ...process.env, PYTHONPATH: process.env.PBK_PATH } }).toString());
  assert.deepEqual(res.valid, [true, true]);
  assert.equal(res.wrong_script, false, 'signature is bound to the key');
});

test('a server that understates a coin is caught before anything is signed', async (t) => {
  const c = new DashClient(xpub, []);
  const mine = c.addressAt(0, 0);
  const scr = Buffer.from(btc.OutScript.encode(btc.Address(DASH_NET).decode(mine))).toString('hex');
  // The coin is really worth 50 DASH; the server says 0.02, which would leave 49.98 DASH to the miners.
  const made = prevTx([{ value: 5_000_000_000n, script: scr }]);
  const other = prevTx([{ value: 2_000_000n, script: '76a914' + '00'.repeat(20) + '88ac' }], 7);
  let mode = 'understate';
  const posted = [];
  const server = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => { b += d; });
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url.startsWith('/rawtx/')) return r.end(JSON.stringify({ rawtx: mode === 'swap' ? other.hex : mode === 'junk' ? 'zz' : made.hex }));
      if (q.url.includes('/utxo')) return r.end(JSON.stringify([{ address: mine, txid: made.txid, vout: 0, satoshis: mode === 'honest' ? 5_000_000_000 : 2_000_000, confirmations: 6 }]));
      if (q.url.includes('/txs')) return r.end('{"items":[]}');
      posted.push(b); r.end('{}');
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const client = new DashClient(xpub, [`http://127.0.0.1:${server.address().port}`]);
  await assert.rejects(client.draft(OTHER, 1_000_000n), /described a coin differently/);
  mode = 'swap'; // a different transaction under the coin's ID
  await assert.rejects(client.draft(OTHER, 1_000_000n), /described a coin differently/);
  mode = 'junk';
  await assert.rejects(client.confirmedUtxos(), /described a coin differently/);
  assert.equal(posted.length, 0);
  mode = 'honest';
  const d = await client.draft(OTHER, 1_000_000n);
  assert.equal(d.inputs[0].value + 0n, 5_000_000_000n);
  assert.equal(d.amount + d.change + d.fee, 5_000_000_000n);
});
