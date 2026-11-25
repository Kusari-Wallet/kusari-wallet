// Silent Payments receiving against two real Bitcoin Core nodes on regtest (by hand): a payment to this wallet's sp1
// address, made by this wallet's own sender, found from block filters and a stand-in tweak server that works the
// tweaks out of the nodes' blocks; then the found coin spent, the node taking it, and the spend seen.
//
//   BTC_BIN=/path/to/bitcoin-28.x/bin node tests/sp-regtest.js
const assert = require('node:assert');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const BIN = process.env.BTC_BIN;
if (!BIN) { console.error('Set BTC_BIN to the folder with bitcoind and bitcoin-cli.'); process.exit(2); }
const { FilterSync } = require('../dist/main/btc-filter-sync');
const { BTC_P2P } = require('../dist/main/p2p-net');
const { plainRecords } = require('../dist/main/records');
const { BtcClient, BITCOIN, btcAccountXpub, signBtcDraft, silentKeys, SP_CHAIN } = require('../dist/main/btc');
const { encodeSilentAddress } = require('../dist/main/btc-silent');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1.js');
const { bech32, bech32m } = require('@scure/base');

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rt-'));
const nodes = [{ port: 18444, rpc: 18443 }, { port: 18544, rpc: 18543 }];
const cli = (n, ...args) => execFileSync(path.join(BIN, 'bitcoin-cli'), ['-regtest', `-rpcport=${nodes[n].rpc}`, '-rpcuser=u', '-rpcpassword=p', ...args], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const toRegtest = (addr) => { const d = (addr.startsWith('bc1p') ? bech32m : bech32).decode(addr); return (addr.startsWith('bc1p') ? bech32m : bech32).encode('bcrt', d.words); };
const P = secp256k1.Point; const N = P.Fn.ORDER;
const big = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));

/** A block's tweaks as an index server works them out: taproot key-path inputs only, which is all this test makes. */
function tweaksOf(height) {
  const block = JSON.parse(cli(0, 'getblock', cli(0, 'getblockhash', String(height)), '3'));
  const out = [];
  for (const tx of block.tx) {
    if (tx.vin[0].coinbase || !tx.vout.some((o) => o.scriptPubKey.type === 'witness_v1_taproot')) continue;
    const keys = tx.vin.filter((i) => i.prevout?.scriptPubKey.type === 'witness_v1_taproot').map((i) => P.fromHex('02' + i.prevout.scriptPubKey.hex.slice(4)));
    if (!keys.length) continue;
    const A = keys.reduce((x, y) => x.add(y));
    const outpoints = tx.vin.map((i) => { const b = Buffer.alloc(36); Buffer.from(i.txid, 'hex').reverse().copy(b); b.writeUInt32LE(i.vout, 32); return b; }).sort(Buffer.compare);
    const ih = big(schnorr.utils.taggedHash('BIP0352/Inputs', outpoints[0], A.toBytes(true)));
    out.push(Buffer.from(A.multiply(ih % N).toBytes(true)).toString('hex'));
  }
  // Someone else's payments in every block, so matching has more than one candidate to go through.
  for (let i = 0; i < 5; i++) out.push(Buffer.from(P.BASE.multiply(BigInt(height * 10 + i + 1)).toBytes(true)).toString('hex'));
  return out;
}

