const test = require('node:test');
const assert = require('node:assert');
const { WalletService } = require('../dist/main/service');

const buyUrl = (...a) => WalletService.prototype.buyUrl.call({}, ...a);

test('buying opens LocalCoinSwap with the referral code and nothing about the wallet', () => {
  for (const a of ['BTC', 'XMR', 'USDT', 'FIRO']) assert.equal(buyUrl(a), 'https://localcoinswap.com/?rc=FE969A35');
  assert.throws(() => buyUrl('SSCRT'), /can't be bought/);
});
