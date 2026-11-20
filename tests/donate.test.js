// The donation addresses are fixed in the app. Each must be a valid address of its coin, and the list must be exactly
// this one: a changed address fails here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PINNED = [
  ['XMR', '46ZEpH2zBmjCu1cRXiN6DYbwZDvw5LUrRNKKeketbJNv7f8thMEbFABSoZVYT6nJ2CGQfPvAXcEficrwZXN35mdZLTBHVNL'],
  ['BTC', 'bc1p60xgyyjl38vqset09hetv7ll3wenhg8zgfn9rpexlkcu59fu5s0qj89fex'],
  ['ETH', '0x27A2BB4E97BB6F58998Ae7A0A921774aa645fE1d'],
  ['TRX', 'TQwoiwr5NuDWxkjRivoGh11tCPG6ZAiyHb'],
  ['DOGE', 'DEiSC35omanbohfcwzQzYpYJY5d3ugv9pe'],
];

test('donation addresses: exactly the pinned ones, each valid for its coin', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/app.ts'), 'utf8');
  const block = src.slice(src.indexOf('const DONATE'), src.indexOf('];', src.indexOf('const DONATE')));
  const found = [...block.matchAll(/asset: '(\w+)', address: '([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(found, PINNED);
  const { isBtcAddress } = require('../dist/main/btc');
  const { isDogeAddress } = require('../dist/main/doge');
  const { isTronAddress } = require('../dist/main/tron');
  const { getAddress } = require('ethers');
  const m = require('monero-ts');
  const ok = {
    XMR: (a) => m.MoneroUtils.isValidAddress(a, m.MoneroNetworkType.MAINNET),
    BTC: isBtcAddress, DOGE: isDogeAddress, TRX: isTronAddress,
    ETH: (a) => getAddress(a) === a, // checksummed
  };
  for (const [asset, address] of found) assert.ok(await ok[asset](address), `${asset} address is valid`);
});

test.after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 100); });
