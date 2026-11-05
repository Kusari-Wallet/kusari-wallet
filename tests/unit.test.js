const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { parseAmount, formatAmount } = require('../dist/main/amount');
const { Vault } = require('../dist/main/vault');
const { estimateMainnetHeight, NETWORKS } = require('../dist/main/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vw-'));
const secrets = { tronMnemonic: 'a b', moneroSeed: 'c d', moneroFilePasswords: { mainnet: 'x', testnet: 'y' }, restoreHeights: { mainnet: 1, testnet: 2 } };
const fastKdf = { N: 2 ** 12, r: 8, p: 1 };

test('amount parsing is exact', () => {
  assert.equal(parseAmount('1.5', 6), 1500000n);
  assert.equal(parseAmount('0.000001', 6), 1n);
  assert.equal(parseAmount('1', 12), 1000000000000n);
  assert.equal(parseAmount('18446744.073709551615', 12), 18446744073709551615n);
  for (const bad of ['', '0', '0.0', '-1', '1e5', '1.', '.5', '1,000', 'abc', '0.0000001']) {
    assert.throws(() => parseAmount(bad, 6), undefined, bad);
  }
});

test('amount formatting round trips', () => {
  assert.equal(formatAmount(1500000n, 6), '1.5');
  assert.equal(formatAmount(0n, 6), '0');
  assert.equal(formatAmount(1n, 12), '0.000000000001');
  for (const s of ['1.5', '0.000001', '123456.789012']) assert.equal(formatAmount(parseAmount(s, 6), 6), s);
});

test('vault round trip, wrong password, tampering', async () => {
  const file = path.join(tmp(), 'vault.json');
  const v = new Vault(file, fastKdf);
  await v.save('correct horse battery', secrets);
  assert.deepEqual(await v.open('correct horse battery'), secrets);
  await assert.rejects(v.open('wrong password!!'), /비밀번호/);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('tronMnemonic'));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ct = Buffer.from(raw.ct, 'base64'); ct[0] ^= 1;
  fs.writeFileSync(file, JSON.stringify({ ...raw, ct: ct.toString('base64') }));
  await assert.rejects(v.open('correct horse battery'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, kdf: { ...raw.kdf, N: 2 ** 11 } }));
  await assert.rejects(v.open('correct horse battery'));
});

test('vault refuses short passwords and leaves no temp files', async () => {
  const dir = tmp();
  const v = new Vault(path.join(dir, 'vault.json'), fastKdf);
  await assert.rejects(v.save('short', secrets));
  await v.save('long enough password', secrets);
  assert.deepEqual(fs.readdirSync(dir), ['vault.json']);
});

test('default scrypt cost actually runs', async () => {
  const v = new Vault(path.join(tmp(), 'vault.json'));
  await v.save('correct horse battery', secrets);
  assert.deepEqual(await v.open('correct horse battery'), secrets);
});

test('mainnet height estimate is sane and network constants are fixed', () => {
  const h = estimateMainnetHeight(new Date('2026-11-04T00:00:00Z'));
  assert.ok(h > 3_500_000 && h < 3_900_000, String(h));
  assert.equal(NETWORKS.mainnet.tron.usdt, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
});

test('swap cost: gap between market value in and out', () => {
  const { swapCost } = require('../dist/main/service');
  assert.deepEqual(swapCost('2', '0.01', 1, 151), { usd: 2 - 1.51, percent: ((2 - 1.51) / 2) * 100, receiveUsd: 1.51 });
  assert.equal(swapCost('2', '0.01', undefined, 151), null, 'no invented number without prices');
  assert.equal(swapCost('2', '0.01', 1, 0), null);
  assert.ok(swapCost('1', '2', 1, 1).usd < 0, 'better than market stays negative, not hidden');
});
