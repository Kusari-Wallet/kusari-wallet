// Runs the Android screen and wallet bundle in Chromium, with the real Java forwarder and a real monerod.
// Only the Android shell itself (WebView, Keystore, fingerprint sensor) is replaced by a stand-in.
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');
const { chromium, devices } = require('playwright');
const { mockNode, MNEMONIC, RECIPIENT, me } = require('./mock-tron');
const { generateMoneroSeed } = require('../dist/main/monero');
const { NETWORKS } = require('../dist/main/config');
const { mockSocks } = require('./mock-socks');
const https = require('node:https');


const QRCode = require('qrcode');
/** A short Y4M video showing one QR code, for Chromium's fake camera. */
function qrVideo(text, file) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const W = 640, H = 480, n = qr.modules.size, cell = Math.floor(400 / (n + 8));
  const y = Buffer.alloc(W * H, 235);
  const ox = Math.floor((W - n * cell) / 2), oy = Math.floor((H - n * cell) / 2);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.modules.get(r, c)) continue;
    for (let i = 0; i < cell; i++) y.fill(16, (oy + r * cell + i) * W + ox + c * cell, (oy + r * cell + i) * W + ox + c * cell + cell);
  }
  const uv = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, uv]);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420\n`), frame, frame, frame]));
}

const PASSWORD = 'correct horse battery';
const www = path.join(__dirname, '../android/build/www-test');
const shots = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'vw-a-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-a-'));
  const site = http.createServer((q, r) => {
    const f = path.join(www, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
    if (!f.startsWith(www) || !fs.existsSync(f)) { r.statusCode = 404; return r.end(); }
    r.setHeader('content-type', MIME[path.extname(f)] ?? 'application/octet-stream');
    fs.createReadStream(f).pipe(r);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${site.address().port}`;

  // real Java forwarder
  const classes = path.join(tmp, 'classes');
  const env = { ...process.env, JAVA_TOOL_OPTIONS: '' };
  execFileSync('javac', ['-encoding', 'UTF-8', '-d', classes, 'android/java/dev/edge/vaultwallet/LocalProxy.java', 'tests/java/dev/edge/vaultwallet/ProxyHarness.java'], { cwd: path.join(__dirname, '..'), env, stdio: 'pipe' });
  const ks = path.join(tmp, 'tls.p12');
  execFileSync('keytool', ['-genkeypair', '-alias', 't', '-keyalg', 'RSA', '-keysize', '2048', '-dname', 'CN=tron.invalid', '-ext', 'san=dns:tron.invalid', '-keystore', ks, '-storetype', 'PKCS12', '-storepass', 'testpass', '-validity', '2'], { env, stdio: 'pipe' });
  const java = spawn('java', [`-Djavax.net.ssl.trustStore=${ks}`, '-Djavax.net.ssl.trustStorePassword=testpass', '-Djavax.net.ssl.trustStoreType=PKCS12', '-cp', classes, 'dev.edge.vaultwallet.ProxyHarness', origin], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: java.stdout })[Symbol.asyncIterator]();
  const open = async (u) => { java.stdin.write(u + '\n'); return Number((await lines.next()).value); };

  const { server: tron, state } = await mockNode();
  const hole = net.createServer(() => {}); // accepts and never answers
  await new Promise((r) => hole.listen(0, '127.0.0.1', r));
  const monerodPort = 18781;
  const daemon = spawn(process.env.MONEROD || 'monerod', ['--regtest', '--offline', '--fixed-difficulty', '1', '--non-interactive', '--no-igd', '--hide-my-port', '--data-dir', path.join(tmp, 'node'), '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(monerodPort), '--p2p-bind-port', '18782', '--zmq-rpc-bind-port', '18783'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${monerodPort}/get_info`); if (r.ok) break; } catch { /* starting */ } await sleep(500); }

  const tronUp = `http://localhost:${tron.address().port}`;
  const nodeUp = `http://localhost:${monerodPort}`;
  const holeUp = `http://localhost:${hole.address().port}`;
  const map = { [tronUp]: await open(tronUp), [nodeUp]: await open(nodeUp), [holeUp]: await open(holeUp) };
  for (const u of [...NETWORKS.mainnet.monero.onionNodes, 'https://check.torproject.org']) map[u] = await open(u);
  assert.ok(Object.values(map).every((p) => p > 0));
  assert.equal(await open('ftp://evil.example'), 0, 'forwarder refuses non-http');
  assert.equal(await open('http://x.example/path'), 0, 'forwarder refuses a path');

  // forwarder rules, against the real Java code
  const t = `http://127.0.0.1:${map[tronUp]}`;
  const opt = await fetch(`${t}/x`, { method: 'OPTIONS', headers: { Origin: origin } });
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), origin);
  assert.equal((await fetch(`${t}/wallet/getnowblock`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 403, 'other sites are refused');
  console.log('ok forwarder: CORS, foreign origin refused, bad upstreams refused');

  // forwarder through SOCKS, against the real Java code: names unresolved, TLS checked, chunked replies, no fallback
  const tlsServer = https.createServer({ pfx: fs.readFileSync(ks), passphrase: 'testpass' }, (q, r) => {
    r.setHeader('content-type', 'application/json');
    r.write('{"tls":'); r.end('true}'); // two writes make it a chunked reply
  });
  await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
  const plain = http.createServer((q, r) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { r.write(JSON.stringify({ method: q.method, url: q.url, body: b, key: q.headers['x-api-key'], auth: q.headers.authorization, idem: q.headers['idempotency-key'] })); r.end(); }); });
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  const fwd = await mockSocks({ 'plain.invalid': '127.0.0.1', 'tron.invalid': '127.0.0.1', 'wrong.invalid': '127.0.0.1' });
  const pPlain = await open(`http://plain.invalid:${plain.address().port}`);
  const pTls = await open(`https://tron.invalid:${tlsServer.address().port}`);
  const pWrong = await open(`https://wrong.invalid:${tlsServer.address().port}`);
  const proxied = async (port, path_, init = {}) => fetch(`http://127.0.0.1:${port}${path_}`, { ...init, headers: { Origin: origin, ...(init.headers ?? {}) } });
  assert.equal((await proxied(pPlain, '/x')).status, 502, 'unresolvable name fails while direct');
  await open(`socks:${new URL(fwd.uri).port}`);
  const echoed = await (await proxied(pPlain, '/json_rpc?a=1', { method: 'POST', body: 'hello', headers: { 'Content-Type': 'application/json', 'x-api-key': 'K1', Authorization: 'Bearer a:b', 'Idempotency-Key': 'I1' } })).json();
  assert.deepEqual(echoed, { method: 'POST', url: '/json_rpc?a=1', body: 'hello', key: 'K1', auth: 'Bearer a:b', idem: 'I1' });
  assert.deepEqual(await (await proxied(pTls, '/p')).json(), { tls: true });
  assert.ok(fwd.log.every((d) => d.type === 'domain'), 'hostnames reach the proxy unresolved');
  assert.equal((await proxied(pWrong, '/p')).status, 502, 'certificate for another host is refused');
  await fwd.close();
  assert.equal((await proxied(pPlain, '/x')).status, 502, 'proxy gone: fails, no direct connection');
  await open('socks:0');
  tlsServer.close(); plain.close();
  console.log('ok forwarder over SOCKS: hostnames unresolved, TLS verified, chunked replies, no fallback');

  const seed = await generateMoneroSeed('mainnet');
  const camVideo = path.join(tmp, 'cam.y4m');
  qrVideo(`tron:${RECIPIENT}?amount=0.7`, camVideo);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${camVideo}`] });
  const context = await browser.newContext({ ...devices['Pixel 7'] });
  const errors = [];
  const socks = await mockSocks();
  const socksPort = Number(new URL(socks.uri).port);
  await context.addInitScript(({ map, tronUp, socksPort }) => {
    window.__VAULT_TEST__ = { allowFakechain: true, tronHost: tronUp, priceUrl: tronUp + '/simple/price', swapBase: tronUp + '/swap', btcApi: tronUp + '/btc', dcrApi: tronUp + '/dcr', dashApi: tronUp + '/dash', ethRpc: tronUp + '/eth/rpc', ethScout: tronUp + '/eth/scout' };
    window.__opened = []; window.__clip = '';
    let saved = localStorage.getItem('bio');
    window.VaultNative = {
      proxyPort: (u) => map[u] ?? 0,
      openExternal: (u) => window.__opened.push(u),
      copy: (t) => { window.__clip = t; }, clearClip: () => { window.__clip = ''; }, paste: () => window.__clip,
      cameraPermission: (id) => setTimeout(() => window.__bioResult(id, !localStorage.getItem('camDenied'), localStorage.getItem('camDenied') ? 'camera-denied' : '')),
      torAvailable: () => true,
      torPrepare: () => socksPort,
      torStart: () => { setTimeout(() => window.__torState('starting', 30, '')); setTimeout(() => window.__torState('ready', 100, ''), 300); },
      torStop: () => setTimeout(() => window.__torState('off', 0, '')),
      torDirect: () => {},
      // The Java side passes lines to and from the engine; this stands in for both.
      zecAvailable: () => true,
      zecInfo: () => 'test',
      zecStart: () => { window.__zecCalls = []; return true; },
      zecStop: () => {},
      zecWrite: (line) => {
        const r = JSON.parse(line);
        window.__zecCalls.push(r.m);
        const answers = { validate: true, open: true, account: 0, sync: true, summary: { total: 150000000, spendable: 100000000, transparent: 50000000, tip: 3200000, scanned: 3200000 }, address: { unified: 'u1' + 'q'.repeat(211), transparent: 't1' + 'a'.repeat(33) }, dump: btoa('{}'), history: { tip: 3200000, items: [] } };
        setTimeout(() => window.__zecLine(JSON.stringify({ id: r.id, result: answers[r.m] })));
        return true;
      },
      bioAvailable: () => true,
      bioEnabled: (w) => w === 'main' && saved !== null,
      bioDisable: (w) => { if (w !== 'main') return; saved = null; localStorage.removeItem('bio'); },
      bioEnable: (id, w, pw) => setTimeout(() => { saved = pw; localStorage.setItem('bio', pw); window.__bioResult(id, true, ''); }),
      bioUnlock: (id, w) => setTimeout(() => localStorage.getItem('bioFail') ? window.__bioResult(id, false, 'cancelled') : window.__bioResult(id, true, saved)),
    };
  }, { map, tronUp, socksPort });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Failed to fetch|background synchronize/.test(m.text())) errors.push(m.text()); });
  const shot = (n) => page.screenshot({ path: path.join(shots, `android-${n}.png`) });

  await page.goto(origin + '/index.html');
  await page.locator('#splash img').waitFor({ timeout: 900 }).catch(() => {});
  await shot('splash');
  await page.getByText('지갑 시작하기').waitFor({ timeout: 15000 });
  await page.evaluate((n) => window.wallet.updateSettings({ customMoneroNode: n }), holeUp);
  await page.getByText('시드로 복구하기').click();
  await page.fill('#tron-seed', MNEMONIC);
  await page.fill('#xmr-seed', seed);
  await page.fill('#pw', PASSWORD);
  await page.fill('#pw2', PASSWORD);
  const t0 = Date.now();
  await page.click('#next');
  await page.locator('#loading').waitFor({ timeout: 5000 });
  await shot('loading');
  await page.locator('#asset-TRX .amt', { hasText: '50' }).waitFor({ timeout: 60000 });
  console.log('ok vault and wallet created in the WebView bundle in', Date.now() - t0, 'ms; balance arrived through the Java forwarder');

  // Zcash row, shown only when the phone has the engine
  await page.waitForSelector('#asset-ZEC', { timeout: 30000 });
  console.log('ok Zcash listed, engine calls:', await page.evaluate(() => window.__zecCalls.join(',')));

  // spinner
  await page.evaluate(() => {
    const real = window.wallet.overview;
    window.wallet.overview = async () => ({ ...(await real()), monero: { connected: true, synced: false, percent: 0.425, height: 1, targetHeight: 2, node: 'n', error: null } });
  });
  await page.click('#refresh');
  await page.locator('#sync-status', { hasText: '거래 동기화중... 42.5%' }).waitFor({ timeout: 8000 });
  assert.equal(await page.locator('#sync-status .spinner').count(), 1);
  await shot('syncing');
  await page.click('#asset-XMR');
  await page.locator('.sync-banner', { hasText: '거래 동기화중' }).waitFor({ timeout: 5000 });
  await shot('syncing-detail');
  await page.click('#back');
  console.log('ok spinner and 거래 동기화중 text shown while syncing');

  // real node through the real forwarder
  await page.evaluate((n) => { delete window.wallet.overview; return window.wallet.updateSettings({ customMoneroNode: n }); }, nodeUp);
  await page.locator('#unlock').waitFor({ timeout: 30000 });
  await page.reload();
  await page.locator('#unlock').waitFor({ timeout: 30000 });
  await page.fill('#pw', 'wrong password!');
  await page.click('#unlock');
  await page.getByText('비밀번호가 틀렸어').waitFor({ timeout: 30000 });
  await page.fill('#pw', PASSWORD);
  await page.click('#unlock');
  await page.locator('#asset-TRX .amt', { hasText: '50' }).waitFor({ timeout: 60000 });
  for (let i = 0; i < 60; i++) { if (!(await page.locator('#asset-XMR .sub').first().innerText()).match(/연결|동기화/)) break; await sleep(1000); }
  const xmrStatus = await page.locator('#asset-XMR .sub').first().innerText();
  assert.doesNotMatch(xmrStatus, /연결 안 됨|동기화/, `XMR state: ${xmrStatus}`);
  await shot('home');
  console.log('ok WASM wallet in a worker connected and synced to monerod through the Java forwarder');

  // receive and persistence
  await page.click('#asset-XMR');
  await page.click('#detail-receive');
  await page.locator('#copy:not([disabled])').waitFor({ timeout: 15000 });
  const address = await page.locator('#my-address').innerText();
  await page.click('#new-sub');
  await page.locator('.sub-list').waitFor({ timeout: 20000 });
  const sub = await page.locator('#my-address').innerText();
  assert.notEqual(sub, address);
  await page.click('#copy');
  assert.equal(await page.evaluate(() => window.__clip), sub);
  await shot('receive');
  await page.click('#back');

  // TRX send through the forwarder
  await page.click('#go-send');
  await page.click('#coin-picker');
  await page.click('#pick-TRX');
  await page.evaluate(() => localStorage.setItem('camDenied', '1'));
  await page.click('#scan');
  await page.getByText('카메라 권한이 없어').waitFor({ timeout: 8000 });
  await shot('scan-denied');
  await page.click('#scan-close');
  await page.evaluate(() => localStorage.removeItem('camDenied'));
  await page.click('#scan');
  await page.locator('#scanner').waitFor({ state: 'detached', timeout: 25000 });
  assert.equal(await page.inputValue('#to'), RECIPIENT);
  assert.equal(await page.inputValue('#amount'), '0.7');
  console.log('ok QR scan on the Android screen, denied camera explained');
  await page.fill('#to', RECIPIENT);
  await page.fill('#amount', '1.5');
  await page.click('#review');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-send');
  await page.locator('#sent').waitFor({ timeout: 30000 });
  assert.equal(state.broadcast.length, 1);
  assert.equal(state.broadcast[0].raw_data.contract[0].parameter.value.amount, 1500000);
  await page.click('#open-explorer');
  assert.match(await page.evaluate(() => window.__opened[0]), /^https:\/\/tronscan\.org\/#\/transaction\/[0-9a-f]{64}$/);
  await page.click('#back');
  console.log('ok TRX signed in the bundle and broadcast through the forwarder');

  // swap through the Java forwarder
  await page.click('#go-swap');
  await page.click('#swap-from');
  await page.click('#swap-from-USDT');
  await page.click('#swap-to');
  await page.click('#swap-to-XMR');
  await page.fill('#swap-amount', '2');
  await page.locator('#swap-next:not([disabled])').waitFor({ timeout: 15000 });
  await page.click('#swap-next');
  await page.locator('#confirm-swap').waitFor({ timeout: 30000 });
  await shot('swap-review');
  await page.click('#back');
  await page.click('#back');
  console.log('ok swap order through the forwarder');

  // Tornado in the WebView: worker, proof, checked by the real contracts on a local chain
  await page.click('#go-swap');
  await page.click('#go-tornado');
  await page.locator('#tornado-engine', { hasText: '준비됨' }).waitFor({ timeout: 90000 });
  const { startChain } = require('./tornado-chain');
  const chain = await startChain('test test test test test test test test test test test junk');
  try {
    const keys = { nullifier: '11'.repeat(31), secret: '22'.repeat(31) };
    const recipient = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const [{ commitment }] = await page.evaluate((k) => window.__tornadoRun('commit', { notes: [k] }), keys);
    await (await chain.tornado.connect(chain.relayer).deposit(commitment, { value: 10n ** 17n })).wait();
    const started = Date.now();
    const { proof, args } = await page.evaluate((p) => window.__tornadoRun('prove', p), { leaves: [commitment], leafIndex: 0, ...keys, recipient, relayer: `0x${'0'.repeat(40)}`, fee: '0' });
    await (await chain.tornado.connect(chain.relayer).withdraw(proof, ...args)).wait();
    console.log('ok Tornado proof made in the WebView bundle in', Date.now() - started, 'ms, accepted by the contract');
  } finally { await chain.stop(); }
  await page.click('#back');
  await page.click('#back');

  // A second wallet: its Monero data and vault don't touch the first one's
  const before = await page.evaluate(() => window.wallet.addresses());
  const second = await page.evaluate(async () => {
    await window.wallet.walletBeginAdd('둘째');
    const seeds = await window.wallet.generateSeeds();
    await window.wallet.restore('second wallet password', seeds.tronMnemonic, seeds.moneroSeed, '');
    const a = await window.wallet.addresses();
    const list = await window.wallet.walletsList();
    return { a, list };
  });
  assert.equal(second.list.list.length, 2);
  assert.notEqual(second.a.XMR, before.XMR);
  assert.notEqual(second.a.ETH, before.ETH);
  await page.evaluate(() => window.wallet.walletSwitch('main'));
  await page.locator('#unlock').waitFor({ timeout: 20000 });
  await page.fill('#pw', PASSWORD);
  await page.click('#unlock');
  await page.locator('#go-swap').waitFor({ timeout: 120000 });
  assert.deepEqual(await page.evaluate(() => window.wallet.addresses().then((a) => [a.XMR, a.ETH])), [before.XMR, before.ETH], 'first wallet came back whole');
  console.log('ok second wallet kept apart from the first in WebView storage');

  // biometric enable, then lock and open with it
  await page.click('#open-settings');
  await page.locator('#bio-pw').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#set-tor').count(), 1, 'Tor setting on Android');
  assert.equal(await page.locator('#tor-update').isVisible(), false, 'no separate Tor download on Android');
  await page.fill('#bio-pw', 'wrong password!');
  await page.click('#bio-on');
  await page.getByText('비밀번호가 틀렸어').waitFor({ timeout: 30000 });
  await page.fill('#bio-pw', PASSWORD);
  await page.click('#bio-on');
  await page.locator('#bio-off').waitFor({ timeout: 30000 });
  await shot('settings-bio');

  await page.click('#lock');
  await page.locator('#asset-TRX').waitFor({ timeout: 40000 });
  console.log('ok fingerprint login opened the wallet automatically after lock');

  // cancel falls back to the password
  await page.evaluate(() => { localStorage.setItem('bioFail', '1'); });
  await page.click('#lock');
  await page.locator('#bio-unlock').waitFor({ timeout: 40000 });
  await page.waitForTimeout(400);
  await shot('unlock-bio');
  assert.equal(await page.locator('#unlock').count(), 1);
  assert.equal(await page.locator('.error:visible').count(), 0, 'cancel shows no error');
  await page.reload();
  await page.locator('#bio-unlock').waitFor({ timeout: 30000 });
  await page.fill('#pw', PASSWORD);
  await page.click('#unlock');
  await page.locator('#asset-XMR').waitFor({ timeout: 60000 });
  await page.click('#asset-XMR');
  await page.click('#detail-receive');
  await page.locator('.sub-list').waitFor({ timeout: 30000 });
  assert.ok((await page.locator('.sub-list').innerText()).includes(sub.slice(0, 14)), 'subaddress survives a restart through stored wallet data');
  assert.equal(await page.locator('#my-address').innerText(), address);
  console.log('ok password fallback, wallet data survives a restart');

  // Tor mode, with the forwarder pointed at a SOCKS proxy
  await page.click('#back');
  await page.click('#open-settings');
  await page.locator('#set-tor').waitFor({ timeout: 15000 });
  await page.fill('#set-node', '');
  await page.check('#set-tor');
  await open(`socks:${socksPort}`);
  await page.click('#save-settings');
  await page.locator('#unlock').waitFor({ timeout: 40000 });
  await page.fill('#pw', PASSWORD);
  await page.click('#unlock');
  await page.locator('#tor-chip', { hasText: 'Tor 연결됨' }).waitFor({ timeout: 30000 });
  await page.locator('#asset-TRX .amt', { hasText: '50' }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  await shot('tor-home');
  assert.ok(socks.log.some((d) => d.host === 'localhost' && d.type === 'domain'), 'Tron traffic through SOCKS');
  assert.ok(socks.log.some((d) => d.host.endsWith('.onion')), 'XMR uses onion nodes');
  await page.click('#tab-history');
  await page.locator('#hist .hist-row').first().click();
  await page.locator('#toast').waitFor({ timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__opened.length), 0, 'no browser opened in Tor mode');
  assert.match(await page.evaluate(() => window.__clip), /tronscan/);
  await page.click('#tab-assets');
  await page.click('#open-settings');
  await page.locator('#tor-status').waitFor({ timeout: 10000 });
  await shot('tor-settings');
  await page.click('#nav-home');
  let conns = 0;
  tron.on('connection', () => { conns++; });
  await socks.close();
  await page.click('#refresh');
  await page.locator('#asset-TRX', { hasText: /조회 실패|최근 값/ }).waitFor({ timeout: 100000 });
  assert.equal(conns, 0, 'nothing reaches the node once Tor is gone');
  console.log('ok Tor mode: all traffic through SOCKS, onion nodes, browser not opened, stops when Tor is gone');

  if (errors.filter((e) => !/monero|sync/i.test(e)).length) console.log('PAGE ERRORS', JSON.stringify(errors).slice(0, 1500));
  assert.deepEqual(errors.filter((e) => !/monero|sync/i.test(e)), [], 'no page errors');
  await browser.close();
  daemon.kill('SIGKILL'); java.kill('SIGKILL');
  console.log('ALL PASSED; screenshots in', shots);
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
