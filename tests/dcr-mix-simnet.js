// Decred mixing against dcrwallet on a local simnet: this wallet's mixing client (over the peer-to-peer network,
// through dcrd) mixes one coin in the same session as three coins dcrwallet mixes with `mixoutput`. Needs the simnet
// of tests/dcr-simnet.js, with the second dcrwallet (RPC 19558; 2.1.6 or later, which mixes with mixing v0.7.x)
// started with --mixing --mixedaccount=mixed/0 --changeaccount=default, and dcrd listening for peers on 127.0.0.1:18555.
//
//   DCR_SIM=/path/to/run node tests/dcr-mix-simnet.js
//
// Mixing epochs are ten minutes, and the client listens for one epoch first: a run takes 10 to 25 minutes.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { randomBytes } = require('node:crypto');

const SIM = process.env.DCR_SIM;
if (!SIM) { console.error('Set DCR_SIM to the simnet run directory.'); process.exit(2); }
const dcr = require('../dist/main/dcr');
dcr.useDcrNetwork('simnet');
const { MixPool, MixClient, CoinJoin } = require('../dist/main/dcr-mix');
const { MixNetwork } = require('../dist/main/dcr-mixnet');
const { tcpDial } = require('../dist/main/dash-net');
const { secp256k1 } = require('@noble/curves/secp256k1.js');

function rpc(port, cert, method, params = [], timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 1, method, params });
    const req = https.request({ host: '127.0.0.1', port, method: 'POST', auth: 'u:p', ca: fs.readFileSync(cert), checkServerIdentity: () => undefined, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { const j = JSON.parse(b); if (j.error) reject(new Error(j.error.message)); else resolve(j.result); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });
}
const dcrd = (m, p) => rpc(19556, path.join(SIM, 'dcrd', 'rpc.cert'), m, p);
const w1 = (m, p) => rpc(19557, path.join(SIM, 'w1', 'rpc.cert'), m, p);
const w2 = (m, p, t) => rpc(19558, path.join(SIM, 'w2', 'rpc.cert'), m, p, t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function mineWith(ids) {
  for (let i = 0; i < 60; i++) {
    const pool = await dcrd('getrawmempool', [false, 'all']);
    if (ids.every((id) => pool.includes(id))) break;
    await sleep(500);
  }
  await sleep(31_000); // dcrd remakes its block template for new transactions every 30 s
  await dcrd('generate', [1]);
  await sleep(1500);
}

const COIN = 1_060_000; // four of the smallest denomination (2^18 atoms) and the fee
const MIX_VALUE = 1n << 18n;

async function main() {
  // A coin of this wallet's, and three of dcrwallet's.
  const priv = secp256k1.utils.randomSecretKey();
  const mine = dcr.dcrAddressOf(secp256k1.getPublicKey(priv, true));
  await w1('walletpassphrase', ['123', 0]).catch(() => undefined);
  await w2('walletpassphrase', ['123', 0]).catch(() => undefined);
  const theirs = [];
  for (let i = 0; i < 3; i++) theirs.push(await w2('getnewaddress', ['default']));
  const ids = [await w1('sendtoaddress', [mine, COIN / 1e8])];
  for (const a of theirs) ids.push(await w1('sendtoaddress', [a, COIN / 1e8]));
  await mineWith(ids);
  const fundTx = await dcrd('getrawtransaction', [ids[0], 1]);
  const vout = fundTx.vout.find((o) => (o.scriptPubKey.addresses ?? []).includes(mine)).n;
  log('funded; height', await dcrd('getblockcount'));

  let height = await dcrd('getblockcount');
  const tick = setInterval(() => { dcrd('getblockcount').then((h) => { height = h; }, () => undefined); }, 5_000);
  const pool = new MixPool(600_000, () => height, 3600);
  const net = new MixNetwork({
    net: 'simnet', dial: tcpDial(undefined), nodes: [{ host: '127.0.0.1', port: 18555 }], height: () => height, peers: 1,
    publishBackup: async (hex) => { await dcrd('sendrawtransaction', [hex]).catch((e) => { if (!/already/.test(e.message)) throw e; }); },
    log: (s) => log('net', s),
  });
  await net.start(pool);
  assert.equal(net.connected, 1, 'connected to dcrd');
  const client = new MixClient(pool, net, { epochMs: 600_000, stageTimeoutMs: 30_000, pairingVersion: 3, solveRoots: true, log: (s) => log('mix', s) });

  const outs = [];
  const cj = new CoinJoin([{ txid: ids[0], vout, tree: 0, value: BigInt(COIN), script: dcr.dcrScript(mine), priv }], null, MIX_VALUE, height + 3599, 4,
    (n) => Array.from({ length: n }, () => { const k = secp256k1.utils.randomSecretKey(); const pub = secp256k1.getPublicKey(k, true); outs.push(dcr.dcrAddressOf(pub)); return dcr.hash160(pub); }));
  const ours = client.dicemix(cj);

  // dcrwallet's three, once this client has been listening (its PRs must be announced to us).
  const unspent = (await w2('listunspent', [1])).filter((u) => Math.round(u.amount * 1e8) === COIN && ids.includes(u.txid)); // this run's (an earlier run may have left some)
  assert.equal(unspent.length, 3);
  await sleep(Math.max(0, Math.ceil(Date.now() / 600_000) * 600_000 - Date.now() + 40_000));
  log('dcrwallet mixes its coins');
  const theirsDone = unspent.map((u) => w2('mixoutput', [`${u.txid}:${u.vout}`], 40 * 60_000).then(() => 'ok', (e) => e.message));

  const txid = await ours;
  log('mixed in', txid, 'dcrwallet:', await Promise.all(theirsDone));
  await mineWith([txid]);
  const tx = await dcrd('getrawtransaction', [txid, 1]);
  assert.ok(tx.confirmations >= 1, 'the mix is in a block');
  const values = tx.vout.map((o) => Math.round(o.value * 1e8));
  assert.equal(values.filter((v) => v === Number(MIX_VALUE)).length, 16, 'sixteen mixed outputs of one size');
  for (const a of outs) assert.ok(tx.vout.some((o) => (o.scriptPubKey.addresses ?? []).includes(a)), 'our outputs are in it');
  log('ok: inputs', tx.vin.length, 'outputs', tx.vout.length);
  clearInterval(tick); client.stop(); net.stop();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
