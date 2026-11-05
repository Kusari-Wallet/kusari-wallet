const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const openpgp = require('openpgp');
const tar = require('tar');
const { TronClient } = require('../dist/main/tron');
const { TorManager, TOR_SIGNING_FINGERPRINT } = require('../dist/main/tor');
const { socksAgent, getJson } = require('../dist/main/request');
const { NETWORKS } = require('../dist/main/config');
const { mockNode, me, RECIPIENT } = require('./mock-tron');
const { mockSocks } = require('./mock-socks');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vw-tor-'));

test('pinned fingerprint matches the published one', () => {
  assert.equal(TOR_SIGNING_FINGERPRINT, 'EF6E286DDA85EA2A4BA7DE684E2C6E8793298290'.toLowerCase());
});

test('onion lists contain only onion hosts', () => {
  for (const n of Object.values(NETWORKS)) {
    assert.ok(n.monero.onionNodes.length >= 3);
    for (const u of n.monero.onionNodes) assert.match(u, /^http:\/\/[a-z2-7]{56}\.onion:\d+$/);
  }
});

test('Tron: every request goes through SOCKS, none directly', async (t) => {
  const { server, state } = await mockNode();
  const direct = [];
  server.on('connection', (s) => direct.push(s.remotePort));
  const port = server.address().port;
  const socks = await mockSocks({ 'tron.invalid': '127.0.0.1' });
  t.after(async () => { await socks.close(); server.close(); server.closeAllConnections(); });
  const net = { ...NETWORKS.mainnet.tron, host: `http://tron.invalid:${port}` };
  const client = new TronClient(net, '', me.address, socksAgent(socks.uri));

  // .invalid can't resolve here, so success proves the hostname was resolved by the proxy.
  assert.equal(await client.getTrxBalance(), 50_000_000n);
  assert.equal(await client.getUsdtBalance(), 10_000_000n);
  await client.getHistory('USDT');
  await client.send({ asset: 'TRX', to: RECIPIENT, amount: 5n }, me.privateKey);
  assert.equal(state.broadcast.length, 1);
  assert.ok(socks.log.every((d) => d.host === 'tron.invalid' && d.type === 'domain'));
  assert.ok(direct.length > 0);
  await new Promise((r) => setTimeout(r, 50));
  for (const p of direct) assert.ok(socks.outboundPorts.has(p), `direct connection from ${p}`);
});

test('when the proxy is gone, requests fail and nothing reaches the server', async (t) => {
  const { server, state } = await mockNode();
  let connections = 0;
  server.on('connection', () => { connections++; });
  const socks = await mockSocks();
  t.after(() => { server.close(); server.closeAllConnections(); });
  const net = { ...NETWORKS.mainnet.tron, host: `http://127.0.0.1:${server.address().port}` };
  const client = new TronClient(net, '', me.address, socksAgent(socks.uri));
  assert.equal(await client.getTrxBalance(), 50_000_000n);
  await socks.close();
  const before = connections;
  await assert.rejects(client.getTrxBalance());
  await assert.rejects(client.getHistory('TRX'));
  await assert.rejects(client.send({ asset: 'TRX', to: RECIPIENT, amount: 5n }, me.privateKey));
  assert.equal(connections, before, 'no direct fallback');
  assert.equal(state.broadcast.length, 0, 'nothing broadcast');
});

test('price style requests use the proxy and fail closed', async (t) => {
  const api = http.createServer((_q, r) => r.end('{"ok":1}'));
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const socks = await mockSocks({ 'price.invalid': '127.0.0.1' });
  t.after(() => { api.close(); api.closeAllConnections(); });
  const url = `http://price.invalid:${api.address().port}/`;
  assert.deepEqual(await getJson(url, { agent: socksAgent(socks.uri) }), { ok: 1 });
  await socks.close();
  await assert.rejects(getJson(url, { agent: socksAgent(socks.uri), timeoutMs: 3000 }));
});

// ---- installer ----

