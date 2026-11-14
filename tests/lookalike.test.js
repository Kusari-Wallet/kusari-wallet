const test = require('node:test');
const assert = require('node:assert');
const { lookalikeOf, rememberRecipient } = require('../dist/main/lookalike');

test('address poisoning: a look-alike of a used address is caught, the real one and strangers are not', () => {
  const real = 'TXYZa1b2c3d4e5f6g7h8i9j0kLmNoPqR8Kd2';
  const fake = 'TXYZa1zzzzzzzzzzzzzzzzzzzzzzzzzz8Kd2';
  assert.strictEqual(lookalikeOf(fake, [real]), real);
  assert.strictEqual(lookalikeOf(real, [real]), null, 'the same address');
  assert.strictEqual(lookalikeOf('TQ9w1b2c3d4e5f6g7h8i9j0kLmNoPqR8aaa', [real]), null, 'a different address');
  const eth = '0xAbCd1234567890aBcDeF1234567890AbCdEf9a8B';
  assert.strictEqual(lookalikeOf('0xabcd12ffffffffffffffffffffffffffffff9a8b', [eth]), eth.toLowerCase(), 'hex ignores case');
  assert.strictEqual(lookalikeOf(eth.toLowerCase(), [eth]), null);
  assert.strictEqual(lookalikeOf('short', ['short1']), null);
});

test('address poisoning: judged on the characters that identify an address, not the part all of a kind share', () => {
  const eth = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
  // 3 at the start and 6 at the end, which a fixed "first 6" rule missed.
  assert.strictEqual(lookalikeOf('0x7a2ffffffffffffffffffffffffffffff9f2488d', [eth]), eth);
  assert.strictEqual(lookalikeOf('0x7a250dfffffffffffffffffffffffffffffff88d', [eth]), eth, '6 and 3');
  assert.strictEqual(lookalikeOf('0x7a2fffffffffffffffffffffffffffffffff488d', [eth]), eth, '3 and 4');
  assert.strictEqual(lookalikeOf('0x7afffffffffffffffffffffffffffffffff2488d', [eth]), null, 'only 2 at the start: chance');
  assert.strictEqual(lookalikeOf('0x7a2fffffffffffffffffffffffffffffffffff8d', [eth]), null, '3 and 2: chance');
  // Taproot: "bc1p" is in every such address, so two shared characters after it are not a match.
  const btc = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297';
  const fake = (a, start, end) => a.slice(0, start) + 'q'.repeat(a.length - start - end) + a.slice(-end);
  assert.strictEqual(lookalikeOf(fake(btc, 6, 5), [btc]), null);
  assert.strictEqual(lookalikeOf(fake(btc, 7, 7), [btc]), btc);
  // Tron: "T" is in every address.
  const trx = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  assert.strictEqual(lookalikeOf('TR7NHzzzzzzzzzzzzzzzzzzzzzzzzzLj6t', [trx]), trx);
  assert.strictEqual(lookalikeOf('TR7zzzzzzzzzzzzzzzzzzzzzzzzzzzzj6t', [trx]), null);
});

test('recipients: newest first, no repeats, capped', () => {
  let list = [];
  for (let i = 0; i < 310; i++) list = rememberRecipient(list, `addr-${i}`);
  assert.strictEqual(list.length, 300);
  assert.strictEqual(list[0], 'addr-309');
  list = rememberRecipient(list, 'addr-200');
  assert.strictEqual(list[0], 'addr-200');
  assert.strictEqual(list.filter((x) => x === 'addr-200').length, 1);
  assert.deepStrictEqual(rememberRecipient('junk', 'x'), ['x']);
});

test('own servers: checked when saved, used alone, reached directly only on the own network', async (t) => {
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const { WalletService } = require('../dist/main/service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new WalletService(dir, undefined, { tronHost: 'http://x' });
  await s.init();
  await assert.rejects(s.updateSettings({ customServers: { ETH: 'ftp://node.example' } }), /^Error: ETH: /);
  await assert.rejects(s.updateSettings({ customServers: { SOL: 'http://public.example:8899' } }), /https/, 'plain http only for onion or local');
  await s.updateSettings({ customServers: { ETH: 'http://192.168.1.20:8545/', LTC: 'blockbook+https://ltc.example', ZEC: 'http://abcdefghijklmnop.onion:9067', DOGE: 'https://not-offered.example' } });
  assert.deepStrictEqual(s.settings.customServers, { ETH: 'http://192.168.1.20:8545', LTC: 'blockbook+https://ltc.example', ZEC: 'http://abcdefghijklmnop.onion:9067' }, 'trimmed, and only coins that take one');
  assert.deepStrictEqual(s.ownList('ETH', ['https://public.example']), ['http://192.168.1.20:8545']);
  assert.deepStrictEqual(s.ownList('SOL', ['https://public.example']), ['https://public.example']);
  s.torActive = true; s.torRoute = (name) => `route:${name}`;
  assert.strictEqual(s.ownAgent('ETH', 'eth'), undefined, 'own network: directly');
  assert.strictEqual(s.ownAgent('LTC', 'ltc'), 'route:ltc', 'elsewhere: through Tor');
  await s.updateSettings({ customServers: {} });
  assert.deepStrictEqual(s.settings.customServers, {});
});
