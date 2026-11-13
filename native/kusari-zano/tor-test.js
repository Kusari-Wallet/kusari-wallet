#!/usr/bin/env node
'use strict';
// A node that sends its own transactions only through Tor (--tx-proxy-tor), on a private chain on this machine.
//   node native/kusari-zano/tor-test.js <build/src with kusarid and kusari-wallet>
//
// A ──► D    A mines and sends; it is connected to D, and its transactions must reach D only through the SOCKS5
//            proxy (a stand-in for Tor written here, which records what it is asked and passes it on), never over
//            that connection. Wallet two (the receiver) is on D.
//
// 1. With the proxy up: the transaction goes through it, as a host name (never resolved by the node) with a SOCKS
//    login (Tor's circuit isolation); A sends nothing to its peer; D broadcasts it; wallet two gets it.
// 2. With the proxy down: A keeps trying, sends nothing to its peer, and no node shows the transaction.
// 3. With the proxy back: A's next try gets it through.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const params = JSON.parse(fs.readFileSync(path.join(__dirname, 'params.json'), 'utf8'));
const bin = path.resolve(process.argv[2] || '.');
const exe = (name) => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kusari-tor-'));
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COIN = 10n ** 12n;
const base = params.ports.rpc + 5000;
const nodes = { A: { rpc: base, p2p: base + 1 }, D: { rpc: base + 2, p2p: base + 3 } };
const SOCKS = base + 9, W1 = base + 11, W2 = base + 12;

function post(port, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', timeout: 120000,
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
const big = (text) => JSON.parse(text.replace(/("(?:balance|unlocked_balance|amount)"\s*:\s*)(\d+)/g, '$1"$2"'));
async function rpc(port, method, p = {}) {
  const j = big(await post(port, '/json_rpc', JSON.stringify({ jsonrpc: '2.0', id: 0, method, params: p })));
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}
async function until(what, fn, ms, every = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch (e) { if (e.fatal) throw e; }
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
const log = (name) => { try { return fs.readFileSync(path.join(work, name), 'utf8'); } catch { return ''; } };

// A SOCKS5 proxy, as Tor's looks from outside: user name/password login (any), CONNECT by host name.
const asked = [];
let socksServer = null;
function socksUp() {
  socksServer = net.createServer((c) => {
    let buf = Buffer.alloc(0), stage = 0, user = '';
    const need = (n) => buf.length >= n;
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0 && need(2) && need(2 + buf[1])) {
          const methods = [...buf.subarray(2, 2 + buf[1])];
          buf = buf.subarray(2 + methods.length);
          if (methods.includes(2)) { c.write(Buffer.from([5, 2])); stage = 1; } else { c.write(Buffer.from([5, 0])); stage = 2; }
        } else if (stage === 1 && need(2) && need(2 + buf[1] + 1) && need(3 + buf[1] + buf[2 + buf[1]])) {
          const ul = buf[1];
          user = buf.subarray(2, 2 + ul).toString();
          buf = buf.subarray(3 + ul + buf[2 + ul]);
          c.write(Buffer.from([1, 0]));
          stage = 2;
        } else if (stage === 2 && need(5) && buf[3] === 3 && need(7 + buf[4])) {
          const host = buf.subarray(5, 5 + buf[4]).toString();
          const port = buf.readUInt16BE(5 + buf[4]);
          buf = buf.subarray(7 + buf[4]);
          asked.push({ host, port, user, atyp: 3 });
          stage = 3;
          const up = net.connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
            c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            if (buf.length) up.write(buf);
            c.pipe(up);
            up.pipe(c);
          });
          up.on('error', () => { c.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); });
          return;
        } else if (stage === 2 && need(4) && buf[3] !== 3) {
          asked.push({ atyp: buf[3] });
          c.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        } else {
          return;
        }
      }
    });
    c.on('error', () => {});
  });
  return new Promise((r) => socksServer.listen(SOCKS, '127.0.0.1', r));
}
const socksDown = () => new Promise((r) => { socksServer.close(r); socksServer = null; });

