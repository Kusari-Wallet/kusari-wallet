const test = require('node:test');
const assert = require('node:assert');
const { WalletService } = require('../dist/main/service');

const buyUrl = (...a) => WalletService.prototype.buyUrl.call({}, ...a);

test('buying opens LocalCoinSwap with the referral code and nothing about the wallet', () => {
  for (const a of ['BTC', 'XMR', 'USDT', 'FIRO']) assert.equal(buyUrl(a), 'https://localcoinswap.com/?rc=FE969A35');
});

test('the Android app is allowed to open the buy page (it refuses links outside its list, silently)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { BUY_PAGE } = require('../dist/main/config');
  const java = fs.readFileSync(path.join(__dirname, '../android/java/dev/edge/vaultwallet/MainActivity.java'), 'utf8');
  const list = [...java.matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(list.some((prefix) => BUY_PAGE.startsWith(prefix)), `${BUY_PAGE} is not in the Android link list`);
});

test('the Android app is allowed to open every coin\'s explorer page', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { DECIMALS, DEFAULT_SETTINGS } = require('../dist/main/config');
  const java = fs.readFileSync(path.join(__dirname, '../android/java/dev/edge/vaultwallet/MainActivity.java'), 'utf8');
  const list = [...java.matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => m[1]);
  const self = { settings: { ...DEFAULT_SETTINGS } };
  const missing = [];
  for (const asset of Object.keys(DECIMALS)) {
    for (const hash of ['ab'.repeat(32), '0x' + 'ab'.repeat(32)]) {
      let url;
      try { url = WalletService.prototype.explorerUrl.call(self, asset, hash); } catch { continue; }
      if (!list.some((p) => url.startsWith(p))) missing.push(`${asset}: ${url}`);
    }
  }
  assert.deepEqual([...new Set(missing.map((m) => m.split(': ')[1].replace(/[0-9a-fx]{64,66}$/, '')))], []);
});
