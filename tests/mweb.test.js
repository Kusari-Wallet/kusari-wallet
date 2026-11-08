const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { MwebClient, mwebKeys, isMwebAddress } = require('../dist/main/mweb');
const { startMwebEngine } = require('../dist/main/mweb-process');

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ENGINE = path.join(__dirname, 'fake-mweb-engine.js');

async function client(t, coins) {
  process.env.FAKE_MWEB_COINS = JSON.stringify(coins);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mweb-'));
  const c = new MwebClient({ engine: () => startMwebEngine(ENGINE), dir, canConnect: () => true, onChange: () => {} }, M);
  await c.start();
  t.after(() => { c.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return c;
}

test('keys come from the seed at mwebd\'s documented paths, the same every time', () => {
  const a = mwebKeys(M);
  assert.deepEqual(a, mwebKeys(M));
  assert.match(a.scan, /^[0-9a-f]{64}$/);
  assert.match(a.spendPub, /^0[23][0-9a-f]{64}$/);
  assert.notEqual(a.scan, a.spend);
});

test('balance: confirmed coins are spendable; unconfirmed only count in the total', async (t) => {
  const c = await client(t, [{ index: 1, value: 50_000_000, height: 10 }, { index: 2, value: 1_000_000, height: 0 }]);
  assert.ok(isMwebAddress(c.receiveAddress));
  assert.notEqual(c.receiveAddress, c.changeAddress);
  assert.deepEqual(c.balance(), { total: 51_000_000n, spendable: 50_000_000n });
});

test('a send takes the largest coins it needs, leaves the fee, and to an ordinary address it is a peg-out', async (t) => {
  const c = await client(t, [{ index: 1, value: 30_000_000, height: 10 }, { index: 3, value: 10_000_000, height: 10 }, { index: 4, value: 5_000_000, height: 0 }]);
  const priv = await c.draft('ltcmweb1' + 'q'.repeat(110), 20_000_000n, 10_000);
  assert.equal(priv.coins.length, 1, 'the 0.3 LTC coin is enough');
  assert.equal(priv.pegout, false);
  const out = await c.draft('ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9', 'max', 10_000);
  assert.equal(out.amount, 40_000_000n - 2000n, 'max: every confirmed coin minus the fee, never the unconfirmed one');
  assert.equal(out.pegout, true);
  await assert.rejects(c.draft(c.receiveAddress, 1n, 10_000), /own address/);
  assert.match(await c.send(priv, M), /^[0-9a-f]{64}$/);
});

test('peg-in: every public coin goes in, with the P2WPKH script its key gives', async (t) => {
  const { HDKey } = require('@scure/bip32');
  const { mnemonicToSeedSync } = require('@scure/bip39');
  const btc = require('@scure/btc-signer');
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(M)).derive("m/84'/2'/0'").deriveChild(0).deriveChild(0);
  const address = btc.p2wpkh(child.publicKey, { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 }).address;
  const c = await client(t, []);
  const utxo = { txid: '11'.repeat(32), vout: 0, value: 2_000_000n, address, chain: 0, index: 0, confirmed: true };
  const d = await c.peginDraft([utxo], 10_000);
  assert.equal(d.amount, 2_000_000n - 3000n);
  assert.equal(d.to, c.receiveAddress);
  assert.match(await c.pegin(d, M), /^[0-9a-f]{64}$/);
  const wrong = { ...utxo, chain: 0, index: 1 };
  await assert.rejects(c.pegin({ ...d, inputs: [wrong] }, M), /does not match/);
});
