// A stand-in for the Solana private pool's program and relayer (tests/sol-pool.test.js, tests/ui-e2e.js). It checks
// what the program checks: the Groth16 proof read from the instruction bytes as its verifier reads them (with the
// verifying key of the shipped proving key, which tests/sol-pool.test.js ties to the program's), the external-data
// hash, the public amount, known roots, nullifiers used once, and the depositor's signature.
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { base58 } = require('@scure/base');
const { ed25519 } = require('@noble/curves/ed25519.js');
const { bn254 } = require('@noble/curves/bn254.js');
const { poseidon2 } = require('poseidon-lite');
const P = require('../dist/main/sol-privacy');

const SOL = P.POOL_TOKENS.SOL;
let VK = null;

/** The verifying key of the shipped proving key, in the program's byte layout. */
async function verifyingKey() {
  if (VK) return VK;
  const { zKey } = require('snarkjs7');
  const vk = await zKey.exportVerificationKey(new Uint8Array(fs.readFileSync(path.join(__dirname, '../assets/solpool/transaction2.zkey'))));
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate(); // its worker threads would keep the process alive
  VK = { alpha: g1Bytes(vk.vk_alpha_1), beta: g2Bytes(vk.vk_beta_2), gamma: g2Bytes(vk.vk_gamma_2), delta: g2Bytes(vk.vk_delta_2), ic: vk.IC.map(g1Bytes) };
  return VK;
}


const big = (b) => BigInt(`0x${Buffer.from(b).toString('hex') || '0'}`);
const Fp2 = bn254.fields.Fp2;
const G1 = (b) => bn254.G1.Point.fromAffine({ x: big(b.slice(0, 32)), y: big(b.slice(32, 64)) });
const G2 = (b) => bn254.G2.Point.fromAffine({ x: Fp2.fromBigTuple([big(b.slice(32, 64)), big(b.slice(0, 32))]), y: Fp2.fromBigTuple([big(b.slice(96, 128)), big(b.slice(64, 96))]) });
const be = (s) => Buffer.from(BigInt(s).toString(16).padStart(64, '0'), 'hex');
const g1Bytes = (p) => Buffer.concat([be(p[0]), be(p[1])]);
const g2Bytes = (p) => Buffer.concat([be(p[0][1]), be(p[0][0]), be(p[1][1]), be(p[1][0])]);

function verify(proof, signals) {
  const A = G1(proof.slice(0, 64)).negate();
  let x = G1(VK.ic[0]);
  signals.forEach((s, i) => { if (s) x = x.add(G1(VK.ic[i + 1]).multiply(s)); });
  const r = bn254.pairingBatch([{ g1: A, g2: G2(proof.slice(64, 192)) }, { g1: G1(VK.alpha), g2: G2(VK.beta) }, { g1: x, g2: G2(VK.gamma) }, { g1: G1(proof.slice(192, 256)), g2: G2(VK.delta) }]);
  return bn254.fields.Fp12.eql(r, bn254.fields.Fp12.ONE);
}

// ---- the stand-in chain and relayer ----

function compactAt(b, o) { let n = 0, s = 0; for (;;) { const x = b[o++]; n |= (x & 127) << s; s += 7; if (!(x & 128)) return [n, o]; } }

