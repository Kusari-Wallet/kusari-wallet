#!/usr/bin/env node
'use strict';
// Starts a private Kusari chain from its genesis block with the built binaries: mines with RandomX, stakes, and
// sends coins between two wallets. Nothing leaves this machine: the node is offline and binds to 127.0.0.1.
// Blocks follow the real 2-minute proof-of-work target once the difficulty has caught up, so this takes a while.
//   node native/kusari-zano/selftest.js <build/src directory>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { decodeAddress } = require('../kusari-coin/lib');

const params = JSON.parse(fs.readFileSync(path.join(__dirname, 'params.json'), 'utf8'));
const bin = path.resolve(process.argv[2] || '.');
const exe = (name) => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kusari-zano-selftest-'));
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COIN = 1000000000000n;

function post(port, route, body, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', timeout,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => resolve(s));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`${route}: timed out`)));
    req.end(body);
  });
}

// Amounts can pass 2^53, so they are read as text.
const big = (text) => JSON.parse(text.replace(/("(?:balance|unlocked_balance|amount|total|unlocked|fee)"\s*:\s*)(\d+)/g, '$1"$2"'));

async function rpc(port, method, p = {}) {
  const j = big(await post(port, '/json_rpc', JSON.stringify({ jsonrpc: '2.0', id: 0, method, params: p })));
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

async function until(what, fn, ms, every = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

function start(file, args, log) {
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  const out = fs.openSync(path.join(work, log), 'w');
  const p = spawn(file, args, { stdio: ['ignore', out, out], cwd: work });
  children.push(p);
  return p;
}

function makeWallet(name) {
  const file = path.join(work, `${name}.wallet`);
  const r = spawnSync(exe('kusari-wallet'), ['--generate-new-wallet', file, '--password', 'selftest', '--offline-mode', '--no-refresh', '--log-level', '0'],
    { input: 'exit\n', encoding: 'utf8', cwd: work, timeout: 120000 });
  if (!fs.existsSync(file)) throw new Error(`could not make ${name}: ${(r.stdout || '') + (r.stderr || '')}`.slice(0, 600));
  return file;
}

function walletRpc(file, port, d, extra = []) {
  return start(exe('kusari-wallet'), ['--wallet-file', file, '--password', 'selftest', '--daemon-address', `127.0.0.1:${d}`,
    '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(port), '--unsecure-no-auth', '--no-white-list', '--log-level', '0', ...extra], `wallet-${port}.log`);
}

async function main() {
  const d = params.ports.rpc + 3000;
  start(exe('kusarid'), ['--data-dir', path.join(work, 'chain'), '--offline-mode', '--disable-upnp', '--disable-ntp', '--disable-stop-if-time-out-of-sync',
    '--no-console', '--no-predownload', '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(d), '--p2p-bind-ip', '127.0.0.1', '--p2p-bind-port', String(d + 1),
    '--rpc-ignore-offline', '--log-level', '0'], 'daemon.log');
  const info = await until('the node', () => rpc(d, 'getinfo', { flags: 0 }), 180000);
  const genesis = (await rpc(d, 'getblockheaderbyheight', { height: 0 })).block_header;
  if (!/^[0-9a-f]{64}$/.test(genesis.hash)) throw new Error('bad genesis hash');
  console.log('genesis', genesis.hash, 'height', info.height);

  const w1 = d + 11, w2 = d + 12;
  const f1 = makeWallet('one');
  const f2 = makeWallet('two');
  // Wallet one also stakes, so proof-of-stake blocks are part of the test.
  walletRpc(f1, w1, d, ['--do-pos-mining']);
  walletRpc(f2, w2, d);
  const a1 = (await until('wallet one', () => rpc(w1, 'getaddress'), 120000)).address;
  const a2 = (await until('wallet two', () => rpc(w2, 'getaddress'), 120000)).address;
  for (const a of [a1, a2]) {
    if (decodeAddress(a).prefix !== params.prefixes.address || a[0] !== params.leading.address) throw new Error(`address ${a} does not use the Kusari prefix`);
  }
  console.log('addresses', a1, a2);

  const started = JSON.parse(await post(d, '/start_mining', JSON.stringify({ miner_address: a1, threads_count: Math.max(1, Math.min(4, os.cpus().length)) })));
  if (started.status !== 'OK') throw new Error(`start_mining: ${JSON.stringify(started)}`);

  // Mined coins unlock after 10 blocks and a send needs 15 other outputs to hide among.
  const amount = COIN;
  let tx = null;
  let lastHeight = 0;
  await until('a send from wallet one', async () => {
    const h = (await rpc(d, 'getinfo', { flags: 0 })).height;
    if (h !== lastHeight) { lastHeight = h; console.log(`height ${h}`); }
    const b = await rpc(w1, 'getbalance');
    if (BigInt(b.unlocked_balance) < amount * 2n) return false;
    try {
      const body = `{"jsonrpc":"2.0","id":0,"method":"transfer","params":{"destinations":[{"address":${JSON.stringify(a2)},"amount":${amount}}],"fee":10000000000,"mixin":15}}`;
      const j = big(await post(w1, '/json_rpc', body));
      if (j.error) { console.log(`  not yet: ${j.error.message}`); return false; }
      tx = j.result;
      return true;
    } catch (e) { console.log(`  not yet: ${e.message}`); return false; }
  }, 4 * 3600000, 15000);
  console.log('sent', tx.tx_hash);

  await until('wallet two to receive it', async () => BigInt((await rpc(w2, 'getbalance')).balance) === amount, 3600000, 10000);

  // Proof of stake: wallet one's coins should have made at least one block by now, or soon.
  const pos = await until('a proof-of-stake block', async () => {
    const top = (await rpc(d, 'getinfo', { flags: 0 })).height;
    const blocks = (await rpc(d, 'get_blocks_details', { height_start: 1, count: top })).blocks ?? [];
    const n = blocks.filter((b) => b.type === 0).length;
    return n > 0 ? { n, pow: blocks.length - n } : false;
  }, 3600000, 30000);

  await post(d, '/stop_mining', '{}');
  const end = await rpc(d, 'getinfo', { flags: 0 });
  console.log(`selftest ok: height ${end.height}, ${pos.pow} PoW (RandomX) and ${pos.n} PoS blocks, tx ${tx.tx_hash}`);
}

main()
  .then(() => 0, (e) => { console.error('selftest failed:', e.message, '\nlogs in', work); return 1; })
  .then((code) => {
    for (const c of children) c.kill('SIGTERM');
    setTimeout(() => process.exit(code), 4000);
  });
