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

// Hyperliquid: enough of /info and /exchange to walk through turning on trading and placing orders.
function hlMock(state, req, body, res) {
  const a = (state.hl = state.hl ?? { agents: [], builder: 0, placed: [], positions: [], orders: [], withdrawals: [], leverage: [] });
  const j = body ? JSON.parse(body) : {};
  const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (req.url === '/hl/info') {
    if (j.type === 'extraAgents') return send(a.agents.map((address) => ({ address, name: 'Kusari', validUntil: Date.now() + 1e10 })));
    if (j.type === 'maxBuilderFee') return send(a.builder);
    if (j.type === 'metaAndAssetCtxs') return send([{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }, { name: 'OLD', szDecimals: 0, maxLeverage: 3, isDelisted: true }] },
      [{ markPx: '60000', midPx: '60000', oraclePx: '60012', prevDayPx: '59100', dayNtlVlm: '900000000', funding: '0.0000125', openInterest: '40000' }, { markPx: '3000', midPx: '3000', prevDayPx: '3024', dayNtlVlm: '400000000', funding: '-0.00001', openInterest: '90000' }, { markPx: '1' }]]);
    if (j.type === 'l2Book') return send({ coin: j.coin, levels: [[{ px: '59999', sz: '1.2', n: 3 }, { px: '59998', sz: '0.4', n: 1 }, { px: '59990', sz: '2.5', n: 4 }], [{ px: '60001', sz: '0.9', n: 2 }, { px: '60003', sz: '1.6', n: 2 }, { px: '60010', sz: '0.3', n: 1 }]] });
    if (j.type === 'candleSnapshot') return send(Array.from({ length: 40 }, (_, i) => ({ t: Date.now() - (40 - i) * 3600e3, o: String(58000 + i * 50), c: String(58000 + i * 50 + (i % 3 ? 80 : -60)), h: String(58200 + i * 50), l: String(57900 + i * 50), v: '10' })));
    if (j.type === 'userFees') return send({ userAddRate: '0.00015', userCrossRate: '0.00045' });
    if (j.type === 'clearinghouseState') return send({ marginSummary: { accountValue: '262.5', totalRawUsd: '250' }, withdrawable: '200', assetPositions: a.positions.map((position) => ({ position })) });
    if (j.type === 'frontendOpenOrders') return send(a.orders);
    if (j.type === 'spotMeta') return send({ tokens: [{ name: 'USDC', tokenId: '0x6d1e7cde53ba9467b783cb7c530ce054' }, { name: 'HYPE', tokenId: '0x0d01dc56dcaaca66ad901c959b4011ec' }] });
    if (j.type === 'spotClearinghouseState') return send({ balances: [{ coin: 'HYPE', token: 150, total: String(a.coreHype ?? 3), hold: '0.5' }] });
    return send(null);
  }
  const act = j.action ?? {};
  if (act.type === 'approveAgent') { a.agents.push(act.agentAddress); return send({ status: 'ok', response: { type: 'default' } }); }
  if (act.type === 'approveBuilderFee') { a.builder = Math.round(parseFloat(act.maxFeeRate) * 1000); return send({ status: 'ok', response: { type: 'default' } }); }
  if (act.type === 'withdraw3') { a.withdrawals.push(act); return send({ status: 'ok', response: { type: 'default' } }); }
  if (act.type === 'spotSend') { (a.spotSends = a.spotSends ?? []).push(act); a.coreHype = (a.coreHype ?? 3) - Number(act.amount); return send({ status: 'ok', response: { type: 'default' } }); }
  if (act.type === 'updateLeverage') { a.leverage.push(act); return send({ status: 'ok', response: { type: 'default' } }); }
  if (act.type === 'cancel') { a.orders = a.orders.filter((o) => o.oid !== act.cancels[0].o); return send({ status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }); }
  if (act.type === 'order') {
    const o = act.orders[0];
    a.placed.push({ ...o, builder: act.builder });
    if (act.builder.f > a.builder) return send({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Builder fee has not been approved.' }] } } });
    if (o.t.limit.tif === 'Ioc') {
      a.positions = o.r ? [] : [{ coin: 'BTC', szi: (o.b ? '' : '-') + o.s, entryPx: '60000', positionValue: String(Number(o.s) * 60500), unrealizedPnl: '5', liquidationPx: '54321', leverage: { type: 'isolated', value: 10 }, marginUsed: '10' }];
      return send({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: 42, avgPx: '60010', totalSz: o.s } }] } } });
    }
    a.orders.push({ coin: 'BTC', side: o.b ? 'B' : 'A', limitPx: o.p, sz: o.s, origSz: o.s, oid: 9, timestamp: Date.now(), reduceOnly: o.r, tif: o.t.limit.tif });
    return send({ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 9 } }] } } });
  }
  return send({ status: 'err', response: 'unknown action' });
}

