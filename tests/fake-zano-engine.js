#!/usr/bin/env node
// Speaks the Zano engine's line protocol with made-up chain data. Amounts are raw big integers, as in the real thing.
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.env.FAKE_ZANO_LOG;
const note = (o) => { if (log) fs.appendFileSync(log, JSON.stringify(o) + '\n'); };
// Kusari's stand-in (fake-ksr-engine.js) sets a K... address; Zano's is Zx...
const ADDRESS = process.env.FAKE_ZANO_ADDRESS || 'Zx' + 'C'.repeat(95);
const VALID = ADDRESS.startsWith('K') ? /^[KL]/ : /^(Zx|iZ)/;
let balance = 20000000000000000n; // past 2^53, on purpose
let unlocked = 15000000000000000n;
const wallets = new Set();
const files = process.env.FAKE_ZANO_FILES;
if (files && fs.existsSync(files)) for (const f of fs.readFileSync(files, 'utf8').split('\n').filter(Boolean)) wallets.add(f);
let sent = [];
const answer = (method, instance, params) => {
  if (method === 'init') { const [node, socks, dir] = params.split('\x1f'); note({ m: 'init', node, socks, dir }); return '{"result":{"return_code":"OK"}}'; }
  if (method === 'address_info') return JSON.stringify({ valid: VALID.test(params), wrap: false, auditable: false, payment_id: false });
  if (method === 'open') {
    const p = JSON.parse(params);
    note({ m: 'open', path: p.path, known: wallets.has(p.path) });
    if (!wallets.has(p.path)) return '{"error":{"code":"FILE_NOT_FOUND"}}';
    return `{"id":0,"jsonrpc":"2.0","result":{"wallet_id":7,"wi":{"address":"${ADDRESS}"}}}`;
  }
  if (method === 'restore_from_derivations') {
    const p = JSON.parse(params);
    note({ m: 'restore', path: p.path, secretLength: p.secret_derivation.length, secret: p.secret_derivation, passLength: p.pass.length, stamp: p.creation_timestamp, auditable: p.is_auditable });
    wallets.add(p.path);
    if (files) fs.appendFileSync(files, p.path + '\n');
    return `{\n "id":0,\n "jsonrpc":"2.0",\n "result":{\n "wallet_id":7,\n "wi":{"address":"${ADDRESS}"}\n }\n}`;
  }
  if (method === 'get_wallet_status') return '{ "current_daemon_height": 10, "current_wallet_height": 10, "is_daemon_connected": true, "is_in_long_refresh": false, "progress": 100, "wallet_state": 2 }';
  if (method === 'close') { note({ m: 'close' }); return '{"result":{"return_code":"OK"}}'; }
  if (method === 'invoke') {
    const r = JSON.parse(params.replace(/("amount":|"fee":)(\d+)/g, '$1"$2"'));
    if (r.method === 'getbalance') return `{"id":0,"jsonrpc":"2.0","result":{"balance":${balance},"unlocked_balance":${unlocked},"balances":[]}}`;
    if (r.method === 'store') return '{"result":{"wallet_file_size":1}}';
    if (r.method === 'getaddress') return `{"result":{"address":"${ADDRESS}"}}`;
    if (r.method === 'transfer') {
      note({ m: 'transfer', raw: params });
      const amount = BigInt(r.params.destinations[0].amount); const fee = BigInt(r.params.fee);
      balance -= amount + fee; unlocked -= amount + fee; sent.push(amount);
      return `{"result":{"tx_hash":"${'ab'.repeat(32)}","tx_size":1}}`;
    }
    if (r.method === 'get_recent_txs_and_info2') {
      const native = 'd6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a';
      const transfers = [{ tx_hash: 'ef'.repeat(32), height: 5, timestamp: 1790000000, fee: 10000000000, subtransfers_by_pid: [{ payment_id: '', subtransfers: [{ amount: 20000000000000000, is_income: true, asset_id: native }, { amount: 5, is_income: true, asset_id: 'ff' }] }] }];
      for (const s of sent) transfers.unshift({ tx_hash: 'ab'.repeat(32), height: 0, timestamp: 0, fee: 10000000000, subtransfers_by_pid: [{ payment_id: '', subtransfers: [{ amount: String(s), is_income: false, asset_id: native }] }] });
      return JSON.stringify({ result: { transfers } }).replace(/"amount":"(\d+)"/g, '"amount":$1');
    }
    return '{"error":{"code":-1,"message":"unknown"}}';
  }
  return '{"error":"unknown method"}';
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [id, method, instance, ...rest] = line.split('\t');
  process.stdout.write(`${id}\t${answer(method, instance, rest.join('\t')).replace(/\n/g, ' ')}\n`);
});
