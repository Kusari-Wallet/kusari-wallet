const test = require('node:test');
const assert = require('node:assert');
const vectors = require('./fixtures/bip352-vectors.json'); // from bitcoin/bips, bip-0352/send_and_receive_test_vectors.json
const { silentOutputs, decodeSilentAddress, isSilentAddress } = require('../dist/main/btc-silent');

const NUMS = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';
// Which inputs count (BIP352 "Inputs For Shared Secret Derivation"), read from what the vectors give.
function pushes(hexScript) {
  const b = Buffer.from(hexScript, 'hex'); const out = []; let i = 0;
  while (i < b.length) { const op = b[i++]; let n = op; if (op === 0x4c) n = b[i++]; else if (op === 0x4d) { n = b.readUInt16LE(i); i += 2; } else if (op > 0x4b) continue; out.push(b.subarray(i, i + n)); i += n; }
  return out;
}
function witnessItems(hexWitness) {
  if (!hexWitness) return [];
  const b = Buffer.from(hexWitness, 'hex'); let i = 0; const vi = () => { const c = b[i++]; if (c < 0xfd) return c; const v = b.readUInt16LE(i); i += 2; return v; };
  const n = vi(); const items = []; for (let k = 0; k < n; k++) { const l = vi(); items.push(b.subarray(i, i + l)); i += l; } return items;
}
function eligible(vin) {
  const spk = vin.prevout.scriptPubKey.hex;
  if (/^5120[0-9a-f]{64}$/.test(spk)) {
    let w = witnessItems(vin.txinwitness);
    if (w.length > 1 && w[w.length - 1][0] === 0x50) w = w.slice(0, -1); // annex
    if (w.length > 1 && w[w.length - 1].subarray(1, 33).toString('hex') === NUMS) return null; // script path, NUMS key
    return { taproot: true };
  }
  if (/^0014[0-9a-f]{40}$/.test(spk)) { const w = witnessItems(vin.txinwitness); return w.length && w[w.length - 1].length === 33 ? { taproot: false } : null; }
  if (/^76a914[0-9a-f]{40}88ac$/.test(spk)) { const p = pushes(vin.scriptSig); return p.some((x) => x.length === 33 && (x[0] === 2 || x[0] === 3)) ? { taproot: false } : null; }
  if (/^a914[0-9a-f]{40}87$/.test(spk)) {
    const p = pushes(vin.scriptSig); const redeem = p[p.length - 1];
    if (!redeem || redeem.length !== 22 || redeem[0] !== 0 || redeem[1] !== 0x14) return null;
    const w = witnessItems(vin.txinwitness); return w.length && w[w.length - 1].length === 33 ? { taproot: false } : null;
  }
  return null;
}

test('BIP352 sending: every official vector with expected outputs', () => {
  let checked = 0;
  for (const v of vectors) {
    for (const s of v.sending ?? []) {
      const inputs = s.given.vin.map((vin) => ({ vin, e: eligible(vin) })).filter((x) => x.e).map(({ vin, e }) => ({ txid: vin.txid, vout: vin.vout, key: Uint8Array.from(Buffer.from(vin.private_key, 'hex')), taproot: e.taproot }));
      const recipients = s.given.recipients.flatMap((r) => (typeof r === 'string' ? [r] : new Array(r.count ?? 1).fill(r.address)));
      const expected = s.expected.outputs; // each entry: one acceptable set of outputs
      if (!expected.length || !expected[0].length) {
        assert.throws(() => silentOutputs(inputs, recipients, s.given.vin.map((x) => ({ txid: x.txid, vout: x.vout }))), undefined, v.comment);
        checked++; continue;
      }
      let outs;
      try { outs = silentOutputs(inputs, recipients, s.given.vin.map((x) => ({ txid: x.txid, vout: x.vout }))).map((o) => Buffer.from(o).toString('hex')); } catch (e) { assert.fail(`${v.comment}: ${e.message}`); }
      const ok = expected.some((set) => set.length === outs.length && [...set].sort().join() === [...outs].sort().join());
      assert.ok(ok, `${v.comment}: got ${outs}`);
      checked++;
    }
  }
  assert.ok(checked >= 25, `checked ${checked}`);
});

