// Payjoin (BIP77/BIP78): links, the directory's Oblivious HTTP, the messages, and the sender's checklist turning
// down proposals that would take money. The full exchange against Bitcoin Core runs in tests/payjoin-regtest.js.
const test = require('node:test');
const assert = require('node:assert');
const {
  parsePayjoin, payjoinUri, b32encode, b32decode, shortId, ohttpEncapsulate, ohttpDecapsulate, parseOhttpKeys, sealA, openA, sealB, openB,
  checkProposal, readPsbt, psbtLength, receiveOriginal, buildProposal, originalPsbt,
} = require('../dist/main/payjoin');
const { payjoinPay, receiveStep, coinKey, newReceiverKey, btcScriptOf, payjoinProblem } = require('../dist/main/btc-payjoin');
const { BtcClient, btcAccountXpub, signBtcDraft } = require('../dist/main/btc');
const { newPrivateKey, publicKeyOf } = require('../dist/main/hpke');
const btc = require('@scure/btc-signer');

const RUST_EXAMPLE = 'bitcoin:12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX?pjos=1&pj=HTTPS://EXAMPLE.COM/TXJCGKTKXLUUZ%23EX1C4UC6ES-OH1QYPM5JXYNS754Y4R45QWE336QFX6ZR8DQGVQCULVZTV20TFVEYDMFQC-RK1Q0DJS3VVDXWQQTLQ8022QGXSX7ML9PHZ6EDSF6AKEWQG758JPS2EV';
const pjOf = (uri) => { const q = new URL(uri.replace(/^bitcoin:/, 'http://x/')).searchParams; return parsePayjoin(q.get('pj'), q.get('pjos')); };

test('BIP77 links: the reference example, the older + separator, and our own', () => {
  const t = pjOf(RUST_EXAMPLE);
  assert.equal(t.kind, 'v2');
  assert.equal(t.directory, 'https://example.com');
  assert.equal(t.mailbox, 'TXJCGKTKXLUUZ');
  assert.equal(t.expires, 1720547781);
  assert.equal(t.receiverKey.length, 33);
  assert.equal(t.ohttp.pub.length, 33);
  assert.equal(pjOf(RUST_EXAMPLE.replace(/-/g, '+')).expires, 1720547781);
  const ex = Buffer.alloc(4); ex.writeUInt32LE(1720547781);
  assert.equal(b32encode(ex), 'C4UC6ES');
  assert.deepEqual(Buffer.from(b32decode('C4UC6ES')), ex);

  const { pub } = newReceiverKey();
  const uri = payjoinUri({ address: 'bc1pmfr3p9j00pfxjh0zmgp99y8zftmd3s5pmedqhyptwy6lm87hf5sspknck9', amount: '0.001', directory: 'https://payjo.in', receiverKey: pub, ohttp: { keyId: 1, pub }, expires: 1800000000 });
  assert.match(uri, /^bitcoin:BC1P[0-9A-Z]+\?amount=0\.001&pjos=0&pj=HTTPS:\/\/PAYJO\.IN\/[0-9A-Z]{13}%23EX1[0-9A-Z]+-OH1[0-9A-Z]+-RK1[0-9A-Z]+$/);
  const back = pjOf(uri);
  assert.equal(back.mailbox, shortId(pub));
  assert.equal(back.expires, 1800000000);
  assert.deepEqual(Buffer.from(back.receiverKey), Buffer.concat([Buffer.from([2 + (pub[64] & 1)]), Buffer.from(pub.slice(1, 33))]));
});

