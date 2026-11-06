const test = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { mnemonicToSeedSync } = require('@scure/bip39');
const { HDKey } = require('@scure/bip32');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { keccak_256 } = require('@noble/hashes/sha3.js');
const { TronWeb } = require('tronweb');
const { TronClient, deriveTronAccount, generateTronMnemonic, isTronAddress, TRON_PATH } = require('../dist/main/tron');
const { NETWORKS } = require('../dist/main/config');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha = (b) => createHash('sha256').update(b).digest();
function b58check(bytes) {
  const full = Buffer.concat([bytes, sha(sha(bytes)).subarray(0, 4)]);
  let n = BigInt('0x' + full.toString('hex')), s = '';
  while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
  return s;
}
/** Independent of TronWeb: BIP39 -> BIP32 -> secp256k1 -> keccak -> base58check. */
function independentAddress(mnemonic) {
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(TRON_PATH);
  const pub = secp256k1.getPublicKey(node.privateKey, false).slice(1);
  const hash = Buffer.from(keccak_256(pub)).subarray(12);
  return { address: b58check(Buffer.concat([Buffer.from([0x41]), hash])), privateKey: Buffer.from(node.privateKey).toString('hex') };
}

const { mockNode, me, RECIPIENT } = require('./mock-tron');

test('derivation matches an independent implementation', () => {
  const ind = independentAddress(MNEMONIC);
  assert.equal(me.address, ind.address);
  assert.equal(me.privateKey, ind.privateKey);
  assert.ok(isTronAddress(me.address));
});

test('random mnemonics are 12 valid words and unique', () => {
  const a = generateTronMnemonic(), b = generateTronMnemonic();
  assert.notEqual(a, b);
  assert.equal(a.split(' ').length, 12);
  assert.equal(deriveTronAccount(a).address, independentAddress(a).address);
});

test('bad input is rejected', () => {
  assert.throws(() => deriveTronAccount('abandon abandon abandon'));
  assert.throws(() => deriveTronAccount(MNEMONIC.replace('about', 'zebra')));
  assert.ok(!isTronAddress('0x' + 'a'.repeat(40)));
  assert.ok(!isTronAddress(me.address.slice(0, -1) + (me.address.endsWith('a') ? 'b' : 'a')));
  assert.ok(isTronAddress(NETWORKS.mainnet.tron.usdt));
  assert.ok(isTronAddress(NETWORKS.testnet.tron.usdt));
});

function verifySignature(tx) {
  const sig = Buffer.from(tx.signature[0], 'hex');
  const hash = sha(Buffer.from(tx.raw_data_hex, 'hex'));
  assert.equal(hash.toString('hex'), tx.txID, 'txID must be hash of raw data');
  const recovered = secp256k1.Signature.fromBytes(sig.subarray(0, 64), 'compact').addRecoveryBit(sig[64] >= 27 ? sig[64] - 27 : sig[64]).recoverPublicKey(hash).toBytes(false);
  const addr = b58check(Buffer.concat([Buffer.from([0x41]), Buffer.from(keccak_256(recovered.slice(1))).subarray(12)]));
  assert.equal(addr, me.address, 'signature must recover to my address');
}

test('TRX send: built locally, signed correctly, exact fields', async (t) => {
  const { server, state, client } = await mockNode();
  t.after(() => server.close());
  const txid = await client.send({ asset: 'TRX', to: RECIPIENT, amount: 1_234_567n }, me.privateKey);
  assert.equal(state.broadcast.length, 1);
  const tx = state.broadcast[0];
  assert.equal(tx.txID, txid);
  verifySignature(tx);
  const v = tx.raw_data.contract[0].parameter.value;
  assert.equal(v.to_address.toLowerCase(), TronWeb.address.toHex(RECIPIENT).toLowerCase());
  assert.equal(v.amount, 1234567);
});

test('USDT send: calldata and contract are exact', async (t) => {
  const { server, state, client } = await mockNode();
  t.after(() => server.close());
  const fee = await client.estimateFee({ asset: 'USDT', to: RECIPIENT, amount: 2_500_000n });
  assert.equal(fee.feeSun, 64285n * 100n);
  assert.equal(fee.feeLimitSun, (64285n * 100n * 3n) / 2n);
  await client.send({ asset: 'USDT', to: RECIPIENT, amount: 2_500_000n, feeLimit: fee.feeLimitSun }, me.privateKey);
  const tx = state.broadcast[0];
  verifySignature(tx);
  const v = tx.raw_data.contract[0].parameter.value;
  assert.equal(v.contract_address.toLowerCase(), TronWeb.address.toHex(NETWORKS.mainnet.tron.usdt).toLowerCase());
  assert.equal(v.data.slice(0, 8), 'a9059cbb');
  assert.equal(BigInt('0x' + v.data.slice(72)), 2_500_000n);
  assert.equal(v.data.slice(8, 72).slice(-40), TronWeb.address.toHex(RECIPIENT).slice(2).toLowerCase());
  assert.equal(BigInt(tx.raw_data.fee_limit), fee.feeLimitSun);
});