test('Silent Payments addresses: decoded, and other things refused', () => {
  const a = vectors[0].sending[0].given.recipients[0];
  const d = decodeSilentAddress(a.address ?? a);
  assert.strictEqual(Buffer.from(d.scan).toString('hex'), a.scan_pub_key);
  assert.strictEqual(Buffer.from(d.spend).toString('hex'), a.spend_pub_key);
  assert.ok(isSilentAddress((a.address ?? a).toUpperCase()), 'upper case is the same address');
  assert.ok(!isSilentAddress('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'));
  assert.ok(!isSilentAddress((a.address ?? a).slice(0, -1) + 'x'), 'a typo fails the checksum');
});

test('a wallet send to an sp1 address: the recipient, scanning with its own keys, finds the output', () => {
  const btc = require('@scure/btc-signer');
  const { secp256k1, schnorr } = require('@noble/curves/secp256k1.js');
  const { BtcClient, btcAccountXpub, signBtcDraft, taprootOutputKey } = require('../dist/main/btc');
  const { HDKey } = require('@scure/bip32'); const { mnemonicToSeedSync } = require('@scure/bip39');
  const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const c = new BtcClient(btcAccountXpub(MNEMONIC), []);
  const v = vectors[0].receiving[0];
  const to = v.expected.addresses[0];
  const inputs = [0, 1].map((i) => ({ txid: String(i + 7).repeat(64).slice(0, 64), vout: i, value: 60000n, address: c.addressAt(0, i), chain: 0, index: i, confirmed: true }));
  const draft = { to, amount: 70000n, fee: 1000n, change: 49000n, changeAddress: c.addressAt(1, 0), changePath: [1, 0], inputs };
  const { hex } = signBtcDraft(draft, MNEMONIC);
  const tx = btc.Transaction.fromRaw(Buffer.from(hex, 'hex'));
  const out = tx.getOutput(0);
  assert.strictEqual(out.amount, 70000n);
  // The receiver's side, written out independently: A from the inputs' taproot output keys, as found on chain.
  const P = secp256k1.Point; const n = P.Fn.ORDER;
  const big = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
  const A = inputs.map((u) => P.fromHex('02' + Buffer.from(btc.OutScript.decode(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(u.address))).pubkey).toString('hex'))).reduce((x, y) => x.add(y));
  const outpoints = inputs.map((u) => { const b = Buffer.alloc(36); Buffer.from(u.txid, 'hex').reverse().copy(b); b.writeUInt32LE(u.vout, 32); return b; }).sort(Buffer.compare);
  const inputHash = big(schnorr.utils.taggedHash('BIP0352/Inputs', outpoints[0], A.toBytes(true)));
  const ecdh = A.multiply((inputHash * big(Buffer.from(v.given.key_material.scan_priv_key, 'hex'))) % n).toBytes(true);
  const t = big(schnorr.utils.taggedHash('BIP0352/SharedSecret', ecdh, Buffer.alloc(4)));
  const Bspend = P.BASE.multiply(big(Buffer.from(v.given.key_material.spend_priv_key, 'hex')));
  const expected = Bspend.add(P.BASE.multiply(t)).toBytes(true).slice(1);
  assert.strictEqual(Buffer.from(out.script).toString('hex'), '5120' + Buffer.from(expected).toString('hex'));
  // And the tweaked key helper matches the address's output key.
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC)).derive("m/86'/0'/0'/0/0");
  const q = P.BASE.multiply(big(taprootOutputKey(child.privateKey))).toBytes(true).slice(1);
  assert.strictEqual(Buffer.from(q).toString('hex'), Buffer.from(btc.OutScript.decode(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(c.addressAt(0, 0)))).pubkey).toString('hex'));
});