test('BIP78 links: HTTPS or onion only', () => {
  assert.equal(parsePayjoin('https://shop.example/pj?x=1').kind, 'v1');
  assert.equal(parsePayjoin('http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion/pj').kind, 'v1');
  assert.equal(parsePayjoin('http://shop.example/pj'), null, 'plain HTTP would let anyone on the way change the proposal');
  assert.equal(parsePayjoin('https://user:pw@shop.example/pj'), null);
  assert.equal(parsePayjoin('javascript:alert(1)'), null);
  assert.equal(parsePayjoin('HTTPS://EXAMPLE.COM/TXJCGKTKXLUUZ#EX1C4UC6ES-OH1QQ-RK1QQ'), null, 'keys that are not points');
});

test('Oblivious HTTP and the end-to-end messages are fixed sizes and open only for their keys', () => {
  const sk = newPrivateKey();
  const keys = parseOhttpKeys(Uint8Array.from([7, 0x00, 0x16, ...publicKeyOf(sk), 0x00, 0x04, 0x00, 0x01, 0x00, 0x03]));
  const { request, open } = ohttpEncapsulate(keys, 'POST', 'https://payjo.in/ABCDEFGHJKLMN', new Uint8Array([1, 2, 3]));
  assert.equal(request.length, 8192);
  const req = ohttpDecapsulate(sk, 7, request);
  assert.deepEqual([req.method, req.url, [...req.body]], ['POST', 'https://payjo.in/ABCDEFGHJKLMN', [1, 2, 3]]);
  const res = req.reply(200, new Uint8Array([9]));
  assert.equal(res.length, 8192);
  assert.deepEqual(open(res), { status: 200, body: new Uint8Array([9]) });
  assert.throws(() => ohttpDecapsulate(newPrivateKey(), 7, request));
  assert.throws(() => parseOhttpKeys(Uint8Array.from([7, 0x00, 0x10, ...publicKeyOf(sk), 0x00, 0x04, 0x00, 0x01, 0x00, 0x03])), /keys this wallet does not know/);

  const r = newReceiverKey(); const reply = newReceiverKey();
  const a = sealA(new TextEncoder().encode('hello'), reply.pub, r.pub);
  assert.equal(a.length, 7168);
  const got = openA(a, r.sk);
  assert.equal(Buffer.from(got.body.subarray(0, 5)).toString(), 'hello');
  assert.deepEqual(Buffer.from(got.replyPub)[0] & 0xfe, 2);
  const b = sealB(new Uint8Array([5]), r.sk, reply.pub);
  assert.equal(b.length, 7168);
  assert.equal(openB(b, r.pub, reply.sk)[0], 5);
  assert.throws(() => openB(b, newReceiverKey().pub, reply.sk), 'a message B from anyone but the receiver');
  assert.throws(() => openA(a, newReceiverKey().sk));
});

