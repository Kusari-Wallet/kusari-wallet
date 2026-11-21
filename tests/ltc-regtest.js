// Private Litecoin sync against two real Litecoin Core nodes on regtest (by hand): block filters from both, a coin
// found, a send handed to the peers and its spend and change found, all across MWEB blocks (HogEx transactions).
//
//   LTC_BIN=/path/to/litecoin-0.21.x/bin node tests/ltc-regtest.js
//
// Starts litecoind twice (ports 19444/19544, RPC 19443/19543) in a temporary folder, activates MWEB with a peg-in,
// and stops both at the end.
const assert = require('node:assert');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const BIN = process.env.LTC_BIN;
if (!BIN) { console.error('Set LTC_BIN to the folder with litecoind and litecoin-cli.'); process.exit(2); }
const { FilterSync } = require('../dist/main/btc-filter-sync');
const { LTC_P2P } = require('../dist/main/p2p-net');
const { plainRecords } = require('../dist/main/records');
const { BtcClient, LITECOIN, ltcAccountXpub, signLtcDraft } = require('../dist/main/btc');
const { bech32 } = require('@scure/base');

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltc-rt-'));
const nodes = [{ port: 19444, rpc: 19443 }, { port: 19544, rpc: 19543 }];
const cli = (n, ...args) => execFileSync(path.join(BIN, 'litecoin-cli'), ['-regtest', `-rpcport=${nodes[n].rpc}`, '-rpcuser=u', '-rpcpassword=p', ...args], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// The same witness program under regtest's prefix, so litecoind can pay this wallet's addresses.
const regtest = (addr) => { const d = bech32.decode(addr); return bech32.encode('rltc', d.words); };

async function main() {
  nodes.forEach((n, i) => {
    const dir = path.join(root, `n${i}`); fs.mkdirSync(dir);
    spawn(path.join(BIN, 'litecoind'), ['-regtest', `-datadir=${dir}`, `-port=${n.port}`, `-rpcport=${n.rpc}`, '-rpcuser=u', '-rpcpassword=p', '-peerblockfilters=1', '-blockfilterindex=1', '-fallbackfee=0.0002', '-listen=1', '-bind=127.0.0.1', '-discover=0', '-dnsseed=0', '-debug=net', ...(i ? [`-connect=127.0.0.1:${nodes[0].port}`] : [])], { stdio: 'ignore' });
  });
  for (let i = 0; i < 60; i++) { try { cli(0, 'getblockcount'); cli(1, 'getblockcount'); break; } catch { await sleep(500); } }
  cli(0, 'createwallet', 'w');
  const mine = (n) => { cli(0, 'generatetoaddress', String(n), cli(0, 'getnewaddress')); };
  mine(431);
  cli(0, 'sendtoaddress', cli(0, 'getnewaddress', '', 'mweb'), '5'); // a peg-in: MWEB blocks from here on
  mine(600); // past block 1000: scanning starts on a thousandth block, from the peers' filter checkpoints

  const client = new BtcClient(ltcAccountXpub(M), ['http://127.0.0.1:9'], undefined, 5_000, LITECOIN);
  const receive = client.addressAt(0, 0);
  const change = client.addressAt(1, 0);
  const coinTx = cli(0, 'sendtoaddress', regtest(receive), '1.25');
  cli(0, 'sendtoaddress', cli(0, 'getnewaddress', '', 'mweb'), '1'); // more MWEB in the same block
  mine(1);
  for (let i = 0; i < 40 && cli(1, 'getblockcount') !== cli(0, 'getblockcount'); i++) await sleep(250);
  log('chain at', cli(0, 'getblockcount'), 'coin', coinTx.slice(0, 16));

  const regNet = {
    ...LTC_P2P, name: 'Litecoin', magic: Buffer.from('fabfb5da', 'hex'), port: 19444, seeds: nodes.map((n) => `127.0.0.1:${n.port}`),
    powLimit: (1n << 255n) - 1n, nextBits: (bits) => bits, // regtest: no retargeting
  };
  const dial = (host, port) => new Promise((res, rej) => {
    const s = net.connect(port, host, () => res({ write: (b) => s.write(b), close: () => s.destroy(), onData: (cb) => s.on('data', cb), onClose: (cb) => s.on('close', () => cb()) }));
    s.on('error', rej);
  });
  const dir = path.join(root, 'wallet'); fs.mkdirSync(dir);
  const sync = new FilterSync({ dir, records: plainRecords, dial, birthday: 1001, net: regNet, checkpoints: [{ height: 0, hash: cli(0, 'getblockhash', '0'), minDifficulty: 0 }] });
  client.useFilters(sync, 'ltc');
  await sync.sync(true);
  let v = sync.view('ltc');
  assert.equal(v.tip, Number(cli(0, 'getblockcount')));
  assert.deepEqual(v.coins.map((c) => [c.txid, c.value]), [[coinTx, '125000000']], 'the coin, found from filters across MWEB blocks');
  log('ok coin found from filters');

  // A send from it, signed here and handed to the peers (not to any server).
  const c = v.coins[0];
  const to = 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9';
  const draft = { to, amount: 50_000_000n, fee: 20_000n, change: 125_000_000n - 50_000_000n - 20_000n, changeAddress: change, changePath: [1, 0], inputs: [{ txid: c.txid, vout: c.vout, value: BigInt(c.value), address: receive, chain: 0, index: 0, confirmed: true }] };
  const { hex, id } = signLtcDraft(draft, M);
  const took = await sync.broadcast(Buffer.from(hex, 'hex'));
  assert.ok(took >= 1, 'a peer took the send');
  for (let i = 0; i < 40 && !JSON.parse(cli(0, 'getrawmempool')).includes(id); i++) await sleep(250);
  assert.ok(JSON.parse(cli(0, 'getrawmempool')).includes(id), 'in the node\'s mempool');
  mine(1);
  for (let i = 0; i < 40 && cli(1, 'getblockcount') !== cli(0, 'getblockcount'); i++) await sleep(250);
  await sleep(21_000); // a forced sync waits 20 s after the last one
  await sync.sync(true);
  v = sync.view('ltc');
  console.log(JSON.stringify(v.coins));
  assert.deepEqual(v.coins.map((x) => [x.txid, x.value, x.chain]), [[id, String(draft.change), 1]], 'the coin spent, the change found');
  log('ok send over the peers; spend and change found');
  sync.close();
}

main().then(() => { cli(0, 'stop'); cli(1, 'stop'); process.exit(0); }, (e) => { console.error(e); try { cli(0, 'stop'); cli(1, 'stop'); } catch { /* */ } process.exit(1); });