function startNode(name, extra, links) {
  const n = nodes[name];
  const dir = path.join(work, `chain-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'p2p_manual_config.json'), JSON.stringify({
    priority_peers_list: links.map((to) => `127.0.0.1:${nodes[to].p2p}`), outgoing_connections_limit: links.length }));
  start(exe('kusarid'), ['--data-dir', dir, '--disable-upnp', '--disable-ntp', '--disable-stop-if-time-out-of-sync', '--no-console',
    '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(n.rpc), '--p2p-bind-ip', '127.0.0.1', '--p2p-bind-port', String(n.p2p),
    '--allow-local-ip', '--rpc-ignore-offline', '--log-level', '1', ...extra], `node-${name}.log`);
}
function makeWallet(name) {
  const file = path.join(work, `${name}.wallet`);
  spawnSync(exe('kusari-wallet'), ['--generate-new-wallet', file, '--password', 'tortest', '--offline-mode', '--no-refresh', '--log-level', '0'],
    { input: 'exit\n', encoding: 'utf8', cwd: work, timeout: 120000 });
  if (!fs.existsSync(file)) throw new Error(`could not make ${name}`);
  return file;
}
function walletRpc(file, port, node) {
  start(exe('kusari-wallet'), ['--wallet-file', file, '--password', 'tortest', '--daemon-address', `127.0.0.1:${nodes[node].rpc}`,
    '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(port), '--unsecure-no-auth', '--no-white-list', '--log-level', '0'], `wallet-${port}.log`);
}
async function send(to, amount) {
  return until('a send from wallet one', async () => {
    const b = await rpc(W1, 'getbalance');
    if (BigInt(b.unlocked_balance) < amount * 2n) return false;
    const body = `{"jsonrpc":"2.0","id":0,"method":"transfer","params":{"destinations":[{"address":${JSON.stringify(to)},"amount":${amount}}],"fee":10000000000,"mixin":15}}`;
    const j = big(await post(W1, '/json_rpc', body));
    return j.error ? false : j.result.tx_hash;
  }, 3 * 3600000, 15000);
}
const shown = async (n, h) => ((await rpc(nodes[n].rpc, 'get_all_pool_tx_list', {})).ids ?? []).includes(h);
const known = async (n, h) => !!(await rpc(nodes[n].rpc, 'get_tx_details', { tx_hash: h }).catch(() => null));
// What A told its peer: any stem or broadcast of a transaction is a leak.
const aLeaks = () => /\[DANDELION\] (stem|broadcast|fluff)/.test(log('node-A.log'));

async function main() {
  await socksUp();
  startNode('D', [], []);
  startNode('A', ['--tx-proxy-tor', `127.0.0.1:${SOCKS}`, '--tx-proxy-node', `localhost:${nodes.D.rpc}`], ['D']);
  for (const n of Object.keys(nodes)) await until(`node ${n}`, () => rpc(nodes[n].rpc, 'getinfo', { flags: 0 }), 180000);
  await until('A to connect to D', async () => (await rpc(nodes.A.rpc, 'getinfo', { flags: 0 })).outgoing_connections_count >= 1, 180000);
  if (!/\[TOR\] this node's own transactions go only through Tor/.test(log('node-A.log'))) throw new Error('A did not take the Tor setting');

  walletRpc(makeWallet('one'), W1, 'A');
  walletRpc(makeWallet('two'), W2, 'D');
  const a1 = (await until('wallet one', () => rpc(W1, 'getaddress'), 120000)).address;
  const a2 = (await until('wallet two', () => rpc(W2, 'getaddress'), 120000)).address;
  const started = JSON.parse(await post(nodes.A.rpc, '/start_mining', JSON.stringify({ miner_address: a1, threads_count: 2 })));
  if (started.status !== 'OK') throw new Error(`start_mining: ${JSON.stringify(started)}`);

  // 1. Through the proxy.
  const t1 = await send(a2, COIN);
  console.log('sent', t1);
  await until('the proxy to carry it', async () => asked.length > 0 && /\[TOR\] sent tx/.test(log('node-A.log')), 300000, 1000);
  const q = asked[0];
  if (q.atyp !== 3 || q.host !== 'localhost' || q.port !== nodes.D.rpc) throw new Error(`the proxy was asked for ${JSON.stringify(q)}`);
  if (!q.user) throw new Error('no SOCKS login: Tor could not give the transaction a circuit of its own');
  await until('wallet two to receive it', async () => BigInt((await rpc(W2, 'getbalance')).balance) === COIN, 1800000, 10000);
  if (aLeaks()) throw new Error('A sent a transaction to its peer');
  console.log(`tor ok: through the proxy as "${q.host}:${q.port}" with a SOCKS login, D broadcast it, wallet two has it, A told its peer nothing`);

  // 2. Proxy down: retried, never sent to the peer, shown by nobody.
  await socksDown();
  const before = asked.length;
  const t2 = await send(a2, COIN);
  console.log('sent', t2, 'with the proxy down');
  // Node logs reach their files late, so this waits a fixed time: A's first try and its retry 15 s later both fail.
  await sleep(25000);
  if (await known('D', t2) || await shown('D', t2)) throw new Error('D has the transaction although the proxy is down');
  if (await shown('A', t2) || await known('A', t2)) throw new Error('A shows a transaction it has not got out yet');
  if (aLeaks()) throw new Error('A sent the transaction to its peer with the proxy down');
  console.log('no fallback ok: A kept trying through Tor, told its peer nothing, showed it to nobody');

  // 3. Proxy back: the next try gets it through.
  await socksUp();
  await until('the retry', async () => asked.length > before, 300000, 1000);
  await until('A to log its failed tries', async () => /\[TOR\] could not send tx/.test(log('node-A.log')), 600000, 2000);
  await until('wallet two to receive the second', async () => BigInt((await rpc(W2, 'getbalance')).balance) === 2n * COIN, 1800000, 10000);
  if (asked.length > before && asked[before].user === q.user) throw new Error('two sends shared a SOCKS login (one Tor circuit)');
  if (aLeaks()) throw new Error('A sent a transaction to its peer');
  console.log('retry ok: through Tor once the proxy was back, on a circuit of its own');
  await post(nodes.A.rpc, '/stop_mining', '{}');
  console.log('tor test ok');
}

main()
  .then(() => 0, (e) => { console.error('tor test failed:', e.message, '\nlogs in', work); return 1; })
  .then((code) => {
    for (const c of children) c.kill('SIGTERM');
    if (socksServer) socksServer.close();
    setTimeout(() => process.exit(code), 4000);
  });
