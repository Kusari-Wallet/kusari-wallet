// Real contracts on a local chain, real proofs from the app's worker, real wallet code.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { WalletService } = require('../dist/main/service');
const { EthClient, deriveEthAccount } = require('../dist/main/eth');
const { checkRelayerUrl, denomination, noteSecrets, noteText, relayerFee } = require('../dist/main/tornado');
const { startChain } = require('./tornado-chain');

const PHRASE = 'test test test test test test test test test test test junk';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const OUT = ethers.Wallet.createRandom().address;
const OUT2 = ethers.Wallet.createRandom().address;

test('note helpers: stable, standard form, pool amounts, relayer limits', () => {
  const a = noteSecrets(PHRASE, 0);
  assert.deepEqual(a, noteSecrets(` ${PHRASE.toUpperCase()} `, 0));
  assert.notEqual(a.nullifier, noteSecrets(PHRASE, 1).nullifier);
  assert.equal(a.nullifier.length, 62);
  assert.notEqual(a.nullifier, a.secret);
  assert.match(noteText('0.1', a), /^tornado-eth-0\.1-1-0x[0-9a-f]{124}$/);
  assert.equal(denomination('0.1'), 10n ** 17n);
  assert.equal(denomination('100'), 100n * 10n ** 18n);
  assert.equal(relayerFee('0.1', 0.5, 1_000_000_000n), 500_000n * 1_000_000_000n + 5n * 10n ** 14n);
  assert.throws(() => relayerFee('0.1', 0.5, 100n * 1_000_000_000n), /over 5%/);
  assert.equal(checkRelayerUrl('https://relay.example.org/', false), 'https://relay.example.org');
  for (const bad of ['http://relay.example.org', 'ftp://x', 'https://a.b/path', 'http://127.0.0.1:80']) assert.throws(() => checkRelayerUrl(bad, false), /[Rr]elayer/);
});

