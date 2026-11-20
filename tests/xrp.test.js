const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { xrpAddress, isXrpAddress, signXrpPayment, XrpClient } = require('../dist/main/xrp');

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// The address ripple-keypairs derives from m/44'/144'/0'/0/0; the payment decoded and its signature verified with
// ripple-binary-codec 2.1 and ripple-keypairs 2.0 (encodeForSigning + verify), its ID as rippled computes it.
const ME = 'rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3';
const REF = {"blob":"120000228000000024000000072E00003039201B055D4A806140000000002625A068400000000000000C7321031D68BC1A142E6766B2BDFB006CCFE135EF2E0E2E94ABB5CF5C9AB6104776FBAE74463044022072A1BD997EF9C0C9911322F04975CD1535A56E79FF4C46C35BE3490C45676C9F02203393905703014C07422492EB6779758FEADCA44DBA5164802FD5D342F59322F88114AFF3C2E33458B30714CA16FFEE19952DD35C17C88314F667B0CA50CC7709A220B0561B85E53A48461FA8","hash":"C17512452C7260F61DB25244A783D3741DB87ACE9A4D02EFBD5B91600C076262"};

test('the XRP account is the one Ledger and Trust Wallet show for the seed', () => {
  assert.equal(xrpAddress(M), ME);
  assert.ok(isXrpAddress('rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'));
  for (const bad of ['rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYf', 'XV5sbjUmgPpvXv4ixFWZ5ptAYZ6PD28Sq49uo34VyjnmK5H', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'r']) assert.ok(!isXrpAddress(bad), bad);
});

test('a signed payment is byte for byte the reference', () => {
  const r = signXrpPayment(M, { to: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', tag: 12345, amount: 2_500_000n, fee: 12n, sequence: 7, lastLedger: 90_000_000 });
  assert.deepEqual(r, REF);
  assert.throws(() => signXrpPayment(M, { to: ME.slice(0, -1) + 'x', amount: 1n, fee: 12n, sequence: 1, lastLedger: 1 }), /Not an XRP address/);
  assert.throws(() => signXrpPayment(M, { to: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', tag: 2 ** 32, amount: 1n, fee: 12n, sequence: 1, lastLedger: 1 }), /destination tag/);
});

test('balance keeps the reserve; a send through a stand-in rippled', async (t) => {
  const calls = [];
  const server = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', () => {
      const { method, params } = JSON.parse(b); calls.push({ method, params: params[0] });
      const ok = (result) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ result: { status: 'success', ...result } })); };
      if (method === 'account_info' && params[0].account === ME) return ok({ account_data: { Balance: '25000000', Sequence: 9, OwnerCount: 0 } });
      if (method === 'account_info') return ok({ status: 'error', error: 'actNotFound' });
      if (method === 'server_state') return ok({ state: { validated_ledger: { reserve_base: 1000000, reserve_inc: 200000 } } });
      if (method === 'fee') return ok({ drops: { open_ledger_fee: '10' } });
      if (method === 'ledger_current') return ok({ ledger_current_index: 1000 });
      if (method === 'submit') return ok({ engine_result: 'tesSUCCESS', engine_result_message: 'ok' });
      ok({});
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => server.close());
  const c = new XrpClient(ME, [`http://127.0.0.1:${server.address().port}`]);
  assert.deepEqual(await c.getBalance(), { total: 25_000_000n, spendable: 24_000_000n });
  await assert.rejects(c.draft('rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', 500_000n), /at least 1 XRP/, 'a new account needs the reserve');
  const d = await c.draft('rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', 'max', '77');
  assert.deepEqual([d.amount, d.fee, d.sequence, d.lastLedger, d.tag], [24_000_000n - 12n, 12n, 9, 1020, 77]);
  const hash = await c.send(d, M);
  assert.match(hash, /^[0-9A-F]{64}$/);
  assert.equal(calls.filter((x) => x.method === 'submit').length, 1);
  await assert.rejects(c.draft('rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', 1n, 'abc'), /destination tag/);
});
