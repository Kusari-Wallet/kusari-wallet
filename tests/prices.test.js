const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { coingecko, kraken, cryptocompare, mexc, gate, binance, okx, bybit, coinbase, gateOne, xtOne, nonkycOne, PRICE_SOURCES } = require('../dist/main/prices');
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

test('exchanges: each one read for the coins it lists, and nothing made up', () => {
  const g = gate('x').parse([{ currency_pair: 'SOL_USDT', last: '150', change_percentage: '2.5' }, { currency_pair: 'SOL_BTC', last: '0.002', change_percentage: '9' }, { currency_pair: 'ZANO_USDT', last: '4', change_percentage: '-1' }]);
  assert.deepEqual(g, { SOL: { usd: 150, change: 2.5 }, ZANO: { usd: 4, change: -1 } });
  assert.deepEqual(binance('x').parse([{ symbol: 'DOGEUSDT', lastPrice: '0.08', priceChangePercent: '3' }, { symbol: 'DOGEBTC', lastPrice: '0.000001' }]), { DOGE: { usd: 0.08, change: 3 } });
  assert.deepEqual(okx('x').parse({ data: [{ instId: 'ZEC-USDT', last: '110', open24h: '100' }] }).ZEC.usd, 110);
  assert.ok(Math.abs(okx('x').parse({ data: [{ instId: 'ZEC-USDT', last: '110', open24h: '100' }] }).ZEC.change - 10) < 1e-9);
  assert.deepEqual(bybit('x').parse({ result: { list: [{ symbol: 'DASHUSDT', lastPrice: '30', price24hPcnt: '0.02' }] } }), { DASH: { usd: 30, change: 2 } });
  assert.deepEqual(coinbase('x').parse({ data: { rates: { SOL: '0.005', EUR: '0.9' } } }), { SOL: { usd: 200, change: null } });
  const m = mexc('x').parse([{ symbol: 'ARRRUSDT', lastPrice: '0.22', openPrice: '0.2' }, { symbol: 'ARRRUSDC', lastPrice: '9', openPrice: '9' }]);
  assert.equal(m.ARRR.usd, 0.22);
  assert.ok(Math.abs(m.ARRR.change - 10) < 1e-9);
  for (const source of [mexc('x'), gate('x'), binance('x'), okx('x'), bybit('x'), coinbase('x')]) {
    assert.throws(() => source.parse({}), source.name);
    assert.throws(() => source.parse(null), source.name);
  }
  assert.throws(() => gate('x').parse([{ currency_pair: 'SOL_USDT', last: '0' }]), 'a zero price');
  assert.throws(() => coinbase('x').parse({ data: { rates: { SOL: '0' } } }));
});

test('Gate and XT.com: one pair each, and a pair that stopped trading is no price', () => {
  assert.deepEqual(gateOne('ARRR', 'x').parse([{ currency_pair: 'ARRR_USDT', last: '0.14', change_percentage: '2.5' }]), { ARRR: { usd: 0.14, change: 2.5 } });
  assert.throws(() => gateOne('ARRR', 'x').parse({ label: 'INVALID_CURRENCY' }));
  const xt = (t) => ({ rc: 0, result: [{ s: 'zano_usdt', t, c: '3.7', cr: '0.0145' }] });
  const z = xtOne('ZANO', 'x').parse(xt(Date.now() - 60_000)).ZANO;
  assert.equal(z.usd, 3.7);
  assert.ok(Math.abs(z.change - 1.45) < 1e-9, 'a fraction, shown as percent');
  assert.throws(() => xtOne('ZANO', 'x').parse(xt(Date.now() - 2 * 24 * 3600_000)), /no trade/, 'last traded two days ago');
  assert.throws(() => xtOne('ZANO', 'x').parse({ rc: 1, result: null }));
});

test('NonKYC: one market, its change from yesterday, and a stopped or switched-off market is no price', () => {
  const m = (over) => ({ symbol: 'FIRO/USDT', primaryTicker: 'FIRO', isActive: true, lastPrice: '0.66', yesterdayPrice: '0.6', lastTradeAt: Date.now() - 60_000, ...over });
  const f = nonkycOne('FIRO', 'x').parse(m({})).FIRO;
  assert.equal(f.usd, 0.66);
  assert.ok(Math.abs(f.change - 10) < 1e-9);
  assert.throws(() => nonkycOne('FIRO', 'x').parse(m({ lastTradeAt: Date.now() - 2 * 24 * 3600_000 })), /no trade/);
  assert.throws(() => nonkycOne('FIRO', 'x').parse(m({ isActive: false })));
  assert.throws(() => nonkycOne('FIRO', 'x').parse(m({ primaryTicker: 'ZANO' })), 'another coin');
});

