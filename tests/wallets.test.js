const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { WalletService } = require('../dist/main/service');

const SECRETS = (t) => ({ tronMnemonic: t, moneroSeed: t, moneroFilePasswords: {}, restoreHeights: {} });
const PW1 = 'first password', PW2 = 'second password';

async function make(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new WalletService(dir, { N: 2 ** 10, r: 8, p: 1 });
  s.startSession = async (secrets) => { s.tron = {}; s.btc = {}; s.eth = {}; s.dash = {}; s.firo = {}; s.monero = { close: async () => {} }; s.seen = secrets.tronMnemonic; };
  await s.init();
  return { s, dir };
}
const makeOldWallet = async (s, pw, seed) => { await s.vault.save(pw, SECRETS(seed)); };

test('a wallet from before this feature stays as the first wallet, in the same files', async (t) => {
  const { s, dir } = await make(t);
  await makeOldWallet(s, PW1, 'old');
  assert.ok(fs.existsSync(path.join(dir, 'vault.json')));
  const again = new WalletService(dir, { N: 2 ** 10, r: 8, p: 1 });
  await again.init();
  assert.equal((await again.status()).hasWallet, true);
  const list = await again.walletsList();
  assert.deepEqual(list.list, [{ id: 'main', name: 'My wallet' }]);
  assert.equal((await again.vault.open(PW1)).tronMnemonic, 'old');
});

test('rename: saved, limits checked, unknown wallet refused', async (t) => {
  const { s, dir } = await make(t);
  await s.walletRename('main', '  Savings ');
  assert.equal((await s.walletsList()).list[0].name, 'Savings');
  await assert.rejects(s.walletRename('main', '   '), /1 to 20 characters/);
  await assert.rejects(s.walletRename('main', 'k'.repeat(21)), /1 to 20 characters/);
  await assert.rejects(s.walletRename('nope', 'Name'), /No such wallet/);
  const again = new WalletService(dir);
  await again.init();
  assert.equal((await again.walletsList()).list[0].name, 'Savings');
});

test('adding: separate seed, password and records; giving up leaves nothing', async (t) => {
  const { s, dir } = await make(t);
  await makeOldWallet(s, PW1, 'one');
  await s.walletBeginAdd('Second');
  assert.equal((await s.status()).hasWallet, false, 'opens the new wallet flow');
  assert.equal((await s.walletsList()).list.length, 1, 'not listed until it exists');
  await s.walletCancelAdd();
  assert.equal((await s.status()).hasWallet, true);
  assert.equal((await s.vault.open(PW1)).tronMnemonic, 'one');

  await s.walletBeginAdd('Second');
  await assert.rejects(s.finishCreate(PW2), /Create the seeds first/);
  s.draftSeeds = { tronMnemonic: 'two', moneroSeed: 'two' };
  await s.finishCreate(PW2);
  const list = await s.walletsList();
  assert.equal(list.list.length, 2);
  assert.equal(list.list[1].name, 'Second');
  assert.equal(list.active, list.list[1].id);
  assert.equal(s.seen, 'two');
  await assert.rejects(s.vault.open(PW1), /Wrong password/);

  // Swap records stay with their wallet
  await s.swapSave([{ id: 'x' }]);
  assert.equal((await s.swapList()).length, 1);
  await s.walletSwitch('main');
  assert.equal((await s.status()).unlocked, false, 'switching locks');
  assert.equal((await s.swapList()).length, 0);
  assert.equal((await s.vault.open(PW1)).tronMnemonic, 'one');

  // The choice survives a restart
  await s.walletSwitch(list.list[1].id);
  const again = new WalletService(dir, { N: 2 ** 10, r: 8, p: 1 });
  await again.init();
  assert.equal((await again.vault.open(PW2)).tronMnemonic, 'two');
  assert.equal(again.activeWallet, list.list[1].id);
  await assert.rejects(s.walletSwitch('nope'), /No such wallet/);
});

test('settings are shared, a Tornado list of leaves too, notes are not', async (t) => {
  const { s } = await make(t);
  await makeOldWallet(s, PW1, 'one');
  await s.updateSettings({ autoLockMinutes: 7 });
  await s.tornadoStore.write({ next: 3, notes: [] });
  await s.walletBeginAdd('Second');
  s.draftSeeds = { tronMnemonic: 'two', moneroSeed: 'two' };
  await s.finishCreate(PW2);
  assert.equal(s.settings.autoLockMinutes, 7);
  assert.equal((await s.tornadoStore.read()).next, 0);
});

test('deleting: wrong password does nothing; only that wallet goes; last one returns to a clean start', async (t) => {
  const { s, dir } = await make(t);
  await makeOldWallet(s, PW1, 'one');
  await s.updateSettings({ autoLockMinutes: 7 });
  await s.swapSave([{ id: 'x' }]);
  await s.walletBeginAdd('Second');
  s.draftSeeds = { tronMnemonic: 'two', moneroSeed: 'two' };
  await s.finishCreate(PW2);
  const second = s.activeWallet;

  await assert.rejects(s.deleteWallet(PW1), /Wrong password/);
  assert.equal(await s.deleteWallet(PW2), second);
  assert.ok(!fs.existsSync(path.join(dir, 'wallets', second)));
  assert.equal(s.activeWallet, 'main');
  assert.equal((await s.vault.open(PW1)).tronMnemonic, 'one', 'the other wallet is untouched');
  assert.equal((await s.swapList()).length, 1);

  assert.equal(await s.deleteWallet(PW1), 'main');
  assert.equal((await s.status()).hasWallet, false);
  assert.equal((await s.swapList()).length, 0);
  assert.equal(s.settings.autoLockMinutes, 7, 'app settings stay');
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
  assert.deepEqual((await s.walletsList()).list, [{ id: 'main', name: 'My wallet' }]);
});

test('removing the first wallet while another exists keeps that other one', async (t) => {
  const { s } = await make(t);
  await makeOldWallet(s, PW1, 'one');
  await s.walletBeginAdd('Second');
  s.draftSeeds = { tronMnemonic: 'two', moneroSeed: 'two' };
  await s.finishCreate(PW2);
  const second = s.activeWallet;
  await s.walletSwitch('main');
  await s.deleteWallet(PW1);
  assert.equal(s.activeWallet, second);
  assert.equal((await s.vault.open(PW2)).tronMnemonic, 'two');
});

test('a wallet whose file is already gone can still be deleted, and files held open are removed at the next start', async (t) => {
  const { s, dir } = await make(t);
  await makeOldWallet(s, PW1, 'one');
  await s.walletBeginAdd('Second');
  s.draftSeeds = { tronMnemonic: 'two', moneroSeed: 'two' };
  await s.finishCreate(PW2);
  const second = s.activeWallet;
  // As after an earlier delete that removed the vault but not the folder.
  fs.rmSync(path.join(dir, 'wallets', second, 'vault.json'));
  assert.equal(await s.deleteWallet(''), second);
  assert.equal(s.activeWallet, 'main');
  assert.deepEqual((await s.walletsList()).list.map((w) => w.id), ['main']);

  // A leftover that something still held open is cleaned up later, and only inside the app's own folder.
  const stale = path.join(dir, 'wallets', 'gone');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(dir, 'leftovers.json'), JSON.stringify([stale, '/etc', path.join(dir, 'xmr')]));
  await s.removeLeftovers();
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync('/etc'));
  assert.equal((await s.vault.open(PW1)).tronMnemonic, 'one', 'the remaining wallet is untouched');
});