// Aster futures: enough of fapi and bapi to walk through turning on trading and placing an order.
function asterMock(state, req, body, res) {
  const a = (state.aster = state.aster ?? { registered: false, builder: null, orders: [], positions: [] });
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/^\/aster/, '');
  const q = new URLSearchParams(req.method === 'POST' ? body : u.search.slice(1));
  const send = (code, o) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (p === '/fapi/v3/time') return send(200, { serverTime: Date.now() });
  if (p === '/fapi/v3/exchangeInfo') return send(200, { symbols: [
    { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'BTC', quoteAsset: 'USDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }, { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' }, { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '100' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] },
    { symbol: 'ETHUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'ETH', quoteAsset: 'USDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] }] });
  if (p === '/fapi/v3/ticker/24hr') return send(200, [{ symbol: 'BTCUSDT', lastPrice: '60000', priceChangePercent: '1.52', quoteVolume: '900000000' }, { symbol: 'ETHUSDT', lastPrice: '3000', priceChangePercent: '-0.8', quoteVolume: '400000000' }]);
  const prem = (symbol) => ({ symbol, markPrice: symbol === 'ETHUSDT' ? '3000' : '60000', indexPrice: symbol === 'ETHUSDT' ? '3001' : '60012', lastFundingRate: '0.0001', nextFundingTime: Date.now() + 3600e3 });
  if (p === '/fapi/v3/premiumIndex') return send(200, q.get('symbol') ? prem(q.get('symbol')) : ['BTCUSDT', 'ETHUSDT'].map(prem));
  if (p === '/fapi/v3/depth') return send(200, { bids: [['59999.9', '1.2'], ['59999.0', '3']], asks: [['60000.1', '0.8'], ['60001', '2']] });
  if (p === '/fapi/v3/klines') return send(200, Array.from({ length: 60 }, (_, i) => [Date.now() - (60 - i) * 3600e3, String(59000 + i * 10), String(59100 + i * 10), String(58900 + i * 10), String(59050 + i * 10), '12', 0]));
  if (p === '/fapi/v3/openInterest') return send(200, { symbol: q.get('symbol'), openInterest: '1234.5' });
  if (p === '/fapi/v3/registerAndApproveAgent') { a.registered = q.get('agentAddress'); return send(200, { code: 200, msg: 'success' }); }
  if (p === '/fapi/v3/approveBuilder') { a.builder = q.get('maxFeeRate'); return send(200, { code: 200, msg: 'success' }); }
  if (p === '/fapi/v3/remainingOpenableNotionalValue') return Number(q.get('leverage')) >= 1 && Number(q.get('leverage')) <= 75 ? send(200, { remainingOpenableNotionalValue: '1000000' }) : send(400, { code: -4028, msg: 'Invalid leverage' });
  if (p.startsWith('/bapi/futures/v1/public/future/aster/estimate-withdraw-fee')) return send(200, { code: '000000', data: { gasCost: 0.3 }, success: true });
  if (!a.registered || q.get('signer') !== a.registered) return send(401, { code: -1022, msg: 'Signature for this request is not valid.' });
  if (p === '/fapi/v3/leverageBrackets') return send(200, (q.get('symbol') ? [q.get('symbol')] : ['BTCUSDT', 'ETHUSDT']).map((symbol) => ({ symbol, brackets: [{ bracket: 1, initialLeverage: symbol === 'ETHUSDT' ? 100 : 200, notionalCap: 50000, notionalFloor: 0, maintMarginRatio: 0.004, cum: 0 }] })));
  if (p === '/fapi/v3/commissionRate') return send(200, { symbol: q.get('symbol'), makerCommissionRate: '0.0001', takerCommissionRate: '0.00035' });
  if (p === '/fapi/v3/account') return send(200, { totalWalletBalance: '250', availableBalance: '200', totalUnrealizedProfit: '12.5', totalMarginBalance: '262.5' });
  if (p === '/fapi/v3/positionRisk') return send(200, a.positions);
  if (p === '/fapi/v3/openOrders') return send(200, a.orders);
  if (p === '/fapi/v3/marginType' || p === '/fapi/v3/leverage') return send(200, { code: 200, msg: 'success' });
  if (p === '/fapi/v3/order' && req.method === 'POST') {
    (a.placed = a.placed ?? []).push(Object.fromEntries(q));
    if (q.get('type') === 'MARKET' && !q.get('reduceOnly')) a.positions = [{ symbol: q.get('symbol'), positionAmt: (q.get('side') === 'SELL' ? '-' : '') + q.get('quantity'), entryPrice: '60000', markPrice: '60500', unRealizedProfit: '5', liquidationPrice: '54321', leverage: '10', marginType: 'isolated', isolatedWallet: '10', notional: '100' }];
    if (q.get('reduceOnly')) a.positions = [];
    if (q.get('type') === 'LIMIT') a.orders.push({ orderId: 9, symbol: q.get('symbol'), side: q.get('side'), origType: 'LIMIT', price: q.get('price'), origQty: q.get('quantity'), executedQty: '0', timeInForce: q.get('timeInForce'), time: Date.now() });
    return send(200, { orderId: 9, status: q.get('type') === 'MARKET' ? 'FILLED' : 'NEW' });
  }
  if (p === '/fapi/v3/order' && req.method === 'DELETE') { a.orders = a.orders.filter((o) => String(o.orderId) !== q.get('orderId')); return send(200, { status: 'CANCELED' }); }
  if (p === '/fapi/v3/aster/user-withdraw') { (a.withdrawals = a.withdrawals ?? []).push(Object.fromEntries(q)); return send(200, { withdrawId: '77', hash: '0xab' }); }
  return send(404, { code: -1, msg: 'unknown' });
}

