// A stand-in for the Dash network as CoinJoin sees it: one TCP server that is both a seed node (serving a real,
// verifiable mnlistdiff) and a masternode running a mixing session with two other made-up participants, plus an
// Insight server holding the coins. Everything is serialized here by hand, apart from the code under test.
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const btc = require('@scure/btc-signer');
const { secp256k1 } = require('@noble/curves/secp256k1.js');

const MAGIC = Buffer.from('bf0c6bbd', 'hex');
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const dsha = (b) => sha(sha(b));
const rev = (b) => Buffer.from(b).reverse();
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const vi = (n) => (n < 0xfd ? Buffer.from([n]) : n <= 0xffff ? Buffer.concat([Buffer.from([0xfd]), u16(n)]) : Buffer.concat([Buffer.from([0xfe]), u32(n)]));
const vb = (b) => Buffer.concat([vi(b.length), b]);
const DASH_NET = { bech32: 'dash', pubKeyHash: 0x4c, scriptHash: 0x10, wif: 0xcc };

function frame(cmd, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(24);
  MAGIC.copy(h);
  h.write(cmd, 4, 'ascii');
  h.writeUInt32LE(payload.length, 16);
  dsha(payload).copy(h, 20, 0, 4);
  return Buffer.concat([h, payload]);
}

// ---- reading what the client sends ----
class R {
  constructor(b) { this.b = b; this.at = 0; }
  take(n) { const x = this.b.subarray(this.at, this.at + n); if (x.length !== n) throw new Error('short'); this.at += n; return x; }
  u8() { return this.take(1)[0]; }
  u32() { return this.take(4).readUInt32LE(); }
  i32() { return this.take(4).readInt32LE(); }
  u64() { return this.take(8).readBigUInt64LE(); }
  vi() { const c = this.u8(); return c < 0xfd ? c : c === 0xfd ? this.take(2).readUInt16LE() : this.u32(); }
  vb() { return this.take(this.vi()); }
  txin() { const txid = rev(this.take(32)).toString('hex'); const vout = this.u32(); const script = Buffer.from(this.vb()); const sequence = this.u32(); return { txid, vout, script, sequence }; }
  txout() { return { value: this.u64(), script: Buffer.from(this.vb()) }; }
  tx() {
    const version = this.take(2).readUInt16LE(); const type = this.take(2).readUInt16LE();
    const inputs = Array.from({ length: this.vi() }, () => this.txin());
    const outputs = Array.from({ length: this.vi() }, () => this.txout());
    return { version, type, inputs, outputs, lockTime: this.u32() };
  }
}
const writeIn = (i) => Buffer.concat([rev(Buffer.from(i.txid, 'hex')), u32(i.vout), vb(i.script), u32(i.sequence)]);
const writeTx = (t) => Buffer.concat([u16(t.version), u16(t.type ?? 0), vi(t.inputs.length), ...t.inputs.map(writeIn), vi(t.outputs.length), ...t.outputs.map((o) => Buffer.concat([u64(o.value), vb(o.script)])), u32(t.lockTime)]);
const txid = (t) => rev(dsha(writeTx(t))).toString('hex');

// ---- the masternode list ----
function merkle(leaves) {
  let level = leaves;
  while (level.length > 1) { const up = []; for (let i = 0; i < level.length; i += 2) up.push(dsha(Buffer.concat([level[i], level[i + 1] ?? level[i]]))); level = up; }
  return level[0];
}

/** Bitcoin's CPartialMerkleTree, built the way a node builds it, proving the leaf at `match`. */
function partialTree(leaves, match) {
  const n = leaves.length;
  const width = (h) => (n + (1 << h) - 1) >> h;
  let height = 0;
  while (width(height) > 1) height++;
  const hashAt = (h, pos) => {
    if (h === 0) return leaves[pos];
    const l = hashAt(h - 1, pos * 2);
    const r = pos * 2 + 1 < width(h - 1) ? hashAt(h - 1, pos * 2 + 1) : l;
    return dsha(Buffer.concat([l, r]));
  };
  const bits = []; const hashes = [];
  const walk = (h, pos) => {
    let parent = false;
    for (let p = pos << h; p < (pos + 1) << h && p < n; p++) parent = parent || p === match;
    bits.push(parent);
    if (h === 0 || !parent) hashes.push(hashAt(h, pos));
    else { walk(h - 1, pos * 2); if (pos * 2 + 1 < width(h - 1)) walk(h - 1, pos * 2 + 1); }
  };
  walk(height, 0);
  const flags = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) flags[i >> 3] |= 1 << (i & 7); });
  return Buffer.concat([u32(n), vi(hashes.length), ...hashes, vb(flags)]);
}

