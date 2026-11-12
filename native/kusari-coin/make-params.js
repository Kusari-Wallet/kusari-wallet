#!/usr/bin/env node
'use strict';
// Writes params.json for a new chain: fresh network ids and genesis transactions whose output keys nobody holds.
// Run it once before launch. Running it again makes a different, incompatible chain.
//   node native/kusari-coin/make-params.js [--force]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { burnPoint, genesisTx, leadingChar } = require('./lib');

const out = path.join(__dirname, 'params.json');
if (fs.existsSync(out) && !process.argv.includes('--force')) {
  console.error('params.json exists. A new one is a new chain; pass --force if that is what you want.');
  process.exit(1);
}

// Monero's genesis output amount, kept so the emission curve starts the same way.
const GENESIS_AMOUNT = 17592186044415n;

function net(prefixes, ports, nonce) {
  for (const p of Object.values(prefixes)) {
    if (!leadingChar(p)) throw new Error(`prefix ${p} does not give a fixed first character`);
  }
  return {
    prefixes,
    leading: Object.fromEntries(Object.entries(prefixes).map(([k, p]) => [k, leadingChar(p)])),
    ports,
    networkId: crypto.randomBytes(16).toString('hex'),
    genesisTx: genesisTx(GENESIS_AMOUNT, burnPoint(), burnPoint()),
    genesisNonce: nonce,
    seedNodes: [],
  };
}

const launch = Math.floor(Date.now() / 1000);
const params = {
  monero: { tag: 'v0.18.5.4', commit: '85f036ba7019cd36f08e8a38a27c37ea7b522618' },
  name: 'Kusari',
  ticker: 'KUS',
  dataDirName: 'kusari',
  binaryPrefix: 'kusari',
  messageSigningKey: 'KusariMessageSignature',
  // Version 1 for block 1 only, then Monero's current rules (v16: RandomX, CLSAG, Bulletproofs+, view tags, ring 16).
  hardForks: [
    { version: 1, height: 1, time: launch },
    { version: 16, height: 2, time: launch + 1 },
  ],
  mainnet: net({ address: 110, integrated: 111, subaddress: 116 }, { p2p: 21080, rpc: 21081, zmq: 21082 }, 10000),
  testnet: net({ address: 66, integrated: 67, subaddress: 72 }, { p2p: 31080, rpc: 31081, zmq: 31082 }, 10001),
  stagenet: net({ address: 84, integrated: 85, subaddress: 90 }, { p2p: 41080, rpc: 41081, zmq: 41082 }, 10002),
};

fs.writeFileSync(out, JSON.stringify(params, null, 2) + '\n');
console.log('wrote', out);
for (const n of ['mainnet', 'testnet', 'stagenet']) {
  console.log(n, params[n].leading, params[n].ports);
}
