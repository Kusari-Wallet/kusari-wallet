const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { BchClient, bchAccountXpub, encodeCashAddr, decodeCashAddr, isBchAddress, normalBchAddress, signBchDraft, typicalBchFee } = require('../dist/main/bch');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const xpub = bchAccountXpub(PHRASE);
// Checked against bitcore-lib-cash, which Bitcoin Cash wallets build on.
const FIRST = 'bitcoincash:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnq5tahq3q6';
const OTHER = 'bitcoincash:qr6m7j9njldwwzlg9v7v53unlr4jkmx6eylep8ekg2';
const ID = (c) => c.repeat(32);

test('CashAddr: encodes like the reference, refuses legacy and broken ones', () => {
  assert.equal(new BchClient(xpub, []).addressAt(0, 0), FIRST);
  assert.equal(encodeCashAddr(0, Buffer.from('F5BF48B397DAE70BE82B3CCA4793F8EB2B6CDAC9', 'hex')), OTHER);
  assert.equal(encodeCashAddr(1, Buffer.from('F5BF48B397DAE70BE82B3CCA4793F8EB2B6CDAC9', 'hex')), 'bitcoincash:pr6m7j9njldwwzlg9v7v53unlr4jkmx6eyguug74nh');
  assert.equal(normalBchAddress(OTHER.slice(12).toUpperCase()), OTHER, 'no prefix and upper case are the same address');
  assert.equal(decodeCashAddr(OTHER).type, 0);
  assert.equal(isBchAddress('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu'), false, 'an old-style address could be Bitcoin');
  assert.equal(isBchAddress(OTHER.slice(0, -1) + '3'), false);
  assert.equal(isBchAddress('bitcoincash:Qr6m7j9njldwwzlg9v7v53unlr4jkmx6eylep8ekg2'), false, 'mixed case');
  assert.equal(isBchAddress('bchtest:qr6m7j9njldwwzlg9v7v53unlr4jkmx6eylep8ekg2'), false);
});

test('signing: byte for byte what bitcore-lib-cash produces', () => {
  const c = new BchClient(xpub, []);
  const inputs = [
    { txid: ID('aa'), vout: 1, value: 150000n, address: c.addressAt(0, 0), chain: 0, index: 0 },
    { txid: ID('1b'), vout: 0, value: 70000n, address: c.addressAt(0, 1), chain: 0, index: 1 },
  ];
  const draft = { to: OTHER, amount: 100000n, fee: 1000n, change: 119000n, changeAddress: c.addressAt(1, 0), changeIndex: 0, inputs };
  const { hex, id } = signBchDraft(draft, PHRASE);
  // Made by bitcore-lib-cash from the same keys and coins.
  assert.equal(hex, '0200000002aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa010000006b483045022100e590648a04fbd0d033f1acac8779bccbc2e9167b1af4105c6e60d3c8351c1b8d022040c17959d06625eac8719cebe8b3be220ee62a68a9698181676d364f0483ad8d412102bbe7dbcdf8b2261530a867df7180b17a90b482f74f2736b8a30d3f756e42e217ffffffff1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b000000006b483045022100b89192d7c20c5576dd712cf376e85dfb71505b298cd8e84477b1f7097ae02d0202205696e5b1f450df415b47338f49a863877edb254b321c694a6e9b9f823f8d9af641210262f8bf1ab1d25111c569da0133c30f8b3fa411e2f8af2565d3f0111cb34ae7f6ffffffff02a0860100000000001976a914f5bf48b397dae70be82b3cca4793f8eb2b6cdac988acd8d00100000000001976a914cfdcdfa3e0483ddd3c7b6ab6ee13c5087c26d5f188ac00000000');
  assert.equal(id, 'b7422e10431435c48909f39c11baa69d18da80e81611e64e1dc8eb705380e234');
  assert.throws(() => signBchDraft({ ...draft, fee: 999n }, PHRASE), /add up/);
  assert.throws(() => signBchDraft({ ...draft, to: '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu' }, PHRASE), /not a BCH address/);
  assert.throws(() => signBchDraft({ ...draft, inputs: [{ ...inputs[0], address: OTHER }, inputs[1]] }, PHRASE), /does not match/);
});

