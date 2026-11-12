#!/usr/bin/env node
'use strict';
// Starts a private Kusari mainnet from its genesis block with the built binaries and mines past the switch to
// Monero's current rules, then sends coins between two wallets on a regtest chain. Nothing leaves this machine: the daemon is offline and binds to 127.0.0.1.
//   node native/kusari-coin/selftest.js <build/bin directory>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { decodeAddress } = require('./lib');

const MONERO_GENESIS_HASH = '418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3';
const params = JSON.parse(fs.readFileSync(path.join(__dirname, 'params.json'), 'utf8'));
const bin = path.resolve(process.argv[2] || '.');
const exe = (name) => path.join(bin, `${params.binaryPrefix}${name}${process.platform === 'win32' ? '.exe' : ''}`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kusari-selftest-'));
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rpc(port, method, params = {}, timeout = 60000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/json_rpc', method: 'POST', timeout,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(s);
          if (j.error) reject(new Error(`${method}: ${j.error.message}`));
          else resolve(j.result);
        } catch (e) { reject(new Error(`${method}: ${s.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`${method}: timed out`)));
    req.end(body);
  });
}

function other(port, route, params = {}) {
  const body = JSON.stringify(params);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function until(what, fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}

function start(file, args, log) {
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  const out = fs.openSync(path.join(work, log), 'w');
  const p = spawn(file, args, { stdio: ['ignore', out, out] });
  children.push(p);
  p.on('exit', (code) => { if (code) console.error(`${path.basename(file)} exited with ${code}, see ${path.join(work, log)}`); });
  return p;
}

function daemon(port, dir, extra) {
  return start(exe('d'), ['--data-dir', path.join(work, dir), '--offline', '--no-igd', '--non-interactive',
    '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(port), '--p2p-bind-ip', '127.0.0.1',
    '--zmq-rpc-bind-port', String(port + 10), '--log-level', '1', ...extra], `${dir}.log`);
}

async function stop(p) {
  if (p.exitCode !== null) return;
  const done = new Promise((r) => p.once('exit', r));
  p.kill('SIGTERM');
  await Promise.race([done, sleep(30000)]);
}

async function wallets(d, ports, extra) {
  const addr = {};
  for (const port of ports) {
    fs.mkdirSync(path.join(work, `w${port}`), { recursive: true });
    start(exe('-wallet-rpc'), ['--daemon-address', `127.0.0.1:${d}`, '--trusted-daemon', '--rpc-bind-ip', '127.0.0.1',
      '--rpc-bind-port', String(port), '--disable-rpc-login', '--wallet-dir', path.join(work, `w${port}`), '--log-level', '1', ...extra],
    `wallet-${port}.log`);
  }
  for (const port of ports) {
    await until(`wallet ${port}`, () => rpc(port, 'get_version'), 60000);
    await rpc(port, 'create_wallet', { filename: 'w', password: '', language: 'English' });
    addr[port] = (await rpc(port, 'get_address')).address;
    const dec = decodeAddress(addr[port]);
    if (dec.prefix !== params.mainnet.prefixes.address || addr[port][0] !== params.mainnet.leading.address) {
      throw new Error(`address ${addr[port]} does not use the Kusari prefix`);
    }
  }
  return addr;
}

// Step 1: the real mainnet rules. The genesis block, the fork table and the missing Monero checkpoints are only
// tested here. Difficulty follows the 2-minute target, so this mines just past the switch to version 16.
async function mainnet() {
  const last = params.hardForks[params.hardForks.length - 1];
  const d = params.mainnet.ports.rpc + 1000;
  const p = daemon(d, 'mainnet', []);
  await until('daemon', () => rpc(d, 'get_info').then((r) => r.status === 'OK'), 120000);
  const genesis = (await rpc(d, 'get_block_header_by_height', { height: 0 })).block_header;
  if (genesis.hash === MONERO_GENESIS_HASH) throw new Error('this is Monero\'s genesis block');
  const w = d + 1;
  const addr = await wallets(d, [w], []);
  const r = await other(d, '/start_mining', { miner_address: addr[w], threads_count: 2, do_background_mining: false, ignore_battery: true });
  if (r.status !== 'OK') throw new Error(`start_mining: ${r.status}`);
  await until('mainnet blocks', async () => (await rpc(d, 'get_info')).height >= last.height + 2, 3600000);
  await other(d, '/stop_mining');
  const fork = await rpc(d, 'hard_fork_info');
  if (fork.version !== last.version) throw new Error(`fork version ${fork.version}`);
  const b = (await rpc(d, 'get_block_header_by_height', { height: last.height + 1 })).block_header;
  if (b.major_version !== fork.version) throw new Error(`block ${last.height + 1} is version ${b.major_version}`);
  await rpc(w, 'refresh');
  const bal = await rpc(w, 'get_balance');
  if (!(bal.balance > 0)) throw new Error('the miner wallet saw no coinbase');
  console.log(`mainnet ok: genesis ${genesis.hash}, version ${fork.version}, miner balance ${bal.balance}`);
  await stop(p);
}

// Step 2: a send. Ring size 16 needs 16 spendable outputs and coinbase unlocks after 60 blocks, which at real
// difficulty takes hours, so this uses regtest: the same code, genesis and prefixes with a fixed difficulty.
async function send() {
  const d = params.mainnet.ports.rpc + 2000;
  daemon(d, 'regtest', ['--regtest', '--fixed-difficulty', '1']);
  await until('regtest daemon', () => rpc(d, 'get_info').then((r) => r.status === 'OK'), 120000);
  const w1 = d + 1, w2 = d + 2;
  const addr = await wallets(d, [w1, w2], ['--allow-mismatched-daemon-version']);
  const sub = (await rpc(w2, 'create_address', { account_index: 0 })).address;
  if (decodeAddress(sub).prefix !== params.mainnet.prefixes.subaddress) throw new Error(`subaddress ${sub} has the wrong prefix`);
  await rpc(d, 'generateblocks', { amount_of_blocks: 120, wallet_address: addr[w1] }, 600000);
  await until('wallet 1 to unlock coins', async () => {
    await rpc(w1, 'refresh');
    return (await rpc(w1, 'get_balance')).unlocked_balance > 0;
  }, 120000);
  const amount = 1000000000000; // 1 coin
  const tx = await rpc(w1, 'transfer', { destinations: [{ amount, address: sub }], priority: 0, ring_size: 16 });
  await rpc(d, 'generateblocks', { amount_of_blocks: 1, wallet_address: addr[w1] });
  await until('wallet 2 to see it confirmed', async () => {
    await rpc(w2, 'refresh');
    const t = await rpc(w2, 'get_transfers', { in: true });
    return (t.in || []).some((x) => x.txid === tx.tx_hash && x.amount === amount && x.confirmations >= 1);
  }, 120000);
  console.log(`send ok: ${tx.tx_hash} to ${sub}, fee ${tx.fee}`);
}

async function main() {
  await mainnet();
  await send();
  console.log('selftest ok');
}

main()
  .then(() => 0, (e) => { console.error('selftest failed:', e.message, '\nlogs in', work); return 1; })
  .then((code) => {
    for (const c of children) c.kill('SIGTERM');
    setTimeout(() => process.exit(code), 3000);
  });