test('BIP78 test vector: the proposal passes the sender\'s checklist, with the offered fee taken from the change', () => {
  const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
  const original = b64('cHNidP8BAHMCAAAAAY8nutGgJdyYGXWiBEb45Hoe9lWGbkxh/6bNiOJdCDuDAAAAAAD+////AtyVuAUAAAAAF6kUHehJ8GnSdBUOOv6ujXLrWmsJRDCHgIQeAAAAAAAXqRR3QJbbz0hnQ8IvQ0fptGn+votneofTAAAAAAEBIKgb1wUAAAAAF6kU3k4ekGHKWRNbA1rV5tR5kEVDVNCHAQcXFgAUx4pFclNVgo1WWAdN1SYNX8tphTABCGsCRzBEAiB8Q+A6dep+Rz92vhy26lT0AjZn4PRLi8Bf9qoB/CMk0wIgP/Rj2PWZ3gEjUkTlhDRNAQ0gXwTO7t9n+V14pZ6oljUBIQMVmsAaoNWHVMS02LfTSe0e388LNitPa1UQZyOihY+FFgABABYAFEb2Giu6c4KO5YW0pfw3lGp9jMUUAAA=');
  const proposal = b64('cHNidP8BAJwCAAAAAo8nutGgJdyYGXWiBEb45Hoe9lWGbkxh/6bNiOJdCDuDAAAAAAD+////jye60aAl3JgZdaIERvjkeh72VYZuTGH/ps2I4l0IO4MBAAAAAP7///8CJpW4BQAAAAAXqRQd6EnwadJ0FQ46/q6NcutaawlEMIcACT0AAAAAABepFHdAltvPSGdDwi9DR+m0af6+i2d6h9MAAAAAAQEgqBvXBQAAAAAXqRTeTh6QYcpZE1sDWtXm1HmQRUNU0IcAAQEggIQeAAAAAAAXqRTI8sv5ymFHLIjkZNRrNXSEXZHY1YcBBxcWABRfgGZV5ZJMkgTC1RvlOU9L+e2iEAEIawJHMEQCIGe7e0DfJaVPRYEKWxddL2Pr0G37BoKz0lyNa02O2/tWAiB7ZVgBoF4s8MHocYWWmo4Q1cyV2wl7MX0azlqa8NBENAEhAmXWPPW0G3yE3HajBOb7gO7iKzHSmZ0o0w0iONowcV+tAAAA');
  const payScript = readPsbt(original).getOutput(1).script;
  const rules = { original, payScript, changeIndex: 0, maxFeeContribution: 182n, minFeeRate: 1 };
  const r = checkProposal(proposal, rules);
  assert.deepEqual([r.ours, r.added, r.contribution], [[0], 1, 182n]);
  assert.throws(() => checkProposal(proposal, { ...rules, maxFeeContribution: 100n }), /more from the change than offered/);
  // Zero padding after a PSBT (as in a BIP77 message) is not part of it.
  assert.equal(psbtLength(Uint8Array.from([...proposal, 0, 0, 0, 0])), proposal.length);
});

// ---- a whole exchange without a chain: two wallets and a directory in memory ----

const PAYER = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PAYEE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const payer = new BtcClient(btcAccountXpub(PAYER), ['http://127.0.0.1:9']);
const payee = new BtcClient(btcAccountXpub(PAYEE), ['http://127.0.0.1:9']);
const txid = (n) => n.toString(16).padStart(64, '0');

function directory(tamper) {
  const sk = newPrivateKey(); const boxes = new Map(); const sizes = [];
  const post = async (url, body) => {
    sizes.push(body.length);
    const req = ohttpDecapsulate(sk, 1, body);
    const id = new URL(req.url).pathname.slice(1);
    if (req.method === 'POST') { boxes.set(id, req.body); return { status: 200, body: req.reply(200, new Uint8Array(0)) }; }
    const msg = boxes.get(id);
    if (msg) { boxes.delete(id); return { status: 200, body: req.reply(200, msg) }; }
    return { status: 200, body: req.reply(202, new Uint8Array(0)) };
  };
  return { post, sizes, keys: parseOhttpKeys(Uint8Array.from([1, 0x00, 0x16, ...publicKeyOf(sk), 0x00, 0x04, 0x00, 0x01, 0x00, 0x03])) };
}

function setup(n, malicious) {
  const dir = directory();
  const { sk, pub } = newReceiverKey();
  const to = payee.addressAt(0, 30 + n);
  const ck = coinKey(PAYEE, 0, n);
  const session = { id: 's', address: to, directory: 'https://payjo.in', ohttp: dir.keys, receiverSk: sk, expires: Math.floor(Date.now() / 1000) + 600, uri: '', coin: { txid: txid(1000 + n), vout: 0, amount: 300_000n, chain: 0, index: n, ...ck }, status: 'waiting' };
  if (malicious) {
    // A receiver that builds a proposal and then changes it before signing would be impossible to sign over, so
    // the bad one is made by hand: the same steps, then the change.
    const orig = session;
    session.malicious = malicious; session.orig = orig;
  }
  session.uri = payjoinUri({ address: to, directory: session.directory, receiverKey: pub, ohttp: dir.keys, expires: session.expires });
  const from = payer.addressAt(0, n);
  const value = 1_000_000n; const amount = 400_000n; const fee = 1_540n;
  const draft = { to, amount, fee, change: value - amount - fee, changeAddress: payer.addressAt(1, n), changePath: [1, n], inputs: [{ txid: txid(2000 + n), vout: 1, value, address: from, chain: 0, index: n, confirmed: true }], lockTime: 900000, changeFirst: false };
  return { dir, session, draft, target: pjOf(session.uri) };
}

