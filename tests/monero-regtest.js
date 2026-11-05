// Real end-to-end Monero test: a local monerod in regtest, two real wallets, a real transfer.
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MoneroClient, generateMoneroSeed, validateMoneroSeed } = require('../dist/main/monero');
const { parseAmount, formatAmount } = require('../dist/main/amount');

const PORT = 18981;
const NODE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params = {}) => {
  const res = await fetch(`${NODE}/json_rpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }) });
  return (await res.json());
};
const mine = async (address, n) => {
  const r = await rpc('generateblocks', { amount_of_blocks: n, wallet_address: address, starting_nonce: 0 });
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result.height;
};
const waitFor = async (what, fn, ms = 120000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('timeout: ' + what);
    await sleep(1000);
  }
};

const moneroTs = require('monero-ts').default;
const WALLET_RPC = process.env.WALLET_RPC || 'monero-wallet-rpc';

// The WASM wallet refuses regtest's hard-fork schedule once blocks exist, so transfers run on
// the same wallet2 engine through monero-wallet-rpc, driven by the same MoneroClient code.
async function rpcEngine(name, port, seed, dir, procs) {
  const walletDir = path.join(dir, name); fs.mkdirSync(walletDir, { recursive: true });
  procs.push(spawn(WALLET_RPC, ['--allow-mismatched-daemon-version', '--daemon-address', NODE, '--trusted-daemon', '--rpc-bind-port', String(port), '--rpc-bind-ip', '127.0.0.1', '--disable-rpc-login', '--wallet-dir', walletDir, '--log-level', '0'], { stdio: 'ignore' }));
  const uri = `http://127.0.0.1:${port}`;
  await waitFor('wallet rpc', async () => { try { const r = await fetch(`${uri}/json_rpc`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_version' }) }); return r.status > 0; } catch { return false; } }, 30000);
  const client = new MoneroClient({
    type: 'mainnet', dir: walletDir, filePassword: 'x', seed, restoreHeight: 0, nodes: [NODE], allowFakechain: true,
    walletFactory: async () => {
      const w = await moneroTs.connectToWalletRpc(uri);
      await w.createWallet({ path: 'w', password: 'pw', seed, restoreHeight: 0, language: 'English' });
      const daemonHeight = async () => (await rpc('get_info')).result.height;
      return new Proxy(w, { get(t, k) {
        if (k === 'getDaemonHeight') return daemonHeight;
        if (k === 'setDaemonConnection') return async () => {};
        if (k === 'addListener') return async () => {};
        const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
      } });
    },
  });
  await client.open();
  return client;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-xmr-'));
  const daemon = spawn(process.env.MONEROD || 'monerod', ['--regtest', '--offline', '--fixed-difficulty', '1', '--non-interactive', '--no-igd', '--hide-my-port',
    '--data-dir', path.join(dir, 'node'), '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(PORT), '--p2p-bind-port', '18982', '--zmq-rpc-bind-port', '18983', '--log-level', '0'], { stdio: 'ignore' });
  const procs = [daemon];
  let a, b, wasm;
  const openWasm = async (name, seed) => {
    const c = new MoneroClient({ type: 'mainnet', dir: path.join(dir, name), filePassword: 'filepw', seed, restoreHeight: 0, nodes: [NODE], allowFakechain: true });
    await c.open();
    return c;
  };
  try {
    await waitFor('monerod', async () => { try { return (await rpc('get_info')).result; } catch { return false; } }, 60000);

    // ---- production WASM engine: keys, files, connection ----
    const seedA = await generateMoneroSeed('mainnet');
    const seedB = await generateMoneroSeed('mainnet');
    assert.equal(seedA.split(' ').length, 25);
    assert.equal(await validateMoneroSeed(seedA), seedA);
    await assert.rejects(validateMoneroSeed(seedA.split(' ').reverse().join(' ')));
    await assert.rejects(validateMoneroSeed('not a seed'));
    console.log('ok seed generation and validation');

    wasm = await openWasm('w', seedB);
    await waitFor('wasm connected', async () => wasm.state.connected);
    await waitFor('wasm synced', async () => wasm.state.synced);
    const addrWasm = await wasm.getPrimaryAddress();
    assert.ok(await wasm.isValidAddress(addrWasm));
    assert.ok(!(await wasm.isValidAddress(addrWasm.slice(0, -1) + 'x')));
    assert.ok(!(await wasm.isValidAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')));
    const subWasm = await wasm.createSubaddress();
    assert.equal((await wasm.getBalance()).total, 0n);
    await wasm.close();
    wasm = await openWasm('w', seedB);
    assert.equal(await wasm.getPrimaryAddress(), addrWasm);
    assert.ok((await wasm.listAddresses()).some((x) => x.address === subWasm), 'subaddress survives reopen');
    await wasm.close();
    wasm = await openWasm('w-restored', seedB);
    assert.equal(await wasm.getPrimaryAddress(), addrWasm);
    await wasm.close(); wasm = null;
    console.log('ok WASM wallet: connect, sync, address checks, file reopen, restore gives same address');

    // Wrong file password must not open the wallet.
    const bad = new MoneroClient({ type: 'mainnet', dir: path.join(dir, 'w'), filePassword: 'nope', seed: seedB, restoreHeight: 0, nodes: [NODE], allowFakechain: true });
    await assert.rejects(bad.open());
    console.log('ok wallet file is encrypted');

    // ---- WASM engine through a proxy, as in Tor mode ----
    const { mockSocks } = require('./mock-socks');
    const socks = await mockSocks({ 'node.invalid': '127.0.0.1' });
    const viaTor = new MoneroClient({ type: 'mainnet', dir: path.join(dir, 'tor'), filePassword: 'p', seed: seedB, restoreHeight: 0, nodes: [`http://node.invalid:${PORT}`], allowFakechain: true, proxyUri: socks.uri });
    await viaTor.open();
    await waitFor('tor wallet connected', async () => viaTor.state.connected);
    await waitFor('tor wallet synced', async () => viaTor.state.synced);
    assert.ok(socks.log.length > 0 && socks.log.every((d) => d.host === 'node.invalid' && d.type === 'domain'), 'only the node, by name, through the proxy');
    const count = socks.log.length;
    await viaTor.getBalance();
    await socks.close();
    await viaTor.checkHealth();
    await viaTor.checkHealth();
    await waitFor('tor wallet notices the lost proxy', async () => !viaTor.state.connected, 60000);
    assert.ok(viaTor.state.error);
    await viaTor.close();
    console.log('ok WASM wallet connects by name through SOCKS and stops when it is gone,', count, 'proxied connections');

    // ---- transfers, same MoneroClient code ----
    a = await rpcEngine('a', 18991, seedA, dir, procs);
    b = await rpcEngine('b', 18992, seedB, dir, procs);
    const addrA = await a.getPrimaryAddress();
    const addrB = await b.getPrimaryAddress();
    assert.equal(addrB, addrWasm, 'RPC engine and WASM engine derive the same address from one seed');
    console.log('ok RPC and WASM engines agree on the address');

    await mine(addrA, 180);
    let lastDraftError = '';
    await waitFor('A can spend', async () => a.draft(addrB, 1n).then(() => true, (e) => { lastDraftError = e.message; return false; }), 90000)
      .catch((e) => { throw new Error(`${e.message}: ${lastDraftError}`); });
    const before = await a.getBalance();
    assert.ok(before.unlocked > 0n);
    console.log('ok mined, A balance', formatAmount(before.total, 12), 'unlocked', formatAmount(before.unlocked, 12));

    const sub = await b.createSubaddress();
    const amount = parseAmount('1.234567890123', 12);
    const draft = await a.draft(sub, amount);
    assert.equal(draft.amount, amount);
    assert.ok(draft.fee > 0n);
    assert.equal((await a.getBalance()).total, before.total, 'a draft must not move funds');
    const hashes = await a.relay(draft);
    assert.equal(hashes.length, 1);
    assert.match(hashes[0], /^[0-9a-f]{64}$/);
    console.log('ok relayed', hashes[0], 'fee', formatAmount(draft.fee, 12));

    await mine(addrA, 12);
    const got = await waitFor('B received', async () => { const bal = await b.getBalance(); return bal.total > 0n ? bal : false; });
    assert.equal(got.total, amount, 'B must receive the exact amount at its subaddress');
    const seen = await b.receivedBy(sub, 20000);
    assert.equal(seen.total, amount, 'privacy swap sees what reached this subaddress');
    assert.equal(seen.unlocked, amount, 'twelve blocks mined, so it counts as unlocked');
    assert.equal((await b.receivedBy(await b.getPrimaryAddress(), 20000)).total, 0n, 'other addresses are not counted');
    await assert.rejects(b.receivedBy(await a.getPrimaryAddress(), 20000), /이 지갑의 주소/);
    console.log('ok received amount read per subaddress');
    const hist = await b.getHistory();
    assert.equal(hist.length, 1);
    assert.equal(hist[0].direction, 'in');
    assert.equal(hist[0].hash, hashes[0]);
    assert.equal(hist[0].amount, '1.234567890123');
    await waitFor('A sees tx', async () => (await a.getHistory()).some((t) => t.hash === hashes[0] && t.status === 'confirmed'));
    const out = (await a.getHistory()).find((t) => t.hash === hashes[0]);
    assert.equal(out.direction, 'out');
    assert.equal(out.amount, '1.234567890123');
    console.log('ok B received exact amount at subaddress, both histories correct');

    await waitFor('B unlocked', async () => (await b.getBalance()).unlocked === amount);
    const sweep = await b.draft(addrA, 'max');
    assert.equal(sweep.amount + sweep.fee, amount, 'sweep must spend everything');
    await b.relay(sweep);
    await mine(addrA, 2);
    await waitFor('B emptied', async () => (await b.getBalance()).total === 0n);
    console.log('ok send max emptied the wallet');

    await assert.rejects(a.draft(addrB, parseAmount('99999999', 12)));
    console.log('ok overspend refused');
    console.log('ALL PASSED');
  } finally {
    await Promise.allSettled([a?.close(), b?.close(), wasm?.close()]);
    for (const p of procs) p.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