const ipv4Mapped = (ip, port) => { const b = Buffer.alloc(18); b[10] = 0xff; b[11] = 0xff; ip.split('.').forEach((x, i) => { b[12 + i] = Number(x); }); b.writeUInt16BE(port, 16); return b; };

/** One list entry as it travels (with its version) and as it's hashed (without). */
function entry({ version, proTxHash, ip, port, type = 0, valid = true }) {
  const parts = [proTxHash, crypto.randomBytes(32)];
  if (version >= 3) {
    // ExtNetInfo v1: purpose CORE_P2P with one IPv4 service (BIP155 network 1), then PLATFORM_P2P with a domain.
    const svc = Buffer.concat([Buffer.from([0x01, 0x01]), vb(Buffer.from(ip.split('.').map(Number))), Buffer.from([port >> 8, port & 255])]);
    const dom = Buffer.concat([Buffer.from([0x02]), vb(Buffer.from('evo.example')), Buffer.from([0x01, 0xbb])]);
    parts.push(Buffer.from([1]), vi(type === 1 ? 2 : 1), Buffer.from([0]), vi(1), svc, ...(type === 1 ? [Buffer.from([1]), vi(1), dom] : []));
  } else {
    parts.push(ipv4Mapped(ip, port));
  }
  parts.push(crypto.randomBytes(48), crypto.randomBytes(20), Buffer.from([valid ? 1 : 0]));
  if (version >= 2) { parts.push(u16(type)); if (type === 1) { if (version < 3) parts.push(u16(443)); parts.push(crypto.randomBytes(20)); } }
  const hashed = Buffer.concat(parts);
  return { wire: Buffer.concat([u16(version), hashed]), hashed, proTxHash };
}

function buildChain(mnHost, mnPort) {
  const mns = [
    { version: 2, proTxHash: crypto.randomBytes(32), ip: mnHost, port: mnPort },
    { version: 3, proTxHash: crypto.randomBytes(32), ip: mnHost, port: mnPort, type: 1 },
    { version: 1, proTxHash: crypto.randomBytes(32), ip: mnHost, port: mnPort, valid: false },
  ].map(entry);
  const sorted = [...mns].sort((a, b) => Buffer.compare(a.proTxHash, b.proTxHash));
  const listRoot = merkle(sorted.map((e) => dsha(e.hashed)));
  const height = 2_570_460;
  // Coinbase: version 3, type 5, payload v3 { height, merkleRootMNList, merkleRootQuorums, ... }.
  const cbPayload = Buffer.concat([u16(3), i32(height), listRoot, crypto.randomBytes(32), vi(0), crypto.randomBytes(96), u64(0)]);
  const cb = Buffer.concat([u16(3), u16(5), vi(1), rev(Buffer.alloc(32)), u32(0xffffffff), vb(Buffer.from('0360b827', 'hex')), u32(0xffffffff), vi(1), u64(225_000_000), vb(Buffer.from('76a914' + '11'.repeat(20) + '88ac', 'hex')), u32(0), vb(cbPayload)]);
  const cbHash = dsha(cb);
  const leaves = [cbHash, ...Array.from({ length: 6 }, () => crypto.randomBytes(32))];
  const blockRoot = merkle(leaves);
  const blockHash = crypto.randomBytes(32);
  const diff = Buffer.concat([u16(1), Buffer.alloc(32), blockHash, partialTree(leaves, 0), cb, vi(0), vi(mns.length), ...mns.map((e) => e.wire), vi(0), vi(0), vi(0)]);
  return {
    height, diff, mns,
    blockHash: rev(blockHash).toString('hex'), merkleRoot: rev(blockRoot).toString('hex'), coinbase: rev(cbHash).toString('hex'),
    valid: mns.filter((e) => !e.wire.equals(mns[2].wire)).map((e) => rev(e.proTxHash).toString('hex')),
  };
}