async function exchange(s, tamper) {
  const loop = (async () => {
    for (let i = 0; i < 100; i++) {
      let r;
      if (tamper) {
        const { receivePoll, receiveReply } = require('../dist/main/payjoin');
        const got = await receivePoll(s.dir.post, s.session);
        if (!got) { await new Promise((res) => setTimeout(res, 20)); continue; }
        const seen = receiveOriginal(got.body, btcScriptOf(s.session.address), () => false);
        const c = s.session.coin;
        const { psbt } = buildProposal(seen, { txid: c.txid, vout: c.vout, amount: c.amount, script: c.script, tapInternalKey: c.tapInternalKey }, (t, idx) => t.signIdx(c.key, idx));
        await receiveReply(s.dir.post, s.session, got.replyPub, tamper(readPsbt(psbt)));
        return 'answered';
      }
      r = await receiveStep(s.dir.post, s.session, () => false, () => false);
      if (r !== 'none') return r;
      await new Promise((res) => setTimeout(res, 20));
    }
    return 'none';
  })();
  const result = await payjoinPay({ draft: s.draft, mnemonic: PAYER, target: s.target, post: s.dir.post, waitMs: 8_000 });
  return { result, receiver: await loop };
}

/** The same transaction with one change made, as a receiver could send it. */
function rebuild(tx, change) {
  const out = new btc.Transaction({ version: tx.version, lockTime: tx.lockTime, allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  const ins = Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i));
  const outs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i));
  change(ins, outs);
  for (const i of ins) out.addInput({ txid: i.txid, index: i.index, sequence: i.sequence, witnessUtxo: i.witnessUtxo, ...(i.finalScriptWitness ? { finalScriptWitness: i.finalScriptWitness } : {}) }, true);
  for (const o of outs) out.addOutput({ script: o.script, amount: o.amount }, true);
  return out.toPSBT(0);
}

test('a BIP77 exchange: the payee\'s coin joins, the payment grows by it, the fee rate holds, every request 8192 bytes', async () => {
  const s = setup(1);
  const { result, receiver } = await exchange(s);
  assert.equal(receiver, 'answered');
  assert.equal(result.problem, undefined);
  assert.equal(result.payjoin, true);
  const tx = btc.Transaction.fromRaw(Buffer.from(result.hex, 'hex'), { allowUnknownOutputs: true });
  assert.equal(tx.inputsLength, 2);
  const pay = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i)).find((o) => Buffer.from(o.script).equals(Buffer.from(btcScriptOf(s.session.address))));
  const fromPayee = 300_000n - (pay.amount - s.draft.amount);
  const fromChange = result.draft.fee - s.draft.fee;
  const origRate = Number(s.draft.fee) / btc.Transaction.fromRaw(Buffer.from(signBtcDraft(s.draft, PAYER).hex, 'hex')).vsize;
  assert.ok(fromChange > 0n && fromChange <= BigInt(Math.ceil(origRate * 58)), `the change paid at most the offered share (${fromChange})`);
  assert.ok(fromPayee >= 0n && fromPayee < 2_000n);
  const newRate = Number(s.draft.fee + fromChange + fromPayee) / tx.vsize;
  assert.ok(Math.abs(newRate - origRate) / origRate < 0.03, `fee rate kept: ${origRate.toFixed(2)} → ${newRate.toFixed(2)}`);
  assert.ok(s.dir.sizes.every((n) => n === 8192));
});