test('deposit, proof, withdraw through a relayer and directly, on the real contracts', { timeout: 280_000 }, async (t) => {
  const chain = await startChain(PHRASE);
  t.after(() => chain.stop());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A relayer doing what real ones do: sends the proof, keeps only the fee the proof allows.
  const relayerAddress = await chain.relayer.getAddress();
  const jobs = new Map();
  const relay = http.createServer((q, r) => {
    let b = '';
    q.on('data', (c) => { b += c; });
    q.on('end', async () => {
      const send = (o, code = 200) => { r.statusCode = code; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
      if (q.url === '/status') return send({ netId: 1, rewardAccount: relayerAddress, tornadoServiceFee: 0.5 });
      if (q.url === '/v1/tornadoWithdraw') {
        const { contract, proof, args } = JSON.parse(b);
        assert.equal(contract, chain.address);
        try {
          const tx = await chain.tornado.connect(chain.relayer).withdraw(proof, ...args);
          await tx.wait();
          jobs.set('j1', { status: 'CONFIRMED', txHash: tx.hash });
          return send({ id: 'j1' });
        } catch (e) { return send({ error: e.message }, 400); }
      }
      if (q.url === '/v1/jobs/j1') return send(jobs.get('j1'));
      send({}, 404);
    });
  });
  await new Promise((res) => relay.listen(0, '127.0.0.1', res));
  t.after(() => relay.close());
  const relayUrl = `http://127.0.0.1:${relay.address().port}`;

  const s = new WalletService(dir, undefined, { tornadoPools: { 0.1: chain.address }, tornadoLocalRelayer: true });
  const me = deriveEthAccount(PHRASE);
  const eth = new EthClient([chain.url], chain.url, USDT, me.address);
  s.tron = {}; s.monero = {}; s.btc = {}; s.dash = {}; s.firo = {}; s.eth = eth;
  s.vault.open = async (pw) => { if (pw !== 'pw') throw new Error('Wrong password.'); return { tronMnemonic: PHRASE }; };

  assert.equal(await s.tornadoCheck(), true);

  // Deposit: the note exists before the money moves
  const prep = await s.tornadoDepositPrepare('0.1');
  assert.equal(prep.amount, '0.1');
  await assert.rejects(s.tornadoDepositConfirm(prep.id, '0.1', 'wrong'), /[Pp]assword/);
  const n1 = await s.tornadoDepositConfirm(prep.id, '0.1', 'pw');
  assert.equal(n1.status, 'deposited');
  assert.equal(n1.index, 0);
  assert.equal(await chain.provider.getBalance(chain.address), 10n ** 17n);
  const n2 = await s.tornadoDepositConfirm((await s.tornadoDepositPrepare('0.1')).id, '0.1', 'pw');
  assert.equal(n2.index, 1);
  await assert.rejects(s.tornadoDepositPrepare('7'), /No such pool/);

  // Withdraw checks
  await assert.rejects(s.tornadoWithdrawQuote(n1.id, me.address.toLowerCase(), ''), /deposit address/);
  await assert.rejects(s.tornadoWithdrawQuote(n1.id, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', ''), /Ethereum address/);

  // Through the relayer: nothing comes from my address
  const quote = await s.tornadoWithdrawQuote(n1.id, OUT, relayUrl);
  assert.equal(quote.mode, 'relayer');
  assert.equal(quote.relayer, relayerAddress);
  const stages = [];
  s.on('tornado-progress', (m) => stages.push(m));
  const nonceBefore = await chain.provider.getTransactionCount(me.address);
  const done = await s.tornadoWithdraw(n1.id, OUT, relayUrl, 'pw');
  assert.equal(done.status, 'withdrawn');
  assert.equal(await chain.provider.getTransactionCount(me.address), nonceBefore, 'my address sent nothing');
  const tx = await chain.provider.getTransaction(done.withdrawTx);
  assert.equal(tx.from, relayerAddress);
  assert.equal(await chain.provider.getBalance(OUT), 10n ** 17n - ethers.parseEther(quote.fee), 'exactly the quoted amount');
  assert.ok(stages.some((m) => /Merkle/.test(m)) && stages.some((m) => /proof/.test(m)));

  // Spent notes are refused without burning time on a proof
  await assert.rejects(s.tornadoWithdraw(n1.id, OUT, relayUrl, 'pw'), /already withdrawn/);

  // Directly, the fallback: works, full amount
  const self = await s.tornadoWithdrawQuote(n2.id, OUT2, '');
  assert.equal(self.mode, 'self');
  assert.equal(self.receive, '0.1');
  await s.tornadoWithdraw(n2.id, OUT2, '', 'pw');
  assert.equal(await chain.provider.getBalance(OUT2), 10n ** 17n);

  // Restoring from the seed finds both, and knows they are spent
  fs.rmSync(path.join(dir, 'tornado.json'));
  assert.deepEqual((await s.tornadoInfo()).notes, []);
  const found = await s.tornadoRecover('pw');
  assert.equal(found.found, 2);
  const notes = (await s.tornadoInfo()).notes;
  assert.deepEqual(notes.map((n) => n.status), ['withdrawn', 'withdrawn']);
  assert.equal((await s.tornadoExport(notes[0].id, 'pw')).length, 'tornado-eth-0.1-1-0x'.length + 124);

  // A new deposit after recovery does not reuse a secret
  const n3 = await s.tornadoDepositConfirm((await s.tornadoDepositPrepare('0.1')).id, '0.1', 'pw');
  assert.equal(n3.index, 2);

  // A proof tied to one recipient can't pay another
  const keys = noteSecrets(PHRASE, 2);
  const { runTornado } = require('../dist/main/tornado-run');
  const leaves = JSON.parse(fs.readFileSync(path.join(dir, 'tornado-cache-0.1.json'), 'utf8')).leaves.concat(n3.commitment);
  const { proof, args } = await runTornado('prove', { leaves, leafIndex: 2, ...keys, recipient: OUT, relayer: relayerAddress, fee: '0' });
  const hijack = [...args];
  hijack[2] = OUT2;
  await assert.rejects(chain.tornado.connect(chain.relayer).withdraw(proof, ...hijack));
  const greedy = [...args];
  greedy[4] = `0x${(10n ** 16n).toString(16)}`;
  await assert.rejects(chain.tornado.connect(chain.relayer).withdraw(proof, ...greedy));
  // The untouched proof still works, so those two failed because of the changes.
  await (await chain.tornado.connect(chain.relayer).withdraw(proof, ...args)).wait();
  assert.equal(await chain.provider.getBalance(OUT), 2n * 10n ** 17n - ethers.parseEther(quote.fee));
});

test('relayer list and pick, split deposits over time, a withdrawal to a new address of this wallet at a later time', { timeout: 280_000 }, async (t) => {
  const { pickRelayer, splitPlan, parseRelayerLog, RELAYER_REGISTERED } = require('../dist/main/tornado');
  const { ethAddressNode } = require('../dist/main/eth');
  // The pick: always among the cheapest 30%.
  const list = Array.from({ length: 10 }, (_, i) => ({ url: `https://r${i}.example`, feePercent: 0.1 * (10 - i) }));
  const seen = new Set(Array.from({ length: 200 }, () => pickRelayer(list).url));
  assert.deepEqual([...seen].sort(), ['https://r7.example', 'https://r8.example', 'https://r9.example']);
  assert.equal(pickRelayer([]), null);
  assert.deepEqual(splitPlan(ethers.parseEther('11.35'), ['0.1', '1', '10', '100']), { pools: ['10', '1', '0.1', '0.1', '0.1'], left: ethers.parseEther('0.05') });
  // A registration event, as the registry writes it.
  const data = ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'string', 'address', 'uint256'], [ethers.namehash('fast.eth'), 'fast.eth', OUT, 10n ** 21n]);
  assert.deepEqual(parseRelayerLog({ data, topics: [RELAYER_REGISTERED] }), { name: 'fast.eth', address: OUT });
  assert.equal(parseRelayerLog({ data: '0x1234' }), null);

  const chain = await startChain(PHRASE);
  t.after(() => chain.stop());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const relayerAddress = await chain.relayer.getAddress();
  const jobs = new Map();
  const relay = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', async () => {
      const send = (o, code = 200) => { r.statusCode = code; r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
      if (q.url === '/status') return send({ netId: 1, rewardAccount: relayerAddress, tornadoServiceFee: 0.3 });
      if (q.url === '/v1/tornadoWithdraw') {
        const { proof, args } = JSON.parse(b);
        try { const tx = await chain.tornado.connect(chain.relayer).withdraw(proof, ...args); await tx.wait(); jobs.set('j1', { status: 'CONFIRMED', txHash: tx.hash }); return send({ id: 'j1' }); } catch (e) { return send({ error: e.message }, 400); }
      }
      if (q.url === '/v1/jobs/j1') return send(jobs.get('j1'));
      send({}, 404);
    });
  });
  await new Promise((res) => relay.listen(0, '127.0.0.1', res));
  t.after(() => relay.close());
  const relayUrl = `http://127.0.0.1:${relay.address().port}`;

  const s = new WalletService(dir, undefined, { tornadoPools: { 0.1: chain.address }, tornadoLocalRelayer: true, tornadoRelayerNames: [{ name: 'local.eth', address: relayerAddress, url: relayUrl }, { name: 'dead.eth', address: OUT, url: 'http://127.0.0.1:1' }] });
  const me = deriveEthAccount(PHRASE);
  s.tron = {}; s.monero = {}; s.btc = {}; s.dash = {}; s.firo = {}; s.eth = new EthClient([chain.url], chain.url, USDT, me.address);
  s.ethNode = ethAddressNode(PHRASE);
  s.vault.open = async (pw) => { if (pw !== 'pw') throw new Error('Wrong password.'); return { tronMnemonic: PHRASE }; };
  t.after(() => s.onLock());

  // 0.25 ETH: two deposits of 0.1, the second signed now and sent later; 0.05 stays.
  const split = await s.tornadoSplitPrepare('0.25', true);
  assert.deepEqual([split.pools, split.left], [['0.1', '0.1'], '0.05']);
  const [first, second] = await s.tornadoSplitConfirm(split.id, 'pw');
  assert.equal(first.status, 'deposited');
  assert.equal(second.status, 'scheduled');
  assert.ok(second.at > Date.now() + 25 * 60_000, 'the next one goes out later');
  assert.equal(await chain.provider.getBalance(chain.address), 10n ** 17n, 'only the first is in the pool yet');
  await s.fireTornado(second.id);
  assert.equal(await chain.provider.getBalance(chain.address), 2n * 10n ** 17n);
  assert.equal((await s.tornadoInfo()).notes.find((n) => n.id === second.id).status, 'deposited');

  // The relayer picked from the list (the one that answers), and a new address of this wallet.
  const q = await s.tornadoWithdrawQuote(first.id, 'new', 'auto');
  assert.equal(q.relayerUrl, relayUrl);
  assert.equal(q.recipient, s.ethNode.addressAt(0));
  assert.equal(q.fresh, true);
  assert.ok(q.warnings.some((w) => /less than a day/.test(w)), 'too soon is said');
  assert.equal(q.after, null, 'unknown until the deposit list has been read on this device');
  await assert.rejects(s.tornadoWithdraw(first.id, 'new', '', 'pw', { delayMinutes: 10 }), /through a relayer/);

  // Later: at a random time 1 to 24 hours away the proof is made and the relayer gets it; the new address is kept.
  const before = Date.now();
  const waiting = await s.tornadoWithdraw(first.id, 'new', 'auto', 'pw', { delayMinutes: 10 });
  assert.equal(waiting.status, 'scheduled');
  assert.ok(waiting.at >= before + 3600_000 && waiting.at <= Date.now() + 24 * 3600_000, 'between 1 and 24 hours away');
  assert.deepEqual((await s.ethAddresses()).map((x) => x.address), [s.ethNode.addressAt(0)]);
  assert.equal(await chain.provider.getBalance(s.ethNode.addressAt(0)), 0n);
  await s.fireTornado(first.id);
  const done = (await s.tornadoInfo()).notes.find((n) => n.id === first.id);
  assert.equal(done.status, 'withdrawn');
  // The deposit list is on the device now: how many came after each one is known.
  const q2 = await s.tornadoWithdrawQuote(second.id, OUT, relayUrl);
  assert.equal(q2.after, 0);
  assert.ok(q2.warnings.some((w) => /Only 0 deposits/.test(w)));

  // A deposit with an address to send it on to: a relayer sends it there at a random time 1 to 24 hours later.
  const OUT2 = ethers.Wallet.createRandom().address;
  const prep = await s.tornadoDepositPrepare('0.1');
  await assert.rejects(s.tornadoDepositConfirm(prep.id, '0.1', 'pw', { sendTo: me.address }), /deposit address/);
  const onward = await s.tornadoDepositConfirm(prep.id, '0.1', 'pw', { sendTo: OUT2 });
  assert.equal(onward.sendTo, OUT2);
  assert.ok(onward.at >= Date.now() + 3600_000 - 5_000 && onward.at <= Date.now() + 24 * 3600_000);
  await s.fireTornado(onward.id);
  assert.equal((await s.tornadoInfo()).notes.find((n) => n.id === onward.id).status, 'withdrawn');
  assert.ok(await chain.provider.getBalance(OUT2) > 9n * 10n ** 16n, 'arrived, less the relayer fee');
  assert.equal(await chain.provider.getBalance(s.ethNode.addressAt(0)), 10n ** 17n - ethers.parseEther(q.fee));
});