// ---- the network ----

/** The scriptSig check a node makes, through @scure/btc-signer's own legacy signature hash. */
function verifyInput(tx, index, prevScript, hashType) {
  const t = btc.Transaction.fromRaw(writeTx({ ...tx, inputs: tx.inputs.map((i) => ({ ...i, script: Buffer.alloc(0) })) }), { allowUnknownOutputs: true, allowLegacyWitnessUtxo: true, disableScriptCheck: true });
  const s = tx.inputs[index].script;
  const sigLen = s[0];
  const sig = s.subarray(1, 1 + sigLen);
  const pub = s.subarray(2 + sigLen, 2 + sigLen + s[1 + sigLen]);
  if (sig[sig.length - 1] !== hashType) return false;
  const h160 = btc.p2pkh(pub, DASH_NET).hash;
  if (!Buffer.from(prevScript).equals(Buffer.concat([Buffer.from('76a914', 'hex'), Buffer.from(h160), Buffer.from('88ac', 'hex')]))) return false;
  const digest = t.preimageLegacy(index, prevScript, hashType);
  return secp256k1.verify(sig.subarray(0, -1), digest, pub, { prehash: false, format: 'der', lowS: true });
}

async function startDashMock() {
  const state = {
    utxos: [], sent: [], sessions: [], calls: [], refuse: null, tamper: null, others: 2, noReady: false,
    height: 2_570_472, versions: [],
  };
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    const send = (cmd, p) => sock.write(frame(cmd, p));
    const session = { id: 0, denom: 0, ours: null };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 24) {
        const len = buf.readUInt32LE(16);
        if (buf.length < 24 + len) break;
        const cmd = buf.subarray(4, 16).toString('ascii').replace(/\0+$/, '');
        const p = buf.subarray(24, 24 + len);
        buf = buf.subarray(24 + len);
        state.calls.push(cmd);
        try { handle(cmd, p); } catch (e) { state.error = e.message; sock.destroy(); }
      }
    });
    const status = (accepted, st, msg) => send('dssu', Buffer.concat([i32(session.id), i32(st), i32(accepted ? 1 : 0), i32(msg)]));
    const handle = (cmd, p) => {
      const r = new R(p);
      if (cmd === 'version') {
        const v = r.i32(); r.take(8 + 8 + 26 + 26 + 8); const ua = r.vb().toString(); r.i32(); r.u8(); r.take(32); const mn = r.u8();
        state.versions.push({ version: v, ua, masternode: mn === 1 });
        send('version', Buffer.concat([i32(70237), u64(5), u64(BigInt(Math.floor(Date.now() / 1000))), Buffer.alloc(52), crypto.randomBytes(8), vb(Buffer.from('/Dash Core:23.0.0/')), i32(state.height), Buffer.from([1])]));
        send('verack');
        send('ping', crypto.randomBytes(8));
        return;
      }
      if (cmd === 'getmnlistd') {
        r.take(32);
        const want = rev(r.take(32)).toString('hex');
        if (want !== state.chain.blockHash) return send('reject', Buffer.alloc(0));
        return send('mnlistdiff', state.tamperList ? state.tamperList(state.chain.diff) : state.chain.diff);
      }
      if (cmd === 'dsa') {
        session.denom = r.i32();
        session.collateral = r.tx();
        if (state.refuse) { status(false, 0, state.refuse); return; }
        session.id = 4242;
        status(true, 1, 19);
        if (!state.noReady) setTimeout(() => send('dsq', Buffer.concat([i32(session.denom), rev(Buffer.from(state.mnProTx, 'hex')), u64(BigInt(Math.floor(Date.now() / 1000))), Buffer.from([1]), vb(crypto.randomBytes(96))])), 30);
        return;
      }
      if (cmd === 'dsi') {
        const inputs = Array.from({ length: r.vi() }, () => r.txin());
        r.tx();
        const outputs = Array.from({ length: r.vi() }, () => r.txout());
        session.ours = { inputs, outputs };
        status(true, 2, 21);
        const value = outputs[0].value;
        const others = { inputs: [], outputs: [] };
        for (let k = 0; k < state.others; k++) {
          others.inputs.push({ txid: crypto.randomBytes(32).toString('hex'), vout: k, script: Buffer.alloc(0), sequence: 0xffffffff });
          others.outputs.push({ value, script: Buffer.concat([Buffer.from('76a914', 'hex'), crypto.randomBytes(20), Buffer.from('88ac', 'hex')]) });
        }
        let tx = { version: 1, type: 0, inputs: [...inputs, ...others.inputs], outputs: [...outputs, ...others.outputs], lockTime: 0 };
        tx.inputs.sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout));
        tx.outputs.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : Buffer.compare(a.script, b.script)));
        if (state.tamper) tx = state.tamper(tx, session.ours);
        session.final = tx;
        send('dsf', Buffer.concat([i32(session.id), writeTx(tx)]));
        return;
      }
      if (cmd === 'dss') {
        const signed = Array.from({ length: r.vi() }, () => r.txin());
        const tx = { ...session.final, inputs: session.final.inputs.map((i) => ({ ...i })) };
        for (const s of signed) {
          const n = tx.inputs.findIndex((i) => i.txid === s.txid && i.vout === s.vout);
          if (n < 0) throw new Error('signed an input not in the mix');
          const coin = state.utxos.find((u) => u.txid === s.txid && u.vout === s.vout);
          if (!coin) throw new Error('signed a coin the chain does not have');
          tx.inputs[n].script = s.script;
          if (!verifyInput(tx, n, btc.OutScript.encode(btc.Address(DASH_NET).decode(coin.address)), 0x81)) throw new Error('bad signature');
        }
        if (signed.length !== session.ours.inputs.length) throw new Error('not all inputs signed');
        // Other participants sign too; then the mix is published and mined.
        for (const i of tx.inputs) if (!i.script.length) i.script = Buffer.from([0x00]);
        const id = txid(tx);
        state.sessions.push({ denom: session.denom, tx, id, ours: session.ours });
        state.utxos = state.utxos.filter((u) => !session.ours.inputs.some((i) => i.txid === u.txid && i.vout === u.vout));
        tx.outputs.forEach((o, vout) => {
          if (!session.ours.outputs.some((x) => x.script.equals(o.script))) return;
          state.utxos.push({ address: btc.Address(DASH_NET).encode(btc.OutScript.decode(o.script)), txid: id, vout, satoshis: Number(o.value), confirmations: 1 });
        });
        send('dsc', Buffer.concat([i32(session.id), i32(20)]));
      }
    };
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  state.chain = buildChain('127.0.0.1', 9999);
  state.mnProTx = null; // set by the test from state.chain.valid

  const insight = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      const p = u.pathname;
      const c = state.chain;
      const tip = '00'.repeat(31) + '01';
      if (p === '/status' && u.searchParams.get('q') === 'getBestBlockHash') return json({ bestblockhash: tip });
      if (p === `/block/${tip}`) return json({ hash: tip, height: state.height, merkleroot: '00'.repeat(32), tx: [] });
      if (p === `/block-index/${state.height - 8}`) return json({ blockHash: c.blockHash });
      if (p === `/block/${c.blockHash}`) return json({ hash: c.blockHash, height: c.height, merkleroot: c.merkleRoot, tx: [c.coinbase] });
      let m = /^\/addrs\/([^/]+)\/utxo$/.exec(p);
      if (m) { const list = m[1].split(','); return json(state.utxos.filter((x) => list.includes(x.address))); }
      m = /^\/addrs\/([^/]+)\/txs$/.exec(p);
      if (m) return json({ items: [] });
      if (p === '/tx/send') {
        const raw = Buffer.from(JSON.parse(body).rawtx, 'hex');
        const t = new R(raw).tx();
        state.sent.push({ raw, tx: t });
        const id = rev(dsha(raw)).toString('hex');
        state.utxos = state.utxos.filter((x) => !t.inputs.some((i) => i.txid === x.txid && i.vout === x.vout));
        return json({ txid: id });
      }
      return json({ error: 'unknown' }, 404);
    });
  });
  await new Promise((r) => insight.listen(0, '127.0.0.1', r));
  return {
    state, port, api: `http://127.0.0.1:${insight.address().port}`,
    close: async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); insight.closeAllConnections?.(); await new Promise((r) => insight.close(r)); },
  };
}

module.exports = { startDashMock, partialTree, merkle, verifyInput, writeTx, txid, buildChain, dsha, DASH_NET };