test('every source is an https address, and the bulk market lists that timed out over Tor are gone', () => {
  assert.equal(PRICE_SOURCES.length, 10);
  for (const s of PRICE_SOURCES) assert.match(s.url, /^https:\/\//);
  assert.ok(!PRICE_SOURCES.some((s) => /\/\/[^/]*(binance|bybit)|ticker\/24hr$|spot\/tickers$/.test(s.url)), 'no whole-market lists');
  assert.ok(PRICE_SOURCES.every((s) => !/gateio|xt\.com/.test(s.url) || /currency_pair=|symbol=/.test(s.url)), 'Gate and XT.com one pair at a time');
});

test('CoinGecko alone, and the second tier alone, each price every coin (answers recorded 2026-11-12 and 13)', () => {
  const { PRICE_TIERS } = require('../dist/main/prices');
  const { DECIMALS } = require('../dist/main/config');
  const rec = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'price-answers.json'), 'utf8'));
  const cg = PRICE_TIERS[0][0].parse(rec.coingecko);
  assert.deepEqual(Object.keys(DECIMALS).filter((a) => !cg[a]), [], 'nothing left for the slower tiers');
  let v = {};
  // Recorded XT.com and NonKYC answers count as stale a day later, as it should: the other sources still cover ZANO.
  PRICE_TIERS[1].forEach((s, i) => { try { v = { ...s.parse(rec.tier2[i]), ...v }; } catch (e) { if (s.name !== 'XT.com' && s.name !== 'NonKYC') throw e; } });
  assert.deepEqual(Object.keys(DECIMALS).filter((a) => !v[a]), [], 'a throttled CoinGecko costs no coin its price');
  assert.ok(Math.abs(v.ZANO.change) < 100 && v.ZANO.usd > 0);
});

test('the last prices are kept on disk and shown at once after a restart, then refreshed', async (t) => {
  let calls = 0;
  const btc = { name: 'T', url: 'http://unused', parse: () => { calls++; throw new Error('down'); } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'prices.json'), JSON.stringify({ at: Date.now() - 3600_000, value: { BTC: { usd: 70000, change: 1 }, EVIL: { usd: 1 } } }));
  const s = new WalletService(dir, undefined, { priceSources: [btc] });
  const p = await s.prices();
  assert.equal(p.BTC.usd, 70000, 'shown straight away');
  assert.equal(p.EVIL, undefined, 'only known coins are read back');
  fs.writeFileSync(path.join(dir, 'prices.json'), JSON.stringify({ at: Date.now() - 25 * 3600_000, value: { BTC: { usd: 1, change: 0 } } }));
  const s2 = new WalletService(dir, undefined, { priceSources: [btc] });
  assert.equal(await s2.prices(), null, 'a day old is too old');
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

test('with the first source down, every other one fills gaps at once, and one that hangs holds up nothing else', async (tt) => {
  const seen = [];
  const server = http.createServer((q, r) => {
    seen.push(q.headers['user-agent']);
    r.setHeader('content-type', 'application/json');
    if (q.url === '/a') { r.statusCode = 403; return r.end('{}'); }
    if (q.url === '/b') return r.end(JSON.stringify(KR));
    if (q.url === '/g') return r.end(JSON.stringify([{ currency_pair: 'ZANO_USDT', last: '4', change_percentage: '1' }, { currency_pair: 'XMR_USDT', last: '777', change_percentage: '1' }]));
    if (q.url === '/n') return r.end(JSON.stringify([{ symbol: 'SOLUSDT', lastPrice: '150', priceChangePercent: '1' }]));
    r.statusCode = 451; r.end('{}');
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  tt.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const s = await make(tt, [coingecko(`${base}/a`), kraken(`${base}/b`), gate(`${base}/g`), binance(`${base}/n`), bybit(`${base}/blocked`)]);
  const p = await s.prices();
  assert.equal(p.ZANO.usd, 4);
  assert.equal(p.SOL.usd, 150);
  assert.equal(p.XMR.usd, 150, 'an earlier source wins');
  assert.equal(p.USDT.usd, 1);
  assert.ok(seen.every((ua) => ua === 'KusariWallet'), 'names a client, as some services require');
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