test('signing is refused if anything differs from what was approved', async (t) => {
  const { server, client } = await mockNode();
  t.after(() => server.close());
  const other = independentAddress('letter advice cage absurd amount doctor acoustic avoid letter advice cage above').address;

  const trx = await client.build({ asset: 'TRX', to: RECIPIENT, amount: 5n });
  assert.throws(() => client.assertMatches(trx, { asset: 'TRX', to: other, amount: 5n }), /differ|match/);
  assert.throws(() => client.assertMatches(trx, { asset: 'TRX', to: RECIPIENT, amount: 6n }), /differ|match/);
  client.assertMatches(trx, { asset: 'TRX', to: RECIPIENT, amount: 5n });

  const mutated = JSON.parse(JSON.stringify(trx));
  mutated.raw_data.contract[0].parameter.value.to_address = TronWeb.address.toHex(other).toLowerCase();
  assert.throws(() => client.assertMatches(mutated, { asset: 'TRX', to: RECIPIENT, amount: 5n }), /integrity|match/);

  const usdt = await client.build({ asset: 'USDT', to: RECIPIENT, amount: 7n, feeLimit: 1000n });
  client.assertMatches(usdt, { asset: 'USDT', to: RECIPIENT, amount: 7n, feeLimit: 1000n });
  assert.throws(() => client.assertMatches(usdt, { asset: 'USDT', to: other, amount: 7n, feeLimit: 1000n }), /differ|match/);
  assert.throws(() => client.assertMatches(usdt, { asset: 'USDT', to: RECIPIENT, amount: 8n, feeLimit: 1000n }), /differ|match/);
  assert.throws(() => client.assertMatches(usdt, { asset: 'USDT', to: RECIPIENT, amount: 7n, feeLimit: 2000n }), /differ|match/);
});

test('balances, fee edge cases, absurd energy refused', async (t) => {
  const { server, state, client } = await mockNode();
  t.after(() => server.close());
  assert.equal(await client.getTrxBalance(), 50_000_000n);
  assert.equal(await client.getUsdtBalance(), 10_000_000n);
  assert.equal((await client.estimateFee({ asset: 'TRX', to: RECIPIENT, amount: 1n })).feeSun, 0n);
  state.recipientExists = false;
  const fresh = await client.estimateFee({ asset: 'TRX', to: RECIPIENT, amount: 1n });
  assert.equal(fresh.feeSun, 1_100_000n);
  assert.ok(fresh.recipientIsNew);
  state.energyUsed = 5_000_000;
  await assert.rejects(client.estimateFee({ asset: 'USDT', to: RECIPIENT, amount: 1n }), /abnormal/);
});

test('history drops fake tokens and zero transfers, flags dust, labels direction', async (t) => {
  const { server, client } = await mockNode();
  t.after(() => server.close());
  const usdt = await client.getHistory('USDT');
  assert.deepEqual(usdt.map((i) => [i.direction, i.amount, i.dust]), [['in', '2.5', false], ['out', '1', false], ['in', '0.000001', true]]);
  const trx = await client.getHistory('TRX');
  assert.deepEqual(trx.map((i) => [i.direction, i.amount]), [['in', '3']]);
});

test('receipts: failed vs confirmed', async (t) => {
  const { server, state, client } = await mockNode();
  t.after(() => server.close());
  state.txInfo = { id: 'ab'.repeat(32), receipt: { result: 'OUT_OF_ENERGY' }, result: 'FAILED' };
  assert.equal(await client.waitForResult('ab'.repeat(32), 8000), 'failed');
  state.txInfo = { id: 'ab'.repeat(32), receipt: { result: 'SUCCESS' } };
  assert.equal(await client.waitForResult('ab'.repeat(32), 8000), 'confirmed');
});

test('typical USDT fee works with an empty wallet and counts a real transfer, not a self transfer', async (t) => {
  const { server, client } = await mockNode();
  t.after(() => server.close());
  const fee = await client.typicalUsdtFee();
  assert.equal(fee, 65_000n * 100n);
});
