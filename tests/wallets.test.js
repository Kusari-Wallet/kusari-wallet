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
  s.startSession = async (secrets) => { s.tron = {}; s.btc = {}; s.eth = {}; s.dcr = {}; s.dash = {}; s.monero = { close: async () => {} }; s.seen = secrets.tronMnemonic; };
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
  assert.deepEqual(list.list, [{ id: 'main', name: '내 지갑' }]);
  assert.equal((await again.vault.open(PW1)).tronMnemonic, 'old');
});

test('rename: saved, limits checked, unknown wallet refused', async (t) => {
  const { s, dir } = await make(t);
  await s.walletRename('main', '  저축용 ');
  assert.equal((await s.walletsList()).list[0].name, '저축용');
  await assert.rejects(s.walletRename('main', '   '), /1자에서 20자/);
  await assert.rejects(s.walletRename('main', 'ㄱ'.repeat(21)), /1자에서 20자/);
  await assert.rejects(s.walletRename('nope', '이름'), /없는 지갑/);
  const again = new WalletService(dir);
  await again.init();
  assert.equal((await again.walletsList()).list[0].name, '저축용');
});

test('adding: separate seed, password and records; giving up leaves nothing', async (t) => {
  const { s, dir } = await make(t);
  await makeOldWallet(s, PW1, 'one');
  await s.walletBeginAdd('둘째');
  assert.equal((await s.status()).hasWallet, false, 'opens the new wallet flow');
  assert.equal((await s.walletsList()).list.length, 1, 'not listed until it exists');
  await s.walletCancelAdd();
  assert.equal((await s.status()).hasWallet, true);
  assert.equal((await s.vault.open(PW1)).tronMnemonic, 'one');

  await s.walletBeginAdd('둘째');
  await assert.rejects(s.finishCreate(PW2), /먼저 시드/);
  s.draftSeeds = { tronMnemonic: 'two', moneroSeed: 'two' };
  await s.finishCreate(PW2);
  const list = await s.walletsList();
  assert.equal(list.list.length, 2);
  assert.equal(list.list[1].name, '둘째');
  assert.equal(list.active, list.list[1].id);
  assert.equal(s.seen, 'two');
  await assert.rejects(s.vault.open(PW1), /틀렸어/);

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
  await assert.rejects(s.walletSwitch('nope'), /없는 지갑/);
});

test('settings are shared, a Tornado list of leaves too, notes are not', async (t) => {
  const { s } = await make(t);
  await makeOldWallet(s, PW1, 'one');
  await s.updateSettings({ autoLockMinutes: 7 });
  await s.tornadoStore.write({ next: 3, notes: [] });
  await s.walletBeginAdd('둘째');
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
  await s.walletBeginAdd('둘째');
  s.draftSeeds = { tronMnemonic: 'two', moneroSeed: 'two' };
  await s.finishCreate(PW2);
  const second = s.activeWallet;

  await assert.rejects(s.deleteWallet(PW1), /틀렸어/);
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
  assert.deepEqual((await s.walletsList()).list, [{ id: 'main', name: '내 지갑' }]);
});

test('removing the first wallet while another exists keeps that other one', async (t) => {
  const { s } = await make(t);
  await makeOldWallet(s, PW1, 'one');
  await s.walletBeginAdd('둘째');
  s.draftSeeds = { tronMnemonic: 'two', moneroSeed: 'two' };
  await s.finishCreate(PW2);
  const second = s.activeWallet;
  await s.walletSwitch('main');
  await s.deleteWallet(PW1);
  assert.equal(s.activeWallet, second);
  assert.equal((await s.vault.open(PW2)).tronMnemonic, 'two');
});