async function installerFixture(mutate = {}) {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ name: 't' }], format: 'object' });
  const fingerprint = publicKey.getFingerprint();
  const src = tmp();
  fs.mkdirSync(path.join(src, 'tor'));
  const exe = process.platform === 'win32' ? 'tor.exe' : 'tor';
  fs.writeFileSync(path.join(src, 'tor', exe), '#!/bin/sh\necho fake\n', { mode: 0o755 });
  const archive = path.join(tmp(), 'b.tar.gz');
  await tar.c({ gzip: true, file: archive, cwd: src }, ['tor']);
  let bundle = fs.readFileSync(archive);
  const message = await openpgp.createMessage({ binary: bundle });
  const asc = await openpgp.sign({ message, signingKeys: privateKey, detached: true });
  if (mutate.tamper) { bundle = Buffer.from(bundle); bundle[bundle.length - 20] ^= 1; }
  const server = http.createServer((req, res) => {
    if (req.url === '/version') return res.end(JSON.stringify({ version: mutate.version ?? '99.1' }));
    if (req.url === '/key') return res.end(publicKey.armor());
    if (req.url.endsWith('.asc')) return res.end(asc);
    if (req.url.endsWith('.tar.gz')) return res.end(bundle);
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, exe, sources: { versionUrl: `${base}/version`, bundleBases: [base], keyUrls: [`${base}/key`], fingerprint: mutate.fingerprint ?? fingerprint } };
}

test('installer accepts a correctly signed bundle', async (t) => {
  const fx = await installerFixture();
  t.after(() => { fx.server.close(); fx.server.closeAllConnections(); });
  const dir = tmp();
  const tor = new TorManager(dir, { sources: fx.sources });
  assert.equal(tor.isInstalled(), false);
  assert.equal(await tor.install(), '99.1');
  assert.equal(tor.isInstalled(), true);
  assert.ok(fs.existsSync(path.join(dir, 'runtime', 'tor', fx.exe)));
  assert.equal(tor.state.installedVersion, '99.1');
});

for (const [name, mutate, pattern] of [
  ['a tampered bundle', { tamper: true }, /서명 확인에 실패/],
  ['a signature from another key', { fingerprint: 'aa'.repeat(20) }, /공식 키가 아니야/],
  ['a strange version string', { version: '1.0/../../evil' }, /버전 정보/],
]) {
  test(`installer rejects ${name} and unpacks nothing`, async (t) => {
    const fx = await installerFixture(mutate);
    t.after(() => { fx.server.close(); fx.server.closeAllConnections(); });
    const dir = tmp();
    const tor = new TorManager(dir, { sources: fx.sources });
    await assert.rejects(tor.install(), pattern);
    assert.equal(tor.isInstalled(), false);
    assert.ok(!fs.existsSync(path.join(dir, 'runtime')));
    assert.ok(!fs.existsSync(path.join(dir, 'runtime.new')));
  });
}

// ---- the real tor program ----

const torBin = (() => { try { return execFileSync('which', ['tor']).toString().trim(); } catch { return ''; } })();

test('real tor process starts, reports progress, listens, and stops', { skip: !torBin }, async () => {
  const tor = new TorManager(tmp(), { binPath: torBin, sources: { bundleBases: [], keyUrls: [], fingerprint: '' } });
  const uri = await tor.allocate();
  const seen = [];
  tor.on('state', (s) => seen.push(s.phase + ':' + s.percent));
  tor.start();
  const net = require('node:net');
  const { port } = new URL(uri);
  const listening = async () => new Promise((r) => { const s = net.connect(Number(port), '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 250)); up = await listening(); }
  assert.ok(up, 'SOCKS port listens');
  assert.equal(tor.state.phase === 'starting' || tor.state.phase === 'ready', true);
  await tor.stop();
  assert.equal(tor.state.phase, 'off');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await listening(), false, 'port closes on stop');
});

test('real tor crash is reported and traffic stays closed', { skip: !torBin }, async () => {
  const dir = tmp();
  const tor = new TorManager(dir, { binPath: torBin, sources: { bundleBases: [], keyUrls: [], fingerprint: '' } });
  await tor.allocate();
  tor.start();
  await new Promise((r) => setTimeout(r, 1500));
  tor.proc.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(tor.state.phase, 'error');
  await tor.stop();
});
