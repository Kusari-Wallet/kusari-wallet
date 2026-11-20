const http = require('node:http');
const { TronWeb } = require('tronweb');
const { TronClient, deriveTronAccount } = require('../dist/main/tron');
const { NETWORKS } = require('../dist/main/config');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECIPIENT = deriveTronAccount('legal winner thank year wave sausage worth useful legal winner thank yellow').address;
const me = deriveTronAccount(MNEMONIC);
const TIP = { blockID: '0000000004c4b40a' + 'ab'.repeat(24), block_header: { raw_data: { number: 80000010, timestamp: Date.now() } } };

// A fixed key for the stand-in Secret Network enclave; queries are decrypted and answered with it as the real one does.
const { x25519 } = require('@noble/curves/ed25519.js');
const { aessiv } = require('@noble/ciphers/aes.js');
const { hkdf } = require('@noble/hashes/hkdf.js');
const { sha256: sha256Bytes } = require('@noble/hashes/sha2.js');
const ENCLAVE = { priv: new Uint8Array(32).fill(5) };
ENCLAVE.pub = x25519.getPublicKey(ENCLAVE.priv);
const SCRT_SALT = Uint8Array.from(Buffer.from('000000000000000000024bead8df69990852c202db0e0097c1a12ea637d7e96d', 'hex'));
const enclaveKey = (nonce, theirs) => hkdf(sha256Bytes, Buffer.concat([x25519.getSharedSecret(ENCLAVE.priv, theirs), nonce]), SCRT_SALT, new Uint8Array(), 32);

/** A Decred transaction read back from its wire bytes (full serialization). */
function readDcrTx(raw) {
  let at = 4;
  const vi = () => raw[at++];
  const inputs = []; const outputs = [];
  for (let n = vi(); n > 0; n--) { inputs.push({ txid: Buffer.from(raw.subarray(at, at + 32)).reverse().toString('hex'), vout: raw.readUInt32LE(at + 32), tree: raw[at + 36], sequence: raw.readUInt32LE(at + 37) }); at += 41; }
  for (let n = vi(); n > 0; n--) { const value = raw.readBigInt64LE(at); const version = raw.readUInt16LE(at + 8); const len = raw[at + 10]; outputs.push({ value, version, script: raw.subarray(at + 11, at + 11 + len) }); at += 11 + len; }
  const lockTime = raw.readUInt32LE(at); const expiry = raw.readUInt32LE(at + 4); at += 8;
  vi();
  for (const i of inputs) { i.value = raw.readBigInt64LE(at); i.blockHeight = raw.readUInt32LE(at + 8); i.blockIndex = raw.readUInt32LE(at + 12); const len = raw[at + 16]; i.sigScript = raw.subarray(at + 17, at + 17 + len); at += 17 + len; }
  return { version: raw.readUInt16LE(0), inputs, outputs, lockTime, expiry };
}

