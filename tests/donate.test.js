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
  ['BCH', 'qqu06gfx29r09pan9dx2dkaxux3jaya4rywcaa9dgy'],
  ['LTC', 'ltcmweb1qqvqnuy3wr2d54v7ffs5p02uxz5gc3ve7ve2fhq3gfmv0juj0c8e0cqjfwck5p5apv773hyfu4urv0rq8aajzeexws4sgt7q9f7m874l35sd0cca4'],
  ['FIRO', 'sm1zstz4eskrjtvunmrhqpvh9u0w78ksezzvn2nhzk5awwuksazsctw75l0gnjjwype53pyrfyspachywle7l87jmgu0gmgzmunqtld4l63pkrsceruyl69mdcz5xvve3sjcfsdsegncwelp'],
  ['ZANO', 'ZxDT9JBt5iqSMFk2TPv5c1fRh6vZ6cr7cDdL8KQjrBxYcoZCM8Y7vfYGBmVy4w2jccGNdZjxwcDP1Zeqg5HRnrUu2HLmGF2Zf'],
  ['ARRR', 'pirate1zt22p7aywfv7anwu3xr6qzet5advvpnawxay4pg7jrw0nnua76vx4jnrp3u7khusdxlqqd7a25h'],
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
  const { bech32, bech32m } = require('@scure/base');
  const { keccak_256 } = require('@noble/hashes/sha3.js');
  const ok = {
    XMR: (a) => m.MoneroUtils.isValidAddress(a, m.MoneroNetworkType.MAINNET),
    BTC: isBtcAddress, DOGE: isDogeAddress, TRX: isTronAddress,
    ETH: (a) => getAddress(a) === a, // checksummed
    BCH: (a) => require('../dist/main/bch').isBchAddress(a),
    // Bech32 checksums: MWEB (bech32), Spark (bech32m), Pirate (bech32), each decoded in full.
    LTC: (a) => require('../dist/main/mweb').isMwebAddress(a) && bech32.decode(a, 1023).prefix === 'ltcmweb',
    FIRO: (a) => require('../dist/main/spark').isSparkAddress(a) && bech32m.decode(a, 1023).prefix === 'sm',
    ARRR: (a) => require('../dist/main/arrr').isArrrAddress(a) && bech32.decode(a, 1023).prefix === 'pirate',
    // CryptoNote base58: the last 4 bytes are the Keccak-256 of the rest.
    ZANO: (a) => {
      const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; const sizes = [0, -1, 1, 2, -1, 3, 4, 5, -1, 6, 7, 8];
      const out = [];
      for (let i = 0; i < a.length; i += 11) {
        const blk = a.slice(i, i + 11); let n = 0n;
        for (const c of blk) n = n * 58n + BigInt(A.indexOf(c));
        const b = []; for (let j = 0; j < sizes[blk.length]; j++) { b.unshift(Number(n & 255n)); n >>= 8n; }
        out.push(...b);
      }
      const raw = Buffer.from(out);
      return require('../dist/main/zano').isZanoAddress(a) && Buffer.from(keccak_256(raw.subarray(0, -4)).slice(0, 4)).equals(raw.subarray(-4));
    },
  };
  for (const [asset, address] of found) assert.ok(await ok[asset](address), `${asset} address is valid`);
});

test.after(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 100); });
