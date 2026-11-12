#!/usr/bin/env node
'use strict';
// A private Kusari network on this machine, from the genesis block: four nodes, RandomKSR mining, the emission
// block by block, proof of stake switching on at its height, and a send that walks a Dandelion++ stem.
// Nothing leaves this machine: nodes bind to 127.0.0.1 and only connect to each other.
//   node native/kusari-zano/selftest.js <build/src of a test build, -DKUSARI_TEST_POS_START_HEIGHT=<h>> <h>
//
//   A ──► B ──► D        A mines and sends; it stems everything (fluff 0%) and its embargo is long, so the
//   └───► C ──►─┘        broadcast must come from D, two hops away. B and C stem too; D, with no outgoing peer,
//                        broadcasts. Wallet two (the receiver) is on D.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { decodeAddress } = require('../kusari-coin/lib');

const params = JSON.parse(fs.readFileSync(path.join(__dirname, 'params.json'), 'utf8'));
const bin = path.resolve(process.argv[2] || '.');
const POS_START = Number(process.argv[3]);
if (!Number.isInteger(POS_START) || POS_START < 20) throw new Error('give the test build\'s KUSARI_TEST_POS_START_HEIGHT (20 or more)');
const exe = (name) => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kusari-selftest-'));
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COIN = 10n ** 12n;
const SUPPLY = BigInt(params.emission.moneySupply);
const TAIL = BigInt(params.emission.tailReward);
const SHIFT = BigInt(params.emission.speedFactor);

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
const big = (text) => JSON.parse(text.replace(/("(?:balance|unlocked_balance|amount|total|unlocked|fee|base_reward|summary_reward|total_fee)"\s*:\s*)(\d+)/g, '$1"$2"'));

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
    } catch (e) {
      if (e.fatal) throw e; // anything else: not up yet
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

function start(file, args, log, env = {}) {
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  const out = fs.openSync(path.join(work, log), 'w');
  const p = spawn(file, args, { stdio: ['ignore', out, out], cwd: work, env: { ...process.env, ...env } });
  children.push(p);
  return p;
}

const base = params.ports.rpc + 3000;
const nodes = { A: { rpc: base, p2p: base + 1 }, B: { rpc: base + 2, p2p: base + 3 }, C: { rpc: base + 4, p2p: base + 5 }, D: { rpc: base + 6, p2p: base + 7 } };
const links = { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] };

