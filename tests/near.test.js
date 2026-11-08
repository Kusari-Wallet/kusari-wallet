const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { nearAccount, isNearAccount, signNearTransfer, NearClient, nearPublicKey } = require('../dist/main/near');

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// From near-seed-phrase (m/44'/397'/0') and near-api-js 5 (createTransaction + SignedTransaction.encode) for the same transfer.
const ME = '5510e2b44cae6eb807e3e0e45d579dda058c274abcba15e5cb84636f5d1ee412';
const BLOCK = 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx';
const REF_TX = 'QAAAADU1MTBlMmI0NGNhZTZlYjgwN2UzZTBlNDVkNTc5ZGRhMDU4YzI3NGFiY2JhMTVlNWNiODQ2MzZmNWQxZWU0MTIAVRDitEyubrgH4+DkXVed2gWMJ0q8uhXly4Rjb10e5BIqAAAAAAAAAAoAAABhbGljZS5uZWFyBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcBAAAAA3nf4j1EpjYPbgUBAAAAAAAA8hQ7Hjv8+Hu4h5wNVK5cjrwDkzO3aIiRZZ2YK4Xe9ONWkMIsGZexcZdElX/fU+Em3uae0I70LzdhTLdDROVfAw==';
const REF_HASH = 'BHpPvDQUeHYJBeXpR1HpgTJSRjuCPfZ8xKoKMBcQSrRJ';

test('the NEAR account is the one MyNearWallet shows for the seed', () => {
  assert.equal(nearAccount(M), ME);
});

test('a signed transfer is byte for byte what near-api-js makes', () => {
  const r = signNearTransfer(M, { to: 'alice.near', amount: 1234567890123456789012345n, fee: 0n, nonce: 42n, blockHash: BLOCK });
  assert.equal(r.base64, REF_TX);
  assert.equal(r.hash, REF_HASH);
});

test('account names', () => {
  for (const ok of [ME, 'alice.near', 'a-b_c.tg', '0x' + 'ab'.repeat(20)]) assert.ok(isNearAccount(ok), ok);
  for (const bad of ['alice', 'Alice.near', 'a..near', ME.slice(1), '.near', 'x'.repeat(70) + '.near']) assert.ok(!isNearAccount(bad), bad);
});

function rpcServer(answer) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      calls.push(json);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer(json, req.url)));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

test('the balance leaves out what storage keeps; a never-funded account reads zero', async () => {
  const { server, url } = await rpcServer((j) => ({ jsonrpc: '2.0', id: j.id, result: { amount: '2000000000000000000000000', storage_usage: 182 } }));
  try {
    const b = await new NearClient(nearPublicKey(M), [url], url).getBalance();
    assert.equal(b.total, 2n * 10n ** 24n);
    assert.equal(b.spendable, 2n * 10n ** 24n - 182n * 10n ** 19n);
  } finally { server.close(); }
  const empty = await rpcServer((j) => ({ jsonrpc: '2.0', id: j.id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } }));
  try {
    assert.deepEqual(await new NearClient(nearPublicKey(M), [empty.url], empty.url).getBalance(), { total: 0n, spendable: 0n });
  } finally { empty.server.close(); }
});

test('a send uses the next nonce, refuses a removed key, and never more than is spendable', async () => {
  let keyGone = false;
  const { server, url } = await rpcServer((j) => {
    const ok = (result) => ({ jsonrpc: '2.0', id: j.id, result });
    if (j.method === 'gas_price') return ok({ gas_price: '100000000' });
    if (j.params?.request_type === 'view_account') return ok({ amount: '1000000000000000000000000', storage_usage: 100 });
    if (j.params?.request_type === 'view_access_key') return keyGone ? ok({ error: 'access key does not exist', block_hash: BLOCK }) : ok({ nonce: 7, block_hash: BLOCK, permission: 'FullAccess' });
    return { jsonrpc: '2.0', id: j.id, error: { message: 'unknown' } };
  });
  try {
    const c = new NearClient(nearPublicKey(M), [url], url);
    const d = await c.draft('alice.near', 'max');
    assert.equal(d.nonce, 8n);
    assert.equal(d.blockHash, BLOCK);
    assert.equal(d.amount + d.fee, 10n ** 24n - 100n * 10n ** 19n);
    await assert.rejects(c.draft('alice.near', 10n ** 24n), /Not enough NEAR/);
    await assert.rejects(c.draft(ME, 1n), /own address/);
    await assert.rejects(c.draft('bob', 1n), /Not a NEAR account/);
    keyGone = true;
    await assert.rejects(c.draft('alice.near', 1n), /no longer on the NEAR account/);
  } finally { server.close(); }
});
