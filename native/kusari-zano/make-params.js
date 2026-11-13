#!/usr/bin/env node
'use strict';
// Writes params.json for Kusari on Zano's code: a fresh network id, keys nobody holds for the parts Zano runs with
// its own keys, and the burn address the genesis block pays. Run once before launch: a new params.json is a new chain.
//   node native/kusari-zano/make-params.js [--force]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { burnPoint, encodeAddress, leadingChar } = require('./lib');

const out = path.join(__dirname, 'params.json');
if (fs.existsSync(out) && !process.argv.includes('--force')) {
  console.error('params.json exists. A new one is a new chain; pass --force if that is what you want.');
  process.exit(1);
}

// Single-byte prefixes, so the first character never depends on the keys.
const prefixes = { address: 110, integrated: 111, integratedV2: 112, auditable: 114, auditableIntegrated: 115, gateway: 120, integratedGateway: 121 };
for (const [k, p] of Object.entries(prefixes)) if (!leadingChar(p)) throw new Error(`${k}: ${p} has no fixed first character`);

const launch = Math.floor(Date.now() / 1000);
const hex = (b) => Buffer.from(b).toString('hex');
const params = {
  zano: { tag: 'v2.2.0.490', commit: '2309f82301bb2f6d72471c8ddfc7b2053ef68193' },
  // Monero's PoW, at the commit Monero v0.18.5.4 pins.
  randomx: { repo: 'https://github.com/tevador/RandomX', commit: '12f2c2ffe2108d6cf54c391fee33c8bc3646cdab' },
  name: 'Kusari',
  ticker: 'KSR',
  prefixes,
  leading: Object.fromEntries(Object.entries(prefixes).map(([k, p]) => [k, leadingChar(p)])),
  ports: { p2p: 21080, rpc: 21081, stratum: 21082 },
  testnetPorts: { p2p: 31080, rpc: 31081, stratum: 31082 },
  networkId: crypto.randomBytes(16).toString('hex'),
  testnetNetworkId: crypto.randomBytes(16).toString('hex'),
  launchTime: launch,
  // Monero's emission for 1-minute blocks: (supply - generated) >> 20 a block, never less than the tail. The main
  // emission runs about 8.1 years (18.13 million KSR), then 0.3 KSR a block forever. 12 decimals. No dev fund.
  emission: { moneySupply: '18446744073709551615', speedFactor: 20, tailReward: '300000000000' },
  // Proof of work alone until this height (about 90 days at 1-minute blocks), with a 1-minute target. From here on,
  // Zano's proof of stake joins: 2-minute proof-of-work and 2-minute proof-of-stake blocks, a minute apart on average.
  posStartHeight: 90 * 24 * 60,
  powTargetBeforePos: 60,
  // The genesis block must pay something: one KSR to an address whose keys were never kept.
  genesis: {
    burnAddress: encodeAddress(prefixes.address, burnPoint(), burnPoint()),
    amount: 1,
    proof: `Kusari genesis ${new Date(launch * 1000).toISOString().slice(0, 10)}`,
  },
  // Zano signs network notices and short aliases with its own keys. Until the project has its own, these are keys
  // nobody holds (their secrets were never kept), which turns both off. Mainnet and testnet use different keys.
  // Make real ones offline with make-key.js and put only the public keys here.
  maintainersPubKey: hex(burnPoint()),
  testnetMaintainersPubKey: hex(burnPoint()),
  aliasAuthorityPubKey: hex(burnPoint()),
  seedNodes: [],
  // Developer checkpoints, { height, hash } of main-chain blocks, compiled into each release. In the first months,
  // while little hashrate guards the chain, each release pins the chain up to a recent block.
  checkpoints: [],
};

fs.writeFileSync(out, JSON.stringify(params, null, 2) + '\n');
console.log('wrote', out, params.leading);
