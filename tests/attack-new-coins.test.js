// Attacks on what 0.68 added: lying servers and look-alike tricks, each checked against the fix.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

function serve(t, handle) {
  const server = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', () => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(handle(q.url, b ? JSON.parse(b) : null))); });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => { t.after(() => server.close()); res(`http://127.0.0.1:${server.address().port}`); }));
}

test('TON: a token that only calls itself USDT doesn\'t show in the USDT history; odd values don\'t break it', async (t) => {
  const { TonClient, tonPublicKey, tonAddress, TON_USDT_MASTER } = require('../dist/main/ton');
  const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const me = tonAddress(M);
  const fake = 'EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA';
  const base = await serve(t, (url) => {
    if (url.startsWith('/api/v3/jetton/transfers')) return { jetton_transfers: [
      { amount: '5000000', source: fake, destination: me, jetton_master: fake, transaction_hash: 'x1', transaction_now: 1 },
      { amount: '7000000', source: fake, destination: me, jetton_master: TON_USDT_MASTER, transaction_hash: 'x2', transaction_now: 1 },
    ] };
    if (url.startsWith('/api/v3/transactions')) return { transactions: [{ hash: 'h', now: 1, in_msg: { source: fake, value: 'NaN' }, out_msgs: [] }] };
    return {};
  });
  const c = new TonClient(tonPublicKey(M), [base]);
  assert.deepEqual((await c.getHistory('USDTT')).map((x) => x.amount), ['7']);
  assert.deepEqual(await c.getHistory('GRAM'), []);
});

test('look-alike addresses on TON are judged past their fixed start', () => {
  const { lookalikeOf } = require('../dist/main/lookalike');
  const ton = 'UQCxCUrVthSyT-BJntgJwcyQ0i_2yBg9mBby0ok0uhXlZDhB';
  // Same three after "UQ" and the same four at the end: a poisoned copy.
  assert.equal(lookalikeOf('UQCxCzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzlZDhB', [ton]), ton);
  // Only "UQ" and a few at the end in common: an ordinary other address.
  assert.equal(lookalikeOf('UQAbcdefghijklmnopqrstuvwxyz0123456789ABCDEFZDhB', [ton]), null);
});

test('explorer links take each chain\'s ID format and nothing else', () => {
  const { WalletService } = require('../dist/main/service');
  const { DEFAULT_SETTINGS } = require('../dist/main/config');
  const ctx = { settings: { ...DEFAULT_SETTINGS } };
  const url = (a, h) => WalletService.prototype.explorerUrl.call(ctx, a, h);
  assert.equal(url('SOL', '5'.repeat(88)), `https://solscan.io/tx/${'5'.repeat(88)}`);
  for (const [a, h] of [['SOL', 'x/../../evil'], ['SOL', `${'5'.repeat(80)}?x=1`], ['GRAM', 'not-a-hash'], ['GRAM', 'a@evil.com/'.padEnd(44, 'a')], ['BTC', `${'ab'.repeat(32)}#`]]) {
    assert.throws(() => url(a, h), /Invalid transaction hash/, `${a} ${h}`);
  }
});

test('a mixer\'s typed receiving address can\'t be one of this wallet\'s own', async () => {
  const { WalletService } = require('../dist/main/service');
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const s = new WalletService(fs.mkdtempSync(path.join(os.tmpdir(), 'own-')), undefined, { tronHost: 'http://x' });
  const mine = '0x1111111111111111111111111111111111111111';
  s.addresses = async () => ({ ETH: mine, BNB: '0x2222222222222222222222222222222222222222', SOL: 'So1ana' });
  s.ethExtra.set(4, { address: '0x3333333333333333333333333333333333333333' });
  for (const a of [mine, mine.toUpperCase().replace('0X', '0x'), '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333', 'So1ana']) {
    await assert.rejects(s.foreign(a), /belongs to this wallet/, a);
  }
  assert.equal(await s.foreign('0x4444444444444444444444444444444444444444'), '0x4444444444444444444444444444444444444444');
});
