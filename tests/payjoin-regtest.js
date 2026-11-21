// Payjoin end to end against a real Bitcoin Core on regtest (by hand): one wallet asks to be paid with a BIP77
// link, another pays it, both through a directory (a small one here, speaking the same Oblivious HTTP), and the
// resulting transaction is accepted and mined. Then the same over BIP78 (a direct HTTPS-style post).
//
//   BTC_BIN=/path/to/bitcoin-28.x/bin node tests/payjoin-regtest.js
const assert = require('node:assert');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = process.env.BTC_BIN;
if (!BIN) { console.error('Set BTC_BIN to the folder with bitcoind and bitcoin-cli.'); process.exit(2); }
const { BtcClient, btcAccountXpub } = require('../dist/main/btc');
const { payjoinPay, receiveStep, coinKey, newReceiverKey } = require('../dist/main/btc-payjoin');
const { payjoinUri, parsePayjoin, ohttpDecapsulate, parseOhttpKeys } = require('../dist/main/payjoin');
const { newPrivateKey, publicKeyOf } = require('../dist/main/hpke');
const { bech32m } = require('@scure/base');

const PAYER = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PAYEE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-rt-'));
const cli = (...args) => execFileSync(path.join(BIN, 'bitcoin-cli'), ['-regtest', '-rpcport=18643', '-rpcuser=u', '-rpcpassword=p', ...args], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const regtest = (addr) => { const d = bech32m.decode(addr); return bech32m.encode('bcrt', d.words); };

/** A directory: mailboxes behind an Oblivious HTTP gateway, as BIP77 describes. */
function directory() {
  const sk = newPrivateKey(); const keyId = 1;
  const boxes = new Map();
  const config = Uint8Array.from([keyId, 0x00, 0x16, ...publicKeyOf(sk), 0x00, 0x04, 0x00, 0x01, 0x00, 0x03]);
  const post = async (url, body) => {
    assert.ok(url.endsWith('/.well-known/ohttp-gateway'), url);
    assert.equal(body.length, 8192, 'every request is 8192 bytes');
    const req = ohttpDecapsulate(sk, keyId, body);
    const id = new URL(req.url).pathname.slice(1);
    if (process.env.PJ_DEBUG) console.log('dir', req.method, id, boxes.has(id));
    if (req.method === 'POST') { boxes.set(id, req.body); return { status: 200, body: req.reply(200, new Uint8Array(0)) }; }
    const msg = boxes.get(id);
    if (msg) { boxes.delete(id); return { status: 200, body: req.reply(200, msg) }; }
    return { status: 200, body: req.reply(202, new Uint8Array(0)) };
  };
  return { post, keys: parseOhttpKeys(config) };
}

async function fund(addr, btcAmount) {
  const txid = cli('sendtoaddress', regtest(addr), String(btcAmount));
  const tx = JSON.parse(cli('getrawtransaction', txid, 'true'));
  const vout = tx.vout.find((o) => o.scriptPubKey.address === regtest(addr)).n;
  return { txid, vout, value: BigInt(Math.round(btcAmount * 1e8)) };
}

async function main() {
  spawn(path.join(BIN, 'bitcoind'), ['-regtest', `-datadir=${root}`, '-rpcport=18643', '-port=18644', '-rpcuser=u', '-rpcpassword=p', '-fallbackfee=0.0002', '-listen=0', '-txindex'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { cli('getblockcount'); break; } catch { await sleep(500); } }
  cli('createwallet', 'w');
  const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'));
  mine(101);

  const payer = new BtcClient(btcAccountXpub(PAYER), ['http://127.0.0.1:9']);
  const payee = new BtcClient(btcAccountXpub(PAYEE), ['http://127.0.0.1:9']);
  const dir = directory();

  for (const version of ['v2', 'v1']) {
    const n = version === 'v2' ? 0 : 1;
    const from = payer.addressAt(0, n); const change = payer.addressAt(1, n);
    const to = payee.addressAt(0, 10 + n); const payeeCoinAddr = payee.addressAt(0, n);
    const a = await fund(from, 0.5); const b = await fund(payeeCoinAddr, 0.2);
    mine(1);

    // The payee's request.
    const { sk, pub } = newReceiverKey();
    const ck = coinKey(PAYEE, 0, n);
    const session = {
      id: 's', address: to, directory: 'https://dir.example', ohttp: dir.keys, receiverSk: sk, expires: Math.floor(Date.now() / 1000) + 3600, uri: '',
      coin: { txid: b.txid, vout: b.vout, amount: b.value, chain: 0, index: n, ...ck }, status: 'waiting',
    };
    session.uri = payjoinUri({ address: to, directory: session.directory, receiverKey: pub, ohttp: dir.keys, expires: session.expires });
    const q = new URL(session.uri.replace(/^bitcoin:/, 'http://x/')).searchParams;
    let target = parsePayjoin(q.get('pj'), q.get('pjos'));
    assert.equal(target.kind, 'v2');

    let v1Server = null;
    if (version === 'v1') {
      // BIP78: the payee answers the post itself. Here the same steps run behind a function.
      target = { kind: 'v1', url: 'https://payee.example/pj', noSubstitution: true };
      v1Server = async (url, body) => {
        const query = new URL(url).search.slice(1);
        const { receiveOriginal, buildProposal } = require('../dist/main/payjoin');
        const { btcScriptOf } = require('../dist/main/btc-payjoin');
        const seen = receiveOriginal(`${Buffer.from(body).toString()}\n${query}`, btcScriptOf(to), () => false);
        const c = session.coin;
        const { psbt } = buildProposal(seen, { txid: c.txid, vout: c.vout, amount: c.amount, script: c.script, tapInternalKey: c.tapInternalKey }, (t, idx) => t.signIdx(c.key, idx));
        return { status: 200, body: new TextEncoder().encode(Buffer.from(psbt).toString('base64')) };
      };
    }

    const amount = 10_000_000n; const fee = 2_000n;
    const draft = {
      to, amount, fee, change: a.value - amount - fee, changeAddress: change, changePath: [1, n],
      inputs: [{ txid: a.txid, vout: a.vout, value: a.value, address: from, chain: 0, index: n, confirmed: true }],
      lockTime: Number(cli('getblockcount')), changeFirst: n === 1,
    };
    // The payee looks at its mailbox while the payer waits.
    let answered = null;
    const payeeLoop = version === 'v2' ? (async () => {
      for (let i = 0; i < 50 && !answered; i++) { const r = await receiveStep(dir.post, session, () => false, () => false).catch((e) => { console.error("payee:", e); throw e; }); if (r !== 'none') answered = r; else await sleep(100); }
    })() : Promise.resolve();
    const result = await payjoinPay({ draft, mnemonic: PAYER, target, post: version === 'v1' ? v1Server : dir.post, waitMs: 20_000 });
    await payeeLoop;
    assert.equal(result.problem, undefined, result.problem);
    assert.equal(result.payjoin, true);
    if (version === 'v2') assert.equal(answered, 'answered');

    const accepted = JSON.parse(cli('testmempoolaccept', JSON.stringify([result.hex])))[0];
    assert.ok(accepted.allowed, JSON.stringify(accepted));
    cli('sendrawtransaction', result.hex);
    mine(1);
    const tx = JSON.parse(cli('getrawtransaction', result.id, 'true'));
    assert.equal(tx.vin.length, 2, 'both sides\' coins');
    const paid = tx.vout.find((o) => o.scriptPubKey.address === regtest(to));
    assert.equal(BigInt(Math.round(paid.value * 1e8)) > amount + b.value - 5_000n, true, 'the payee got the payment plus its own coin, less its share of the fee');
    const ch = tx.vout.find((o) => o.scriptPubKey.address === regtest(change));
    assert.equal(BigInt(Math.round(ch.value * 1e8)), result.draft.change, 'the change as the wallet records it');
    console.log(`ok ${version}: payjoin ${result.id.slice(0, 16)} mined; ${tx.vin.length} inputs, fee rate ${(Number(a.value + b.value - tx.vout.reduce((s, o) => s + BigInt(Math.round(o.value * 1e8)), 0n)) / tx.vsize).toFixed(2)} sat/vB`);
  }

  // When the payee never answers, the ordinary payment is what goes out, and it is valid.
  {
    const n = 5;
    const from = payer.addressAt(0, n); const a = await fund(from, 0.1); mine(1);
    const { pub } = newReceiverKey();
    const target = { kind: 'v2', noSubstitution: true, directory: 'https://dir.example', mailbox: 'AAAAAAAAAAAAA', receiverKey: pub, ohttp: dir.keys, expires: Math.floor(Date.now() / 1000) + 3600 };
    const draft = { to: payee.addressAt(0, 20), amount: 1_000_000n, fee: 1_500n, change: a.value - 1_001_500n, changeAddress: payer.addressAt(1, n), changePath: [1, n], inputs: [{ txid: a.txid, vout: a.vout, value: a.value, address: from, chain: 0, index: n, confirmed: true }], lockTime: 0, changeFirst: false };
    const result = await payjoinPay({ draft, mnemonic: PAYER, target, post: dir.post, waitMs: 1_500 });
    assert.equal(result.payjoin, false);
    assert.match(result.problem, /did not answer/);
    assert.ok(JSON.parse(cli('testmempoolaccept', JSON.stringify([result.hex])))[0].allowed);
    console.log('ok no answer: the ordinary payment, valid');
  }
}

main().then(() => { cli('stop'); process.exit(0); }, (e) => { console.error(e); try { cli('stop'); } catch { /* */ } process.exit(1); });
