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
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); // a write may still be landing
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
  await s.updateSettings({ showPrices: false });
  await s.tornadoStore.write({ next: 3, notes: [] });
  await s.walletBeginAdd('Second');
  s.draftSeeds = { tronMnemonic: 'two', moneroSeed: 'two' };
  await s.finishCreate(PW2);
  assert.equal(s.settings.showPrices, false);
  assert.equal((await s.tornadoStore.read()).next, 0);
});

test('deleting: wrong password does nothing; only that wallet goes; last one returns to a clean start', async (t) => {
  const { s, dir } = await make(t);
  await makeOldWallet(s, PW1, 'one');
  await s.updateSettings({ showPrices: false });
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
  assert.equal(s.settings.showPrices, false, 'app settings stay');
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

test('your own Bitcoin server and Zano node are checked and kept', async (t) => {
  const { s } = await make(t);
  await makeOldWallet(s, PW1, 'one');
  await s.updateSettings({ customBtcServer: 'http://192.168.1.20:3006/api/', customZanoNode: 'http://10.0.0.5:11211/' });
  assert.equal(s.settings.customBtcServer, 'http://192.168.1.20:3006/api');
  assert.equal(s.settings.customZanoNode, '10.0.0.5:11211');
  await assert.rejects(s.updateSettings({ customBtcServer: 'http://mempool.example/api' }), /https/);
  await assert.rejects(s.updateSettings({ customZanoNode: 'not a node' }), /host:port/);
  assert.equal(s.settings.customBtcServer, 'http://192.168.1.20:3006/api', 'a refused change leaves the last good one');
  await s.updateSettings({ customBtcServer: '', customZanoNode: '' });
  assert.equal(s.settings.customBtcServer, '');
});

test('the Kusari node is checked and kept, and KSR stays off without one', async (t) => {
  const { s } = await make(t);
  await makeOldWallet(s, PW1, 'one');
  assert.equal(s.ksrInfo().hasNode, false, 'no public Kusari node before launch');
  await s.updateSettings({ customKsrNode: 'http://10.0.0.6:21081/' });
  assert.equal(s.settings.customKsrNode, '10.0.0.6:21081');
  assert.equal(s.ksrInfo().hasNode, true);
  await assert.rejects(s.updateSettings({ customKsrNode: 'not a node' }), /Kusari node as host:port/);
  assert.equal(s.settings.customKsrNode, '10.0.0.6:21081', 'a refused change leaves the last good one');
  await s.updateSettings({ customKsrNode: '' });
  assert.equal(s.ksrInfo().hasNode, false);
});

test('CoinJoin: needs an open wallet, and the coordinator setting takes known ones, https or .onion only', async (t) => {
  const { s } = await make(t);
  await makeOldWallet(s, PW1, 'one');
  await assert.rejects(s.btcMixStart(PW1), /locked/, 'nothing happens without an open wallet');
  assert.equal(s.settings.coinjoinCoordinator, 'https://coinjoin.kruw.io/');
  await s.updateSettings({ coinjoinCoordinator: 'https://coinjoin.nl/' });
  assert.equal(s.settings.coinjoinCoordinator, 'https://coinjoin.nl/');
  await s.updateSettings({ coinjoinCoordinator: 'https://my.coordinator.example' });
  assert.equal(s.settings.coinjoinCoordinator, 'https://my.coordinator.example/');
  await s.updateSettings({ coinjoinCoordinator: 'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion' });
  assert.match(s.settings.coinjoinCoordinator, /\.onion\/$/);
  await assert.rejects(s.updateSettings({ coinjoinCoordinator: 'http://192.168.1.2:37127' }), /https:\/\/ or an \.onion/);
  await assert.rejects(s.updateSettings({ coinjoinCoordinator: '' }), /Choose a CoinJoin coordinator/);
});

test('CoinJoin: how much to mix is 1, 5 or 10', async (t) => {
  const { s } = await make(t);
  assert.equal(s.settings.coinjoinTarget, 5, 'Wasabi\'s default');
  await s.updateSettings({ coinjoinTarget: 10 });
  assert.equal(s.settings.coinjoinTarget, 10);
  await s.updateSettings({ coinjoinTarget: 1 });
  assert.equal(s.settings.coinjoinTarget, 1);
  await assert.rejects(s.updateSettings({ coinjoinTarget: 3 }), /how many others/);
});

test('duress password: opens a decoy in the wallet\'s place, the real one stays untouched, even when the decoy is deleted', async (t) => {
  const { s, dir } = await make(t);
  // Making the decoy's Monero seed starts monero-ts's worker; it is stopped so the test run can end.
  t.after(async () => { await require('monero-ts').LibraryUtils.terminateWorker().catch(() => undefined); });
  await makeOldWallet(s, PW1, 'real seed');
  await s.unlock(PW1);
  await s.slotting;
  assert.deepEqual(await s.duressStatus(), { set: false });
  // Without a duress password the files look the same as with one: a hidden wallet nobody can open.
  const shape = () => {
    const id = JSON.parse(fs.readFileSync(path.join(dir, 'duress.json'), 'utf8')).id;
    const hidden = path.join(dir, 'wallets', id);
    return { id, files: fs.readdirSync(hidden).sort(), vault: Object.keys(JSON.parse(fs.readFileSync(path.join(hidden, 'vault.json'), 'utf8'))).sort(), size: fs.statSync(path.join(hidden, 'vault.json')).size };
  };
  const before = shape();
  await s.lock();
  await assert.rejects(s.unlock('decoy password'), /./, 'the hidden wallet opens with no password anyone knows');
  await s.unlock(PW1);
  await s.slotting;
  assert.equal(shape().id, before.id, 'made once, then kept');
  await assert.rejects(s.duressSet('wrong password', 'decoy password'), /./);
  await assert.rejects(s.duressSet(PW1, PW1), /different/);
  await s.duressSet(PW1, 'decoy password');
  assert.deepEqual(await s.duressStatus(), { set: true });
  const after = shape();
  assert.notEqual(after.id, before.id);
  assert.ok(!fs.existsSync(path.join(dir, 'wallets', before.id)), 'the unopenable one is gone');
  assert.deepEqual([after.files, after.vault], [before.files, before.vault], 'same files, same vault fields');
  assert.ok(Math.abs(after.size - before.size) < 120, `vaults of about the same size (${before.size}, ${after.size})`);
  await s.lock();

  await s.unlock('decoy password');
  assert.notEqual(s.seen, 'real seed', 'the decoy has a seed of its own');
  assert.match(s.seen, /^(\w+ ){11,23}\w+$/);
  const decoySeed = s.seen;
  assert.equal(s.activeWallet, 'main', 'under the real wallet\'s name');
  assert.deepEqual((await s.walletsList()).list.map((w) => w.id), ['main'], 'never listed');
  assert.deepEqual(await s.duressStatus(), { set: false }, 'looks like a wallet without one');
  await s.lock();

  await assert.rejects(s.unlock('neither of them'), /./);
  await s.unlock(PW1);
  assert.equal(s.seen, 'real seed');
  await s.lock();

  // Deleting from the decoy removes only the decoy.
  await s.unlock('decoy password');
  assert.equal(s.seen, decoySeed);
  await s.deleteWallet('decoy password');
  assert.equal(await s.vault.exists(), true);
  assert.equal((await s.vault.open(PW1)).tronMnemonic, 'real seed');
  assert.ok(!fs.existsSync(path.join(dir, 'duress.json')));
  await assert.rejects(s.unlock('decoy password'), /./);
  await s.unlock(PW1);
  assert.equal(s.seen, 'real seed');
  await s.slotting;
  assert.ok(fs.existsSync(path.join(dir, 'duress.json')), 'the real wallet gets a hidden one again');
  assert.deepEqual(await s.duressStatus(), { set: false });

  // Removing the duress password leaves a hidden wallet nobody can open.
  await s.duressSet(PW1, 'decoy password');
  await s.duressRemove(PW1);
  assert.deepEqual(await s.duressStatus(), { set: false });
  assert.ok(fs.existsSync(path.join(dir, 'duress.json')));
  await s.lock();
  await assert.rejects(s.unlock('decoy password'), /./);

  // Deleting the wallet takes its hidden wallet with it: a new wallet in its place never opens the old decoy.
  await s.unlock(PW1);
  await s.duressSet(PW1, 'decoy password');
  const decoyDir = path.join(dir, 'wallets', shape().id);
  await s.deleteWallet(PW1);
  assert.ok(!fs.existsSync(decoyDir) && !fs.existsSync(path.join(dir, 'duress.json')));
  await makeOldWallet(s, PW2, 'new seed');
  await assert.rejects(s.unlock('decoy password'), /./, 'the old decoy password opens nothing');
});

test('extra Ethereum addresses: made on demand, read on their own, found again after a restore, spent on their own', async (t) => {
  const http = require('node:http');
  const { ethAddressNode, deriveEthAccount, ETH_EXTRA_FIRST } = require('../dist/main/eth');
  const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const node = ethAddressNode(PHRASE);
  assert.equal(node.addressAt(0), deriveEthAccount(PHRASE, ETH_EXTRA_FIRST).address, 'account 4, as MetaMask numbers them');
  // A node where only the third extra address has been used.
  const used = node.addressAt(2).toLowerCase();
  const asked = [];
  const server = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', () => {
      const { id, method, params } = JSON.parse(b);
      const ok = (result) => r.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      if (method === 'eth_chainId') return ok('0x1');
      asked.push([method, JSON.stringify(params)]);
      if (method === 'eth_getBalance') return ok(params[0].toLowerCase() === used ? '0xde0b6b3a7640000' : '0x0');
      if (method === 'eth_call') return ok('0x' + '0'.repeat(64));
      if (method === 'eth_getTransactionCount') return ok('0x0');
      ok(null);
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); // a write may still be landing
  const s = new WalletService(dir, { N: 2 ** 10, r: 8, p: 1 }, { ethRpc: `http://127.0.0.1:${server.address().port}` });
  s.startSession = async () => { s.tron = {}; s.btc = {}; s.eth = { address: deriveEthAccount(PHRASE).address }; s.dash = {}; s.firo = {}; s.monero = { close: async () => {} }; s.ethNode = node; };
  await s.init();
  await s.startSession();

  assert.equal(await s.ethAddressesFind(), 1, 'the used one is found, looking on past unused ones');
  assert.deepEqual((await s.ethAddresses()).map((x) => [x.n, x.address, x.eth]), [[2, node.addressAt(2), '1']]);
  const fresh = await s.ethAddressNew();
  assert.deepEqual(fresh, { n: 3, address: node.addressAt(3) }, 'the next one after those known');
  assert.equal((await s.ethAddresses()).length, 2);
  await assert.rejects(s.prepareSend('ETH', node.addressAt(9), '0.1', { fromAddress: 7 }), /not in this wallet/);
});
