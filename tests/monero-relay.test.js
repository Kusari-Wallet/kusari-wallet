const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { MoneroClient } = require('../dist/main/monero');

/** A Monero node that only takes sends: records them, answers as told. */
async function node(t, answer) {
  const got = [];
  const server = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', () => {
      r.setHeader('content-type', 'application/json');
      if (q.url === '/send_raw_transaction') { got.push(JSON.parse(b)); return r.end(JSON.stringify({ status: 'OK', untrusted: false, double_spend: false, fee_too_low: false, invalid_input: false, invalid_output: false, low_mixin: false, not_relayed: false, overspend: false, too_big: false, sanity_check_failed: false, reason: '', ...answer() })); }
      r.statusCode = 404; r.end('{}');
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { uri: `http://127.0.0.1:${server.address().port}`, got };
}

function client(t, nodes) {
  const relayed = [];
  const wallet = { relayTxs: async (txs) => { relayed.push(...txs); return txs.map((x) => x.getHash()); }, sync: async () => {}, save: async () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const c = new MoneroClient({ dir, type: 'mainnet', filePassword: 'x', seed: '', restoreHeight: 0, nodes, walletFactory: async () => wallet, sendElsewhereInTests: true });
  c.wallet = wallet;
  c.state = { ...c.state, connected: true, node: nodes[0] };
  return { c, relayed };
}
const draft = { txs: [{ getFullHex: () => 'ab'.repeat(40), getHash: () => 'cd'.repeat(32) }], fee: 1n, amount: 5n };

test('a Monero send goes out through another node than the one the wallet syncs from', async (t) => {
  const sync = await node(t, () => ({}));
  const other = await node(t, () => ({}));
  const { c, relayed } = client(t, [sync.uri, other.uri]);
  assert.deepEqual(await c.relay(draft), ['cd'.repeat(32)]);
  assert.equal(other.got.length, 1);
  assert.equal(other.got[0].tx_as_hex, 'ab'.repeat(40));
  assert.equal(sync.got.length, 0, 'the sync node is never handed it');
  assert.equal(relayed.length, 0);
});

test('a send the network refuses for what it is stops; a node that is down passes it on', async (t) => {
  const sync = await node(t, () => ({}));
  const spent = await node(t, () => ({ status: 'Failed', double_spend: true, reason: 'double spend' }));
  const a = client(t, [sync.uri, spent.uri]);
  await assert.rejects(a.c.relay(draft), /double spend/);
  assert.equal(a.relayed.length, 0, 'not tried again through the wallet\'s node');
  // Only a dead node besides the sync node: the wallet's own node relays it.
  const b = client(t, [sync.uri, 'http://127.0.0.1:1']);
  assert.deepEqual(await b.c.relay(draft), ['cd'.repeat(32)]);
  assert.equal(b.relayed.length, 1);
  // The only node there is (one's own): it relays, as before.
  const own = client(t, [sync.uri]);
  await own.c.relay(draft);
  assert.equal(own.relayed.length, 1);
});
