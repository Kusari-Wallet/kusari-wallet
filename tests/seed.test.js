const test = require('node:test');
const assert = require('node:assert');
const { HDKey } = require('@scure/bip32');
const { setPassphrase, clearPassphrases, bip39Seed, passphraseOf } = require('../dist/main/seed');
const { deriveEthAccount } = require('../dist/main/eth');
const { deriveTronAccount } = require('../dist/main/tron');
const { btcAccountXpub } = require('../dist/main/btc');
const { adaAddress } = require('../dist/main/ada');
const { solAddress } = require('../dist/main/sol');

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('passphrase: the BIP39 vector, and every coin from the 12 words changes with it, together', (t) => {
  t.after(clearPassphrases);
  const plain = { eth: deriveEthAccount(M).address, trx: deriveTronAccount(M).address, btc: btcAccountXpub(M), ada: adaAddress(M), sol: solAddress(M) };
  setPassphrase(M, 'TREZOR');
  // BIP39's own test vector for these words with the passphrase "TREZOR".
  assert.strictEqual(Buffer.from(bip39Seed(M)).toString('hex'), 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04');
  assert.strictEqual(passphraseOf('  ABANDON abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about '), 'TREZOR', 'found whatever the spacing or case');
  const withPass = { eth: deriveEthAccount(M).address, trx: deriveTronAccount(M).address, btc: btcAccountXpub(M), ada: adaAddress(M), sol: solAddress(M) };
  for (const k of Object.keys(plain)) assert.notStrictEqual(withPass[k], plain[k], `${k} changes`);
  // ethers (Ethereum, Tron) and the BIP32 code used for Bitcoin agree on the seed.
  const ethFromSeed = HDKey.fromMasterSeed(bip39Seed(M)).derive("m/44'/60'/0'/0/0");
  const { computeAddress } = require('ethers');
  assert.strictEqual(computeAddress('0x' + Buffer.from(ethFromSeed.publicKey).toString('hex')), withPass.eth);
  // Locking forgets it: the plain wallet again.
  clearPassphrases();
  assert.strictEqual(deriveEthAccount(M).address, plain.eth);
  assert.strictEqual(btcAccountXpub(M), plain.btc);
  assert.strictEqual(adaAddress(M), plain.ada);
});

test('passphrase: a wallet made with one keeps it in the vault, and leaves Zcash and Pirate Chain off', async (t) => {
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const { WalletService } = require('../dist/main/service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  t.after(() => { clearPassphrases(); fs.rmSync(dir, { recursive: true, force: true }); });
  const s = new WalletService(dir, { N: 2 ** 10, r: 8, p: 1 }, { tronHost: 'http://x' });
  let zecStarted = false;
  const realZec = s.startZec.bind(s);
  s.startZec = async (secrets) => { zecStarted = true; return realZec(secrets); };
  s.startSession = async function (secrets) { require('../dist/main/seed').setPassphrase(secrets.tronMnemonic, secrets.passphrase); this.seen = secrets; };
  await s.init();
  await assert.rejects(s.restore('a long password', M, 'x', '', '   '), /only spaces/);
  await s.vault.save('a long password', { tronMnemonic: M, moneroSeed: 'm', moneroFilePasswords: { mainnet: 'a', testnet: 'b' }, restoreHeights: { mainnet: 0, testnet: 0 }, passphrase: 'TREZOR' });
  await s.unlock('a long password');
  assert.strictEqual(s.seen.passphrase, 'TREZOR');
  assert.strictEqual(passphraseOf(M), 'TREZOR');
  assert.deepStrictEqual(Object.keys(await s.revealSeeds('a long password')).sort(), ['moneroSeed', 'passphrase', 'tronMnemonic']);
  zecStarted = false;
  assert.strictEqual(await realZec(s.seen), undefined);
  assert.strictEqual(s.zec, null, 'Zcash stays off: its engine takes the words without a passphrase');
});
