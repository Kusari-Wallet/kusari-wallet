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
