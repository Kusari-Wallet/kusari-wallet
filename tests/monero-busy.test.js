// A real scan blocks wallet calls for minutes. The app has to stay usable during that.
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { MoneroClient } = require('../dist/main/monero');

function busyWallet() {
  const w = {
    blocked: false,
    gate: Promise.resolve(),
    release: () => {},
    block() { w.blocked = true; w.gate = new Promise((r) => { w.release = () => { w.blocked = false; r(); }; }); },
    call(value) { return w.gate.then(() => value); },
    getAddress: () => w.call('ADDR'),
    getBalance: () => w.call(w.balance),
    getUnlockedBalance: () => w.call(w.balance),
    getHeight: () => w.call(100),
    getDaemonHeight: () => w.call(100),
    isConnectedToDaemon: () => w.call(true),
    addListener: async () => {},
    setDaemonConnection: async () => {},
    startSyncing: async () => {},
    stopSyncing: async () => {},
    save: async () => {},
    close: async () => {},
    balance: 5n,
  };
  return w;
}

test('address and last balance come back at once while the wallet is busy', async () => {
  const w = busyWallet();
  const c = new MoneroClient({ type: 'mainnet', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'vw-b-')), filePassword: 'x', seed: 's', restoreHeight: 0, nodes: [], walletFactory: async () => w });
  await c.open();
  w.block();
  const t0 = Date.now();
  assert.equal(await c.getPrimaryAddress(), 'ADDR');
  assert.equal((await c.getBalance(200)).total, 5n);
  assert.ok(Date.now() - t0 < 1000, 'must not wait for the sync step');

  // New balance shows up once the wallet answers again.
  w.balance = 9n;
  w.release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await c.getBalance()).total, 9n);
  await c.close();
});

test('calls pile up as one balance request, not many', async () => {
  const w = busyWallet();
  let calls = 0;
  const original = w.getBalance;
  w.getBalance = () => { calls++; return original(); };
  const c = new MoneroClient({ type: 'mainnet', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'vw-b-')), filePassword: 'x', seed: 's', restoreHeight: 0, nodes: [], walletFactory: async () => w });
  await c.open();
  calls = 0;
  w.block();
  await Promise.all([c.getBalance(50), c.getBalance(50), c.getBalance(50)]);
  assert.equal(calls, 1);
  w.release();
  await c.close();
});

test('a single missed health check is not treated as a lost connection', async () => {
  const w = busyWallet();
  const c = new MoneroClient({ type: 'mainnet', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'vw-b-')), filePassword: 'x', seed: 's', restoreHeight: 0, nodes: [], walletFactory: async () => w });
  await c.open();
  c.state.connected = true;
  c.state.node = 'http://127.0.0.1:1';
  let stopped = false;
  w.stopSyncing = async () => { stopped = true; };
  await c.checkHealth();
  assert.equal(c.state.connected, true, 'one miss is not a lost connection');
  assert.equal(stopped, false);
  await c.close();
});
