const test = require('node:test');
const assert = require('node:assert');
const C = require('@emurgo/cardano-serialization-lib-nodejs');
const { mnemonicToEntropy } = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english');
const ada = require('../dist/main/ada');

// Cardano's own serialization library is the reference here; the wallet never ships it.
const MNEMONICS = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'test walk nut penalty hip pave soap entry language right filter choice',
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title',
];
const H = (n) => (n | 0x80000000) >>> 0;
const reference = (m) => {
  const root = C.Bip32PrivateKey.from_bip39_entropy(Buffer.from(mnemonicToEntropy(m, wordlist)), Buffer.alloc(0));
  const acct = root.derive(H(1852)).derive(H(1815)).derive(H(0));
  const pay = acct.derive(0).derive(0);
  const stake = acct.derive(2).derive(0);
  const addr = C.BaseAddress.new(1, C.Credential.from_keyhash(pay.to_raw_key().to_public().hash()), C.Credential.from_keyhash(stake.to_raw_key().to_public().hash())).to_address().to_bech32();
  return { pay, stake, addr };
};

test('keys and the base address match Cardano\'s library for 12 and 24 words', () => {
  for (const m of MNEMONICS) {
    const ref = reference(m);
    const { payment, stake } = ada.adaKeys(m);
    assert.equal(Buffer.from(ada.publicKeyOf(payment)).toString('hex'), Buffer.from(ref.pay.to_public().to_raw_key().as_bytes()).toString('hex'));
    assert.equal(Buffer.from(ada.publicKeyOf(stake)).toString('hex'), Buffer.from(ref.stake.to_public().to_raw_key().as_bytes()).toString('hex'));
    assert.equal(ada.adaAddress(m), ref.addr);
    assert.ok(ada.isAdaAddress(ref.addr));
  }
});

test('extended-key signatures are the library\'s, byte for byte', () => {
  const m = MNEMONICS[1];
  const ref = reference(m);
  const msg = Buffer.from('a7'.repeat(32), 'hex');
  const ours = ada.signExtended(ada.adaKeys(m).payment, msg);
  assert.equal(Buffer.from(ours).toString('hex'), ref.pay.to_raw_key().sign(msg).to_hex());
});

const P = { minFeeA: 44n, minFeeB: 155381n, coinsPerByte: 4310n, maxTxSize: 16384 };

test('a payment with change: parsed by the library, its id is the body hash, the signature checks, the fee covers the minimum', () => {
  const m = MNEMONICS[0];
  const from = ada.adaAddress(m);
  const to = reference(MNEMONICS[2]).addr;
  const utxos = [
    { txHash: 'bb'.repeat(32), index: 1, lovelace: 3_000_000n, assets: false },
    { txHash: 'aa'.repeat(32), index: 0, lovelace: 10_000_000n, assets: false },
    { txHash: 'cc'.repeat(32), index: 2, lovelace: 50_000_000n, assets: true },
  ];
  const plan = ada.planAda(utxos, ada.adaAddressBytes(from), ada.adaAddressBytes(to), 5_000_000n, P, 123_456_789);
  assert.equal(plan.inputs.length, 1, 'the coin with tokens on it is left alone');
  assert.equal(plan.inputs[0].lovelace + 0n, 10_000_000n);
  assert.equal(plan.amount + plan.change + plan.fee, 10_000_000n);
  const body = ada.txBody(plan.inputs, [{ address: ada.adaAddressBytes(to), lovelace: plan.amount }, { address: ada.adaAddressBytes(from), lovelace: plan.change }], plan.fee, plan.ttl);
  const { cbor, id } = ada.signTx(body, ada.adaKeys(m).payment);
  const tx = C.Transaction.from_bytes(cbor);
  const b = tx.body();
  assert.equal(b.fee().to_str(), String(plan.fee));
  assert.equal(b.ttl_bignum().to_str(), '123456789');
  assert.equal(b.outputs().get(0).address().to_bech32(), to);
  assert.equal(b.outputs().get(0).amount().coin().to_str(), '5000000');
  assert.equal(b.outputs().get(1).address().to_bech32(), from);
  const hash = C.FixedTransaction.from_bytes(cbor).transaction_hash().to_hex();
  assert.equal(id, hash);
  const w = tx.witness_set().vkeys().get(0);
  assert.ok(w.vkey().public_key().verify(Buffer.from(hash, 'hex'), w.signature()));
  const min = BigInt(C.min_fee(tx, C.LinearFee.new(C.BigNum.from_str('44'), C.BigNum.from_str('155381'))).to_str());
  assert.ok(plan.fee >= min && plan.fee - min < 10_000n, `fee ${plan.fee} vs minimum ${min}`);
  // Each output holds at least the ledger's minimum.
  const minOut = BigInt(C.min_ada_for_output(b.outputs().get(1), C.DataCost.new_coins_per_byte(C.BigNum.from_str('4310'))).to_str());
  assert.ok(ada.minAda(ada.adaAddressBytes(from), P) >= minOut);
});

test('sending everything leaves no change; small amounts and bad addresses are refused', () => {
  const m = MNEMONICS[0];
  const from = ada.adaAddressBytes(ada.adaAddress(m));
  const to = ada.adaAddressBytes(reference(MNEMONICS[1]).addr);
  const utxos = [{ txHash: '11'.repeat(32), index: 0, lovelace: 4_000_000n, assets: false }, { txHash: '22'.repeat(32), index: 3, lovelace: 2_500_000n, assets: false }];
  const all = ada.planAda(utxos, from, to, 'max', P, 1);
  assert.equal(all.change, 0n);
  assert.equal(all.amount + all.fee, 6_500_000n);
  assert.throws(() => ada.planAda(utxos, from, to, 500_000n, P, 1), /at least/);
  assert.throws(() => ada.planAda(utxos, from, to, 7_000_000n, P, 1), /Not enough ADA/);
  for (const bad of ['addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp', 'Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi', 'stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw', 'addr1xyz']) {
    assert.equal(ada.isAdaAddress(bad), false, bad);
  }
});
