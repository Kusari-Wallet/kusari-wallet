// The cryptography under Payjoin (BIP77): ElligatorSwift against BIP324's vectors, HPKE against the secp256k1
// DHKEM draft's vectors (ChaCha20-Poly1305, Base and Auth modes).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { xswiftec, xswiftecInv, ellswiftDecode, ellswiftEncode } = require('../dist/main/ellswift');
const { setupSender, setupReceiver, publicKeyOf, newPrivateKey } = require('../dist/main/hpke');

const hex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
const big = (s) => BigInt('0x' + s);
const csv = (f) => { const [head, ...rows] = fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8').trim().split('\n'); const keys = head.split(','); return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [keys[i], v]))); };

test('ElligatorSwift decodes as BIP324 says', () => {
  const rows = csv('bip324-ellswift-decode.csv');
  assert.ok(rows.length > 70);
  for (const r of rows) {
    const enc = hex(r.ellswift);
    assert.equal(xswiftec(big(r.ellswift.slice(0, 64)), big(r.ellswift.slice(64))).toString(16).padStart(64, '0'), r.x, r.comment);
    assert.equal(Buffer.from(ellswiftDecode(enc).subarray(1, 33)).toString('hex'), r.x);
  }
});

test('XSwiftECInv gives every case BIP324 lists', () => {
  const rows = csv('bip324-xswiftec-inv.csv');
  assert.ok(rows.length > 30);
  for (const r of rows) {
    for (let c = 0; c < 8; c++) {
      const t = xswiftecInv(big(r.x), big(r.u), c);
      const want = r[`case${c}_t`];
      assert.equal(t === null ? '' : t.toString(16).padStart(64, '0'), want, `${r.u} case ${c}`);
    }
  }
});

test('an encoded key decodes to the same point, y included', () => {
  for (let i = 0; i < 40; i++) {
    const pub = publicKeyOf(newPrivateKey());
    const enc = ellswiftEncode(pub);
    assert.equal(enc.length, 64);
    assert.deepEqual(Buffer.from(ellswiftDecode(enc)), Buffer.from(pub));
  }
});

test('HPKE matches the DHKEM(secp256k1) vectors, Base and Auth', () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/hpke-k256-vectors.json'), 'utf8'));
  assert.deepEqual(vectors.map((v) => v.mode).sort(), [0, 2]);
  for (const v of vectors) {
    const info = hex(v.info);
    const auth = v.mode === 2;
    const { enc, ctx } = setupSender(hex(v.pkRm), info, auth ? hex(v.skSm) : undefined, hex(v.skEm));
    assert.equal(Buffer.from(enc).toString('hex'), v.enc);
    const rx = setupReceiver(enc, hex(v.skRm), info, auth ? hex(v.pkSm) : undefined);
    for (const e of v.encryptions) {
      const ct = ctx.seal(hex(e.pt), hex(e.aad));
      assert.equal(Buffer.from(ct).toString('hex'), e.ct);
      assert.equal(Buffer.from(rx.open(ct, hex(e.aad))).toString('hex'), e.pt);
    }
    for (const x of v.exports) assert.equal(Buffer.from(ctx.export(hex(x.exporter_context), x.L)).toString('hex'), x.exported_value);
  }
});
