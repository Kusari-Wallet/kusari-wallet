// Decred staking end to end on a local simnet: dcrd, two dcrwallets (one buying and voting its own tickets, one as
// the VSP's voting wallet) and vspd, as set up in DCR_SIM (see the comment at the end). A stand-in for dcrdata's
// Insight and stake API reads dcrd. The wallet service buys two tickets through vspd, the VSP broadcasts them and
// the fee transactions, the tickets vote, and the rewards are spent from the stake tree.
//
//   DCR_SIM=/path/to/run node tests/dcr-simnet.js
//
// Not part of `npm test`: it needs the simnet running.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { generateMnemonic } = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english');

const SIM = process.env.DCR_SIM;
if (!SIM) { console.error('Set DCR_SIM to the simnet run directory.'); process.exit(2); }
const VSP = process.env.DCR_VSP ?? 'http://127.0.0.1:8800';
const PORTS = { dcrd: 19556, w1: 19557 };

const dcr = require('../dist/main/dcr');
dcr.useDcrNetwork('simnet');
const stake = require('../dist/main/dcr-stake');
const { WalletService } = require('../dist/main/service');

function rpc(port, cert, method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 1, method, params });
    const req = https.request({ host: '127.0.0.1', port, method: 'POST', auth: 'u:p', ca: fs.readFileSync(cert), checkServerIdentity: () => undefined, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; });
      res.on('end', () => { try { const j = JSON.parse(b); if (j.error) reject(new Error(j.error.message)); else resolve(j.result); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const dcrd = (m, p) => rpc(PORTS.dcrd, path.join(SIM, 'dcrd', 'rpc.cert'), m, p);
const w1 = (m, p) => rpc(PORTS.w1, path.join(SIM, 'w1', 'rpc.cert'), m, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const atoms = (v) => Math.round(Number(v) * 1e8);

// ---- a stand-in for dcrdata, read from dcrd ----

const blocks = new Map(); // height -> { hash, time, txs }
async function chain() {
  const tip = await dcrd('getblockcount');
  for (const [h, b] of blocks) if (h > tip || (h === tip && b.hash !== await dcrd('getblockhash', [h]))) blocks.delete(h);
  for (let h = 1; h <= tip; h++) {
    if (blocks.has(h)) continue;
    const hash = await dcrd('getblockhash', [h]);
    const b = await dcrd('getblock', [hash, true, true]);
    blocks.set(h, { hash, time: b.time, txs: [...(b.rawtx ?? []), ...(b.rawstx ?? [])] });
  }
  const txs = new Map();
  for (const [h, b] of blocks) for (const tx of b.txs) txs.set(tx.txid, { tx, height: h, time: b.time });
  for (const id of await dcrd('getrawmempool', [false, 'all'])) {
    try { txs.set(id, { tx: await dcrd('getrawtransaction', [id, 1]), height: null, time: Math.floor(Date.now() / 1000) }); } catch { /* gone */ }
  }
  const spent = new Map();
  for (const { tx } of txs.values()) for (const v of tx.vin) if (v.txid) spent.set(`${v.txid}:${v.vout}`, tx);
  return { tip, txs, spent };
}

async function standIn(q, r, body) {
  const json = (x, status = 200) => { r.statusCode = status; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(x)); };
  const url = q.url.split('?')[0];
  let m;
  if (url === '/api/block/best/height') return json(await dcrd('getblockcount'));
  if (url === '/api/stake/diff') return json(await dcrd('getstakedifficulty'));
  if (q.method === 'POST' && url === '/insight/api/tx/send') {
    try { return json({ txid: await dcrd('sendrawtransaction', [JSON.parse(body).rawtx]) }); } catch (e) { return json({ message: e.message }, 400); }
  }
  const c = await chain();
  const conf = (e) => (e.height === null ? 0 : c.tip - e.height + 1);
  if ((m = url.match(/^\/insight\/api\/addr\/(\w+)\/utxo$/))) {
    const rows = [];
    for (const [id, e] of c.txs) for (const o of e.tx.vout) {
      if (!(o.scriptPubKey.addresses ?? []).includes(m[1]) || o.value <= 0 || c.spent.has(`${id}:${o.n}`) || o.scriptPubKey.type === 'sstxcommitment') continue;
      rows.push({ address: m[1], txid: id, vout: o.n, scriptPubKey: o.scriptPubKey.hex, atoms: atoms(o.value), satoshis: atoms(o.value), amount: o.value, height: e.height ?? 0, confirmations: conf(e) });
    }
    return json(rows);
  }
  if ((m = url.match(/^\/insight\/api\/addrs\/(\w+)\/txs$/))) {
    const items = [];
    for (const [id, e] of c.txs) {
      const outs = e.tx.vout.map((o) => ({ value: o.value, scriptPubKey: { addresses: o.scriptPubKey.addresses ?? [] } }));
      const ins = e.tx.vin.map((v) => { const p = v.txid && c.txs.get(v.txid)?.tx.vout[v.vout]; return { addr: p?.scriptPubKey.addresses?.[0], value: p?.value ?? 0 }; });
      if (outs.some((o) => o.scriptPubKey.addresses.includes(m[1])) || ins.some((v) => v.addr === m[1])) items.push({ txid: id, confirmations: conf(e), time: e.time, vin: ins, vout: outs });
    }
    return json({ items, totalItems: items.length });
  }
  if ((m = url.match(/^\/insight\/api\/tx\/(\w+)$/))) { const e = c.txs.get(m[1]); return e ? json({ txid: m[1], confirmations: conf(e) }) : json({}, 404); }
  if ((m = url.match(/^\/api\/tx\/(\w+)\/tinfo$/))) {
    const e = c.txs.get(m[1]);
    if (!e) return json({}, 404);
    if (e.height === null) return json({ status: 'unmined' });
    const by = c.spent.get(`${m[1]}:0`);
    if (by) return json({ status: by.vin[0].stakebase ? 'voted' : 'revoked' });
    return json({ status: conf(e) > 16 ? 'live' : 'immature' });
  }
  return json({}, 404);
}

// ---- the run ----

/** dcrwallet hands transactions to dcrd a moment after it answers. */
async function inMempool(ids) {
  for (let i = 0; i < 50; i++) {
    const pool = await dcrd('getrawmempool', [false, 'all']);
    if (ids.every((id) => pool.includes(id))) { await sleep(31_000); return; } // dcrd remakes its block template for new transactions every 30 s
    await sleep(200);
  }
  const pool = await dcrd('getrawmempool', [false, 'all']);
  throw new Error(`not in the mempool: ${ids.filter((id) => !pool.includes(id)).join(' ')}`);
}

async function mine(n = 1) {
  for (let i = 0; i < n; i++) {
    await dcrd('generate', [1]);
    await sleep(700); // the wallets vote on each new block before the next
  }
}

async function main() {
  const server = http.createServer((q, r) => { let b = ''; q.on('data', (x) => { b += x; }); q.on('end', () => { standIn(q, r, b).catch((e) => { r.statusCode = 500; r.end(String(e.message)); }); }); });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const api = `http://127.0.0.1:${server.address().port}/insight/api`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-sim-'));
  const s = new WalletService(dir, { N: 2 ** 10, r: 8, p: 1 });
  s.startSession = async (secrets) => {
    s.tron = {}; s.btc = {}; s.eth = {}; s.dash = {}; s.firo = {}; s.monero = { close: async () => {} };
    s.dcr = new dcr.DcrClient(dcr.dcrAccountXpub(secrets.tronMnemonic), [api], undefined, 60_000);
    await s.dcrStakeLoad();
  };
  await s.init();
  const PW = 'simnet password';
  const words = generateMnemonic(wordlist);
  await s.vault.save(PW, { tronMnemonic: words, moneroSeed: 'x', moneroFilePasswords: {}, restoreHeights: {} });
  await s.unlock(PW);

  // Funding: two coins, so the split has more than one to choose from.
  const to = s.dcr.receiveAddress;
  assert.match(to, /^Ss/);
  await w1('walletpassphrase', ['123', 0]).catch(() => undefined);
  const funding = [await w1('sendtoaddress', [to, 1.5]), await w1('sendtoaddress', [to, 0.7])];
  await inMempool(funding);
  await mine(1);
  await s.dcr.refresh(true);
  assert.equal((await s.dcr.getBalance()).spendable, 220_000_000n);

  let info = await s.dcrStakeInfo();
  while (!info.canBuy) { await mine(1); info = await s.dcrStakeInfo(); }
  console.log('price', info.price, 'height', info.height);
  const quote = await s.dcrStakeQuote(2, VSP);
  console.log('quote', quote);
  assert.ok(quote.enough);

  const bought = await s.dcrStakeBuy(2, VSP, PW);
  console.log('bought', bought);
  assert.deepEqual([bought.bought, bought.paid, bought.problem], [2, 2, '']);
  const recs = (await s.dcrStakeRead()).tickets;
  // The split waits in the mempool; tickets spending it wait in dcrd's stage pool until it is in a block.
  await inMempool([recs[0].splitId]);
  for (const t of recs) {
    assert.ok(await dcrd('getrawtransaction', [t.hash, 0]), 'the VSP broadcast the ticket');
    // The fee as vspd works it out, against ours.
    const ours = stake.vspFee(BigInt(t.price), (await dcrd('getblockcount')), t.vsp.feePercentage);
    assert.equal(BigInt(t.fee.amount), ours, `vspd's fee ${t.fee.amount}, ours ${ours}`);
  }
  // Fee coins are held back until the VSP's fee transaction is in a block.
  const held = recs.reduce((x, t) => x + BigInt(t.fund.value), 0n);
  await mine(1);
  const bal = await s.dcr.getBalance();
  assert.ok(bal.total - bal.spendable >= held, 'fee coins not spendable');

  // Six confirmations, then vspd broadcasts the fees.
  let tickets;
  for (let i = 0; i < 30; i++) {
    await mine(1);
    tickets = await s.dcrTickets(true);
    if (tickets.every((t) => t.feeConfirmed)) break;
  }
  console.log('after fees', tickets);
  assert.ok(tickets.every((t) => t.feeConfirmed && t.state === 'paid'));

  // Until both vote (the pool is 64 tickets, 5 vote per block).
  for (let i = 0; i < 300 && !tickets.every((t) => t.state === 'done'); i++) {
    await mine(1);
    if (i % 4 === 0) tickets = await s.dcrTickets(true);
  }
  console.log('voted', tickets);
  assert.ok(tickets.every((t) => t.status === 'voted'), 'both tickets voted through the VSP');

  // The rewards come back to this wallet in the stake tree and can be spent once mature.
  await mine(dcr.DCR_SIMNET.coinbaseMaturity + 1);
  const before = await s.dcr.getBalance();
  console.log('balance', before);
  const coins = await s.dcr.confirmedUtxos();
  const rewards = coins.filter((u) => u.tree === 1);
  assert.equal(rewards.length, 2, 'two vote rewards');
  const back = await w1('getnewaddress', []);
  const draft = await s.dcr.draft(back, 'max');
  assert.ok(draft.inputs.some((u) => u.tree === 1));
  const id = await s.dcr.send(draft, words);
  await inMempool([id]);
  await mine(1);
  const tx = await dcrd('getrawtransaction', [id, 1]);
  assert.ok(tx.confirmations >= 1, 'the rewards were spent');
  console.log('spent rewards in', id, 'total', Number(draft.amount) / 1e8, 'DCR');

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok');
}

main().catch((e) => { console.error(e); process.exit(1); });

// The simnet: dcrd (--simnet --txindex --miningaddr=<w1 address>, RPC u/p on 19556), dcrwallet w1 (RPC 19557,
// --enablevoting, --enableticketbuyer) and w2 (RPC 19558, --enablevoting, unlocked, its master pubkey used by
// vspadmin for the fee xpub), vspd 1.4 (network simnet, its dcrd and w2, listening on 127.0.0.1:8800), mined past
// stake validation height. Each dcrwallet keeps rpc.cert in its directory under DCR_SIM.
