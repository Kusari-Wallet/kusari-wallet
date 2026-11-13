#!/usr/bin/env node
'use strict';
// Makes a key pair for Kusari's network notices or short aliases, on this machine and nowhere else. Run it offline.
//   node native/kusari-zano/make-key.js <file for the secret key, outside this repository>
// It writes the secret key to that file (owner-only) and prints the public key, which goes into params.json as
// maintainersPubKey, testnetMaintainersPubKey or aliasAuthorityPubKey. Use a different key for each. The secret
// key never belongs in the repository, a session or a chat: keep it offline, with a backup.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ed25519 } = require('@noble/curves/ed25519.js');

const out = process.argv[2];
if (!out) {
  console.error('usage: make-key.js <file for the secret key, outside this repository>');
  process.exit(2);
}
const target = path.resolve(out);
const repo = path.resolve(__dirname, '..', '..');
if (target === repo || target.startsWith(repo + path.sep)) {
  console.error(`refusing to write a secret key inside the repository (${repo})`);
  process.exit(1);
}
if (fs.existsSync(target)) {
  console.error(`${target} exists; not overwriting a key`);
  process.exit(1);
}

// A CryptoNote key: the secret is a scalar mod L, the public key is secret * G.
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const le = (b) => BigInt('0x' + (Buffer.from(b).reverse().toString('hex') || '0'));
let s = 0n;
while (s === 0n) s = le(crypto.randomBytes(64)) % L;
const secret = Buffer.from(s.toString(16).padStart(64, '0'), 'hex').reverse();
const pub = Buffer.from(ed25519.Point.BASE.multiply(s).toBytes());

fs.writeFileSync(target, secret.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
console.log(`secret key written to ${target} (keep it offline, back it up)`);
console.log(`public key: ${pub.toString('hex')}`);