function mockNode() {
  const state = { broadcast: [], balance: 50_000_000, usdt: 10_000_000n, energyUsed: 64285, recipientExists: true, tamper: null };
  const server = http.createServer((req, res) => {
    let body = '';
    const rawChunks = [];
    req.on('data', (c) => { body += c; rawChunks.push(Buffer.from(c)); });
    req.on('end', () => {
      if (req.url.startsWith('/hl/')) return hlMock(state, req, body, res);
      if (req.url.startsWith('/aster/')) return asterMock(state, req, body, res);
      if (req.url.startsWith('/ada/')) {
        // Koios, enough for a balance and one payment; the payment is checked with Cardano's own library.
        const p = req.url.replace(/^\/ada/, '').split('?')[0];
        const out = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
        if (p === '/address_utxos') return out([{ tx_hash: 'ab'.repeat(32), tx_index: 0, value: '12500000', asset_list: [] }, { tx_hash: 'cd'.repeat(32), tx_index: 1, value: '1500000', asset_list: [{ policy_id: '00', quantity: '1' }] }]);
        if (p === '/tip') return out([{ abs_slot: 150000000 }]);
        if (p === '/epoch_params') return out([{ min_fee_a: 44, min_fee_b: 155381, coins_per_utxo_size: '4310', max_tx_size: 16384 }]);
        if (p === '/address_txs') return out([]);
        if (p === '/submittx') {
          const C = require('@emurgo/cardano-serialization-lib-nodejs');
          const raw = Buffer.concat(rawChunks);
          const tx = C.FixedTransaction.from_bytes(raw);
          const hash = tx.transaction_hash();
          const w = C.Transaction.from_bytes(raw).witness_set().vkeys().get(0);
          if (!w.vkey().public_key().verify(hash.to_bytes(), w.signature())) { res.statusCode = 400; return res.end('bad signature'); }
          (state.ada = state.ada ?? []).push(C.Transaction.from_bytes(raw).to_json());
          return out(hash.to_hex());
        }
        res.statusCode = 404; return res.end('{}');
      }
      // Exchange spot books for the Kusari index: BTC near 60,000 everywhere but Bybit, which is down.
      if (req.url.startsWith('/kx/')) {
        const name = req.url.split('/')[2];
        const b = { Binance: { bidPrice: '60010', askPrice: '60012' }, OKX: { data: [{ bidPx: '60008', askPx: '60010' }] }, Kraken: { result: { XXBTZUSD: { b: ['59990'], a: ['59994'] } } }, KuCoin: { data: { bestBid: '60011', bestAsk: '60013' } }, Gate: [{ highest_bid: '60009', lowest_ask: '60011' }], MEXC: { bidPrice: '60012', askPrice: '60014' } }[name];
        res.setHeader('content-type', 'application/json');
        if (!b) { res.statusCode = 403; return res.end('{}'); }
        return res.end(JSON.stringify(b));
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
      if (url.startsWith('/dash/addrs/') && url.endsWith('/utxo')) return send(state.dashUtxos ?? []);
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
      if (url.startsWith('/btc/address/')) return send(url.endsWith('/utxo') || url.endsWith('/txs') ? [] : { chain_stats: {}, mempool_stats: {} });
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
