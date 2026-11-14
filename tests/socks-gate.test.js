const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { SocksGate } = require('../dist/main/socks-gate');

// A stand-in for Tor's SOCKS port: wants a login, records it and the target, then echoes.
function fakeTor() {
  const seen = [];
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0); let stage = 0; let user = '';
    s.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (stage === 0 && buf.length >= 3) { assert.deepStrictEqual([...buf.subarray(0, 3)], [5, 1, 2], 'offers only a login'); buf = buf.subarray(3); s.write(Buffer.from([5, 2])); stage = 1; }
      if (stage === 1 && buf.length >= 2 && buf.length >= 3 + buf[1]) {
        const ul = buf[1]; user = buf.subarray(2, 2 + ul).toString(); const pl = buf[2 + ul];
        if (buf.length < 3 + ul + pl) return;
        buf = buf.subarray(3 + ul + pl); s.write(Buffer.from([1, 0])); stage = 2;
      }
      if (stage === 2 && buf.length >= 5 && buf.length >= 7 + buf[4]) {
        const host = buf.subarray(5, 5 + buf[4]).toString(); const port = buf.readUInt16BE(5 + buf[4]);
        seen.push({ user, host, port });
        buf = buf.subarray(7 + buf[4]);
        s.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); stage = 3;
        if (buf.length) s.write(buf);
        return;
      }
      if (stage === 3) { s.write(buf); buf = Buffer.alloc(0); }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, port: server.address().port })));
}

// What an engine does: SOCKS5 without a login, by name.
function viaGate(port, host) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let stage = 0; let buf = Buffer.alloc(0);
    s.on('error', reject);
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (stage === 0 && buf.length >= 2) { assert.strictEqual(buf[1], 0); buf = buf.subarray(2); stage = 1; s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host), Buffer.from([0x52, 0x09])])); }
      if (stage === 1 && buf.length >= 10) { assert.strictEqual(buf[1], 0); buf = buf.subarray(10); stage = 2; resolve(s); }
    });
  });
}
const echo = (s, text) => new Promise((r) => { s.once('data', (d) => r(d.toString())); s.write(text); });

test('engine gate: a Tor login of its own, a new one after renew, open connections closed', async (t) => {
  const tor = await fakeTor();
  const gate = new SocksGate(tor.port);
  const port = await gate.start();
  t.after(() => { gate.close(); tor.server.close(); });

  const a = await viaGate(port, 'node.example.onion');
  assert.strictEqual(await echo(a, 'hello'), 'hello', 'data goes through both ways');
  const b = await viaGate(port, 'node.example.onion');
  assert.strictEqual(tor.seen.length, 2);
  assert.strictEqual(tor.seen[0].user, tor.seen[1].user, 'one route until renewed');
  assert.deepStrictEqual([tor.seen[0].host, tor.seen[0].port], ['node.example.onion', 0x5209], 'the name goes to Tor, unresolved');
  assert.match(tor.seen[0].user, /^[0-9a-f]{24}$/);

  const closed = new Promise((r) => a.once('close', r));
  gate.renew();
  await closed; // the engine reconnects, on the new route
  const c = await viaGate(port, 'node.example.onion');
  assert.strictEqual(await echo(c, 'again'), 'again');
  assert.notStrictEqual(tor.seen[2].user, tor.seen[0].user, 'a new login: a new circuit');
  b.destroy(); c.destroy();
});

test('engine gate: refuses what it does not speak, and never connects anywhere but Tor', async (t) => {
  const tor = await fakeTor();
  const gate = new SocksGate(tor.port);
  const port = await gate.start();
  t.after(() => { gate.close(); tor.server.close(); });
  const answer = await new Promise((r) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(Buffer.from([5, 1, 2]))); // only a login offered
    s.on('data', (d) => r([...d]));
  });
  assert.deepStrictEqual(answer, [5, 0xff]);
  assert.strictEqual(tor.seen.length, 0);
});

test('Monero: before a send the wallet reconnects to its node with a new Tor login', async () => {
  const { MoneroClient } = require('../dist/main/monero');
  const seen = [];
  const c = Object.create(MoneroClient.prototype);
  Object.assign(c, { opts: { proxyUri: 'socks5h://127.0.0.1:9150' }, wallet: { setDaemonConnection: async (conn) => { seen.push(conn.getProxyUri ? conn.getProxyUri() : conn.proxyUri); } }, state: { node: 'http://node.example.onion:18089' }, closed: false });
  await c.renewRoute();
  await c.renewRoute();
  assert.strictEqual(seen.length, 2);
  for (const p of seen) assert.match(p, /^socks5h:\/\/[0-9a-f]{24}:[0-9a-f]{24}@127\.0\.0\.1:9150$/);
  assert.notStrictEqual(seen[0], seen[1], 'a different login each time');
  // A node on this machine is never reached through Tor, so nothing changes for it.
  c.state.node = 'http://127.0.0.1:18081';
  await c.renewRoute();
  assert.strictEqual(seen.length, 2);
});