function startNode(name, env) {
  const n = nodes[name];
  const dir = path.join(work, `chain-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  // The topology: each node connects out to its links and to nobody else, and still takes incoming connections
  // (--use-only-priority-nodes would refuse those).
  fs.writeFileSync(path.join(dir, 'p2p_manual_config.json'), JSON.stringify({
    priority_peers_list: links[name].map((to) => `127.0.0.1:${nodes[to].p2p}`),
    outgoing_connections_limit: links[name].length,
  }));
  const args = ['--data-dir', dir, '--disable-upnp', '--disable-ntp', '--disable-stop-if-time-out-of-sync',
    '--no-console', '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(n.rpc), '--p2p-bind-ip', '127.0.0.1', '--p2p-bind-port', String(n.p2p),
    '--allow-local-ip', '--rpc-ignore-offline', '--log-level', '1'];
  start(exe('kusarid'), args, `node-${name}.log`, env);
}

function makeWallet(name) {
  const file = path.join(work, `${name}.wallet`);
  const r = spawnSync(exe('kusari-wallet'), ['--generate-new-wallet', file, '--password', 'selftest', '--offline-mode', '--no-refresh', '--log-level', '0'],
    { input: 'exit\n', encoding: 'utf8', cwd: work, timeout: 120000 });
  if (!fs.existsSync(file)) throw new Error(`could not make ${name}: ${(r.stdout || '') + (r.stderr || '')}`.slice(0, 600));
  return file;
}

function walletRpc(file, port, node, extra = []) {
  return start(exe('kusari-wallet'), ['--wallet-file', file, '--password', 'selftest', '--daemon-address', `127.0.0.1:${nodes[node].rpc}`,
    '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(port), '--unsecure-no-auth', '--no-white-list', '--log-level', '0', ...extra], `wallet-${port}.log`);
}

const log = (name) => { try { return fs.readFileSync(path.join(work, `node-${name}.log`), 'utf8'); } catch { return ''; } };

// The end of a log, for checks made while waiting (a refused block logs a long stack, so logs grow fast).
function logTail(name, bytes = 65536) {
  try {
    const file = path.join(work, `node-${name}.log`);
    const size = fs.statSync(file).size, fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

async function blocks(port, from, to) {
  const out = [];
  for (let h = from; h <= to; h += 100) out.push(...((await rpc(port, 'get_blocks_details', { height_start: h, count: Math.min(100, to - h + 1) })).blocks ?? []));
  return out;
}

async function main() {
  // A stems everything and waits long before its own fail-safe, so a broadcast it sees must come from elsewhere.
  startNode('A', { KUSARI_TEST_DANDELION_FLUFF_PERCENT: '0', KUSARI_TEST_DANDELION_EMBARGO_MS: '600000' });
  startNode('B', { KUSARI_TEST_DANDELION_FLUFF_PERCENT: '0' });
  startNode('C', { KUSARI_TEST_DANDELION_FLUFF_PERCENT: '0' });
  startNode('D', {});
  for (const n of Object.keys(nodes)) await until(`node ${n}`, () => rpc(nodes[n].rpc, 'getinfo', { flags: 0 }), 180000);
  await until('the nodes to connect', async () => {
    const counts = await Promise.all(Object.keys(nodes).map(async (n) => {
      const i = await rpc(nodes[n].rpc, 'getinfo', { flags: 0 });
      return i.outgoing_connections_count + i.incoming_connections_count;
    }));
    return counts[0] >= 2 && counts[1] >= 2 && counts[2] >= 2 && counts[3] >= 2;
  }, 180000);
  const genesis = (await rpc(nodes.A.rpc, 'getblockheaderbyheight', { height: 0 })).block_header.hash;
  console.log('genesis', genesis, '| 4 nodes connected');

  const w1 = base + 11, w2 = base + 12;
  // Wallet one also stakes from the start: proof of stake must not appear before its height.
  walletRpc(makeWallet('one'), w1, 'A', ['--do-pos-mining']);
  walletRpc(makeWallet('two'), w2, 'D');
  const a1 = (await until('wallet one', () => rpc(w1, 'getaddress'), 120000)).address;
  const a2 = (await until('wallet two', () => rpc(w2, 'getaddress'), 120000)).address;
  for (const a of [a1, a2]) {
    if (decodeAddress(a).prefix !== params.prefixes.address || a[0] !== params.leading.address) throw new Error(`address ${a} does not use the Kusari prefix`);
  }

  const started = JSON.parse(await post(nodes.A.rpc, '/start_mining', JSON.stringify({ miner_address: a1, threads_count: 2 })));
  if (started.status !== 'OK') throw new Error(`start_mining: ${JSON.stringify(started)}`);

  // Mined coins unlock after 10 blocks and a send needs 15 other outputs to hide among.
  const amount = COIN;
  let tx = null;
  let shown = 0;
  await until('a send from wallet one', async () => {
    const h = (await rpc(nodes.A.rpc, 'getinfo', { flags: 0 })).height;
    if (h !== shown) { shown = h; console.log(`height ${h}`); }
    const refused = /mined block has failed to pass verification|coinbase transaction balance check failed/.exec(logTail('A'));
    if (refused) throw Object.assign(new Error(`node A refuses its own blocks: ${refused[0]} (see ${work}/node-A.log)`), { fatal: true });
    const b = await rpc(w1, 'getbalance');
    if (BigInt(b.unlocked_balance) < amount * 2n) return false;
    const body = `{"jsonrpc":"2.0","id":0,"method":"transfer","params":{"destinations":[{"address":${JSON.stringify(a2)},"amount":${amount}}],"fee":10000000000,"mixin":15}}`;
    const j = big(await post(w1, '/json_rpc', body));
    if (j.error) { console.log(`  not yet: ${j.error.message}`); return false; }
    tx = j.result;
    return true;
  }, 6 * 3600000, 15000);
  console.log('sent', tx.tx_hash);

  // Dandelion++: A handed it to one stem peer and did not broadcast it; D, at the end of the stem, did.
  await until('D to have it', async () => (await rpc(nodes.D.rpc, 'get_pool_info', {})) && log('D').includes('[DANDELION] broadcast'), 300000, 2000);
  const aLog = log('A');
  const stems = (aLog.match(/\[DANDELION\] stem \d+ tx\(s\) to/g) || []).length;
  if (stems < 1) throw new Error('A did not send the transaction along a stem');
  if (/\[DANDELION\] (broadcast|fluff)/.test(aLog)) throw new Error('A broadcast its own transaction');
  if (!/\[DANDELION\] stem \d+ tx\(s\) to/.test(log('B') + log('C'))) throw new Error('the stem did not pass through B or C');
  console.log('dandelion ok: A stemmed it, a middle node passed it on, D broadcast it');

  await until('wallet two to receive it', async () => BigInt((await rpc(w2, 'getbalance')).balance) === amount, 3600000, 10000);

  // Proof of stake: none before its height, some after.
  await until(`height ${POS_START + 30}`, async () => (await rpc(nodes.A.rpc, 'getinfo', { flags: 0 })).height > POS_START + 30, 6 * 3600000, 15000);
  const top = (await rpc(nodes.A.rpc, 'getinfo', { flags: 0 })).height - 1;
  const all = await blocks(nodes.A.rpc, 1, top);
  const early = all.filter((b) => b.height < POS_START && b.type === 0);
  if (early.length) throw new Error(`proof-of-stake block before ${POS_START}: ${early[0].height}`);
  const pos = all.filter((b) => b.type === 0);
  if (!pos.length) throw new Error(`no proof-of-stake block after ${POS_START}`);

  // The emission, block by block: what each block added is (supply - before) >> 20, at least the tail.
  let before = BigInt((await rpc(nodes.A.rpc, 'get_blocks_details', { height_start: 0, count: 1 })).blocks[0].already_generated_coins);
  if (before !== BigInt(params.genesis.amount) * COIN) throw new Error(`genesis made ${before}`);
  for (const b of all) {
    const after = BigInt(b.already_generated_coins);
    let want = (SUPPLY - before) >> SHIFT;
    if (want < TAIL) want = TAIL;
    if (after - before !== want) throw new Error(`block ${b.height} made ${after - before}, the curve says ${want}`);
    before = after;
  }
  const total = BigInt((await rpc(nodes.A.rpc, 'getinfo', { flags: 0x8000 })).total_coins ?? before);
  console.log(`emission ok: ${all.length} blocks, block 1 made ${Number(BigInt(all[0].already_generated_coins) - COIN) / 1e12} KSR, ${Number(total) / 1e12} KSR in all`);

  await post(nodes.A.rpc, '/stop_mining', '{}');
  console.log(`selftest ok: height ${top + 1}, ${all.length - pos.length} PoW (RandomKSR) and ${pos.length} PoS blocks (none before ${POS_START}), tx ${tx.tx_hash}`);
}

main()
  .then(() => 0, (e) => { console.error('selftest failed:', e.message, '\nlogs in', work); return 1; })
  .then((code) => {
    for (const c of children) c.kill('SIGTERM');
    setTimeout(() => process.exit(code), 4000);
  });
