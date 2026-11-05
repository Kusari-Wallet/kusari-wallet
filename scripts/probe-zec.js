// Which Zcash light servers answer, directly and through Tor. Run by .github/workflows/zec-probe.yml.
// Sends nothing but an empty "latest block" request. Usage: node scripts/probe-zec.js [socksPort]
const http2 = require('http2'), tls = require('tls'), net = require('net');
const PATH = '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock';
const FRAME = Buffer.from([0, 0, 0, 0, 0]);
const socksPort = Number(process.argv[2] || 0);
const NATIVE = ['zec.rocks:443', 'na.zec.rocks:443', 'eu.zec.rocks:443', 'ap.zec.rocks:443', 'sa.zec.rocks:443',
  'zaino.zfnd.org:443', 'mainnet.lightwalletd.com:9067'];
const WEB = ['zcash-mainnet.chainsafe.dev:443'];

function height(buf) {
  // gRPC frame: 1 flag + 4 length, then BlockID { uint64 height = 1; bytes hash = 2 }
  if (buf.length < 7 || buf[5] !== 0x08) return null;
  let v = 0, m = 1;
  for (let i = 6; i < buf.length; i++) { v += (buf[i] & 0x7f) * m; m *= 128; if (!(buf[i] & 0x80)) return v; }
  return null;
}

function socks(host, port) {
  return new Promise((ok, no) => {
    const s = net.connect(socksPort, '127.0.0.1');
    let step = 0;
    s.on('error', no);
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', d => {
      if (step === 0) {
        if (d[1] !== 0) return no(new Error('socks auth'));
        step = 1;
        const h = Buffer.from(host);
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]));
      } else if (step === 1) {
        if (d[1] !== 0) return no(new Error('socks reply ' + d[1]));
        step = 2; s.removeAllListeners('data'); s.removeAllListeners('error'); ok(s);
      }
    });
  });
}

async function connect(host, port, viaTor) {
  const raw = viaTor ? await socks(host, port) : undefined;
  return new Promise((ok, no) => {
    const t = tls.connect({ host, port, socket: raw, servername: host, ALPNProtocols: ['h2'] });
    t.once('secureConnect', () => ok(t));
    t.once('error', no);
  });
}

async function native(target, viaTor) {
  const [host, p] = target.split(':'), port = Number(p), started = Date.now();
  const sock = await connect(host, port, viaTor);
  if (sock.alpnProtocol !== 'h2') { sock.destroy(); throw new Error('no http2, alpn=' + sock.alpnProtocol); }
  const c = http2.connect(`https://${host}:${port}`, { createConnection: () => sock });
  return new Promise((ok, no) => {
    c.on('error', no);
    const r = c.request({ ':method': 'POST', ':path': PATH, 'content-type': 'application/grpc', te: 'trailers' });
    const chunks = []; let status = '', grpc = '';
    r.on('response', h => { status = h[':status']; grpc = h['grpc-status'] || ''; });
    r.on('trailers', h => { grpc = h['grpc-status'] ?? grpc; });
    r.on('data', d => chunks.push(d));
    r.on('error', no);
    r.on('end', () => { c.close(); ok({ status, grpc, height: height(Buffer.concat(chunks)), ms: Date.now() - started }); });
    r.end(FRAME);
  });
}

async function web(target, viaTor) {
  const [host, p] = target.split(':'), port = Number(p), started = Date.now();
  const sock = await connect(host, port, viaTor);
  const req = `POST ${PATH} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/grpc-web+proto\r\nX-Grpc-Web: 1\r\nContent-Length: 5\r\nConnection: close\r\n\r\n`;
  return new Promise((ok, no) => {
    const chunks = [];
    sock.on('data', d => chunks.push(d));
    sock.on('error', no);
    sock.on('end', () => {
      const all = Buffer.concat(chunks), at = all.indexOf('\r\n\r\n');
      const head = all.subarray(0, at).toString(), status = head.split(' ')[1];
      let body = all.subarray(at + 4);
      if (/transfer-encoding: *chunked/i.test(head)) {
        const out = []; let i = 0;
        while (i < body.length) {
          const e = body.indexOf('\r\n', i), n = parseInt(body.subarray(i, e).toString(), 16);
          if (!n) break;
          out.push(body.subarray(e + 2, e + 2 + n)); i = e + 2 + n + 2;
        }
        body = Buffer.concat(out);
      }
      ok({ status, height: height(body), ms: Date.now() - started });
    });
    sock.write(req); sock.write(FRAME);
  });
}

async function attempt(kind, fn, target, viaTor) {
  const label = `${kind.padEnd(6)} ${viaTor ? 'tor   ' : 'direct'} ${target}`;
  try {
    const r = await Promise.race([fn(target, viaTor), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 60000))]);
    console.log(label, JSON.stringify(r));
  } catch (e) { console.log(label, 'FAIL', e.message); }
}

(async () => {
  for (const viaTor of socksPort ? [false, true] : [false]) {
    for (const t of NATIVE) await attempt('grpc', native, t, viaTor);
    for (const t of WEB) await attempt('web', web, t, viaTor);
  }
  process.exit(0);
})();
