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
  assert.throws(() => relayerFee('0.1', 0.5, 100n * 1_000_000_000n), /5%를 넘어/);
  assert.equal(checkRelayerUrl('https://relay.example.org/', false), 'https://relay.example.org');
  for (const bad of ['http://relay.example.org', 'ftp://x', 'https://a.b/path', 'http://127.0.0.1:80']) assert.throws(() => checkRelayerUrl(bad, false), /릴레이어/);
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
  s.tron = {}; s.monero = {}; s.btc = {}; s.dcr = {}; s.dash = {}; s.firo = {}; s.eth = eth;
  s.vault.open = async (pw) => { if (pw !== 'pw') throw new Error('비밀번호가 틀렸어.'); return { tronMnemonic: PHRASE }; };

  assert.equal(await s.tornadoCheck(), true);

  // Deposit: the note exists before the money moves
  const prep = await s.tornadoDepositPrepare('0.1');
  assert.equal(prep.amount, '0.1');
  await assert.rejects(s.tornadoDepositConfirm(prep.id, '0.1', 'wrong'), /비밀번호/);
  const n1 = await s.tornadoDepositConfirm(prep.id, '0.1', 'pw');
  assert.equal(n1.status, 'deposited');
  assert.equal(n1.index, 0);
  assert.equal(await chain.provider.getBalance(chain.address), 10n ** 17n);
  const n2 = await s.tornadoDepositConfirm((await s.tornadoDepositPrepare('0.1')).id, '0.1', 'pw');
  assert.equal(n2.index, 1);
  await assert.rejects(s.tornadoDepositPrepare('7'), /없는 풀/);

  // Withdraw checks
  await assert.rejects(s.tornadoWithdrawQuote(n1.id, me.address.toLowerCase(), ''), /입금한 주소/);
  await assert.rejects(s.tornadoWithdrawQuote(n1.id, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', ''), /Ethereum 주소/);

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
  assert.ok(stages.some((m) => /머클/.test(m)) && stages.some((m) => /증명/.test(m)));

  // Spent notes are refused without burning time on a proof
  await assert.rejects(s.tornadoWithdraw(n1.id, OUT, relayUrl, 'pw'), /이미 출금/);

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