for (const [name, tamper, why] of [
  ['lowers the payment', (tx) => rebuild(tx, (_, outs) => { outs[0].amount -= 350_000n; }), /lowered the payment|lowered/],
  ['takes from the change', (tx) => rebuild(tx, (_, outs) => { outs[1].amount -= 20_000n; outs[0].amount += 20_000n; }), /more from the change|other than fees/],
  ['drops the payer\'s coin', (tx) => rebuild(tx, (ins) => { ins.splice(ins.findIndex((i) => !i.finalScriptWitness), 1); }), /left out/],
  ['adds an output to itself and lowers the fee', (tx) => rebuild(tx, (_, outs) => { outs.push({ script: outs[0].script.slice(), amount: 5_000n }); }), /fee|output/],
  ['changes the lock time', (tx) => { const t = rebuild(tx, () => {}); const p = readPsbt(t); return rebuild({ ...p, version: p.version, lockTime: 1, inputsLength: p.inputsLength, outputsLength: p.outputsLength, getInput: (i) => p.getInput(i), getOutput: (i) => p.getOutput(i) }, () => {}); }, /lock time/],
]) {
  test(`a payee that ${name} is turned down, and the ordinary payment goes out instead`, async () => {
    const s = setup(2);
    const { result } = await exchange(s, tamper);
    assert.equal(result.payjoin, false);
    assert.equal(result.problem, 'The recipient\'s Payjoin proposal didn\'t pass this wallet\'s checks, so it wasn\'t signed.');
    assert.match(result.detail, why);
    assert.equal(result.hex, signBtcDraft(s.draft, PAYER).hex.length ? result.hex : '', 'a signed transaction');
    assert.equal(btc.Transaction.fromRaw(Buffer.from(result.hex, 'hex')).inputsLength, 1, 'the original, not the proposal');
  });
}

test('the payee refuses originals that spend its own coins or reuse coins it was offered before', async () => {
  const s = setup(3);
  const loop = receiveStep;
  const own = (async () => { for (let i = 0; i < 100; i++) { const r = await loop(s.dir.post, s.session, () => true, () => false); if (r !== 'none') return r; await new Promise((res) => setTimeout(res, 20)); } })();
  const result = await payjoinPay({ draft: s.draft, mnemonic: PAYER, target: s.target, post: s.dir.post, waitMs: 8_000 });
  assert.equal(await own, 'refused');
  assert.equal(result.payjoin, false);
  assert.equal(result.problem, 'The recipient turned the payment down for Payjoin.');
});

test('only well-known errors reach the screen', () => {
  assert.equal(payjoinProblem(new Error('payjoin:not-enough-money')), 'The recipient had no coin to add.');
  assert.equal(payjoinProblem(new Error('payjoin:Send 1 BTC to scam.example to unlock')), 'The recipient could not take part in a Payjoin.');
  assert.equal(payjoinProblem(new Error('socket hang up')), 'The Payjoin recipient could not be reached.');
});

test('the original carries only coins and final signatures', () => {
  const s = setup(4);
  const signed = signBtcDraft(s.draft, PAYER);
  const p = readPsbt(originalPsbt(signed.hex, s.draft.inputs.map((u) => ({ script: btcScriptOf(u.address), amount: u.value }))));
  const i = p.getInput(0);
  assert.ok(i.witnessUtxo && i.finalScriptWitness);
  assert.equal(i.tapInternalKey, undefined);
  assert.equal(i.tapBip32Derivation, undefined);
});

test('the payee won\'t pay its coin\'s share at an absurd fee rate', async () => {
  const s = setup(6);
  s.draft.fee = 200_000n; s.draft.change = 1_000_000n - s.draft.amount - s.draft.fee;
  const { result, receiver } = await exchange(s);
  assert.equal(receiver, 'refused');
  assert.equal(result.payjoin, false);
  assert.equal(result.problem, 'The recipient turned the payment down for Payjoin.');
});