function standIn() {
  const st = { leaves: [], enc: [], roots: [], nullifiers: new Set(), withdrawals: [], deposits: [], lie: null, maxDeposit: 10n ** 12n };
  const levels = () => {
    const z = P.zeros();
    const layers = [st.leaves.slice()];
    for (let l = 0; l < P.TREE_DEPTH; l++) {
      const prev = layers[l]; const next = [];
      for (let i = 0; i < prev.length; i += 2) next.push(poseidon2([prev[i], prev[i + 1] ?? z[l]]));
      layers.push(next);
    }
    return layers;
  };
  const root = () => levels()[P.TREE_DEPTH][0] ?? P.zeros()[P.TREE_DEPTH];
  const pathOf = (index) => { const L = levels(); return Array.from({ length: P.TREE_DEPTH }, (_, l) => L[l][(index >> l) ^ 1] ?? P.zeros()[l]); };
  const append = (c, enc) => { st.leaves.push(c); st.enc.push(Buffer.from(enc).toString('hex')); };
  st.roots.push(root());
  for (let i = 0; i < 6; i++) { append(BigInt(`0x${crypto.randomBytes(31).toString('hex')}`), crypto.randomBytes(120)); } // other people's notes
  st.roots.push(root());

  const tableKeys = (() => { const a = P.poolAccounts(SOL); return [a.tree, a.globalConfig, a.treeToken, P.POOL_FEE_RECIPIENT, '11111111111111111111111111111111']; })();
  const accountData = (addr) => {
    const a = P.poolAccounts(SOL);
    if (addr === a.tree) {
      const d = Buffer.alloc(4136);
      d.writeBigUInt64LE(BigInt(st.leaves.length), 40);
      be(root()).copy(d, 880);
      st.roots.slice(-100).forEach((r, i) => be(r).copy(d, 912 + i * 32));
      d.writeBigUInt64LE(st.maxDeposit, 4120);
      return { owner: P.POOL_PROGRAM, data: d };
    }
    if (addr === P.POOL_LOOKUP_TABLE) return { owner: 'AddressLookupTab1e1111111111111111111111111', data: Buffer.concat([Buffer.alloc(56), ...tableKeys.map((k) => Buffer.from(base58.decode(k)))]) };
    return null;
  };

  // The program's transact, on instruction bytes and the accounts it gets.
  function transact(data, recipient, feeRecipient, nf0Account) {
    const d = Buffer.from(data);
    assert.ok(d.subarray(0, 8).equals(Buffer.from([217, 149, 130, 143, 221, 52, 252, 119])), 'transact');
    const proof = d.subarray(8, 264);
    const sig = (k) => big(d.subarray(264 + k * 32, 296 + k * 32));
    const signals = [0, 1, 2, 3, 4, 5, 6].map(sig);
    let o = 264 + 224;
    const extAmount = d.readBigInt64LE(o); const fee = d.readBigUInt64LE(o + 8); o += 16;
    const l1 = d.readUInt32LE(o); const enc1 = d.subarray(o + 4, o + 4 + l1); o += 4 + l1;
    const l2 = d.readUInt32LE(o); const enc2 = d.subarray(o + 4, o + 4 + l2); o += 4 + l2;
    if (o !== d.length) return 'trailing bytes';
    if (!st.roots.slice(-100).includes(signals[0])) return 'UnknownRoot';
    const hash = P.extDataHash({ recipient, extAmount, enc1, enc2, fee, feeRecipient, mint: SOL.mint });
    if (hash !== signals[2]) return 'ExtDataHashMismatch';
    if (P.publicAmount(extAmount, fee) !== signals[1] || (extAmount >= 0n && extAmount <= fee)) return 'InvalidPublicAmountData';
    if (extAmount < 0n && fee < (-extAmount * 25n) / 10000n) return 'InvalidFeeAmount';
    if (!verify(proof, signals)) return 'InvalidProof';
    if (nf0Account !== P.nullifierAccounts(P.be32(signals[3]), P.be32(signals[4])).nf0) return 'nullifier account';
    for (const n of [signals[3], signals[4]]) if (st.nullifiers.has(n)) return 'already in use';
    st.nullifiers.add(signals[3]); st.nullifiers.add(signals[4]);
    append(signals[5], enc1); append(signals[6], enc2);
    st.roots.push(root());
    return { extAmount, fee, signals };
  }

  // A signed version 0 transaction, read the way the runtime reads it.
  function readTx(b64) {
    const raw = Buffer.from(b64, 'base64');
    let [n, o] = compactAt(raw, 0);
    assert.equal(n, 1);
    const sigBytes = raw.subarray(o, o + 64); o += 64;
    const msg = raw.subarray(o);
    assert.equal(msg[0], 0x80, 'version 0');
    let p = 4; let count;
    [count, p] = compactAt(msg, p);
    const statics = []; for (let i = 0; i < count; i++) { statics.push(base58.encode(msg.subarray(p, p + 32))); p += 32; }
    p += 32;
    let nix; [nix, p] = compactAt(msg, p);
    const ixs = [];
    for (let i = 0; i < nix; i++) {
      const prog = msg[p++]; let na; [na, p] = compactAt(msg, p); const accts = [...msg.subarray(p, p + na)]; p += na;
      let dl; [dl, p] = compactAt(msg, p); ixs.push({ prog, accts, data: msg.subarray(p, p + dl) }); p += dl;
    }
    let nl; [nl, p] = compactAt(msg, p);
    const loadedW = []; const loadedR = [];
    for (let i = 0; i < nl; i++) {
      const tbl = base58.encode(msg.subarray(p, p + 32)); p += 32;
      assert.equal(tbl, P.POOL_LOOKUP_TABLE);
      let w; [w, p] = compactAt(msg, p); for (let j = 0; j < w; j++) loadedW.push(tableKeys[msg[p++]]);
      let r; [r, p] = compactAt(msg, p); for (let j = 0; j < r; j++) loadedR.push(tableKeys[msg[p++]]);
    }
    assert.equal(p, msg.length);
    assert.ok(ed25519.verify(sigBytes, msg, base58.decode(statics[0])), 'signed by the payer');
    const keys = [...statics, ...loadedW, ...loadedR];
    const pool = ixs.find((x) => keys[x.prog] === P.POOL_PROGRAM);
    return { payer: statics[0], id: base58.encode(sigBytes), accounts: pool.accts.map((i) => keys[i]), data: pool.data, size: raw.length, header: [...msg.subarray(1, 4)], statics };
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, j) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const url = new URL(req.url, 'http://x');
      try {
        if (url.pathname === '/rpc') {
          const { method, params } = JSON.parse(body);
          const ok = (result) => send(200, { jsonrpc: '2.0', id: 1, result });
          if (method === 'getAccountInfo') { const a = accountData(params[0]); return ok({ value: a && { owner: a.owner, data: [a.data.toString('base64'), 'base64'] } }); }
          if (method === 'getLatestBlockhash') return ok({ value: { blockhash: base58.encode(crypto.randomBytes(32)) } });
          if (method === 'getMinimumBalanceForRentExemption') return ok(953_520);
          if (method === 'getMultipleAccounts') {
            const spent = new Set([...st.nullifiers].flatMap((n) => P.spentMarkers(n)));
            return ok({ value: params[0].map((a) => (spent.has(a) ? { data: ['', 'base64'] } : null)) });
          }
          if (method === 'getSignaturesForAddress') return ok([]);
          if (method === 'getSignatureStatuses') return ok({ value: params[0].map((id) => (st.deposits.some((d) => d.id === id) ? { confirmationStatus: 'confirmed' } : null)) });
          return send(200, { jsonrpc: '2.0', id: 1, error: { message: `no ${method}` } });
        }
        if (url.pathname === '/r/utxos/range') {
          const start = Number(url.searchParams.get('start')); const end = Number(url.searchParams.get('end'));
          let list = st.enc.slice(start, end + 1);
          if (st.lie === 'shift' && list.length > 1) list = [list[list.length - 1], ...list.slice(0, -1)];
          return send(200, { encrypted_outputs: list, hasMore: end + 1 < st.enc.length, total: st.enc.length, start, end });
        }
        if (url.pathname === '/r/merkle/proofv2/') {
          const cms = url.searchParams.get('commitments').split(',');
          st.lastAsk = cms;
          return send(200, { root: root().toString(), nextIndex: st.leaves.length, proofs: cms.map((c) => {
            const i = st.leaves.indexOf(BigInt(c));
            const p = pathOf(i).map(String);
            if (st.lie === 'path') p[3] = '12345';
            return { pathElements: p, pathIndices: [] };
          }) });
        }
        if (url.pathname === '/r/config') return send(200, { withdraw_fee_rate: 0.0025, withdraw_rent_fee: 0.001, deposit_fee_rate: 0, rent_fees: { usdc: 0.5, usdt: 0.5 }, minimum_withdrawal: { sol: 0.01 } });
        if (url.pathname === '/r/deposit') {
          const j = JSON.parse(body);
          const tx = readTx(j.signedTransaction);
          assert.equal(tx.payer, j.senderAddress);
          assert.ok(tx.size <= P.MAX_TX_SIZE, 'fits in a packet');
          const a = P.poolAccounts(SOL);
          assert.deepEqual([tx.accounts[0], tx.accounts[5], tx.accounts[6], tx.accounts[7], tx.accounts[8], tx.accounts[9]], [a.tree, a.treeToken, a.globalConfig, P.POOL_FEE_RECIPIENT, P.POOL_FEE_RECIPIENT, tx.payer]);
          const r = transact(tx.data, tx.accounts[7], tx.accounts[8], tx.accounts[1]);
          if (typeof r === 'string') return send(400, { error: r });
          st.deposits.push({ id: tx.id, amount: r.extAmount });
          return send(200, { success: true, signature: tx.id });
        }
        if (url.pathname === '/r/withdraw') {
          const j = JSON.parse(body);
          const r = transact(Buffer.from(j.serializedProof, 'base64'), j.recipient, j.feeRecipientAccount, j.nullifier0PDA);
          if (typeof r === 'string') return send(400, { error: r });
          assert.equal(Number(r.extAmount), j.extAmount); assert.equal(Number(r.fee), j.fee);
          st.withdrawals.push({ to: j.recipient, amount: -r.extAmount, fee: r.fee });
          return send(200, { success: true, signature: base58.encode(crypto.randomBytes(64)) });
        }
        send(404, { error: 'not found' });
      } catch (e) { send(500, { error: String(e.message) }); }
    });
  });
  return { st, server };
}


module.exports = { standIn, verifyingKey, g1Bytes, g2Bytes };