async function main() {
  nodes.forEach((n, i) => {
    const dir = path.join(root, `n${i}`); fs.mkdirSync(dir);
    spawn(path.join(BIN, 'bitcoind'), ['-regtest', `-datadir=${dir}`, `-port=${n.port}`, `-rpcport=${n.rpc}`, '-rpcuser=u', '-rpcpassword=p', '-peerblockfilters=1', '-blockfilterindex=1', '-txindex=1', '-fallbackfee=0.0002', '-listen=1', '-bind=127.0.0.1', '-discover=0', '-dnsseed=0', ...(i ? [`-connect=127.0.0.1:${nodes[0].port}`] : [])], { stdio: 'ignore' });
  });
  for (let i = 0; i < 60; i++) { try { cli(0, 'getblockcount'); cli(1, 'getblockcount'); break; } catch { await sleep(500); } }
  cli(0, 'createwallet', 'w');
  const mine = (n) => { cli(0, 'generatetoaddress', String(n), cli(0, 'getnewaddress')); };
  const synced = async () => { for (let i = 0; i < 60 && cli(1, 'getblockcount') !== cli(0, 'getblockcount'); i++) await sleep(250); };
  mine(1010);

  const client = new BtcClient(btcAccountXpub(M), ['http://127.0.0.1:9'], undefined, 5_000, BITCOIN);
  const receive = client.addressAt(0, 0);
  const fundTx = cli(0, 'sendtoaddress', toRegtest(receive), '1.5');
  mine(1); await synced();

  // The stand-in tweak server.
  const asked = new Set();
  const server = http.createServer((req, res) => {
    const m = /^\/tweak-index\/(\d+)/.exec(req.url);
    if (!m) { res.writeHead(404).end(); return; }
    asked.add(Number(m[1]));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(tweaksOf(Number(m[1]))));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const tweakUrl = `http://127.0.0.1:${server.address().port}`;
  const getTweaks = async (h) => {
    const body = await new Promise((res, rej) => http.get(`${tweakUrl}/tweak-index/${h}?dustLimit=0`, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej));
    return JSON.parse(body).map((t) => Uint8Array.from(Buffer.from(t, 'hex')));
  };

  const regNet = { ...BTC_P2P, magic: Buffer.from('fabfb5da', 'hex'), port: 18444, seeds: nodes.map((n) => `127.0.0.1:${n.port}`), powLimit: (1n << 255n) - 1n, nextBits: (bits) => bits };
  const dial = (host, port) => new Promise((res, rej) => {
    const s = net.connect(port, host, () => res({ write: (b) => s.write(b), close: () => s.destroy(), onData: (cb) => s.on('data', cb), onClose: (cb) => s.on('close', () => cb()) }));
    s.on('error', rej);
  });
  const dir = path.join(root, 'wallet'); fs.mkdirSync(dir);
  const sync = new FilterSync({ dir, records: plainRecords, dial, birthday: 1001, net: regNet, checkpoints: [{ height: 0, hash: cli(0, 'getblockhash', '0'), minDifficulty: 0 }] });
  client.useFilters(sync, 'btc');
  const keys = silentKeys(M);
  const spAddress = encodeSilentAddress(keys.scanPub, keys.spendPub);
  const from = Number(cli(0, 'getblockcount')) + 1;
  client.useSilent({ scanKey: keys.scan, spendPub: keys.spendPub, from, tweaks: getTweaks });
  await sync.sync(true);
  let v = sync.view('btc');
  assert.deepEqual(v.coins.map((c) => c.txid), [fundTx], 'the funding coin found');
  log('ok funding coin found; paying', spAddress.slice(0, 20) + '…');

  // Pay this wallet's own sp1 address from it.
  const c = v.coins[0];
  const change = client.addressAt(1, 0);
  const pay = { to: spAddress, amount: 60_000_000n, fee: 20_000n, change: 150_000_000n - 60_000_000n - 20_000n, changeAddress: change, changePath: [1, 0], inputs: [{ txid: c.txid, vout: c.vout, value: BigInt(c.value), address: receive, chain: 0, index: 0, confirmed: true }] };
  const sent = signBtcDraft(pay, M);
  assert.ok(await sync.broadcast(Buffer.from(sent.hex, 'hex')) >= 1, 'a peer took the payment');
  for (let i = 0; i < 40 && !JSON.parse(cli(0, 'getrawmempool')).includes(sent.id); i++) await sleep(250);
  mine(1); await synced();
  mine(2); await synced(); // blocks after it, with no payment, are scanned too
  await sleep(21_000);
  await sync.sync(true);
  const tip = Number(cli(0, 'getblockcount'));
  for (let h = from; h <= tip; h++) assert.ok(asked.has(h), `tweaks asked for block ${h}`);
  assert.ok(![...asked].some((h) => h < from), 'no tweaks asked before the start block');
  const sp = sync.view('btc:sp');
  assert.deepEqual(sp.coins.map((x) => [x.txid, x.value]), [[sent.id, '60000000']], 'the Silent Payments coin found');
  const coins = await client.coins();
  const spCoin = coins.find((u) => u.chain === SP_CHAIN);
  assert.ok(spCoin && spCoin.tweak, 'the client lists it, with its tweak');
  const onChain = JSON.parse(cli(0, 'getrawtransaction', sent.id, '1')).vout.find((o) => Math.round(o.value * 1e8) === 60_000_000);
  assert.equal(toRegtest(spCoin.address), onChain.scriptPubKey.address, 'the coin\'s address is the output on chain');
  log('ok payment found from filters and tweaks; address matches the chain');

  // Spend it: the key is the spend key plus the tweak.
  const to = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const spend = { to, amount: 59_980_000n, fee: 20_000n, change: 0n, changeAddress: change, changePath: [1, 1], inputs: [spCoin] };
  const signed = signBtcDraft(spend, M);
  const accept = JSON.parse(cli(0, 'testmempoolaccept', JSON.stringify([signed.hex])))[0];
  assert.ok(accept.allowed, `the node accepts the spend: ${accept['reject-reason']}`);
  assert.ok(await sync.broadcast(Buffer.from(signed.hex, 'hex')) >= 1, 'a peer took the spend');
  for (let i = 0; i < 40 && !JSON.parse(cli(0, 'getrawmempool')).includes(signed.id); i++) await sleep(250);
  mine(1); await synced();
  await sleep(21_000);
  await sync.sync(true);
  assert.deepEqual(sync.view('btc:sp').coins, [], 'the spend seen');
  log('ok spent with the tweaked key; the spend seen');
  server.close();
  sync.close();
}

main().then(() => { cli(0, 'stop'); cli(1, 'stop'); process.exit(0); }, (e) => { console.error(e); try { cli(0, 'stop'); cli(1, 'stop'); } catch { /* */ } process.exit(1); });
