const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { verifyMessage, verifyTypedData } = require('ethers');
const { WalletService } = require('../dist/main/service');
const { FileStorage } = require('../dist/main/walletconnect');
const { deriveEthAccount } = require('../dist/main/eth');

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ME = deriveEthAccount(M).address;

function setup(t, request) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = new WalletService(dir, undefined, { tronHost: 'http://x' });
  const answered = [];
  const sent = [];
  s.tron = { address: 'T' };
  const evm = (symbol) => ({ address: ME, chain: { symbol }, estimateCall: async () => 50_000n, costOf: async () => ({ likely: 1_000_000_000_000n }), sendCalls: async (calls) => { sent.push(calls); return ['0x' + 'ab'.repeat(32)]; } });
  s.eth = evm('ETH'); s.bsc = evm('BNB'); s.pol = evm('POL'); s.arb = evm('ETH');
  s.vault = { exists: async () => false, open: async (pw) => { if (pw !== 'right password') throw new Error('Wrong password'); return { tronMnemonic: M }; } };
  s.wc = { request: () => request, respond: async (id, result) => answered.push(result) };
  s.session = () => ({ tron: s.tron, eth: s.eth });
  return { s, answered, sent };
}

test('personal_sign: the text is shown, and the signature is this wallet\'s', async (t) => {
  const { s, answered } = setup(t, { id: 1, dapp: 'D', url: 'https://d.example', chainId: 1n, method: 'personal_sign', params: ['0x' + Buffer.from('Log in to D').toString('hex'), ME] });
  const info = await s.wcRequestInfo(1);
  assert.equal(info.message, 'Log in to D');
  assert.deepEqual(info.warnings, []);
  await assert.rejects(s.wcConfirm(1, 'wrong'), /Wrong password/);
  assert.equal(answered.length, 0, 'nothing answered without the password');
  await s.wcConfirm(1, 'right password');
  assert.equal(verifyMessage('Log in to D', answered[0]), ME);
});

test('typed data: a permit is called out, and the signature verifies', async (t) => {
  const data = {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Permit: [{ name: 'owner', type: 'address' }, { name: 'value', type: 'uint256' }] },
    domain: { name: 'Token', chainId: 1 }, primaryType: 'Permit', message: { owner: ME, value: '5' },
  };
  const { s, answered } = setup(t, { id: 2, dapp: 'D', url: '', chainId: 1n, method: 'eth_signTypedData_v4', params: [ME, JSON.stringify(data)] });
  const info = await s.wcRequestInfo(2);
  assert.match(info.warnings.join(' '), /permit/);
  await s.wcConfirm(2, 'right password');
  assert.equal(verifyTypedData(data.domain, { Permit: data.types.Permit }, data.message, answered[0]), ME);
});

test('transactions: an open-ended approval is called out; sent on the requested chain; another sender refused', async (t) => {
  const spender = '1111111111111111111111111111111111111111';
  const approve = '0x095ea7b3' + spender.padStart(64, '0') + 'f'.repeat(64);
  const { s, answered, sent } = setup(t, { id: 3, dapp: 'D', url: '', chainId: 56n, method: 'eth_sendTransaction', params: [{ from: ME, to: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', data: approve, value: '0x0' }] });
  const info = await s.wcRequestInfo(3);
  assert.equal(info.network, 'BNB Smart Chain');
  assert.match(info.warnings.join(' '), /no limit/);
  await s.wcConfirm(3, 'right password');
  assert.equal(sent[0][0].data, approve);
  assert.equal(sent[0][0].gas, 50_000n);
  assert.equal(answered[0], '0x' + 'ab'.repeat(32));
  const other = setup(t, { id: 4, dapp: 'D', url: '', chainId: 1n, method: 'eth_sendTransaction', params: [{ from: '0x' + '22'.repeat(20), to: ME, value: '0x1' }] });
  await assert.rejects(other.s.wcRequestInfo(4), /different address/);
});

test('WalletConnect is refused in a private wallet, and Tor in a WalletConnect wallet', async (t) => {
  const { s } = setup(t, null);
  s.wc = null;
  await assert.rejects(s.wcPair('wc:' + 'a'.repeat(64) + '@2?relay-protocol=irn&symKey=' + 'b'.repeat(64)), /only in wallets made for it|isn't set up/);
  assert.equal(await s.walletMode(), 'private', 'a wallet made before the choice is private');
  // A WalletConnect wallet never gets Tor: the setting is refused there.
  await s.setWalletMode('walletconnect');
  await assert.rejects(s.updateSettings({ torEnabled: true }), /only in maximum-privacy wallets/);
  assert.equal(s.torOn, false);
});

test('the WalletConnect store keeps its entries in one file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'wc.json');
  const a = new FileStorage(f);
  await a.setItem('x', { y: 1 });
  await a.setItem('z', [1, 2]);
  await a.removeItem('z');
  const b = new FileStorage(f);
  assert.deepEqual(await b.getEntries(), [['x', { y: 1 }]]);
  assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600');
});

test('typed data the way perp DEXes send it: another network in the domain, data as an object, or in the other order', async (t) => {
  // An "enable trading" approval: signed for chain 1337 while the session is on Arbitrum.
  const data = {
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
    domain: { name: 'Exchange', chainId: 1337 }, primaryType: 'Agent', message: { source: 'a', connectionId: '0x' + '11'.repeat(32) },
  };
  for (const params of [[ME, data], [JSON.stringify(data), ME]]) {
    const { s, answered } = setup(t, { id: 5, dapp: 'Perp', url: '', chainId: 42161n, method: 'eth_signTypedData_v4', params });
    const info = await s.wcRequestInfo(5);
    assert.equal(info.kind, 'typed');
    assert.match(info.warnings.join(' '), /different network/, 'shown, with a warning, not refused');
    await s.wcConfirm(5, 'right password');
    assert.equal(verifyTypedData(data.domain, { Agent: data.types.Agent }, data.message, answered[0]), ME);
  }
  const old = setup(t, { id: 6, dapp: 'D', url: '', chainId: 1n, method: 'eth_signTypedData', params: [[{ type: 'string', name: 'x', value: 'y' }], ME] });
  await assert.rejects(old.s.wcRequestInfo(6), /old kind of signature/);
});

test('a request the wallet can\'t do is answered with an error and shown, never dropped silently', async () => {
  const { WalletConnectManager } = require('../dist/main/walletconnect');
  const events = [];
  const answers = [];
  const m = new WalletConnectManager('p', '/nonexistent', ME, (e, d) => events.push([e, d]));
  m.kit = { respondSessionRequest: async (r) => answers.push(r.response), getActiveSessions: () => ({ t1: { peer: { metadata: { name: 'Perp', url: 'https://perp.example' } } } }) };
  await m.onRequest({ topic: 't1', id: 9, params: { chainId: 'eip155:42161', request: { method: 'eth_sign', params: [] } } });
  await m.onRequest({ topic: 't1', id: 10, params: { chainId: 'eip155:999', request: { method: 'personal_sign', params: [] } } });
  assert.equal(answers.length, 2);
  assert.ok(answers.every((a) => a.error));
  assert.deepEqual(events.map(([e]) => e), ['wc-refused', 'wc-refused']);
  assert.equal(events[0][1].method, 'eth_sign');
  assert.equal(events[1][1].network, 'network 999');
});
