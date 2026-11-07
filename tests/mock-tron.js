const http = require('node:http');
const { TronWeb } = require('tronweb');
const { TronClient, deriveTronAccount } = require('../dist/main/tron');
const { NETWORKS } = require('../dist/main/config');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECIPIENT = deriveTronAccount('legal winner thank year wave sausage worth useful legal winner thank yellow').address;
const me = deriveTronAccount(MNEMONIC);
const TIP = { blockID: '0000000004c4b40a' + 'ab'.repeat(24), block_header: { raw_data: { number: 80000010, timestamp: Date.now() } } };

function mockNode() {
  const state = { broadcast: [], balance: 50_000_000, usdt: 10_000_000n, energyUsed: 64285, recipientExists: true, tamper: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      const url = req.url.split('?')[0];
      if (url.startsWith('/dash-firo/addrs/') && url.endsWith('/utxo')) return send([]);
      if (url.startsWith('/dash-firo/addrs/') && url.includes('/txs')) return send({ totalItems: 0, items: [] });
      if (url === '/sol') return send({ jsonrpc: '2.0', id: 1, result: json.method === 'getBalance' ? { value: 0 } : json.method === 'getTokenAccountsByOwner' ? { value: [] } : [] });
      if (url === '/bch/block/tip') return send({ height: 900000 });
      if (url.startsWith('/bch/address/')) return send([]);
      if (url.startsWith('/doge/addrs/')) return send({ address: url.match(/addrs\/(\w+)/)[1], final_balance: 0, n_tx: 0 });
      if (url.startsWith('/dash/addrs/') && url.endsWith('/utxo')) return send(state.dashUtxos ?? []);
      if (url.startsWith('/dash/addrs/') && url.endsWith('/txs')) return send({ totalItems: 0, items: [] });
      if (url === '/dash/tx/send') { (state.dashRaw = state.dashRaw ?? []).push(json.rawtx); return send({}); }
      // Polygon and Arbitrum: their own chain ids, and nothing held there.
      if (url === '/pol/rpc' || url === '/arb/rpc') {
        const ok = (result) => send({ jsonrpc: '2.0', id: json.id, result });
        const m = json.method;
        (state.evmCalls = state.evmCalls ?? []).push(`${url}:${m}`);
        if (m === 'eth_chainId') return ok(url === '/pol/rpc' ? '0x89' : '0xa4b1');
        if (m === 'eth_getBalance') return ok('0x0');
        if (m === 'eth_call') return ok('0x' + '0'.repeat(64));
        if (m === 'eth_getBlockByNumber') return ok({ baseFeePerGas: '0x3b9aca00' });
        if (m === 'eth_maxPriorityFeePerGas') return ok('0x0');
        return send({ jsonrpc: '2.0', id: json.id, error: { message: 'unknown ' + m } });
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
