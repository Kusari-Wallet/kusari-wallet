// Drives the real Electron app: restore, balances, TRX and USDT sends against a mock Tron node.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { mockNode, MNEMONIC, RECIPIENT, me } = require('./mock-tron');
const { TronWeb } = require('tronweb');
const { mockSocks } = require('./mock-socks');
const { startSparkMock, mintCoin } = require('./mock-spark');
const { startSparkEngine } = require('../dist/main/spark-process');
const { sparkKey } = require('../dist/main/spark');
const SPARK_ENGINE = path.join(__dirname, '..', 'native-bin', 'spark-linux', 'spark-bridge');

/** Opens a coin menu's token group unless it is already open. */
async function openFold(page, sel) {
  if ((await page.getAttribute(sel, 'aria-expanded')) !== 'true') await page.click(sel);
}


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

const shots = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'vw-shots-'));
const PASSWORD = 'correct horse battery';

(async () => {
  const { server, state } = await mockNode();
  // Firo Spark: the real engine against a stand-in server holding one private coin of ours among others.
  const spark = fs.existsSync(SPARK_ENGINE) ? await startSparkMock() : null;
  if (spark) {
    const e = startSparkEngine(SPARK_ENGINE);
    const mine = await e.call('address', { key: sparkKey(MNEMONIC), index: 1, diversifier: 0 });
    const other = await e.call('address', { key: 'cb02b05c71a69080b083484f1cdf407677fac00ced6438df16925e2a29b4eebf', index: 1, diversifier: 0 });
    for (const [to, v] of [[other, 3e8], [mine, 1.5e8], [other, 2e8], [other, 1e8]]) spark.state.groups[1].push(await mintCoin(e, to, v));
    e.close();
  }
  const camVideo = path.join(os.tmpdir(), `vw-cam-${process.pid}.y4m`);
  qrVideo(`tron:${RECIPIENT}?amount=2.5`, camVideo);
  const socks = await mockSocks();
  // A stand-in CoinJoin coordinator; the round itself is made when the test starts mixing.
  let cjCoord = null;
  const cjServer = require('node:http').createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; });
    q.on('end', async () => {
      r.setHeader('content-type', 'application/json; charset=utf-8');
      try {
        if (!cjCoord) { r.end(JSON.stringify({ roundStates: [] })); return; }
        const out = await cjCoord.transport.post(q.url.replace(/^\/wabisabi\//, ''), JSON.parse(b || '{}'), q.headers['user-agent'] ? 'ua-sent' : 'plain');
        r.end(JSON.stringify(out));
      } catch (e) { r.statusCode = 500; r.end(JSON.stringify({ type: 'wabisabi-protocol-violation', errorCode: e.code ?? 'Error', description: e.message, exceptionData: { Type: 'EmptyExceptionData' } })); }
    });
  });
  await new Promise((res) => cjServer.listen(0, '127.0.0.1', res));
  // A stand-in for the Solana private pool's program and relayer.
  const solPool = require('./solpool-standin').standIn();
  await new Promise((res) => solPool.server.listen(0, '127.0.0.1', res));
  const connectionsToNode = [];
  server.on('connection', (c) => connectionsToNode.push(c.remotePort));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-ui-'));
  const externalLog = path.join(data, 'external-links.txt');
  const launch = () => _electron.launch({
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camVideo}`, path.join(__dirname, '..')],
    env: { ...process.env, VAULT_WALLET_DATA: data, VAULT_DEV_EXTERNAL_LOG: externalLog, VAULT_DEV_TRON_HOST: `http://127.0.0.1:${server.address().port}`, VAULT_DEV_SOCKS: socks.uri, VAULT_DEV_BTC_API: `http://127.0.0.1:${server.address().port}/btc`, VAULT_DEV_COINJOIN: `http://127.0.0.1:${cjServer.address().port}/`, VAULT_DEV_COINJOIN_TEST: JSON.stringify({ pollMs: 300, registrationMarginMs: 2000, minInputs: 3 }), VAULT_DEV_TORNADO: JSON.stringify({ 0.1: '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc', 1: '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936' }), VAULT_DEV_DASH_API: `http://127.0.0.1:${server.address().port}/dash`, VAULT_DEV_SOL_RPC: `http://127.0.0.1:${server.address().port}/sol`, VAULT_DEV_SOLPOOL_RELAYER: `http://127.0.0.1:${solPool.server.address().port}/r`, VAULT_DEV_DOGE_API: `http://127.0.0.1:${server.address().port}/doge`, VAULT_DEV_DCR_API: `http://127.0.0.1:${server.address().port}/dcr`, VAULT_DEV_FIRO_API: `http://127.0.0.1:${server.address().port}/dash-firo`, VAULT_DEV_ZEC_BIN: path.join(__dirname, 'fake-zec-engine.js'), VAULT_DEV_ZANO_BIN: path.join(__dirname, 'fake-zano-engine.js'), VAULT_DEV_KSR_BIN: path.join(__dirname, 'fake-ksr-engine.js'), VAULT_DEV_KSR_NODE: '127.0.0.1:21081', VAULT_DEV_ARRR_BIN: path.join(__dirname, 'fake-arrr-engine.js'), VAULT_DEV_MWEB_BIN: path.join(__dirname, 'fake-mweb-engine.js'), ...(spark ? { VAULT_DEV_SPARK_BIN: SPARK_ENGINE, VAULT_DEV_SPARK_SERVER: `127.0.0.1:${spark.port}` } : {}), VAULT_DEV_ETH_RPC: `http://127.0.0.1:${server.address().port}/eth/rpc`, VAULT_DEV_ETH_SCOUT: `http://127.0.0.1:${server.address().port}/eth/scout`, VAULT_DEV_LTC_API: `http://127.0.0.1:${server.address().port}/btc`, VAULT_DEV_BCH_API: `http://127.0.0.1:${server.address().port}/bch`, VAULT_DEV_POL_RPC: `http://127.0.0.1:${server.address().port}/pol/rpc`, VAULT_DEV_POL_SCOUT: `http://127.0.0.1:${server.address().port}/eth/scout`, VAULT_DEV_ARB_RPC: `http://127.0.0.1:${server.address().port}/arb/rpc`, VAULT_DEV_ARB_SCOUT: `http://127.0.0.1:${server.address().port}/eth/scout`, VAULT_DEV_BSC_RPC: `http://127.0.0.1:${server.address().port}/bsc/rpc`, VAULT_DEV_HYPE_RPC: `http://127.0.0.1:${server.address().port}/hype/rpc`, VAULT_DEV_UNISWAP_BASE: `http://127.0.0.1:${server.address().port}/uniswap`, VAULT_DEV_UNISWAP_KEY: 'test-key', VAULT_DEV_BSC_SCOUT: `http://127.0.0.1:${server.address().port}/eth/scout`, VAULT_DEV_SIMPLESWAP_BASE: `http://127.0.0.1:${server.address().port}/simple`, VAULT_DEV_GHOSTSWAP_BASE: `http://127.0.0.1:${server.address().port}/ghost`, VAULT_DEV_SWAP_BASE: `http://127.0.0.1:${server.address().port}/swap`, VAULT_DEV_PRICE_URL: `http://127.0.0.1:${server.address().port}/simple/price`, NO_PROXY: '*' },
  });
  let app = await launch();
  let page = await app.firstWindow();
  // Most of the run is the narrow layout (menu at the bottom); the wide one is checked at the end.
  const sized = (w, hgt) => app.evaluate(({ BrowserWindow }, [a, b]) => BrowserWindow.getAllWindows()[0].setSize(a, b), [w, hgt]);
  await sized(500, 880);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  
  // create flow up to the seed screen
  await page.locator('#splash img').waitFor({ timeout: 800 }).catch(() => {});
  await shot('0-splash');
  // No mode to choose: every wallet is a maximum-privacy wallet.
  await page.getByText('Get started').waitFor();
  assert.equal(await page.locator('#mode-walletconnect, #mode-private').count(), 0);
  assert.equal(await page.locator('.entry-logo').count(), 1, 'logo on the welcome screen');
  assert.equal(await page.locator('.entry .coin').count(), 0, 'coin images removed from entry');
  assert.equal(await page.locator('#net').count(), 0, 'no network choice');
  assert.equal(await page.getByText('testnet').count(), 0, 'no testnet wording');
  await shot('1-welcome');
  await page.getByText('Create a new wallet').click();
  // The Terms of Use come first: read in a layer over the form, and creating waits for the box to be ticked.
  assert.equal(await page.locator('#next').isDisabled(), true, 'no wallet without agreeing');
  await page.fill('#pw', PASSWORD);
  await page.click('#terms-open');
  await page.locator('#terms', { hasText: 'Your keys, your responsibility' }).waitFor();
  assert.match(await page.locator('#terms').innerText(), /Disputes/);
  await shot('1b-terms');
  await page.click('#terms-close');
  assert.equal(await page.inputValue('#pw'), PASSWORD, 'what was typed stays');
  await page.check('#terms-agree');
  await page.fill('#pw2', 'different password');
  await page.click('#next');
  await page.getByText('The two passwords do not match').waitFor();
  await page.fill('#pw2', PASSWORD);
  if (await page.locator('#terms-agree').count() && !(await page.isChecked('#terms-agree'))) await page.check('#terms-agree');
  await page.click('#next');
  await page.getByText('Write both seed phrases on paper').waitFor({ timeout: 60000 });
  await shot('2-seeds');
  const words = await page.locator('.seed').allInnerTexts();
  assert.equal((await page.locator('.seed').nth(0).locator('li').count()), 12);
  assert.equal((await page.locator('.seed').nth(1).locator('li').count()), 25);
  void words;
  assert.ok(await page.locator('#next').isDisabled(), 'cannot continue before ticking the box');
  const tronSeed = (await page.locator('.seed').nth(0).locator('li').allInnerTexts()).map((t) => t.split('\n').pop().trim());
  const xmrSeed = (await page.locator('.seed').nth(1).locator('li').allInnerTexts()).map((t) => t.split('\n').pop().trim());
  await page.click('#seed-qr-show'); // both seeds as one QR code, hidden until asked for
  const seedQr = await page.locator('#seed-qr-img').evaluate(async (img) => {
    await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    return jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height)?.data ?? '';
  });
  assert.match(seedQr, /^kusari-seeds:1\?b=[a-z]+(-[a-z]+){11}&m=[a-z]+(-[a-z]+){24}$/, 'the QR holds both seeds');
  await page.click('#seed-qr-show');
  assert.equal(await page.locator('#seed-qr-img').count(), 0);
  await page.check('#saved');
  await page.click('#next');
  // wrong quiz answer is refused
  await page.locator('.quiz').first().fill('wrongword');
  await page.locator('.quiz').nth(1).fill('wrongword');
  await page.click('#next');
  await page.locator('.error').filter({ hasText: 'does not match' }).waitFor();
  const quizLabels = await page.locator('label.field > span').allInnerTexts();
  const idx = quizLabels.map((l) => Number(l.match(/word (\d+)/)[1]) - 1);
  await page.locator('.quiz').first().fill(tronSeed[idx[0]]);
  await page.locator('.quiz').nth(1).fill(xmrSeed[idx[1]]);
  await shot('3-quiz');
  await page.click('#next');
  await page.locator('#asset-XMR').waitFor({ timeout: 90000 });
  await page.waitForTimeout(1500);
  await shot('4-created-wallet');
  console.log('ok create wallet through backup quiz');

  // delete, then restore with a known Tron seed so the mock node recognizes it
  await page.click('#open-settings');
  await page.locator('#seed-pw').waitFor();
  assert.equal(await page.locator('#wc-section, #wc-enable').count(), 0, 'a maximum-privacy wallet shows no WalletConnect in settings');
  assert.equal(await page.locator('#go-dapps').count(), 0);
  assert.equal(await page.locator('#set-tor').count(), 1, 'a maximum-privacy wallet has the Tor switch');
  await page.fill('#seed-pw', 'wrong password!');
  await page.click('#reveal');
  await page.getByText('Wrong password').waitFor({ timeout: 15000 });
  await page.fill('#seed-pw', PASSWORD);
  await page.click('#reveal');
  await page.locator('.seed').first().waitFor({ timeout: 15000 });
  const revealed = (await page.locator('.seed').nth(0).locator('li').allInnerTexts()).map((t) => t.split('\n').pop().trim());
  assert.deepEqual(revealed, tronSeed, 'revealed seed equals generated seed');
  await shot('5-settings');
  // Donation addresses: hidden until asked for, each with a QR code.
  assert.equal(await page.locator('#donate-list').isHidden(), true);
  await page.click('#donate');
  await page.locator('#donate-XMR', { hasText: '46ZEpH2z' }).waitFor();
  assert.equal(await page.locator('.donate-row').count(), 10);
  await page.locator('#donate-BTC button', { hasText: 'QR' }).click();
  await page.locator('#donate-BTC img').waitFor();
  await page.locator('#donate-LTC button', { hasText: 'QR' }).click();
  await page.locator('#donate-LTC img').waitFor();
  await page.locator('#donate-section').scrollIntoViewIfNeeded();
  await shot('donate');
  await page.click('#donate');
  await page.fill('#del-pw', PASSWORD);
  await page.click('#delete');
  await page.getByText('Get started').waitFor({ timeout: 30000 });
  assert.ok(!fs.existsSync(path.join(data, 'vault.json')));
  console.log('ok reveal requires password, delete wipes the vault');

  await page.getByText('Restore from seeds').click();
  await page.fill('#tron-seed', MNEMONIC);
  await page.fill('#xmr-seed', xmrSeed.join(' '));
  await page.fill('#from', 'someday');
  await page.fill('#pw', PASSWORD);
  await page.fill('#pw2', PASSWORD);
  if (await page.locator('#terms-agree').count() && !(await page.isChecked('#terms-agree'))) await page.check('#terms-agree');
  await page.click('#next');
  await page.getByText('restore point').waitFor({ timeout: 30000 });
  await page.fill('#from', '');
  await page.click('#next');
  await page.locator('#asset-TRX').waitFor({ timeout: 90000 });
  assert.deepEqual(await page.locator('.asset').evaluateAll((els) => els.map((e) => e.id)), ['asset-XMR', 'asset-BTC', 'asset-ETH', 'asset-ZEC', 'asset-SOL', 'asset-TRX', 'asset-GRAM', 'asset-BNB', 'asset-POL', 'asset-ARB', 'asset-BCH', 'asset-LTC', 'asset-DCR', 'asset-DOGE', 'asset-DASH', 'asset-FIRO', 'asset-ZANO', 'asset-KSR', 'asset-ARRR'], 'tokens start folded under their chain');
  for (const parent of ['ETH', 'SOL', 'TRX', 'GRAM', 'BNB', 'POL', 'ARB']) await page.click(`#fold-${parent}`);
  await page.evaluate(() => document.getElementById('fold-ARB').scrollIntoView({ block: 'center' }));
  const scrolled = await page.evaluate(() => document.querySelector('.scroll').scrollTop);
  await page.click('#fold-ARB'); await page.click('#fold-ARB');
  assert.equal(await page.evaluate(() => document.querySelector('.scroll').scrollTop), scrolled, 'folding keeps the list where it was');
  assert.deepEqual(await page.locator('.asset').evaluateAll((els) => els.map((e) => e.id)), ['asset-XMR', 'asset-BTC', 'asset-ETH', 'asset-USDTE', 'asset-USDCE', 'asset-LINK', 'asset-PEPE', 'asset-SHIB', 'asset-ZEC', 'asset-SOL', 'asset-USDTS', 'asset-USDCS', 'asset-ORCA', 'asset-PUMP', 'asset-TRX', 'asset-USDT', 'asset-GRAM', 'asset-USDTT', 'asset-BNB', 'asset-USDTB', 'asset-USDCB', 'asset-POL', 'asset-ETHP', 'asset-USDTP', 'asset-USDCP', 'asset-ARB', 'asset-ETHA', 'asset-USDTA', 'asset-USDCA', 'asset-BCH', 'asset-LTC', 'asset-DCR', 'asset-DOGE', 'asset-DASH', 'asset-FIRO', 'asset-ZANO', 'asset-KSR', 'asset-ARRR']);
  assert.match(await page.locator('#asset-USDTA').innerText(), /USDT \(Arb\)/);
  assert.match(await page.locator('#asset-ETHA').innerText(), /ETH \(Arb\)/);
  assert.match(await page.locator('#asset-USDTB').innerText(), /USDT \(BNB\)/);
  for (const [id, label] of [['USDCE', 'USDC (Eth)'], ['USDCB', 'USDC (BNB)'], ['USDCS', 'USDC (Sol)'], ['USDCP', 'USDC (Pol)'], ['USDCA', 'USDC (Arb)']]) assert.ok((await page.locator(`#asset-${id}`).innerText()).includes(label), label);
  assert.match(await page.locator('#asset-ETHP').innerText(), /ETH \(Pol\)/);
  assert.match(await page.locator('#asset-USDTE').innerText(), /USDT \(Eth\)/);
  assert.match(await page.locator('#asset-USDT').innerText(), /USDT \(Tron\)/);
  assert.match(await page.locator('#asset-USDTS').innerText(), /USDT \(Sol\)/);
  await page.locator('#asset-TRX .amt', { hasText: '50' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#total').innerText(), '$26.00');
  assert.match(await page.locator('#asset-TRX').innerText(), /\+1\.20%/);
  assert.match(await page.locator('#asset-USDT').innerText(), /\$10\.00/);
  await shot('home');
  assert.deepEqual(await page.locator('.actions .action').allInnerTexts(), ['Send', 'Receive', 'Swap', 'BUY/SELL']);
  // Buy goes straight to LocalCoinSwap with the referral link, no screen in between.
  await page.click('#go-buy');
  await page.getByText(/LocalCoinSwap opened in your browser/).waitFor({ timeout: 15000 });
  assert.deepEqual(fs.readFileSync(externalLog, 'utf8').trim().split('\n'), ['https://localcoinswap.com/']);
  await page.locator('#go-buy').waitFor();


  // Litecoin MWEB: the private balance on the LTC screen, a private receiving address, and making LTC private.
  await page.click('#asset-LTC');
  await page.locator('#mweb-panel', { hasText: 'Private (MWEB): 0 LTC' }).waitFor({ timeout: 30000 });
  await shot('ltc-mweb');
  await page.click('#mweb-pegin');
  await Promise.race([page.locator('#review-amount', { hasText: 'LTC → MWEB' }).waitFor({ timeout: 30000 }), page.locator('#toast', { hasText: /public LTC/ }).waitFor({ timeout: 30000 })]);
  if (await page.locator('#review-amount').count()) await page.click('#back');
  await page.locator('#detail-receive').waitFor();
  await page.click('#detail-receive');
  // The private (MWEB) address comes first; the public one is a tap away.
  await page.locator('#my-address', { hasText: /^ltcmweb1/ }).waitFor({ timeout: 30000 });
  assert.match(await page.locator('.screen').innerText(), /private \(MWEB\) Litecoin address/);
  await page.click('#ltc-address-kind');
  await page.locator('#my-address', { hasText: /^ltc1/ }).waitFor({ timeout: 20000 });
  await page.click('#back');
  await page.locator('#asset-TRX').waitFor();
  await page.click('#asset-TRX');
  await page.click('#back');
  console.log('ok Litecoin MWEB: private balance, private address, make private');

  // Decred: the coin at the first address, and a payment whose signature the stand-in server checks.
  state.dcrFirst = await page.evaluate(() => window.wallet.overview().then((o) => o.addresses.DCR));
  assert.match(state.dcrFirst, /^Ds/);
  await page.click('#asset-DCR');
  await page.locator('#detail-send').waitFor({ timeout: 30000 });
  await page.click('#detail-send');
  await page.fill('#to', 'DsUZxxoHJSty8DCfwfartwTYbuhmVct7tJu');
  await page.fill('#amount', '2');
  await page.click('#review');
  await page.locator('#confirm-send').waitFor({ timeout: 60000 });
  assert.match(await page.locator('#review-fee').innerText(), /0\.0000\d+ DCR/);
  await shot('dcr-review');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-send');
  await page.locator('#sent').waitFor({ timeout: 30000 });
  const dcrTx = state.dcr[0];
  assert.ok(dcrTx.outputs.some((o) => o.value === 200_000_000n), 'the payment, at whichever place');
  assert.equal(dcrTx.inputs[0].value, 12_500_000_000n, 'the coin\'s amount in the witness');
  await page.click('#back');
  await page.locator('#asset-TRX').waitFor();
  console.log('ok Decred: send signed and its signature checked');

  // Solana private pool: set up (with every warning shown), the private balance, and a deposit this wallet can't pay.
  await page.click('#asset-SOL');
  await page.locator('#sol-pool-setup').waitFor({ timeout: 30000 });
  await page.click('#sol-pool-setup');
  const poolWarn = await page.locator('#sol-pool-warnings').innerText();
  for (const w of [/Squads/, /risk lists/, /Amounts and timing/, /smaller than Tornado/, /only 4 participants/]) assert.match(poolWarn, w);
  assert.equal(await page.locator('#sol-pool-enable').isDisabled(), true, 'not until the warnings are agreed to');
  await page.check('#sol-pool-agree');
  await shot('sol-pool-setup');
  await page.click('#sol-pool-enable');
  await page.locator('#sol-pool-balance', { hasText: /Private pool: 0 SOL/ }).waitFor({ timeout: 30000 });
  await shot('sol-pool-panel');
  await page.click('#sol-pool-deposit');
  await page.fill('#sol-pool-amount', '1');
  await page.click('#sol-pool-next');
  await page.locator('.error', { hasText: /Not enough SOL/ }).waitFor({ timeout: 30000 });
  await page.click('#back');
  await page.locator('#sol-pool-panel').waitFor();
  assert.equal(await page.locator('#sol-pool-send').isDisabled(), true, 'nothing to send yet');
  await page.click('#back');
  await page.locator('#asset-TRX').waitFor();
  console.log('ok Solana private pool: warnings, set up, balance, deposit checks');

  if (spark) {
    // Firo Spark: the private balance, a private receiving address, and paying a transparent address from it.
    await page.click('#asset-FIRO');
    await page.locator('#spark-panel', { hasText: 'Private (Spark): 1.5 FIRO' }).waitFor({ timeout: 60000 });
    await shot('firo-spark');
    await page.click('#spark-mint');
    await page.locator('#toast', { hasText: /public FIRO/ }).waitFor({ timeout: 30000 });
    await page.click('#detail-receive');
    // The private (Spark) address comes first; the public one is a tap away.
    await page.locator('#my-address', { hasText: /^sm1/ }).waitFor({ timeout: 30000 });
    await page.click('#firo-address-kind');
    await page.locator('#my-address', { hasText: /^[aZ]/ }).waitFor({ timeout: 20000 });
    await page.click('#firo-address-kind');
    await page.locator('#my-address', { hasText: /^sm1/ }).waitFor({ timeout: 20000 });
    assert.match(await page.locator('.screen').innerText(), /private \(Spark\) Firo address/);
    await page.click('#back');
    await page.locator('#asset-FIRO').waitFor();
    await page.click('#asset-FIRO');
    await page.locator('#detail-send').waitFor();
    await page.click('#detail-send');
    await page.fill('#to', 'a8ULhhDgfdSiXJhSZVdhb8EuDc6R3ogsaM');
    await page.fill('#amount', '0.5');
    await page.click('#review');
    await page.locator('#confirm-send').waitFor({ timeout: 60000 });
    assert.match(await page.locator('.screen').innerText(), /private \(Spark\) balance/);
    await shot('firo-spark-review');
    await page.fill('#confirm-pw', PASSWORD);
    await page.click('#confirm-send');
    await page.locator('#sent').waitFor({ timeout: 30000 });
    assert.equal(spark.state.sent.length, 1, 'the spend went to the Spark server');
    assert.equal(spark.state.sent[0].slice(0, 8), '03000b00');
    await page.click('#back').catch(() => undefined);
    await page.locator('#asset-TRX').waitFor();
    await page.click('#asset-TRX');
    await page.click('#back');
    console.log('ok Firo Spark: private balance, private address, private to public send');
  }
  await page.click('#eye');
  assert.equal(await page.locator('#total').innerText(), '••••');
  await page.click('#eye');
  console.log('ok restore shows balances and USD value from the node');
  const pressShot = async (selector, name) => {
    const box = await page.locator(selector).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await shot(name);
    await page.mouse.move(5, 5);
    await page.mouse.up();
    await page.waitForTimeout(100);
  };
  if (process.env.PRESS_SHOTS) {
    await pressShot('#go-swap', 'press-home-swap');
    await pressShot('#asset-ETH', 'press-home-asset');
    await page.click('#go-swap');
    await page.fill('#swap-amount', '2');
    await page.locator('#swap-next:not([disabled])').waitFor({ timeout: 15000 });
    await pressShot('#swap-next', 'press-swap-next');
    await pressShot('#go-tornado', 'press-swap-tornado');
    console.log('PRESS SHOTS DONE');
    process.exit(0);
  }

  // TRX send. The Decred steps before leave DCR chosen, so TRX is picked first.
  await page.click('#asset-TRX'); await page.click('#back');
  await page.click('#go-send');
  // What can be sent now is shown where the amount is chosen, with the reason for any part that can't.
  await page.locator('#send-available', { hasText: /Available to send/ }).waitFor({ timeout: 30000 });
  await page.locator('#send-fee', { hasText: '$' }).waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#review').evaluate((e) => getComputedStyle(e).webkitTapHighlightColor), 'rgba(0, 0, 0, 0)', 'no blue tap box');
  await shot('send-empty');
  assert.ok(await page.locator('#review').isDisabled(), 'next is disabled while empty');
  await page.fill('#to', '0xabc');
  await page.locator('#amount').pressSequentially('1a2-b.3.4e');
  assert.equal(await page.locator('#amount').inputValue(), '12.34', 'only digits and one point');
  await page.fill('#amount', '');
  await page.locator('#amount').pressSequentially('7,5');
  assert.equal(await page.locator('#amount').inputValue(), '7.5', 'a comma is the decimal point');
  await page.fill('#amount', '1');
  await page.click('#review');
  await page.getByText('Not a Tron address').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#usd-preview').innerText(), '≈ $0.32');
  await page.fill('#to', RECIPIENT);
  await page.fill('#amount', '1000');
  await page.click('#review');
  await page.getByText('Not enough').waitFor({ timeout: 15000 });
  await page.fill('#amount', '1.5');
  await page.click('#review');
  await page.locator('#confirm-send').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#review-amount').innerText(), '1.5 TRX');
  await shot('6-review-trx');
  await page.fill('#confirm-pw', 'wrong password!');
  await page.click('#confirm-send');
  await page.getByText('Wrong password').waitFor({ timeout: 15000 });
  assert.equal(state.broadcast.length, 0, 'nothing broadcast on a wrong password');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-send');
  await page.locator('#sent').waitFor({ timeout: 20000 });
  assert.equal(state.broadcast.length, 1);
  const v = state.broadcast[0].raw_data.contract[0].parameter.value;
  assert.equal(v.amount, 1500000);
  assert.equal(TronWeb.address.fromHex(v.to_address), RECIPIENT);
  assert.equal(TronWeb.address.fromHex(v.owner_address), me.address);
  await shot('7-sent');
  console.log('ok TRX send through the UI, wrong password blocked');

  // USDT send, then too little TRX for the fee
  await page.click('#send-again');
  await page.click('#coin-picker');
  await shot('picker');
  await openFold(page, '#pick-fold-TRX'); // tokens fold under their network
  await page.click('#pick-USDT');
  await page.fill('#to', RECIPIENT);
  await page.fill('#amount', '2');
  await page.click('#review');
  await page.locator('#confirm-send').waitFor({ timeout: 15000 });
  await shot('8-review-usdt');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-send');
  await page.locator('#sent').waitFor({ timeout: 20000 });
  assert.equal(state.broadcast.length, 2);
  assert.equal(BigInt('0x' + state.broadcast[1].raw_data.contract[0].parameter.value.data.slice(72)), 2000000n);
  state.balance = 100;
  await page.click('#send-again');
  await page.fill('#to', RECIPIENT);
  await page.fill('#amount', '2');
  await page.click('#review');
  await page.getByText('Not enough TRX for the fee').waitFor({ timeout: 15000 });
  await shot('9-no-trx');
  state.balance = 50_000_000;
  console.log('ok USDT send through the UI, missing TRX explained before signing');

  // Receive and history
  await page.click('#back');
  await page.click('#go-receive');
  await page.locator('#copy:not([disabled])').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#my-address').innerText(), me.address);
  await shot('10-receive-usdt');
  await page.click('#back');
  await page.click('#tab-history');
  await page.locator('#hist .hist-row').first().waitFor({ timeout: 15000 });
  await shot('11-history');
  await page.click('#tab-assets');
  await page.click('#asset-XMR');
  await page.locator('#node-note').waitFor({ timeout: 15000 });
  await shot('asset-xmr');
  await page.click('#detail-receive');
  await page.locator('#copy:not([disabled])').waitFor({ timeout: 15000 });
  const xmrAddress = await page.locator('#my-address').innerText();
  await page.click('#new-sub');
  await page.locator('.sub-list').waitFor({ timeout: 15000 });
  await shot('12-receive-xmr');
  // ETH: a new address of this wallet, listed with what it holds.
  await page.click('#coin-picker');
  await page.click('#pick-ETH');
  await page.locator('#eth-new').waitFor({ timeout: 15000 });
  const mainEth = await page.locator('#my-address').innerText();
  await page.click('#eth-new');
  await page.locator('#eth-addresses').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => /^0x/.test(document.querySelector('#my-address')?.textContent ?? ''), null, { timeout: 15000 });
  const newEth = await page.locator('#my-address').innerText();
  assert.match(newEth, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(newEth, mainEth);
  const kept = await page.evaluate(() => window.wallet.ethAddresses().then((l) => l.map((x) => x.address)));
  // The stand-in node says every address holds ETH, so the search after the restore listed many already.
  assert.equal(kept.at(-1), newEth, 'kept in the wallet\'s list');
  await shot('12b-receive-eth-new');
  await page.click('#back');
  await page.click('#go-send');
  await page.click('#coin-picker');
  await page.click('#pick-XMR');
  await page.fill('#to', xmrAddress);
  await page.fill('#amount', '1');
  await page.click('#review');
  await page.getByText('finish syncing').waitFor({ timeout: 20000 });
  await shot('13-xmr-offline');
  await page.click('#back');
  console.log('ok receive, history, asset detail, XMR send refused while not synced');


  // Swap
  await page.click('#go-swap');
  await page.locator('#swap-from').waitFor();
  await shot('swap-empty');
  assert.ok(await page.locator('#swap-next').isDisabled());
  await page.click('#swap-from');
  await openFold(page, '#swap-from-fold-TRX'); // tokens fold under their network
  await page.click('#swap-from-USDT');
  await page.click('#swap-to');
  await page.click('#swap-to-XMR');
  // The share buttons fill in part of the balance, exactly.
  const held = (await page.locator('#swap-balance').innerText()).split(' ')[0];
  await page.click('#swap-pct-50');
  const half = await page.inputValue('#swap-amount');
  assert.ok(Math.abs(Number(half) - Number(held) / 2) < 1e-6, `50% of ${held} is ${half}`);
  await page.click('#swap-pct-25');
  const quarter = await page.inputValue('#swap-amount');
  assert.ok(Math.abs(Number(quarter) - Number(held) / 4) < 1e-6, `25% of ${held} is ${quarter}`);
  await page.fill('#swap-amount', '2');
  await page.locator('#swap-receive', { hasText: '0.01' }).waitFor({ timeout: 10000 });
  await page.locator('#swap-next:not([disabled])').waitFor({ timeout: 5000 });
  await shot('swap-quote');
  const beforeSwap = state.broadcast.length;
  await page.click('#swap-next');
  await page.locator('#confirm-swap').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#review-receive').innerText(), '0.01 XMR');
  assert.match(await page.locator('#swap-sees').innerText(), /sees/, 'says what the provider learns');
  assert.equal(await page.locator('#swap-suggest-private').count(), 0, 'XMR on one side: no private swap offered');
  await shot('swap-review');
  assert.equal(state.broadcast.length, beforeSwap, 'nothing sent before confirming');
  assert.equal(state.swapOrder.withdrawalAddress[0], '8', 'XMR arrives at a new mainnet subaddress of this wallet, not the primary address');
  assert.equal(state.swapOrder.refundAddress, me.address);
  await page.fill('#confirm-pw', 'wrong password!');
  await page.click('#confirm-swap');
  await page.getByText('Wrong password').waitFor({ timeout: 15000 });
  assert.equal(state.broadcast.length, beforeSwap, 'wrong password sends nothing');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-swap');
  await page.locator('#swap-status').waitFor({ timeout: 20000 });
  assert.equal(state.broadcast.length, beforeSwap + 1, 'deposit broadcast');
  assert.match(state.broadcast[beforeSwap].raw_data.contract[0].parameter.value.data, /^a9059cbb/, 'USDT transfer to the deposit');
  await page.locator('#swap-status', { hasText: 'Exchanging' }).waitFor({ timeout: 10000 });
  await shot('swap-status');
  await page.click('#back');
  await page.locator('#swap-list .hist-row').first().waitFor({ timeout: 8000 });
  await page.click('#back');
  console.log('ok swap: quote, checked order, password, deposit, status');

  // Comparing services
  await page.evaluate(() => window.wallet.updateSettings({ simpleSwapKey: 'SKEY', ghostSwapKey: 'pub:sec' }));
  assert.equal(await page.locator('#set-simple-key').count(), 0, 'no key fields in settings');
  await page.click('#nav-home');
  await page.click('#go-swap');
  await page.click('#swap-from');
  await openFold(page, '#swap-from-fold-TRX'); // tokens fold under their network
  await page.click('#swap-from-USDT');
  await page.click('#swap-to');
  await page.click('#swap-to-XMR');
  await page.fill('#swap-amount', '2');
  await page.locator('#offer-simpleswap').waitFor({ timeout: 10000 });
  assert.equal(state.simpleKey, 'SKEY');
  assert.equal(state.ghostAuth, 'Bearer pub:sec');
  assert.equal(await page.locator('.swap-offer').count(), 3);
  assert.ok(await page.locator('#offer-ghostswap.on').count(), 'GhostSwap is chosen by default when it has a quote');
  await page.click('#offer-simpleswap');
  await page.locator('#offer-simpleswap.on').waitFor();
  assert.match(await page.locator('#offer-simpleswap').innerText(), /Fee about \$\d/);
  assert.match(await page.locator('#offer-simpleswap').innerText(), /Provider \$[\d.]+ \([\d.]+%\) \+ network \$/);
  assert.match(await page.locator('#swap-network-fee').innerText(), /estimate/);
  // 0.012 XMR at $151.23 is $1.81, less the network fee of 6.5 TRX at $0.32 ($2.08), so nothing is left
  assert.match(await page.locator('#swap-net').innerText(), /After all fees about \$0\.00/);
  assert.match(await page.locator('#offer-simpleswap').innerText(), /After all fees about/);
  await shot('swap-compare');
  await page.click('#offer-exolix');
  await page.locator('#offer-exolix.on').waitFor();
  assert.match(await page.locator('#swap-info').innerText(), /Exolix/);
  await page.click('#offer-simpleswap');
  await page.click('#swap-next');
  await page.locator('#confirm-swap').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#review-receive').innerText(), 'about 0.012 XMR');
  await shot('swap-simpleswap');
  await page.click('#back');
  await page.click('#back');
  await page.evaluate(() => window.wallet.updateSettings({ simpleSwapKey: '', ghostSwapKey: '' }));
  await page.click('#nav-home');
  console.log('ok swap compares services, best rate first, choice respected');

  // Ethereum: ETH send, then USDT(Eth) and its fee rule
  const ETH_TO = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  state.ethWei = 10n ** 18n;
  state.ethUsdt = 5_000_000n;
  await page.click('#go-send');
  await page.click('#coin-picker');
  await page.click('#pick-ETH');
  await page.fill('#to', RECIPIENT);
  await page.fill('#amount', '0.1');
  await page.click('#review');
  await page.getByText('Not an Ethereum address').waitFor({ timeout: 15000 });
  await page.fill('#to', ETH_TO);
  await page.click('#review');
  await page.locator('#confirm-send').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#review-amount').innerText(), '0.1 ETH');
  assert.equal(await page.locator('#review-fee').innerText(), 'about $0.19 (0.000063 ETH)');
  await shot('review-eth');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-send');
  await page.locator('#sent').waitFor({ timeout: 20000 });
  const { Transaction } = require('ethers');
  const ethTx = Transaction.from(state.ethRaw[0]);
  assert.equal(ethTx.to, ETH_TO);
  assert.equal(ethTx.value, 10n ** 17n);
  assert.equal(ethTx.chainId, 1n);
  assert.equal(ethTx.nonce, 7);
  await page.click('#send-again');
  await page.click('#coin-picker');
  await openFold(page, '#pick-fold-ETH'); // tokens fold under their network
  await page.click('#pick-USDTE');
  await page.fill('#to', ETH_TO);
  await page.fill('#amount', '2');
  state.ethWei = 1000n;
  await page.click('#review');
  await page.getByText('Not enough ETH for the fee').waitFor({ timeout: 15000 });
  state.ethWei = 10n ** 18n;
  await page.click('#review');
  await page.locator('#confirm-send').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#review-amount').innerText(), '2 USDT (Eth)');
  await shot('review-usdte');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-send');
  await page.locator('#sent').waitFor({ timeout: 20000 });
  const tokenTx = Transaction.from(state.ethRaw[1]);
  assert.equal(tokenTx.to, '0xdAC17F958D2ee523a2206206994597C13D831ec7');
  assert.equal(tokenTx.value, 0n);
  assert.equal(BigInt('0x' + tokenTx.data.slice(74)), 2_000_000n);
  assert.equal(('0x' + tokenTx.data.slice(34, 74)).toLowerCase(), ETH_TO.toLowerCase());
  await page.click('#send-again');
  await page.click('#back');
  console.log('ok Ethereum: ETH and USDT sends, signed mainnet, fee shortfall explained');


  // Dash
  const dashAddress = await page.evaluate(() => window.wallet.addresses().then((a) => a.DASH));
  assert.match(dashAddress, /^X/);
  state.dashUtxos = [{ address: dashAddress, txid: 'cd'.repeat(32), vout: 0, satoshis: 100000000, confirmations: 5 }];
  await page.click('#go-send');
  await page.click('#coin-picker');
  await page.click('#pick-DASH');
  await page.fill('#to', 'DsUZxxoHJSty8DCfwfartwTYbuhmVct7tJu');
  await page.fill('#amount', '0.25');
  await page.click('#review');
  await page.getByText('Not a Dash address').waitFor({ timeout: 15000 });
  await page.fill('#to', new (require('../dist/main/dash').DashClient)(require('../dist/main/dash').dashAccountXpub('legal winner thank year wave sausage worth useful legal winner thank yellow'), []).addressAt(0, 0));
  await page.click('#review');
  await page.locator('#confirm-send').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#review-amount').innerText(), '0.25 DASH');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-send');
  await page.locator('#sent').waitFor({ timeout: 20000 });
  assert.equal(state.dashRaw.length, 1);
  state.dashUtxos = [];
  await page.click('#send-again');
  await page.click('#back');
  console.log('ok Dash: address, checks, signed send');

  // Dash CoinJoin: regular DASH split into the standard sizes on the CoinJoin account, after a review.
  state.dashUtxos = [{ address: dashAddress, txid: 'ce'.repeat(32), vout: 0, satoshis: 50000000, confirmations: 5 }];
  await page.click('#nav-home');
  await page.click('#asset-DASH');
  await page.locator('#coinjoin-panel #cj-intro').waitFor({ timeout: 20000 });
  await page.click('#cj-mix');
  await page.fill('#cj-amount', '0.3');
  await page.click('#cj-next');
  await page.locator('#confirm-send').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#review-amount').innerText(), '0.29900299 DASH → CoinJoin');
  assert.equal(await page.locator('#review-coins').innerText(), '23', '20 coins of three sizes and 3 collateral coins');
  await shot('coinjoin-review');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-send');
  await page.locator('#coinjoin-panel').waitFor({ timeout: 20000 });
  assert.equal(state.dashRaw.length, 2);
  {
    const btcSigner = require('@scure/btc-signer');
    const NET = { bech32: 'dash', pubKeyHash: 0x4c, scriptHash: 0x10, wif: 0xcc };
    const tx = btcSigner.Transaction.fromRaw(Buffer.from(state.dashRaw[1], 'hex'), { allowLegacyWitnessUtxo: true });
    const outs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i)).map((o) => ({ value: o.amount, address: btcSigner.Address(NET).encode(btcSigner.OutScript.decode(o.script)) }));
    const sizes = outs.map((o) => o.value).filter((v) => [10000100n, 1000010n, 100001n, 40000n].includes(v));
    assert.equal(sizes.length, 23);
    assert.equal(sizes.filter((v) => v === 10000100n).length, 2);
    assert.equal(sizes.filter((v) => v === 40000n).length, 3);
    assert.equal(new Set(outs.map((o) => o.address)).size, outs.length, 'every output on its own address');
    assert.equal(outs.length, 24, 'and change back to the regular balance');
  }
  state.dashUtxos = [];
  await page.click('#back');
  console.log('ok Dash CoinJoin: split into standard sizes on the CoinJoin account');

  // Zcash, shielded: the engine here is a stand-in, the screens and their checks are real.
  const zecOther = 'u1' + 'p'.repeat(150);
  await page.waitForFunction(() => window.wallet.overview().then((o) => o.balances.ZEC && o.balances.ZEC.ok), null, { timeout: 30000 });
  await page.click('#nav-home');
  await page.locator('#asset-ZEC').waitFor({ timeout: 20000 });
  await shot('zec-1-home');
  await page.click('#asset-ZEC');
  await page.locator('#zec-shield').waitFor({ timeout: 20000 });
  await shot('zec-2-detail');
  await page.click('#detail-receive');
  await page.locator('#zec-address-kind').waitFor({ timeout: 20000 });
  assert.match(await page.locator('#my-address').innerText(), /^u1/);
  await shot('zec-3-receive-shielded');
  await page.click('#zec-address-kind');
  await page.waitForFunction(() => document.querySelector('#my-address')?.textContent.startsWith('t1'), null, { timeout: 15000 });
  await page.getByText('public on the chain').waitFor({ timeout: 5000 });
  await shot('zec-4-receive-transparent');
  await page.click('#back');
  await page.click('#asset-ZEC');
  await page.click('#detail-send');
  await page.fill('#to', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  await page.fill('#amount', '0.25');
  await page.click('#review');
  await page.getByText('Not a Zcash address').waitFor({ timeout: 15000 });
  await page.fill('#to', zecOther);
  await page.click('#review');
  await page.locator('#confirm-send').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#review-amount').innerText(), '0.25 ZEC');
  await shot('zec-5-review');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-send');
  await page.locator('#sent').waitFor({ timeout: 20000 });
  await page.click('#send-again');
  await page.click('#back');
  await page.click('#asset-ZEC');
  await page.click('#zec-shield');
  await page.locator('#confirm-shield').waitFor();
  await shot('zec-6-shield');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-shield');
  await page.locator('#zec-rescan').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('#zec-shield'), null, { timeout: 20000 });
  await page.click('#zec-rescan');
  await page.locator('#confirm-rescan').waitFor();
  await shot('zec-7-rescan');
  await page.click('#back');
  await page.click('#back');
  console.log('ok Zcash: receive both kinds, checks, send, shield');

  // Zano: the engine here is a stand-in too
  const zanoOther = 'Zx' + 'D'.repeat(95);
  await page.locator('#asset-ZANO').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#asset-ZANO .amt')?.textContent === '20,000', null, { timeout: 30000 });
  await page.click('#asset-ZANO');
  await shot('zano-1-detail');
  await page.click('#detail-receive');
  await page.waitForFunction(() => document.querySelector('#my-address')?.textContent.startsWith('Zx'), null, { timeout: 15000 });
  await shot('zano-2-receive');
  await page.click('#back');
  await page.click('#asset-ZANO');
  await page.click('#detail-send');
  await page.fill('#to', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  await page.fill('#amount', '1');
  await page.click('#review');
  await page.getByText('Not a Zano address').waitFor({ timeout: 15000 });
  await page.fill('#to', zanoOther);
  await page.click('#review');
  await page.locator('#confirm-send').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#review-amount').innerText(), '1 ZANO');
  await shot('zano-3-review');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-send');
  await page.locator('#sent').waitFor({ timeout: 20000 });
  await page.click('#send-again');
  await page.click('#back');
  console.log('ok Zano: receive, checks, send');

  // Kusari (KSR): Zano's client on its own stand-in engine
  const ksrOther = 'K' + 'D'.repeat(96);
  await page.locator('#asset-KSR').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#asset-KSR .amt')?.textContent === '20,000', null, { timeout: 30000 });
  await page.click('#asset-KSR');
  await shot('ksr-1-detail');
  await page.click('#detail-receive');
  await page.waitForFunction(() => document.querySelector('#my-address')?.textContent.startsWith('K'), null, { timeout: 15000 });
  assert.notEqual(await page.locator('#my-address').innerText(), 'Zx' + 'C'.repeat(95), 'not the Zano address');
  await shot('ksr-2-receive');
  await page.click('#back');
  await page.click('#asset-KSR');
  await page.click('#detail-send');
  await page.fill('#to', 'Zx' + 'D'.repeat(95));
  await page.fill('#amount', '1');
  await page.click('#review');
  await page.getByText('Not a Kusari address').waitFor({ timeout: 15000 });
  await page.fill('#to', ksrOther);
  await page.click('#review');
  await page.locator('#confirm-send').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#review-amount').innerText(), '1 KSR');
  await shot('ksr-3-review');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-send');
  await page.locator('#sent').waitFor({ timeout: 20000 });
  await page.click('#send-again');
  await page.click('#back');
  console.log('ok Kusari: receive, checks, send');

  // Pirate Chain, with a stand-in engine
  await page.locator('#asset-ARRR').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#asset-ARRR .amt')?.textContent === '3', null, { timeout: 30000 });
  await page.click('#asset-ARRR');
  await shot('arrr-1-detail');
  await page.click('#detail-receive');
  await page.waitForFunction(() => document.querySelector('#my-address')?.textContent.startsWith('zs1'), null, { timeout: 15000 });
  await shot('arrr-2-receive');
  await page.click('#back');
  await page.click('#asset-ARRR');
  await page.click('#detail-send');
  await page.fill('#to', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  await page.fill('#amount', '1');
  await page.click('#review');
  await page.getByText('Not a Pirate Chain address').waitFor({ timeout: 15000 });
  await page.fill('#to', 'zs1' + 'p'.repeat(75));
  await page.click('#review');
  await page.locator('#confirm-send').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#review-amount').innerText(), '1 ARRR');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-send');
  await page.locator('#sent').waitFor({ timeout: 20000 });
  await page.click('#send-again');
  await page.click('#back');
  console.log('ok Pirate Chain: receive, checks, send');

  // Same chain: Uniswap is offered next to the swap services, and its review shows the minimum and the fee.
  await page.click('#nav-home');
  await page.click('#go-swap');
  await page.click('#swap-from'); await page.click('#swap-from-ETH');
  await page.click('#swap-to'); await openFold(page, '#swap-to-fold-ETH'); // tokens fold under their network
  await page.click('#swap-to-USDTE');
  await page.fill('#swap-amount', '0.01');
  await page.locator('#offer-uniswap').waitFor({ timeout: 20000 });
  assert.match(await page.locator('#offer-uniswap').innerText(), /on-chain/);
  await page.click('#offer-uniswap');
  await page.locator('#swap-slippage').waitFor();
  await page.click('#swap-next');
  await page.locator('#dex-confirm').waitFor({ timeout: 20000 });
  assert.match(await page.locator('#dex-receive').innerText(), /about 20 USDT/);
  assert.match(await page.locator('#dex-min').innerText(), /19\.9 USDT/);
  assert.equal(state.uniswapAsks.at(-1).swapper, require('../dist/main/eth').deriveEthAccount(MNEMONIC).address, 'asked for this wallet');
  await shot('swap-dex-review');
  await page.click('#back'); // to the swap screen
  await page.locator('#swap-from').waitFor();
  await page.click('#back'); // home
  console.log('ok Uniswap offered for a same-chain pair, review shows the minimum');

  // Swap result to an outside address
  const OUT_BTC = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
  await page.click('#nav-home');
  await page.click('#go-swap');
  await page.click('#swap-from'); await page.click('#swap-from-ETH');
  await page.click('#swap-to'); await page.click('#swap-to-BTC');
  await page.fill('#swap-amount', '0.1');
  await page.fill('#swap-dest', ETH_TO);
  await page.locator('#swap-next:not([disabled])').waitFor({ timeout: 15000 });
  await page.click('#swap-next');
  await page.getByText('not a BTC address').waitFor({ timeout: 15000 });
  await page.fill('#swap-dest', OUT_BTC);
  await page.click('#swap-next');
  await page.locator('#confirm-swap').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#review-receive-address').innerText(), OUT_BTC);
  assert.equal(await page.locator('#review-external').count(), 1);
  assert.equal(await page.locator('#swap-suggest-private').count(), 1, 'ETH to BTC: the private swap through XMR is offered');
  await page.locator('#swap-sees').scrollIntoViewIfNeeded();
  await shot('swap-sees-private-offer');
  assert.equal(state.swapOrder.withdrawalAddress, OUT_BTC);
  await shot('swap-external');
  await page.click('#back');

  // Privacy swap, first step
  await page.locator('#swap-privacy').waitFor();
  await page.locator('#swap-privacy').check();
  await page.fill('#swap-dest', ETH_TO);
  await page.locator('#swap-privacy:checked').waitFor();
  await page.fill('#swap-amount', '0.1');
  await page.fill('#swap-dest', OUT_BTC);
  await page.locator('#swap-next:not([disabled])').waitFor({ timeout: 15000 });
  await shot('privacy-form');
  await page.click('#swap-next');
  await page.locator('#confirm-swap').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#review-final-address').innerText(), OUT_BTC);
  assert.match(state.swapOrder.withdrawalAddress, /^8/, 'first step pays a fresh XMR subaddress');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-swap');
  await page.locator('#privacy-stage').waitFor({ timeout: 20000 });
  assert.match(await page.locator('#privacy-stage').innerText(), /Step 1/);
  await shot('privacy-status');
  await page.click('#back');
  await page.locator('.swap-history').first().waitFor({ timeout: 10000 });
  assert.match(await page.locator('#swap-list').innerText(), /Privacy swaps in progress/);
  await page.click('#back');
  console.log('ok swap to an outside address; privacy swap first step, status, resume list');

  // Tornado screen
  await page.click('#nav-home');
  await page.click('#go-swap');
  await page.click('#go-tornado');
  await page.locator('#tornado-engine', { hasText: 'Ready' }).waitFor({ timeout: 30000 });
  await page.locator('#tornado-empty').waitFor();
  await shot('tornado-home');
  state.ethRaw = [];
  await page.click('#pool-0');
  await page.locator('#confirm-deposit').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#review-amount').innerText(), '0.1 ETH');
  await page.fill('#confirm-pw', PASSWORD);
  await page.click('#confirm-deposit');
  await page.locator('#tornado-notes').waitFor({ timeout: 30000 });
  const depositTx = require('ethers').Transaction.from(state.ethRaw[0]);
  assert.equal(depositTx.to, '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc');
  assert.equal(depositTx.value, 10n ** 17n);
  assert.equal(depositTx.data.slice(0, 10), '0xb214faa5', 'deposit(bytes32)');
  await shot('tornado-note');
  await page.click('#backup-0');
  await page.fill('#backup-pw', PASSWORD);
  await page.click('#backup-show');
  await page.locator('#backup-note', { hasText: 'tornado-eth-0.1-1-0x' }).waitFor({ timeout: 15000 });
  await page.click('#back');
  await page.locator('#withdraw-0').waitFor({ timeout: 10000 });
  await page.click('#withdraw-0');
  // New address and automatic relayer by default; this test turns both off to try a direct withdrawal.
  assert.equal(await page.isChecked('#tornado-fresh'), true);
  assert.equal(await page.isChecked('#tornado-auto-relayer'), true);
  await shot('tornado-withdraw-form');
  await page.uncheck('#tornado-fresh');
  await page.uncheck('#tornado-auto-relayer');
  await page.fill('#tornado-to', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  await page.fill('#tornado-relayer', '');
  await page.click('#tornado-next');
  await page.locator('#tornado-self-warn').waitFor({ timeout: 15000 });
  assert.ok(await page.locator('#tornado-warn-0', { hasText: 'less than a day' }).count(), 'a fresh deposit is called too soon');
  assert.equal(await page.locator('#tornado-when option').count(), 1, 'without a relayer, only now');
  await shot('tornado-withdraw');
  await page.click('#back');
  await page.click('#back');
  await page.click('#back');
  await page.click('#back');
  state.ethWei = 0n; state.ethUsdt = 0n;
  console.log('ok Tornado screen: engine, deposit tx, note backup, direct withdraw warning');

  // Several wallets: rename, give up on adding, add one, switch back, delete it
  const firstEth = await page.evaluate(() => window.wallet.addresses().then((a) => a.ETH));
  await page.click('#wallet-switch');
  await page.click('#rename-main');
  await page.fill('#wallet-rename-input', 'Savings');
  await page.click('#wallet-rename-save');
  await page.locator('#wallet-main', { hasText: 'Savings' }).waitFor();
  await page.fill('#wallet-new-name', 'Second wallet');
  await page.click('#wallet-add');
  await page.getByText('Get started').waitFor({ timeout: 20000 });
  await page.locator('#wallet-add-cancel:visible').waitFor();
  await page.click('#wallet-add-cancel');
  await page.locator('#unlock').waitFor({ timeout: 15000 });
  await page.locator('#unlock-name', { hasText: 'Savings' }).waitFor();
  await shot('unlock-named');
  await page.click('#unlock-wallets');
  await page.locator('#wallet-list').waitFor();
  assert.equal(await page.locator('.wallet-row').count(), 1, 'giving up left nothing');
  await page.fill('#wallet-new-name', 'Second wallet');
  await page.click('#wallet-add');
  await page.getByText('Restore from seeds').click();
  await page.fill('#tron-seed', 'legal winner thank year wave sausage worth useful legal winner thank yellow');
  await page.fill('#xmr-seed', xmrSeed.join(' '));
  await page.fill('#pw', 'second wallet password');
  await page.fill('#pw2', 'second wallet password');
  if (await page.locator('#terms-agree').count() && !(await page.isChecked('#terms-agree'))) await page.check('#terms-agree');
  await page.click('#next');
  await page.locator('#wallet-name', { hasText: 'Second wallet' }).waitFor({ timeout: 90000 });
  const secondEth = await page.evaluate(() => window.wallet.addresses().then((a) => a.ETH));
  assert.notEqual(secondEth, firstEth, 'a different wallet');
  // No dApps, no perps, no HyperCore moves, and Tor is there in every wallet.
  assert.equal(await page.locator('#go-dapps, #nav-perps').count(), 0);
  assert.deepEqual(await page.evaluate(() => ['walletMode', 'setWalletMode', 'wcInfo', 'wcPair', 'hypeCore', 'perpsInfo'].map((m) => typeof window.wallet[m])), Array(6).fill('undefined'));
  await page.click('#asset-BNB');
  assert.equal(await page.locator('#hype-core').count(), 0);
  await page.click('#back');
  await page.click('#open-settings');
  await page.locator('#set-tor').waitFor();
  await page.click('#nav-home');
  await page.click('#wallet-switch');
  await shot('wallets');
  assert.equal(await page.locator('.wallet-row').count(), 2);
  await page.click('#wallet-main');
  await page.locator('#unlock').waitFor({ timeout: 20000 });
  await page.fill('#pw', 'second wallet password');
  await page.click('#unlock');
  await page.getByText('Wrong password').waitFor({ timeout: 30000 });
  await page.fill('#pw', PASSWORD);
  await page.click('#unlock');
  await page.locator('#wallet-name', { hasText: 'Savings' }).waitFor({ timeout: 90000 });
  assert.equal(await page.evaluate(() => window.wallet.addresses().then((a) => a.ETH)), firstEth);
  assert.equal(await page.locator('#nav-perps').count(), 0, 'no perps');
  assert.equal(await page.evaluate(() => typeof window.wallet.perpsInfo), 'undefined', 'and nothing behind it');
  console.log('ok wallets: rename, cancel, add, switch, each with its own password and addresses');

  // Skipping the seed backup: warned once, wallet made, seed still readable later
  await page.click('#wallet-switch');
  await page.fill('#wallet-new-name', 'Third');
  await page.click('#wallet-add');
  await page.getByText('Create a new wallet').click();
  await page.fill('#pw', 'third wallet password');
  await page.fill('#pw2', 'third wallet password');
  if (await page.locator('#terms-agree').count() && !(await page.isChecked('#terms-agree'))) await page.check('#terms-agree');
  await page.click('#next');
  await page.locator('#skip-backup').waitFor({ timeout: 60000 });
  await page.click('#skip-backup');
  await page.locator('#skip-warning').waitFor();
  await shot('skip-backup');
  await page.click('#skip-back');
  await page.getByText('Write both seed phrases on paper').waitFor();
  await page.click('#skip-backup');
  await page.click('#skip-confirm');
  await page.locator('#wallet-name', { hasText: 'Third' }).waitFor({ timeout: 90000 });
  const skipped = await page.evaluate(() => window.wallet.revealSeeds('third wallet password'));
  assert.equal(skipped.tronMnemonic.split(' ').length, 12, 'the seed is still there to back up');
  assert.equal(skipped.moneroSeed.split(' ').length, 25);
  await page.click('#open-settings');
  await page.fill('#del-pw', 'third wallet password');
  await page.click('#delete');
  await page.locator('#unlock').waitFor({ timeout: 30000 });
  await page.fill('#pw', PASSWORD);
  await page.click('#unlock');
  await page.locator('#wallet-name', { hasText: 'Savings' }).waitFor({ timeout: 90000 });
  console.log('ok seed backup can be skipped after a warning, seed stays readable');


  // QR scan parsing
  const tronAddr = RECIPIENT;
  const parseCases = await page.evaluate((a) => {
    const xmr = '4' + 'A'.repeat(94);
    return {
      bare: parseScanned('TRX', a), link: parseScanned('USDT', `tron:${a}?amount=2.5`), slashes: parseScanned('TRX', `tron://${a}`),
      badAmount: parseScanned('TRX', `tron:${a}?amount=1e9`).amount, xmrLink: parseScanned('XMR', `monero:${xmr}?tx_amount=1.25`).amount,
      wrongChain: parseScanned('XMR', a), wrongScheme: parseScanned('TRX', `monero:${a}`), eth: parseScanned('USDT', '0x' + 'a'.repeat(40)), junk: parseScanned('TRX', 'https://evil.example/' + a),
    };
  }, tronAddr);
  assert.equal(parseCases.bare.address, tronAddr);
  assert.deepEqual(parseCases.link, { address: tronAddr, amount: '2.5' });
  assert.equal(parseCases.slashes.address, tronAddr);
  assert.equal(parseCases.badAmount, '');
  assert.equal(parseCases.xmrLink, '1.25');
  for (const k of ['wrongChain', 'wrongScheme', 'eth', 'junk']) assert.equal(parseCases[k], null, k);

  // Real camera path with a fake video showing tron:<address>?amount=2.5
  await page.click('#go-send');
  await page.click('#coin-picker');
  await page.click('#pick-XMR');
  await page.click('#scan');
  await page.getByText('not a Monero address QR').waitFor({ timeout: 20000 });
  await shot('scan-wrong');
  assert.equal(await page.inputValue('#to'), '', 'wrong coin fills nothing');
  await page.click('#scan-close');
  assert.equal(await page.locator('#scanner').count(), 0);
  await page.click('#coin-picker');
  await page.click('#pick-TRX');
  await page.click('#scan');
  await page.locator('#scanner').waitFor({ state: 'detached', timeout: 20000 });
  assert.equal(await page.inputValue('#to'), tronAddr, 'address filled from the camera');
  assert.equal(await page.inputValue('#amount'), '2.5');
  assert.equal(await page.locator('#confirm-send').count(), 0, 'scanning never skips the review step');
  await shot('scan-filled');
  await page.click('#back');
  console.log('ok QR scan: wrong coin refused, address and amount filled, no automatic send');

  // Lock, restart, unlock
  await page.click('#lock');
  await page.locator('#unlock').waitFor({ timeout: 15000 });
  await shot('14-locked');
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await sized(500, 880);
  await page.locator('#unlock').waitFor({ timeout: 15000 });
  await page.fill('#pw', PASSWORD);
  await page.click('#unlock');
  await page.locator('#asset-TRX .amt', { hasText: '50' }).waitFor({ timeout: 30000 });
  console.log('ok lock, restart, unlock');

  // Tor mode
  assert.equal(socks.log.length, 0, 'nothing uses the proxy while Tor is off');
  await page.click('#open-settings');
  await page.locator('#set-tor').waitFor();
  assert.equal(await page.locator('#set-net').count(), 0, 'no network setting');
  await shot('tor-settings-off');
  await page.check('#set-tor');
  await page.click('#save-settings');
  await page.locator('#unlock').waitFor({ timeout: 20000 });
  await page.fill('#pw', PASSWORD);
  await page.click('#unlock');
  await page.locator('#asset-TRX .amt', { hasText: '50' }).waitFor({ timeout: 40000 });
  await page.getByText('Tor connected').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  await shot('tor-home');
  const mark = socks.log.length;
  assert.ok(mark > 0, 'wallet traffic goes through the proxy');
  assert.ok(socks.log.some((d) => d.host.endsWith('.onion')), 'XMR tries onion nodes');
  assert.ok(!socks.log.some((d) => /sethforprivacy|monerodevs/.test(d.host)), 'no clearnet XMR nodes');
  await new Promise((r) => setTimeout(r, 200));
  const afterTor = connectionsToNode.slice(-3);
  for (const p of afterTor) assert.ok(socks.outboundPorts.has(p), `direct connection to the Tron node from ${p}`);
  console.log('ok Tor on: Tron and price traffic through the proxy, XMR uses onion nodes');

  // How Tor connects: automatic by default, own bridge lines checked, a change doesn't lock the wallet.
  await page.click('#open-settings');
  await page.locator('#set-tor-bridge').waitFor();
  assert.equal(await page.locator('#set-tor-bridge').inputValue(), 'auto');
  assert.match(await page.locator('#tor-bridge-note').innerText(), /Snowflake.*slower/);
  assert.ok(await page.locator('#set-tor-bridge-lines-row').isHidden());
  await page.selectOption('#set-tor-bridge', 'custom');
  await page.locator('#set-tor-bridge-lines').waitFor();
  await page.fill('#set-tor-bridge-lines', 'obfs4 bridge.example:443 AAAA');
  await page.click('#save-settings');
  await page.getByText(/Bridge line 1 isn't one this wallet can use/).waitFor({ timeout: 10000 });
  await shot('tor-bridges-error');
  await page.selectOption('#set-tor-bridge', 'snowflake');
  await page.click('#save-settings');
  await page.getByText('Saved.').waitFor({ timeout: 10000 });
  assert.equal((await page.evaluate(() => window.wallet.getSettings())).torBridge, 'snowflake');
  assert.equal(await page.locator('#unlock').count(), 0, 'still unlocked');
  await page.selectOption('#set-tor-bridge', 'auto');
  await page.click('#save-settings');
  await page.getByText('Saved.').waitFor({ timeout: 10000 });
  await page.click('#nav-home');
  console.log('ok Tor connection method: automatic by default, own bridges checked, no lock on change');

  // Sent screen must not open a browser in Tor mode
  await page.click('#tab-history');
  await page.locator('#hist .hist-row').first().click();
  await page.locator('#toast').waitFor({ timeout: 5000 });
  await shot('tor-explorer-copied');
  await page.click('#tab-assets');

  // Bitcoin coin control: freeze one coin, label another, spend exactly the chosen coin.
  {
    const { BtcClient: Btc, btcAccountXpub } = require('../dist/main/btc');
    const mineBtc = new Btc(btcAccountXpub(MNEMONIC), []).addressAt(0, 0);
    const A = 'ab'.repeat(32), C = 'cd'.repeat(32);
    state.btcCoins = { [mineBtc]: [{ txid: A, vout: 0, value: 500000, status: { confirmed: true } }, { txid: C, vout: 2, value: 300000, status: { confirmed: true } }] };
    await page.click('#asset-BTC');
    await page.click('#detail-send');
    await page.click('#coin-control');
    await page.locator('.coin-row').nth(1).waitFor({ timeout: 30000 });
    assert.match(await page.locator('.coin-row').first().innerText(), /0\.005 BTC/, 'largest first');
    await page.locator('.coin-row').first().locator('.coin-freeze').click();
    await page.locator('.coin-row.frozen').waitFor({ timeout: 15000 });
    await page.locator('.coin-row').nth(1).locator('.coin-label').fill('from the exchange');
    await page.locator('.coin-row').nth(1).locator('.coin-label').press('Tab');
    await page.locator(`.coin-pick[data-coin="${C}:2"]`).check();
    await page.locator('#coin-summary', { hasText: 'Chosen: 1, 0.003 BTC' }).waitFor();
    await shot('btc-coin-control');
    await page.fill('#to', 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
    await page.click('#max');
    await page.click('#review');
    await page.locator('#review-amount').waitFor({ timeout: 30000 });
    assert.match(await page.locator('#review-amount').innerText(), /0\.0029/, 'max is all of the chosen coin, less the fee');
    const notes = JSON.parse(fs.readFileSync(fs.readdirSync(data, { recursive: true }).map((f) => path.join(data, f)).find((f) => f.endsWith('btc-coins.json')), 'utf8'));
    // Kept on the device encrypted: neither the label nor the coin shows in the file.
    assert.equal(notes.sealed, 1);
    assert.doesNotMatch(JSON.stringify(notes), /exchange|abab/);
    await page.click('#back');
    await page.click('#back');
    await page.locator('#asset-TRX').waitFor();
    await page.click('#asset-TRX');
    await page.click('#back');
    console.log('ok Bitcoin coin control: freeze, label, spend only the chosen coin');

    // CoinJoin: mix the coins that aren't frozen through the stand-in coordinator, over Tor.
    const { mockCoordinator } = require('./mock-wabisabi');
    await page.click('#asset-BTC');
    await page.locator('#btc-coinjoin-panel #btc-cj-intro').waitFor({ timeout: 30000 });
    await page.click('#btc-cj-mix');
    await page.locator('#btc-cj-count', { hasText: '1' }).waitFor({ timeout: 30000 });
    assert.match(await page.locator('#btc-cj-amount').innerText(), /0\.003 BTC/, 'the frozen coin is left out');
    await shot('btc-coinjoin-start');
    await page.fill('#confirm-pw', 'wrong password');
    await page.click('#btc-cj-start');
    await page.locator('.error', { hasText: /password/i }).waitFor({ timeout: 30000 });
    const bs = require('@scure/btc-signer');
    cjCoord = mockCoordinator({ utxos: new Map([[`${C}:2`, { value: 300000n, script: bs.OutScript.encode(bs.Address().decode(mineBtc)) }]]), expectInputs: 1, others: 5, inputRegMs: 5000 });
    await page.fill('#confirm-pw', PASSWORD);
    await page.click('#btc-cj-start');
    await page.locator('#btc-cj-stop').waitFor({ timeout: 30000 });
    await page.locator('#btc-cj-step', { hasText: /Mixing finished|last round finished|go round again/ }).waitFor({ timeout: 150000 });
    assert.equal(cjCoord.state.witnesses.size, 1, 'the coin was signed into the coinjoin');
    assert.ok(!cjCoord.state.identities.includes('ua-sent'), 'no request carried a user agent');
    assert.ok(socks.log.filter((d) => d.port === cjServer.address().port).length >= 5, 'the requests went through Tor');
    const routes = new Set(socks.log.filter((d) => d.port === cjServer.address().port).map((d) => d.user));
    assert.ok(routes.size >= 4, 'on separate Tor routes');
    await shot('btc-coinjoin-done');
    await page.click('#back');
    await page.locator('#asset-TRX').waitFor();
    console.log('ok Bitcoin CoinJoin: frozen coin left out, wrong password refused, a round mixed over separate Tor routes');
  }

  // Kill switch
  const before = connectionsToNode.length;
  await socks.close();
  await page.click('#refresh');
  assert.match(await page.getAttribute('#refresh', 'class'), /spinning/, 'the arrow turns while refreshing');
  await page.waitForFunction(() => !document.querySelector('#refresh')?.classList.contains('spinning'), null, { timeout: 60000 });
  await page.locator('#asset-TRX', { hasText: /Lookup failed|recent value/ }).waitFor({ timeout: 70000 });
  await shot('tor-lost');
  await page.waitForTimeout(1000);
  assert.equal(connectionsToNode.length, before, 'nothing reaches the node once Tor is gone');
  console.log('ok Tor lost: balances fail, no direct connection');

  // Language
  await page.click('#open-settings');
  await page.locator('#set-language').waitFor();
  assert.deepEqual(await page.locator('#set-language option').evaluateAll((o) => o.map((e) => e.value)), ['en', 'ko', 'ja', 'zh-CN', 'vi', 'pt', 'tr', 'uk', 'ru']);
  assert.equal(await page.locator('#set-language').inputValue(), 'en');
  await page.selectOption('#set-language', 'ko');
  await page.locator('#open-settings', { hasText: '설정' }).waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#set-language option[value="ru"]').innerText(), 'Русский', 'language names stay in their own language');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'ko');
  await shot('settings-ko');
  // The private Bitcoin sync switch (on for this new wallet) and the duress password, translated.
  assert.equal(await page.locator('#set-btc-filters').isChecked(), false, 'a restored wallet keeps asking servers until switched');
  assert.equal(await page.locator('#set-btc-filters-from-row').isVisible(), false);
  await page.locator('#set-btc-filters').check();
  assert.equal(await page.locator('#set-btc-filters-from-row').isVisible(), true, 'switching on asks for the date to scan from');
  await page.locator('#set-btc-filters').scrollIntoViewIfNeeded();
  await shot('settings-btc-sync-ko');
  await page.locator('#duress-section').scrollIntoViewIfNeeded();
  assert.match(await page.locator('#duress-section h3').innerText(), /긴급 비밀번호/);
  await shot('settings-duress-ko');
  await page.locator('#set-btc-filters').uncheck();
  // Filled-in text, and a reason inside a longer message.
  const said = await page.evaluate(() => {
    const el = document.createElement('p');
    el.id = 'language-probe';
    document.body.append(el);
    el.textContent = 'Not enough ETH for the fee. Up to 0.25 ETH is needed, and there is 0.1 ETH.';
    return new Promise((r) => setTimeout(() => {
      const first = el.textContent;
      el.textContent = 'The provider\'s answer differs from the request, so this was stopped: the send amount differs. No coins have left your wallet.';
      setTimeout(() => {
        const second = el.textContent;
        el.textContent = 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC';
        setTimeout(() => { const third = el.textContent; el.remove(); r([first, second, third]); }, 50);
      }, 50);
    }, 50));
  });
  assert.equal(said[0], '수수료로 낼 ETH가 부족합니다. 최대 0.25 ETH가 필요하고 0.1 ETH가 있습니다.');
  assert.equal(said[1], '업체의 응답이 요청과 달라 중단했습니다: 보내는 금액이 다름. 지갑에서 코인이 나가지 않았습니다.');
  assert.equal(said[2], 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC', 'addresses are left alone');
  for (const code of ['ru', 'uk', 'ja', 'zh-CN', 'vi', 'pt', 'tr']) {
    await page.selectOption('#set-language', code);
    await page.waitForTimeout(100);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(`settings-${code}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${code} doesn't push the page sideways`);
  }
  await page.selectOption('#set-language', 'en');
  await page.locator('#open-settings', { hasText: 'Settings' }).waitFor({ timeout: 5000 });
  await page.click('#nav-home');
  console.log('ok language: switches live, fills gaps, leaves addresses, comes back to English');

  // A wide window: the menu moves to the side, holdings show as cards, settings get an index.
  await sized(1280, 820);
  await page.waitForTimeout(400);
  await page.click('#side-home');
  await page.locator('.side #side-home.on').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.nav').isVisible(), false, 'no bottom menu on a wide window');
  assert.equal(await page.locator('#go-send').isVisible(), false, 'the side menu has Send; the home page gives the room to the total');
  await page.locator('#holdings .holding').first().waitFor({ timeout: 10000 });
  await shot('desk-home');
  await page.click('#side-settings');
  await page.locator('#settings-index button').first().waitFor({ timeout: 10000 });
  assert.ok((await page.locator('#settings-index button').count()) > 8, 'every section listed');
  await page.locator('#settings-index button', { hasText: 'Support the developer' }).click();
  await shot('desk-settings');
  await page.click('#side-receive');
  await page.locator('#my-address').waitFor({ timeout: 10000 });
  await shot('desk-receive');
  await page.click('#side-send');
  await page.locator('#to').waitFor({ timeout: 10000 });
  await shot('desk-send');
  for (const id of ['#side-home', '#side-history']) {
    await page.click(id);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, 'nothing pushes the wide page sideways');
  }
  await shot('desk-history');
  await sized(500, 880);
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.side').isVisible(), false, 'narrow again: the side menu goes');
  console.log('ok wide window: side menu, holdings, settings index');

  const raw = fs.readFileSync(path.join(data, 'vault.json'), 'utf8');
  assert.ok(!raw.includes('abandon'), 'seed is not stored in plaintext');
  console.log('page errors:', JSON.stringify(errors).slice(0,800)); assert.deepEqual(errors, [], 'no page errors');
  await app.close();
  server.close();
  solPool.server.close();
  fs.rmSync(data, { recursive: true, force: true });
  console.log('ALL PASSED; screenshots in', shots);
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