function mockNode() {
  const state = { broadcast: [], balance: 50_000_000, usdt: 10_000_000n, energyUsed: 64285, recipientExists: true, tamper: null };
  const server = http.createServer((req, res) => {
    let body = '';
    const rawChunks = [];
    req.on('data', (c) => { body += c; rawChunks.push(Buffer.from(c)); });
    req.on('end', () => {
      if (req.url.startsWith('/dcr/')) {
        // dcrdata's Insight API: one coin at the first receiving address; a payment is checked by its signature.
        const p = req.url.replace(/^\/dcr/, '').split('?')[0];
        const out = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
        const first = state.dcrFirst;
        if (p.endsWith('/utxo')) return out(first && p.includes(first) && !state.dcr ? [{ address: first, txid: 'ab'.repeat(32), vout: 0, atoms: 12_500_000_000, amount: 125, confirmations: 30 }] : []);
        // The coin's transaction is in the first address's history, as on a real server.
        if (p.endsWith('/txs')) return out(first && p.includes(first) ? { totalItems: 1, items: [{ txid: 'ab'.repeat(32), confirmations: 30, time: 1_700_000_000, vin: [], vout: [{ value: 125, n: 0, scriptPubKey: { addresses: [first] } }] }] } : { totalItems: 0, items: [] });
        if (p === '/tx/send' && req.method === 'POST') {
          const { verifyDcrInput, dcrScript, dcrTxid } = require('../dist/main/dcr');
          const raw = Buffer.from(JSON.parse(body).rawtx, 'hex');
          const tx = readDcrTx(raw);
          const sig = tx.inputs[0].sigScript;
          const pub = sig.subarray(sig[0] + 2);
          if (!verifyDcrInput(tx, 0, dcrScript(first), pub)) { res.statusCode = 400; return res.end('bad signature'); }
          (state.dcr = state.dcr ?? []).push(tx);
          return out({ txid: dcrTxid(tx) });
        }
        res.statusCode = 404; return res.end('{}');
      }
      const json = body ? JSON.parse(body) : {};
      const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      const url = req.url.split('?')[0];
      if (url.startsWith('/dash-firo/addrs/') && url.endsWith('/utxo')) return send([]);
      if (url.startsWith('/dash-firo/addrs/') && url.includes('/txs')) return send({ totalItems: 0, items: [] });
      if (url === '/sol') return send({ jsonrpc: '2.0', id: 1, result: json.method === 'getBalance' ? { value: 0 } : json.method === 'getTokenAccountsByOwner' ? { value: [] } : [] });
      if (url === '/scrt/cosmos/base/tendermint/v1beta1/node_info') return send({ default_node_info: { network: 'secret-4' } });
      if (url.startsWith('/scrt/cosmos/bank/v1beta1/balances/')) return send({ balances: [{ denom: 'uscrt', amount: '2500000' }] });
      if (url.startsWith('/scrt/cosmos/tx/v1beta1/txs') && req.method === 'GET') return send({ tx_responses: [] });
      // sSCRT: a stand-in enclave. The private balance reads as unset until a transaction is broadcast (the viewing key).
      if (url === '/scrt/registration/v1beta1/tx-key') return send({ key: Buffer.from(ENCLAVE.pub).toString('base64') });
      if (url.startsWith('/scrt/compute/v1beta1/code_hash/')) return send({ code_hash: 'ab'.repeat(32) });
      if (url.startsWith('/scrt/compute/v1beta1/query/')) {
        const sealed = Buffer.from(decodeURIComponent(req.url.split('query=')[1] ?? ''), 'base64');
        const nonce = sealed.subarray(0, 32), theirs = sealed.subarray(32, 64);
        const k = enclaveKey(nonce, theirs);
        const asked = JSON.parse(new TextDecoder().decode(aessiv(k, new Uint8Array()).decrypt(sealed.subarray(64))).slice(64));
        const answer = asked.balance ? (state.sscrtKey ? { balance: { amount: '1250000' } } : { viewing_key_error: { msg: 'Wrong viewing key for this address or viewing key not set' } })
          : { transaction_history: { txs: [], total: 0 } };
        return send({ data: Buffer.from(aessiv(k, new Uint8Array()).encrypt(new TextEncoder().encode(Buffer.from(JSON.stringify(answer)).toString('base64')))).toString('base64') });
      }
      if (url.startsWith('/scrt/cosmos/auth/v1beta1/accounts/')) return send({ account: { '@type': '/cosmos.auth.v1beta1.BaseAccount', address: url.split('/').pop(), account_number: '42', sequence: String(state.scrtSeq ?? 0) } });
      if (url === '/scrt/cosmos/tx/v1beta1/simulate') return send({ gas_info: { gas_used: '150000' } });
      if (url === '/scrt/cosmos/tx/v1beta1/txs' && req.method === 'POST') {
        state.scrtSeq = (state.scrtSeq ?? 0) + 1;
        state.sscrtKey = true;
        (state.scrtBroadcast = state.scrtBroadcast ?? []).push(json.tx_bytes);
        const hash = require('node:crypto').createHash('sha256').update(Buffer.from(json.tx_bytes, 'base64')).digest('hex').toUpperCase();
        return send({ tx_response: { txhash: hash, code: 0 } });
      }
      if (url === '/bch/block/tip') return send({ height: 900000 });
      if (url.startsWith('/bch/address/')) return send([]);
      if (url.startsWith('/doge/addrs/')) return send({ address: url.match(/addrs\/(\w+)/)[1], final_balance: 0, n_tx: 0 });
      if (url.startsWith('/dash/addrs/') && url.endsWith('/utxo')) {
        // Each coin gets a transaction that really pays it, under that transaction's ID: the wallet checks.
        const { prevTx } = require('./prev-tx');
        const btcs = require('@scure/btc-signer');
        const NET = { bech32: 'dash', pubKeyHash: 0x4c, scriptHash: 0x10, wif: 0xcc };
        state.dashRaws = state.dashRaws ?? {};
        for (const c of state.dashUtxos ?? []) {
          if (state.dashRaws[c.txid]) continue;
          const outs = Array.from({ length: c.vout + 1 }, (_, i) => (i === c.vout ? { value: c.satoshis, script: Buffer.from(btcs.OutScript.encode(btcs.Address(NET).decode(c.address))).toString('hex') } : { value: 1, script: '51' }));
          const t = prevTx(outs, Object.keys(state.dashRaws).length + 1);
          state.dashRaws[t.txid] = t.hex;
          c.txid = t.txid;
        }
        return send(state.dashUtxos ?? []);
      }
      if (url.startsWith('/dash/rawtx/')) return state.dashRaws?.[url.slice(12, 76)] ? send({ rawtx: state.dashRaws[url.slice(12, 76)] }) : send({ error: 'unknown' }, 404);
      if (url.startsWith('/dash/addrs/') && url.endsWith('/txs')) return send({ totalItems: 0, items: [] });
      if (url === '/dash/tx/send') { (state.dashRaw = state.dashRaw ?? []).push(json.rawtx); return send({}); }
      // NEAR: 1.6 NEAR held, 0.1 of it kept for 10 kB of storage.
      if (url === '/near/rpc') {
        const ok = (result) => send({ jsonrpc: '2.0', id: json.id, result });
        if (json.method === 'query' && json.params?.request_type === 'view_account') return ok({ amount: '1600000000000000000000000', locked: '0', storage_usage: 10000, block_hash: '11111111111111111111111111111111', block_height: 1 });
        if (json.method === 'gas_price') return ok({ gas_price: '100000000' });
        return send({ jsonrpc: '2.0', id: json.id, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } });
      }
      if (url.startsWith('/near/history/')) return send({ txns: [] });
      // Polygon and Arbitrum: their own chain ids, and nothing held there.
      if (url === '/pol/rpc' || url === '/arb/rpc' || url === '/bsc/rpc' || url === '/hype/rpc') {
        const ok = (result) => send({ jsonrpc: '2.0', id: json.id, result });
        const m = json.method;
        (state.evmCalls = state.evmCalls ?? []).push(`${url}:${m}`);
        if (m === 'eth_chainId') return ok(url === '/pol/rpc' ? '0x89' : url === '/bsc/rpc' ? '0x38' : url === '/hype/rpc' ? '0x3e7' : '0xa4b1');
        if (m === 'eth_getBalance') return ok(url === '/hype/rpc' ? '0x' + (25n * 10n ** 17n).toString(16) : '0x0'); // 2.5 HYPE
        if (m === 'eth_call') return ok('0x' + '0'.repeat(64));
        if (m === 'eth_getBlockByNumber') return ok({ baseFeePerGas: '0x3b9aca00' });
        if (m === 'eth_maxPriorityFeePerGas') return ok('0x0');
        // HyperEVM also takes a plain HYPE send (to HyperCore's system address in the tests).
        if (url === '/hype/rpc' && m === 'eth_estimateGas') return ok('0x5208');
        if (url === '/hype/rpc' && m === 'eth_getTransactionCount') return ok('0x0');
        if (url === '/hype/rpc' && m === 'eth_sendRawTransaction') { (state.hypeSent = state.hypeSent ?? []).push(json.params[0]); return ok('0x' + 'ab'.repeat(32)); }
        if (url === '/hype/rpc' && m === 'eth_getTransactionReceipt') return ok(null);
        return send({ jsonrpc: '2.0', id: json.id, error: { message: 'unknown ' + m } });
      }
      // Uniswap's Trading API: a pool route for whatever was asked, paid to whoever asked.
      if (url === '/uniswap/quote') {
        (state.uniswapAsks = state.uniswapAsks ?? []).push(json);
        const out = (BigInt(json.amount) * 2000n / 10n ** 12n).toString(); // ETH (18 decimals) at $2000 into USDT (6)
        return send({ routing: 'CLASSIC', permitData: null, quote: { chainId: Number(json.tokenInChainId), swapper: json.swapper, input: { token: json.tokenIn, amount: json.amount }, output: { token: json.tokenOut, amount: out, minimumAmount: (BigInt(out) * 995n / 1000n).toString(), recipient: json.swapper }, priceImpact: 0.05, gasUseEstimate: '120000' } });
      }
      if (url === '/eth/rpc') {
        const ok = (result) => send({ jsonrpc: '2.0', id: json.id, result });
        const m = json.method;
        state.ethCalls = state.ethCalls ?? [];
        state.ethCalls.push(m);
        if (m === 'eth_chainId') return ok('0x1');
        if (m === 'eth_getBalance') return ok('0x' + BigInt(state.ethWei ?? 0).toString(16));
        if (m === 'eth_call') return ok(json.params[0].data.startsWith('0x70a08231') ? '0x' + BigInt(state.ethUsdt ?? 0).toString(16).padStart(64, '0') : '0x' + '0'.repeat(64));
        if (m === 'eth_getBlockByNumber') return ok({ baseFeePerGas: '0x77359400' });
        if (m === 'eth_maxPriorityFeePerGas') return ok('0x3b9aca00');
        if (m === 'eth_getCode') return ok('0x');
        if (m === 'eth_estimateGas') return ok('0xc350');
        if (m === 'eth_blockNumber') return ok('0x10');
        if (m === 'eth_getLogs') return ok([]);
        if (m === 'eth_getTransactionCount') return ok('0x7');
        if (m === 'eth_sendRawTransaction') { (state.ethRaw = state.ethRaw ?? []).push(json.params[0]); return ok('0x' + 'ab'.repeat(32)); }
        return send({ jsonrpc: '2.0', id: json.id, error: { message: 'unknown ' + m } });
      }
      if (url.startsWith('/eth/scout/')) return send({ items: [] });
      if (url.startsWith('/btc/address/')) {
        const coins = state.btcCoins?.[url.split('/')[3]];
        if (coins) return send(url.endsWith('/utxo') ? coins : url.endsWith('/txs') ? [] : { chain_stats: { tx_count: coins.length, funded_txo_sum: coins.reduce((s, c) => s + c.value, 0), spent_txo_sum: 0 }, mempool_stats: {} });
        return send(url.endsWith('/utxo') || url.endsWith('/txs') ? [] : { chain_stats: {}, mempool_stats: {} });
      }
      if (url === '/btc/v1/fees/recommended') return send({ halfHourFee: 5 });
      if (url === '/simple/v3/estimates') { state.simpleKey = req.headers['x-api-key']; return send({ result: { estimatedAmount: '0.012' } }); }
      if (url === '/simple/v3/exchanges' && req.method === 'POST') return send({ result: { publicId: 'S1', addressFrom: json.networkFrom === 'eth' ? '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' : RECIPIENT, addressTo: json.addressTo, userRefundAddress: json.userRefundAddress, amountFrom: json.amount, amountTo: '0.012', tickerFrom: json.tickerFrom, tickerTo: json.tickerTo, networkFrom: json.networkFrom, networkTo: json.networkTo } });
      if (url === '/ghost/v1/currencies') return send({ currencies: ['btc', 'xmr', 'eth', 'trx', 'ltc', 'doge', 'dash', 'sol', 'bch', 'zec', 'pol', 'bnbbsc', 'etharb', 'hype'].map((ticker) => ({ ticker, enabled: true })).concat([{ ticker: 'usdtrx', enabled: true, contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }]) });
      if (url === '/ghost/v1/quotes') { state.ghostAuth = req.headers.authorization; return send({ quote: { amountUserReceives: '0.009', rate: '0.0045' } }); }
      if (url === '/swap/rate') return send({ fromAmount: 2, toAmount: 0.01, rate: 0.005, minAmount: 1, maxAmount: 9000 });
      if (url.startsWith('/swap/currencies/')) return send([{ network: 'TRX', shortName: 'TRC20' }]);
      if (url === '/swap/transactions' && req.method === 'POST') {
        state.swapOrder = json;
        return send({ id: 'SWAP1', amount: json.amount, amountTo: 0.01, depositAddress: json.networkFrom === 'ETH' ? '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' : RECIPIENT, withdrawalAddress: json.withdrawalAddress, refundAddress: json.refundAddress, rate: 0.005, status: 'wait', coinFrom: { coinCode: json.coinFrom, network: json.networkFrom }, coinTo: { coinCode: json.coinTo, network: json.networkTo } });
      }
      if (url === '/swap/transactions/SWAP1') return send({ id: 'SWAP1', status: state.swapStatus ?? 'exchanging' });
      if (url.endsWith('/simple/price')) return send({ tron: { usd: 0.32, usd_24h_change: 1.2 }, tether: { usd: 1, usd_24h_change: 0.0 }, monero: { usd: 151.23, usd_24h_change: -0.85 }, ethereum: { usd: 3000, usd_24h_change: 0.5 }, dash: { usd: 30, usd_24h_change: 1 }, bitcoin: { usd: 70000, usd_24h_change: 0.5 } });
      if (url.endsWith('/getaccount')) {
        const isMe = json.address === TronWeb.address.toHex(me.address) || json.address === me.address;
        if (isMe) return send({ address: json.address, balance: state.balance });
        return send(state.recipientExists ? { address: json.address, balance: 1 } : {});
      }
      if (url.endsWith('/getblock') || url.endsWith('/getnowblock')) return send(TIP);
      if (url.endsWith('/getaccountresource')) return send({ freeNetLimit: 600, freeNetUsed: 0 });
      if (url.endsWith('/getchainparameters')) return send({ chainParameter: [{ key: 'getEnergyFee', value: 100 }, { key: 'getTransactionFee', value: 1000 }, { key: 'getCreateNewAccountFeeInSystemContract', value: 1000000 }, { key: 'getCreateAccountFee', value: 100000 }] });
      if (url.endsWith('/triggerconstantcontract')) {
        if (json.function_selector === 'balanceOf(address)') return send({ result: { result: true }, constant_result: [state.usdt.toString(16).padStart(64, '0')] });
        return send({ result: { result: true }, energy_used: state.energyUsed, constant_result: ['0'.repeat(63) + '1'] });
      }
      if (url.endsWith('/broadcasttransaction')) { state.broadcast.push(json); return send({ result: true, txid: json.txID }); }
      if (url.endsWith('/gettransactioninfobyid')) return send(state.txInfo ?? {});
      if (url.includes('/transactions/trc20')) {
        return send({ data: [
          { transaction_id: 'aa'.repeat(32), token_info: { address: NETWORKS.mainnet.tron.usdt }, block_timestamp: 1, from: RECIPIENT, to: me.address, value: '2500000' },
          { transaction_id: 'bb'.repeat(32), token_info: { address: NETWORKS.mainnet.tron.usdt }, block_timestamp: 2, from: me.address, to: RECIPIENT, value: '1000000' },
          { transaction_id: 'cc'.repeat(32), token_info: { address: NETWORKS.mainnet.tron.usdt }, block_timestamp: 3, from: RECIPIENT, to: me.address, value: '0' },
          { transaction_id: 'dd'.repeat(32), token_info: { address: 'TFakeUsdtFakeUsdtFakeUsdtFakeUsdt1' }, block_timestamp: 4, from: RECIPIENT, to: me.address, value: '99000000' },
          { transaction_id: 'ee'.repeat(32), token_info: { address: NETWORKS.mainnet.tron.usdt }, block_timestamp: 5, from: RECIPIENT, to: me.address, value: '1' },
        ] });
      }
      if (url.endsWith('/transactions')) {
        return send({ data: [
          { txID: '11'.repeat(32), block_timestamp: 9, ret: [{ contractRet: 'SUCCESS' }], raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { owner_address: TronWeb.address.toHex(RECIPIENT), to_address: TronWeb.address.toHex(me.address), amount: 3000000 } } }] } },
          { txID: '22'.repeat(32), block_timestamp: 8, ret: [{ contractRet: 'SUCCESS' }], raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: {} } }] } },
        ] });
      }
      res.statusCode = 404; send({ error: url });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const net = { ...NETWORKS.mainnet.tron, host: `http://127.0.0.1:${server.address().port}` };
    resolve({ server, state, client: new TronClient(net, '', me.address) });
  }));
}


module.exports = { mockNode, me, RECIPIENT, MNEMONIC };
