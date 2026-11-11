const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readPtConfig, parseCustomBridges, bridgeArgs, autoFirst, autoNext } = require('../dist/main/tor-bridges');
const { TorManager } = require('../dist/main/tor');

const PT = fs.readFileSync(path.join(__dirname, '../android/pt_config.json'), 'utf8');

test('default bridges come from the Tor bundle\'s own pt_config.json', () => {
  const d = readPtConfig(PT);
  assert.ok(d.snowflake.length >= 1 && d.snowflake.every((l) => l.startsWith('snowflake ')));
  assert.ok(d.obfs4.length >= 1 && d.obfs4.every((l) => /^obfs4 \S+:\d+ [0-9A-F]{40} cert=/.test(l)));
  assert.deepEqual(readPtConfig('{"bridges":{"obfs4":["obfs4 nope", 5, "obfs4 1.2.3.4:5 AB cert=x"]}}'), { snowflake: [], obfs4: ['obfs4 1.2.3.4:5 AB cert=x'] }, 'bad lines are dropped');
});

test('custom bridge lines: pasted forms accepted, anything else refused with the line number', () => {
  assert.deepEqual(parseCustomBridges('Bridge obfs4 1.2.3.4:443 AAAA cert=x iat-mode=0\r\n\n  webtunnel [2001:db8::1]:443 BBBB url=https://e.example/p  \n'),
    ['obfs4 1.2.3.4:443 AAAA cert=x iat-mode=0', 'webtunnel [2001:db8::1]:443 BBBB url=https://e.example/p']);
  assert.throws(() => parseCustomBridges(''), /at least one/);
  assert.throws(() => parseCustomBridges('obfs4 1.2.3.4:443 A\nvanilla 1.2.3.4:9001'), /line 2/);
  assert.throws(() => parseCustomBridges('obfs4 example.com:443 A'), /line 1/, 'a host name would be resolved outside Tor');
  assert.throws(() => parseCustomBridges('obfs4 1.2.3.4:443 A\u0000'), /line 1/);
});

test('Tor options for each way in; nothing extra when connecting directly', () => {
  const d = readPtConfig(PT);
  assert.deepEqual(bridgeArgs('none', d, [], ''), []);
  const sf = bridgeArgs('snowflake', d, [], './pluggable_transports/lyrebird');
  assert.deepEqual(sf.slice(0, 4), ['--UseBridges', '1', '--ClientTransportPlugin', 'snowflake exec ./pluggable_transports/lyrebird']);
  assert.equal(sf.filter((a) => a === '--Bridge').length, d.snowflake.length);
  const custom = bridgeArgs('custom', d, ['obfs4 1.2.3.4:443 A', 'webtunnel [::1]:443 B'], 'pt/lyrebird');
  assert.equal(custom[3], 'obfs4,webtunnel exec pt/lyrebird');
  assert.throws(() => bridgeArgs('obfs4', d, [], 'C:\\Users\\Ann Lee\\lyrebird.exe'), /space/);
  assert.equal(autoFirst(null), 'none');
  assert.equal(autoFirst('snowflake'), 'snowflake');
  assert.deepEqual([autoNext('none'), autoNext('snowflake'), autoNext('obfs4')], ['snowflake', 'obfs4', 'none']);
});

