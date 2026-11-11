// A stand-in for Firo's ElectrumX servers, Spark methods only, over TLS with a throwaway certificate. Anonymity sets
// are made of real Spark coins minted by the engine itself, and answers have the node's shapes: sets newest first,
// each entry [coin + tx hash + serial context, tx hash, serial context] in base64.
const tls = require('node:tls');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const b64 = (b) => Buffer.from(b).toString('base64');
const sha = (x) => crypto.createHash('sha256').update(x).digest();
const dsha = (b) => sha(sha(b));
const compact = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 0xff, n >> 8]));

function certificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-mock-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=localhost',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(dir, 'c.pem'));
  const key = fs.readFileSync(path.join(dir, 'k.pem'));
  fs.rmSync(dir, { recursive: true, force: true });
  const der = Buffer.from(cert.toString().replace(/-----[^-]+-----|\s/g, ''), 'base64');
  return { cert, key, fingerprint: sha(der).toString('hex') };
}

/** The serial context of a mint: its inputs as the node serializes them, with empty scripts and sequence max-1. */
function mintContext(inputs) {
  return Buffer.concat(inputs.map((i) => {
    const vout = Buffer.alloc(4);
    vout.writeUInt32LE(i.vout);
    return Buffer.concat([Buffer.from(i.txid, 'hex'), vout, Buffer.from([0]), Buffer.from('feffffff', 'hex')]);
  }));
}

/** Mints `value` atoms to `address` with the engine, as a mined coin record. */
async function mintCoin(engine, address, value) {
  const txid = crypto.randomBytes(32).toString('hex'); // internal byte order
  const inputs = [{ txid, vout: 0 }];
  const [out] = await engine.call('mint', { inputs, outputs: [{ address, value, memo: '' }] });
  const coin = Buffer.from(out.script, 'hex').subarray(1);
  return { coin, tx: crypto.randomBytes(32), ctx: mintContext(inputs) };
}

function startSparkMock() {
  const state = {
    height: 1_400_000,
    groups: { 1: [] },     // oldest first
    tags: [],              // [tag 34 bytes, txid internal 32 bytes]
    sent: [],
    calls: [],
    fail: null,
    ...certificate(),
  };
  const blockHash = (g) => sha(Buffer.from(`block-${g}-${state.groups[g].length}-${state.height}`));
  const setHash = (g) => sha(Buffer.from(`set-${g}-${state.groups[g].length}`));
  const entry = (r) => [b64(Buffer.concat([r.coin, r.tx, compact(r.ctx.length), r.ctx])), b64(r.tx), b64(r.ctx)];
  const handle = (method, p) => {
    state.calls.push(method);
    if (state.fail && state.fail(method, p)) throw new Error('mock failure');
    const latest = Math.max(...Object.keys(state.groups).map(Number));
    switch (method) {
      case 'server.version': return ['ElectrumX mock', '1.4'];
      case 'blockchain.headers.subscribe': return { height: state.height, hex: '' };
      case 'spark.getsparklatestcoinid': return latest;
      case 'spark.getsparkanonymitysetmeta': {
        const g = Number(p[0]);
        return { blockHash: b64(blockHash(g)), setHash: b64(setHash(g)), size: state.groups[g].length };
      }
      case 'spark.getsparkanonymitysetsector': {
        const g = Number(p[0]);
        if (p[1] !== b64(blockHash(g))) throw new Error('Incorrect blockHash provided');
        const newest = [...state.groups[g]].reverse();
        return { coins: newest.slice(Number(p[2]), Number(p[3])).map(entry) };
      }
      case 'spark.getusedcoinstags': return { tags: state.tags.map(([t]) => b64(t)) };
      case 'spark.getusedcoinstagstxhashes':
        if (state.noTxHashes) throw new Error('unknown method');
        return { tagsandtxids: state.tags.slice(Number(p[0])).map(([t, x]) => [b64(t), b64(x)]) };
      case 'blockchain.transaction.get': return { txid: p[0], blocktime: 1_762_000_000 };
      case 'blockchain.transaction.broadcast': {
        const raw = Buffer.from(p[0], 'hex');
        state.sent.push(p[0]);
        return Buffer.from(dsha(raw)).reverse().toString('hex');
      }
      default: throw new Error(`unknown method ${method}`);
    }
  };
  const sockets = new Set();
  const server = tls.createServer({ cert: state.cert, key: state.key }, (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => undefined);
    sock.on('data', (d) => {
      buf += d;
      for (let at = buf.indexOf('\n'); at >= 0; at = buf.indexOf('\n')) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        let answer;
        try { answer = { jsonrpc: '2.0', id: req.id, result: handle(req.method, req.params ?? []) }; } catch (e) { answer = { jsonrpc: '2.0', id: req.id, error: { code: 1, message: e.message } }; }
        sock.write(JSON.stringify(answer) + '\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    state, server, port: server.address().port,
    /** What a node records once a spend is mined: its tags, and its private outputs as new coins. */
    mine(txHex, verified) {
      const raw = Buffer.from(txHex, 'hex');
      const txid = dsha(raw);
      for (const t of verified.tags) state.tags.push([Buffer.from(t, 'hex'), txid]);
      const outs = sparkOutputs(raw);
      const g = Math.max(...Object.keys(state.groups).map(Number));
      for (const s of outs) state.groups[g].push({ coin: s.subarray(1), tx: txid, ctx: Buffer.from(verified.context, 'hex') });
      state.height += 1;
    },
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  })));
}

/** The private output scripts (OP_SPARKSMINT) of a raw transaction. */
function sparkOutputs(raw) {
  let at = 4;
  const varint = () => { const c = raw[at++]; if (c < 0xfd) return c; if (c === 0xfd) { const v = raw.readUInt16LE(at); at += 2; return v; } const v = raw.readUInt32LE(at); at += 4; return v; };
  const nIn = varint();
  for (let i = 0; i < nIn; i++) { at += 36; const l = varint(); at += l + 4; }
  const nOut = varint();
  const outs = [];
  for (let i = 0; i < nOut; i++) { at += 8; const n = varint(); const s = raw.subarray(at, at + n); at += n; if (s[0] === 0xd2) outs.push(Buffer.from(s)); }
  return outs;
}

module.exports = { startSparkMock, mintCoin, mintContext, sparkOutputs };
