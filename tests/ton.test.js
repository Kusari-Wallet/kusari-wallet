const test = require('node:test');
const assert = require('node:assert');
const { ed25519 } = require('@noble/curves/ed25519.js');
const { Address, Cell, loadMessage, loadMessageRelaxed } = require('@ton/core');
const { WalletContractV4 } = require('@ton/ton');
const { tonAddress, tonPublicKey, isTonAddress, signTonTransfer, TON_USDT_MASTER } = require('../dist/main/ton');

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TO = WalletContractV4.create({ workchain: 0, publicKey: Buffer.alloc(32, 1) }).address.toString({ bounceable: false, urlSafe: true });

test('the address: a v4r2 wallet for the key at m/44\'/607\'/0\', shown non-bounceable', () => {
  const a = tonAddress(M);
  assert.equal(a, 'UQAzWZa6nM5mJev91wGc7VCSfBoIsYRqKJpV78N8Add9-RKY');
  assert.ok(Address.parse(a).equals(WalletContractV4.create({ workchain: 0, publicKey: Buffer.from(tonPublicKey(M)) }).address));
  for (const ok of [a, TON_USDT_MASTER, '0:' + 'ab'.repeat(32)]) assert.ok(isTonAddress(ok), ok);
  for (const bad of ['UQAzWZa6nM5mJev91wGc7VCSfBoIsYRqKJpV78N8Add9-RKZ', 'rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3', '']) assert.ok(!isTonAddress(bad), bad);
});

/** Opens the external message: checks the wallet's signature and returns the one internal message inside. */
function open(boc) {
  const msg = loadMessage(Cell.fromBase64(boc).beginParse());
  assert.equal(msg.info.type, 'external-in');
  const body = msg.body.beginParse();
  const sig = body.loadBuffer(64);
  const rest = body.asCell();
  assert.ok(ed25519.verify(sig, rest.hash(), tonPublicKey(M)), 'signed by the wallet key');
  const s = rest.beginParse();
  const walletId = s.loadUint(32); const validUntil = s.loadUint(32); const seqno = s.loadUint(32); const op = s.loadUint(8); const mode = s.loadUint(8);
  const inner = loadMessageRelaxed(s.loadRef().beginParse());
  return { msg, walletId, validUntil, seqno, op, mode, inner };
}

test('a GRAM transfer: signed, the first one deploys the wallet, comment and bounce flag as asked', () => {
  const r = signTonTransfer(M, { asset: 'GRAM', to: TO, amount: 1_500_000_000n, fee: 10_000_000n, seqno: 0, comment: 'deposit 42', bounce: false });
  const o = open(r.boc);
  assert.ok(o.msg.init, 'state init with seqno 0');
  assert.equal(o.walletId, 698983191);
  assert.equal(o.seqno, 0);
  assert.equal(o.mode, 3, 'pay fees separately, ignore errors');
  assert.ok(o.inner.info.dest.equals(Address.parse(TO)));
  assert.equal(o.inner.info.value.coins, 1_500_000_000n);
  assert.equal(o.inner.info.bounce, false);
  const b = o.inner.body.beginParse();
  assert.equal(b.loadUint(32), 0); assert.equal(b.loadStringTail(), 'deposit 42');
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  const later = open(signTonTransfer(M, { asset: 'GRAM', to: TO, amount: 1n, fee: 1n, seqno: 5, bounce: true }).boc);
  assert.equal(later.msg.init, undefined); assert.equal(later.seqno, 5);
});

test('a USDT transfer: a TEP-74 transfer to this wallet\'s jetton wallet, excess back here, comment forwarded', () => {
  const jw = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
  const o = open(signTonTransfer(M, { asset: 'USDTT', to: TO, amount: 25_000_000n, fee: 60_000_000n, seqno: 2, comment: 'memo', bounce: true }, jw).boc);
  assert.ok(o.inner.info.dest.equals(Address.parse(jw)));
  assert.equal(o.inner.info.value.coins, 50_000_000n);
  const b = o.inner.body.beginParse();
  assert.equal(b.loadUint(32), 0x0f8a7ea5);
  b.loadUintBig(64);
  assert.equal(b.loadCoins(), 25_000_000n);
  assert.ok(b.loadAddress().equals(Address.parse(TO)));
  assert.ok(b.loadAddress().equals(Address.parse(tonAddress(M))), 'excess back to this wallet');
  assert.equal(b.loadBit(), false);
  assert.equal(b.loadCoins(), 1n);
  const fwd = b.loadMaybeRef().beginParse();
  assert.equal(fwd.loadUint(32), 0); assert.equal(fwd.loadStringTail(), 'memo');
  assert.throws(() => signTonTransfer(M, { asset: 'USDTT', to: TO, amount: 1n, fee: 1n, seqno: 2, bounce: true }), /USDT wallet address/);
});
