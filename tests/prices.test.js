const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { coingecko, kraken, cryptocompare } = require('../dist/main/prices');
const { WalletService } = require('../dist/main/service');

const CG = { bitcoin: { usd: 70000, usd_24h_change: 1 }, ethereum: { usd: 3000, usd_24h_change: 2 }, tron: { usd: 0.3, usd_24h_change: 3 }, tether: { usd: 1, usd_24h_change: 0 }, monero: { usd: 150, usd_24h_change: -1 } };
const t = (c, o) => ({ c: [String(c), '1'], o: String(o) });
const KR = { error: [], result: { XXBTZUSD: t(70000, 69000), XETHZUSD: t(3000, 3000), TRXUSD: t(0.3, 0.3), USDTZUSD: t(1, 1), XXMRZUSD: t(150, 100) } };
const u = (p, c) => ({ USD: { PRICE: p, CHANGEPCT24HOUR: c } });
const CC = { RAW: { BTC: u(70000, 1), ETH: u(3000, 1), TRX: u(0.3, 1), USDT: u(1, 0), XMR: u(150, 1) } };

test('each source gives the same shape, both USDT included', () => {
  for (const [source, json] of [[coingecko('x'), CG], [kraken('x'), KR], [cryptocompare('x'), CC]]) {
    const p = source.parse(json);
    assert.equal(p.XMR.usd, 150, source.name);
    assert.equal(p.BTC.usd, 70000);
    assert.equal(p.USDT.usd, 1);
    assert.equal(p.USDTE.usd, 1);
  }
  assert.equal(kraken('x').parse(KR).XMR.change, 50, 'change from the open');
});

test('broken answers are refused, not shown', () => {
  assert.throws(() => coingecko('x').parse({}));
  assert.throws(() => kraken('x').parse({ error: ['EService:Unavailable'] }));
  assert.throws(() => cryptocompare('x').parse({ Response: 'Error' }));
  assert.throws(() => coingecko('x').parse({ ...CG, monero: { usd: 0 } }));
  assert.throws(() => coingecko('x').parse({ ...CG, tether: { usd: 40 } }), 'a dollar token at $40');
});

async function make(tt, sources) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  tt.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new WalletService(dir, undefined, { priceSources: sources });
}

test('falls through when the first source is limited, then remembers', async (tt) => {
  const hits = { a: 0, b: 0 };
  const server = http.createServer((q, r) => {
    r.setHeader('content-type', 'application/json');
    if (q.url === '/a') { hits.a++; r.statusCode = 429; return r.end('{}'); }
    hits.b++; r.end(JSON.stringify(KR));
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  tt.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const s = await make(tt, [coingecko(`${base}/a`), kraken(`${base}/b`)]);
  assert.equal((await s.prices()).XMR.usd, 150);
  assert.deepEqual(hits, { a: 1, b: 1 });
  await s.prices();
  assert.deepEqual(hits, { a: 1, b: 1 }, 'cached');
});

test('coins a source does not list come from the next one, without replacing what it had', async (tt) => {
  const server = http.createServer((q, r) => {
    r.setHeader('content-type', 'application/json');
    if (q.url === '/a') { r.statusCode = 429; return r.end('{}'); }
    if (q.url === '/b') return r.end(JSON.stringify(KR));
    r.end(JSON.stringify({ RAW: { ...CC.RAW, XMR: u(999, 1), SOL: u(150, 2), DOGE: u(0.08, 3) } }));
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  tt.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const s = await make(tt, [coingecko(`${base}/a`), kraken(`${base}/b`), cryptocompare(`${base}/c`)]);
  const p = await s.prices();
  assert.equal(p.SOL.usd, 150);
  assert.equal(p.DOGE.usd, 0.08);
  assert.equal(p.XMR.usd, 150, 'the earlier source wins');
});

test('when everything fails: no made-up price, and it stops asking for a while', async (tt) => {
  let count = 0;
  const server = http.createServer((q, r) => { count++; r.statusCode = 429; r.end('{}'); });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  tt.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const s = await make(tt, [coingecko(`${base}/a`), kraken(`${base}/b`)]);
  assert.equal(await s.prices(), null);
  assert.equal(count, 2);
  assert.equal(await s.prices(), null);
  assert.equal(count, 2, 'backs off');
});

test('many callers at once make one request; the setting still turns prices off', async (tt) => {
  let count = 0;
  const server = http.createServer((q, r) => { count++; setTimeout(() => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(CG)); }, 50); });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  tt.after(() => { server.close(); server.closeAllConnections(); });
  const s = await make(tt, [coingecko(`http://127.0.0.1:${server.address().port}/a`)]);
  await Promise.all([s.prices(), s.prices(), s.prices()]);
  assert.equal(count, 1);
  s.settings.showPrices = false;
  assert.equal(await s.prices(), null);
});
