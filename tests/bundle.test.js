const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const dist = path.join(__dirname, '..', 'dist', 'main');

test('the bundles read monero-ts\'s helpers as globals (a strict bundle has no `this` there)', () => {
  for (const f of ['app.js', 'monero-worker.js']) {
    const text = fs.readFileSync(path.join(dist, f), 'utf8');
    assert.ok(text.startsWith('"use strict"'), `${f} is strict`);
    assert.doesNotMatch(text, /=this\.(HttpClient|LibraryUtils|GenUtils)\b/, f);
    assert.equal((text.match(/=globalThis\.HttpClient\b/g) ?? []).length, 2, f);
  }
});

test('a wallet in the bundled Monero worker reaches its node (0.58.1 failed with "reading HttpClient")', { timeout: 120_000 }, async (t) => {
  const moneroTs = require('monero-ts');
  moneroTs.LibraryUtils.setWorkerDistPath(path.join(dist, 'monero-worker.js'));
  let hits = 0;
  const srv = http.createServer((q, r) => { hits++; q.resume(); q.on('end', () => { r.setHeader('content-type', 'application/json'); r.end('{"id":"0","jsonrpc":"2.0","result":{"status":"OK","height":100,"count":100}}'); }); });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  t.after(() => { srv.close(); srv.closeAllConnections(); });
  const w = await moneroTs.createWalletFull({ networkType: moneroTs.MoneroNetworkType.MAINNET, password: 'pw', server: { uri: `http://127.0.0.1:${srv.address().port}` }, proxyToWorker: true });
  const err = await Promise.race([w.sync().then(() => null, (e) => e), new Promise((r) => setTimeout(() => r(null), 5000))]);
  assert.doesNotMatch(String(err?.message ?? ''), /HttpClient|undefined/);
  assert.ok(hits > 0, 'its requests got to the node');
  await Promise.race([w.close().catch(() => undefined), new Promise((r) => setTimeout(r, 3000))]);
  await moneroTs.LibraryUtils.terminateWorker().catch(() => undefined);
});