/** A stand-in tor: records its options, and gets through only with the bridges it's told to expect. */
function fakeTor(dir, works) {
  const torDir = path.join(dir, 'bin');
  fs.mkdirSync(path.join(torDir, 'pluggable_transports'), { recursive: true });
  fs.writeFileSync(path.join(torDir, 'pluggable_transports', 'pt_config.json'), PT);
  fs.writeFileSync(path.join(torDir, 'pluggable_transports', 'lyrebird'), '#!/bin/sh\n', { mode: 0o755 });
  const bin = path.join(torDir, 'tor');
  fs.writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${path.join(dir, 'runs.txt')}"
case "$*" in ${works}) echo "[notice] Bootstrapped 100% (done): Done";; *) echo "[notice] Bootstrapped 5% (conn): Connecting";; esac
exec sleep 30
`, { mode: 0o755 });
  return bin;
}
const runs = (dir) => fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8').trim().split('\n');
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };

test('automatic: straight to Tor first, Snowflake when that is blocked, and it starts with what worked next time', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = fakeTor(dir, '*"ClientTransportPlugin snowflake exec ./pluggable_transports/lyrebird"*');
  const tor = new TorManager(path.join(dir, 'state'), { binPath: bin, autoWaitMs: 400 });
  fs.mkdirSync(path.join(dir, 'state'));
  await tor.allocate();
  tor.start();
  await until(() => tor.state.phase === 'ready');
  assert.equal(tor.state.route, 'snowflake');
  const r = runs(dir);
  assert.equal(r.length, 2);
  assert.ok(!r[0].includes('UseBridges'), 'first try is straight to Tor');
  assert.match(r[1], /--UseBridges 1 --ClientTransportPlugin snowflake exec \.\/pluggable_transports\/lyrebird --Bridge snowflake /);
  await tor.stop();

  const again = new TorManager(path.join(dir, 'state'), { binPath: bin, autoWaitMs: 400 });
  await again.allocate();
  again.start();
  await until(() => again.state.phase === 'ready');
  assert.equal(runs(dir).length, 3, 'started with Snowflake straight away');
  await again.stop();
});

test('a chosen way in is used as is; switching restarts Tor; a Tor without lyrebird says so', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = fakeTor(dir, '*"--Bridge obfs4 1.2.3.4:443 AAAA"*|*"--SocksPort"*');
  fs.mkdirSync(path.join(dir, 'state'));
  const tor = new TorManager(path.join(dir, 'state'), { binPath: bin, autoWaitMs: 400 });
  tor.setBridge('none');
  await tor.allocate();
  tor.start();
  await until(() => tor.state.phase === 'ready');
  tor.setBridge('custom', ['obfs4 1.2.3.4:443 AAAA cert=x iat-mode=0']);
  await until(() => runs(dir).length === 2 && tor.state.phase === 'ready');
  assert.match(runs(dir)[1], /--ClientTransportPlugin obfs4 exec \.\/pluggable_transports\/lyrebird --Bridge obfs4 1\.2\.3\.4:443 AAAA cert=x iat-mode=0/);
  assert.equal(tor.state.route, 'custom');
  await tor.stop();

  fs.rmSync(path.join(dir, 'bin', 'pluggable_transports', 'lyrebird'));
  const old = new TorManager(path.join(dir, 'state'), { binPath: bin });
  old.setBridge('snowflake');
  await old.allocate();
  old.start();
  assert.equal(old.state.phase, 'error');
  assert.match(old.state.error, /Update Tor/);
  assert.equal(runs(dir).length, 2, 'Tor was not started without its bridge program');
});

test('Android: Tor takes only well-formed bridge lines, and none without its bridge program', { skip: (() => { try { require('node:child_process').execFileSync('javac', ['-version'], { stdio: 'ignore' }); return false; } catch { return 'no JDK'; } })() }, () => {
  const { execFileSync } = require('node:child_process');
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'torj-'));
  try {
    execFileSync('javac', ['-encoding', 'UTF-8', '-d', classes, 'android/java/dev/edge/vaultwallet/TorProcess.java', 'tests/java/dev/edge/vaultwallet/TorBridgeHarness.java'], { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
    fs.writeFileSync(path.join(classes, 'lyrebird'), '');
    const run = (lyrebird) => execFileSync('java', ['-cp', classes, 'dev.edge.vaultwallet.TorBridgeHarness', lyrebird], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    // obfs4, snowflake, webtunnel taken; a smuggled option, an unknown transport, a host name and a tab refused; empty is fine.
    assert.equal(run(path.join(classes, 'lyrebird')), '11100001');
    assert.equal(run(path.join(classes, 'missing')), '00000001', 'no bridges without lyrebird, a direct connection still works');
  } finally { fs.rmSync(classes, { recursive: true, force: true }); }
});
