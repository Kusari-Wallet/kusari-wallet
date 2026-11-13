#!/usr/bin/env node
'use strict';
// XMRig ("rx/ksr") mining a private Kusari chain through the node's stratum server, on this machine only.
//   node native/kusari-zano/xmrig-test.js <build/src with kusarid and kusari-wallet> <xmrig binary> [blocks, default 5]
// Passes when the node accepted that many blocks found through the stratum, the miner's wallet got their rewards,
// and the node's own CPU miner never ran.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const params = JSON.parse(fs.readFileSync(path.join(__dirname, 'params.json'), 'utf8'));
const bin = path.resolve(process.argv[2] || '.');
const xmrig = path.resolve(process.argv[3] || 'xmrig');
const WANT = Number(process.argv[4] || 5);
const exe = (name) => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kusari-xmrig-'));
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RPC = params.ports.rpc + 4000, P2P = params.ports.p2p + 4000, STRATUM = params.ports.stratum + 4000, WALLET = RPC + 10;

function post(port, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', timeout: 60000,
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
const big = (text) => JSON.parse(text.replace(/("(?:balance|unlocked_balance)"\s*:\s*)(\d+)/g, '$1"$2"'));
async function rpc(port, method, p = {}) {
  const j = big(await post(port, '/json_rpc', JSON.stringify({ jsonrpc: '2.0', id: 0, method, params: p })));
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}
async function until(what, fn, ms, every = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
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
const read = (log) => { try { return fs.readFileSync(path.join(work, log), 'utf8'); } catch { return ''; } };

async function main() {
  const file = path.join(work, 'miner.wallet');
  spawnSync(exe('kusari-wallet'), ['--generate-new-wallet', file, '--password', 'xmrigtest', '--offline-mode', '--no-refresh', '--log-level', '0'],
    { input: 'exit\n', encoding: 'utf8', cwd: work, timeout: 120000 });
  if (!fs.existsSync(file)) throw new Error('could not make the wallet');

  start(exe('kusarid'), ['--data-dir', path.join(work, 'chain'), '--offline-mode', '--disable-upnp', '--disable-ntp', '--no-console',
    '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(RPC), '--p2p-bind-ip', '127.0.0.1', '--p2p-bind-port', String(P2P), '--rpc-ignore-offline',
    '--stratum', '--stratum-bind-ip', '127.0.0.1', '--stratum-bind-port', String(STRATUM), '--stratum-always-online', '--log-level', '1'], 'node.log');
  await until('the node', () => rpc(RPC, 'getinfo', { flags: 0 }), 180000);
  start(exe('kusari-wallet'), ['--wallet-file', file, '--password', 'xmrigtest', '--daemon-address', `127.0.0.1:${RPC}`,
    '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(WALLET), '--unsecure-no-auth', '--no-white-list', '--log-level', '0'], 'wallet.log');
  const address = (await until('the wallet', () => rpc(WALLET, 'getaddress'), 120000)).address;

  // Light mode (256 MiB, no huge pages) keeps it to what any test machine has; it is the same hash.
  start(xmrig, ['-o', `127.0.0.1:${STRATUM}`, '-a', 'rx/ksr', '-u', address, '-p', 'x', '--rig-id', 'xmrig-test', '-t', '2',
    '--randomx-mode', 'light', '--no-color', '--donate-level', '0', '--print-time', '10',
    // XMRig only prints to a terminal, so its log goes to a file.
    '--log-file', path.join(work, 'xmrig.log')], 'xmrig.out');

  let shown = -1;
  await until(`${WANT} blocks from XMRig`, async () => {
    if (/login error|rejected|error:/i.test(read('xmrig.log'))) throw Object.assign(new Error(`xmrig: ${read('xmrig.log').split('\n').filter((l) => /error|rejected/i.test(l)).slice(-3).join(' | ')}`), { fatal: true });
    const found = (read('node.log').match(/was successfully added to the blockchain/g) || []).length;
    if (found !== shown) { shown = found; console.log(`blocks from the stratum: ${found}`); }
    return found >= WANT;
  }, 3 * 3600000, 5000).catch((e) => { throw e; });

  const height = (await rpc(RPC, 'getinfo', { flags: 0 })).height;
  if (/Miner thread was started/.test(read('node.log'))) throw new Error('the node\'s own miner ran');
  const accepted = (read('xmrig.log').match(/accepted \(/g) || []).length;
  // Every block after the genesis came from XMRig and paid the wallet.
  await until('the wallet to see the rewards', async () => BigInt((await rpc(WALLET, 'getbalance')).balance) > 0n, 300000, 5000);
  const balance = BigInt((await rpc(WALLET, 'getbalance')).balance);
  console.log(`xmrig ok: height ${height}, ${shown} blocks found through the stratum, ${accepted} shares accepted, wallet ${Number(balance) / 1e12} KSR`);
}

main()
  .then(() => 0, (e) => { console.error('xmrig test failed:', e.message, '\nlogs in', work); return 1; })
  .then((code) => {
    for (const c of children) c.kill('SIGTERM');
    setTimeout(() => process.exit(code), 3000);
  });