function server(coins = {}, { tx } = {}) {
  const log = [];
  const posted = [];
  const srv = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => { b += d; });
    q.on('end', () => {
      log.push(q.url);
      r.setHeader('content-type', 'application/json');
      if (q.url === '/block/tip') return r.end(JSON.stringify({ height: 900010 }));
      if (q.url === '/tx/send') {
        const { rawTx } = JSON.parse(b);
        posted.push(rawTx);
        return r.end(JSON.stringify({ txid: tx ? tx(rawTx) : require('node:crypto').createHash('sha256').update(require('node:crypto').createHash('sha256').update(Buffer.from(rawTx, 'hex')).digest()).digest().reverse().toString('hex') }));
      }
      if (q.url.startsWith('/tx/')) return r.end(JSON.stringify({ blockTimeNormalized: '2026-11-01T00:00:00.000Z' }));
      const bare = q.url.match(/^\/address\/(\w+)\/txs/)?.[1];
      r.end(JSON.stringify(coins[bare] ?? []));
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, log, posted, url: `http://127.0.0.1:${srv.address().port}` })));
}
const close = (t, m) => t.after(() => { m.srv.close(); m.srv.closeAllConnections(); });

test('balance, history and a send, one address at a time', async (t) => {
  const bare = FIRST.slice(12);
  // Coins as Bitcore lists them: spent ones carry spentTxid, unconfirmed ones a negative height.
  const m = await server({ [bare]: [
    { mintTxid: ID('ab'), mintIndex: 0, mintHeight: 900000, spentTxid: '', spentHeight: -2, address: bare, value: 300000 },
    { mintTxid: ID('cd'), mintIndex: 1, mintHeight: -1, spentTxid: '', spentHeight: -2, address: bare, value: 50000 },
    { mintTxid: ID('ef'), mintIndex: 0, mintHeight: 899000, spentTxid: ID('ee'), spentHeight: 899500, address: bare, value: 20000 },
  ] });
  close(t, m);
  const c = new BchClient(xpub, [m.url]);
  assert.deepEqual(await c.getBalance(), { total: 350000n, spendable: 300000n });
  assert.equal(c.receiveAddress, c.addressAt(0, 1));
  assert.ok(m.log.every((u) => !/xpub|bitcoincash/.test(u)), 'no account key, and addresses without the prefix');
  const h = await c.getHistory();
  assert.deepEqual(h.map((x) => [x.hash, x.direction, x.amount, x.status]).sort(), [
    [ID('ab'), 'in', '0.003', 'confirmed'], [ID('cd'), 'in', '0.0005', 'pending'], [ID('ee'), 'out', '0.0002', 'confirmed'], [ID('ef'), 'in', '0.0002', 'confirmed'],
  ].sort());
  const d = await c.draft(OTHER, 100000n);
  assert.equal(d.inputs.length, 1, 'the unconfirmed coin waits');
  assert.equal(d.fee, typicalBchFee());
  const id = await c.send(d, PHRASE);
  assert.equal(m.posted.length, 1);
  assert.match(id, /^[0-9a-f]{64}$/);
});

test('refused: answers for another address, a different returned id', async (t) => {
  const bare = FIRST.slice(12);
  const m = await server({ [bare]: [{ mintTxid: ID('ab'), mintIndex: 0, mintHeight: 900000, spentTxid: '', address: OTHER.slice(12), value: 300000 }] });
  close(t, m);
  await assert.rejects(new BchClient(xpub, [m.url]).getBalance(), /unexpected/);
  const n = await server({ [bare]: [{ mintTxid: ID('ab'), mintIndex: 0, mintHeight: 900000, spentTxid: '', address: bare, value: 300000 }] }, { tx: () => ID('99') });
  close(t, n);
  const c = new BchClient(xpub, [n.url]);
  await assert.rejects(c.send(await c.draft(OTHER, 100000n), PHRASE), /different transaction/);
});
