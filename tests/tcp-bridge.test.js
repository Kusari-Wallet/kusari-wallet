// The Android side's TCP bridge for Dash peer-to-peer connections, run on the desktop JVM.
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');
const { mockSocks } = require('./mock-socks');

function haveJava() { try { execFileSync('javac', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } }

test('Android TCP bridge: Dash port only, straight or through Tor with a login per connection', { skip: !haveJava() && 'no JDK' }, async (t) => {
  const echo = net.createServer((c) => c.pipe(c));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const port = echo.address().port;
  const socks = await mockSocks({ 'node.example': '127.0.0.1' });
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'tcp-'));
  t.after(() => { echo.close(); socks.close(); fs.rmSync(classes, { recursive: true, force: true }); });
  const root = path.join(__dirname, '..');
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', classes, 'android/java/dev/edge/vaultwallet/TcpBridge.java', 'tests/java/dev/edge/vaultwallet/TcpHarness.java'], { cwd: root, stdio: 'pipe' });
  const java = spawn('java', ['-cp', classes, 'dev.edge.vaultwallet.TcpHarness', String(port)], { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => java.kill('SIGKILL'));
  const events = [];
  const waiters = [];
  readline.createInterface({ input: java.stdout }).on('line', (line) => {
    if (/^(r|open|data|close) /.test(line) && !line.startsWith('r ')) {
      const w = waiters.findIndex((x) => x.match(line));
      if (w >= 0) waiters.splice(w, 1)[0].resolve(line); else events.push(line);
    } else if (line.startsWith('r ')) { const w = waiters.findIndex((x) => x.reply); if (w >= 0) waiters.splice(w, 1)[0].resolve(line.slice(2)); }
  });
  const cmd = (c) => new Promise((resolve) => { waiters.push({ reply: true, match: () => false, resolve }); java.stdin.write(c + '\n'); });
  const event = (re) => {
    const i = events.findIndex((e) => re.test(e));
    if (i >= 0) return Promise.resolve(events.splice(i, 1)[0]);
    return new Promise((resolve) => waiters.push({ match: (l) => re.test(l), resolve }));
  };

  assert.equal(await cmd(`open 1 127.0.0.1 ${port + 1}`), 'false', 'only the allowed port');
  assert.equal(await cmd(`open 2 127.0.0.1 ${port}`), 'true');
  await event(/^open 2$/);
  assert.equal(await cmd('write 2 ' + Buffer.from('hello').toString('base64')), 'true');
  assert.equal(Buffer.from((await event(/^data 2 /)).split(' ')[2], 'base64').toString(), 'hello');
  await cmd('close 2');

  assert.equal(await cmd(`socks ${new URL(socks.uri).port}`), 'ok');
  for (const id of [3, 4]) {
    assert.equal(await cmd(`open ${id} node.example ${port}`), 'true');
    await event(new RegExp(`^open ${id}$`));
    await cmd(`write ${id} ` + Buffer.from('via tor').toString('base64'));
    assert.equal(Buffer.from((await event(new RegExp(`^data ${id} `))).split(' ')[2], 'base64').toString(), 'via tor');
    await cmd(`close ${id}`);
  }
  assert.deepEqual(socks.log.map((l) => [l.host, l.type]), [['node.example', 'domain'], ['node.example', 'domain']], 'names reach Tor unresolved');
  assert.ok(socks.log[0].user && socks.log[0].user !== socks.log[1].user, 'each connection on its own Tor route');

  // Tor set but not answering: the connection fails, and nothing goes out directly.
  await cmd('socks 1');
  assert.equal(await cmd(`open 5 127.0.0.1 ${port}`), 'true');
  assert.match(await event(/^close 5 /), /Could not connect/);
});