test('other chains: the pools the Tornado site lists, standard notes, relayers checked for the network', async (t) => {
  const { TORNADO_CHAINS, noteText, relayerStatus, relayerFee } = require('../dist/main/tornado');
  const { randomLater } = require('../dist/main/service-send');
  assert.deepEqual(Object.keys(TORNADO_CHAINS), ['eth', 'bsc', 'pol', 'arb']);
  assert.equal(TORNADO_CHAINS.bsc.pools['0.1'], '0x84443CFd09A48AF6eF360C6976C5392aC5023a1F');
  assert.equal(TORNADO_CHAINS.pol.pools['100000'], '0xa5C2254e4253490C54cef0a4347fddb8f75A4998');
  assert.equal(TORNADO_CHAINS.arb.pools['100'], '0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD');
  const keys = { nullifier: '11'.repeat(31), secret: '22'.repeat(31) };
  assert.equal(noteText('1', keys, 'bsc'), `tornado-bnb-1-56-0x${'11'.repeat(31)}${'22'.repeat(31)}`);
  assert.equal(noteText('100', keys, 'pol').slice(0, 21), 'tornado-matic-100-137');
  assert.equal(noteText('0.1', keys, 'arb').slice(0, 23), 'tornado-eth-0.1-42161-0');
  // Arbitrum's gas, as the site prices it, goes into the fee.
  assert.equal(relayerFee('1', 0, 10n ** 8n, TORNADO_CHAINS.arb.withdrawGas), 1_900_000n * 10n ** 8n);
  const relay = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ netId: 56, rewardAccount: OUT, tornadoServiceFee: 0.2 })); });
  await new Promise((res) => relay.listen(0, '127.0.0.1', res));
  t.after(() => relay.close());
  const url = `http://127.0.0.1:${relay.address().port}`;
  assert.equal((await relayerStatus(url, undefined, 56)).feePercent, 0.2);
  await assert.rejects(relayerStatus(url, undefined, 137), /another network/);
  for (let i = 0; i < 200; i++) { const at = randomLater(0); assert.ok(at >= 3600_000 && at <= 24 * 3600_000, String(at)); }
});
