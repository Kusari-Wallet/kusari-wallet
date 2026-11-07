const test = require('node:test');
const assert = require('node:assert');
const { WalletService } = require('../dist/main/service');

const buyUrl = (...a) => WalletService.prototype.buyUrl.call({}, ...a);

test('buy: ChangeNOW\'s page, the partner link, the right coin and nothing about the wallet', () => {
  const u = new URL(buyUrl('USDTS'));
  assert.equal(u.origin + u.pathname, 'https://changenow.io/embeds/exchange-widget/v2/widget.html');
  const p = Object.fromEntries(u.searchParams);
  assert.equal(p.link_id, '9183599f3b8ee2');
  assert.deepEqual([p.to, p.toFiat, p.from, p.fromFiat], ['usdtsol', 'usdtsol', 'usd', 'usd']);
  assert.ok(u.searchParams.has('isFiat'));
  assert.ok(![...u.searchParams.keys()].some((k) => /address|email|user/i.test(k)), 'no address or identity in the link');
  const tickers = { BTC: 'btc', XMR: 'xmr', ETH: 'eth', ZEC: 'zec', SOL: 'sol', TRX: 'trx', USDTE: 'usdterc20', USDT: 'usdttrc20', USDTS: 'usdtsol', DOGE: 'doge', DASH: 'dash', FIRO: 'firo', ZANO: 'zano', ARRR: 'arrr' };
  for (const [asset, ticker] of Object.entries(tickers)) assert.equal(new URL(buyUrl(asset)).searchParams.get('to'), ticker, asset);
  assert.throws(() => buyUrl('NOPE'), /can't be bought/);
  assert.throws(() => buyUrl('BTC', 'us&x=1'), /currency/);
});
