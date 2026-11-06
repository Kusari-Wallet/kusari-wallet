// Drives the real Electron app: restore, balances, TRX and USDT sends against a mock Tron node.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { mockNode, MNEMONIC, RECIPIENT, me } = require('./mock-tron');
const { TronWeb } = require('tronweb');
const { mockSocks } = require('./mock-socks');


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
  const camVideo = path.join(os.tmpdir(), `vw-cam-${process.pid}.y4m`);
  qrVideo(`tron:${RECIPIENT}?amount=2.5`, camVideo);
  const socks = await mockSocks();
  const connectionsToNode = [];
  server.on('connection', (c) => connectionsToNode.push(c.remotePort));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-ui-'));
  const launch = () => _electron.launch({
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camVideo}`, path.join(__dirname, '..')],
    env: { ...process.env, VAULT_WALLET_DATA: data, VAULT_DEV_TRON_HOST: `http://127.0.0.1:${server.address().port}`, VAULT_DEV_SOCKS: socks.uri, VAULT_DEV_BTC_API: `http://127.0.0.1:${server.address().port}/btc`, VAULT_DEV_TORNADO: JSON.stringify({ 0.1: '0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc', 1: '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936' }), VAULT_DEV_DASH_API: `http://127.0.0.1:${server.address().port}/dash`, VAULT_DEV_SOL_RPC: `http://127.0.0.1:${server.address().port}/sol`, VAULT_DEV_DOGE_API: `http://127.0.0.1:${server.address().port}/doge`, VAULT_DEV_FIRO_API: `http://127.0.0.1:${server.address().port}/dash-firo`, VAULT_DEV_ZEC_BIN: path.join(__dirname, 'fake-zec-engine.js'), VAULT_DEV_ZANO_BIN: path.join(__dirname, 'fake-zano-engine.js'), VAULT_DEV_ARRR_BIN: path.join(__dirname, 'fake-arrr-engine.js'), VAULT_DEV_ETH_RPC: `http://127.0.0.1:${server.address().port}/eth/rpc`, VAULT_DEV_ETH_SCOUT: `http://127.0.0.1:${server.address().port}/eth/scout`, VAULT_DEV_SIMPLESWAP_BASE: `http://127.0.0.1:${server.address().port}/simple`, VAULT_DEV_GHOSTSWAP_BASE: `http://127.0.0.1:${server.address().port}/ghost`, VAULT_DEV_SWAP_BASE: `http://127.0.0.1:${server.address().port}/swap`, VAULT_DEV_PRICE_URL: `http://127.0.0.1:${server.address().port}/simple/price`, NO_PROXY: '*' },
  });
  let app = await launch();
  let page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  
  // create flow up to the seed screen
  await page.locator('#splash img').waitFor({ timeout: 800 }).catch(() => {});
  await shot('0-splash');
  await page.getByText('Get started').waitFor();
  assert.equal(await page.locator('.entry-logo').count(), 1, 'logo on the welcome screen');
  assert.equal(await page.locator('.entry .coin').count(), 0, 'coin images removed from entry');
  assert.equal(await page.locator('#net').count(), 0, 'no network choice');
  assert.equal(await page.getByText('testnet').count(), 0, 'no testnet wording');
  await shot('1-welcome');
  await page.getByText('Create a new wallet').click();
  await page.fill('#pw', PASSWORD);
  await page.fill('#pw2', 'different password');
  await page.click('#next');
  await page.getByText('The two passwords do not match').waitFor();
  await page.fill('#pw2', PASSWORD);
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
  await page.fill('#seed-pw', 'wrong password!');
  await page.click('#reveal');
  await page.getByText('Wrong password').waitFor({ timeout: 15000 });
  await page.fill('#seed-pw', PASSWORD);
  await page.click('#reveal');
  await page.locator('.seed').first().waitFor({ timeout: 15000 });
  const revealed = (await page.locator('.seed').nth(0).locator('li').allInnerTexts()).map((t) => t.split('\n').pop().trim());
  assert.deepEqual(revealed, tronSeed, 'revealed seed equals generated seed');
  await shot('5-settings');
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
  await page.click('#next');
  await page.getByText('restore point').waitFor({ timeout: 30000 });
  await page.fill('#from', '');
  await page.click('#next');
  await page.locator('#asset-USDT').waitFor({ timeout: 90000 });
  assert.deepEqual(await page.locator('.asset').evaluateAll((els) => els.map((e) => e.id)), ['asset-XMR', 'asset-BTC', 'asset-ETH', 'asset-TRX', 'asset-USDTE', 'asset-USDT', 'asset-SOL', 'asset-DOGE', 'asset-DASH', 'asset-FIRO', 'asset-ZEC', 'asset-ZANO', 'asset-ARRR']);
  assert.match(await page.locator('#asset-USDTE').innerText(), /USDT \(Eth\)/);
  assert.match(await page.locator('#asset-USDT').innerText(), /USDT \(Tron\)/);
  await page.locator('#asset-TRX .amt', { hasText: '50' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#total').innerText(), '$26.00');
  assert.match(await page.locator('#asset-TRX').innerText(), /\+1\.20%/);
  assert.match(await page.locator('#asset-USDT').innerText(), /\$10\.00/);
  await shot('home');
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

  // TRX send
  await page.click('#go-send');
  await page.locator('#send-fee', { hasText: '$' }).waitFor({ timeout: 15000 });
  assert.equal(await page.locator('#review').evaluate((e) => getComputedStyle(e).webkitTapHighlightColor), 'rgba(0, 0, 0, 0)', 'no blue tap box');
  await shot('send-empty');
  assert.ok(await page.locator('#review').isDisabled(), 'next is disabled while empty');
  await page.fill('#to', '0xabc');
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
  await page.click('#swap-from-USDT');
  await page.click('#swap-to');
  await page.click('#swap-to-XMR');
  await page.fill('#swap-amount', '2');
  await page.locator('#swap-receive', { hasText: '0.01' }).waitFor({ timeout: 10000 });
  await page.locator('#swap-next:not([disabled])').waitFor({ timeout: 5000 });
  await shot('swap-quote');
  const beforeSwap = state.broadcast.length;
  await page.click('#swap-next');
  await page.locator('#confirm-swap').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('#review-receive').innerText(), '0.01 XMR');
  await shot('swap-review');
  assert.equal(state.broadcast.length, beforeSwap, 'nothing sent before confirming');
  assert.equal(state.swapOrder.withdrawalAddress[0], '4', 'XMR arrives at my mainnet address');
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
  await page.click('#swap-from-USDT');
  await page.click('#swap-to');
  await page.click('#swap-to-XMR');
  await page.fill('#swap-amount', '2');
  await page.locator('#offer-simpleswap').waitFor({ timeout: 10000 });
  assert.equal(state.simpleKey, 'SKEY');
  assert.equal(state.ghostAuth, 'Bearer pub:sec');
  assert.equal(await page.locator('.swap-offer').count(), 3);
  assert.ok(await page.locator('#offer-simpleswap.on').count(), 'best rate is chosen');
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
  await page.waitForFunction(() => document.querySelector('#asset-ZANO .amt')?.textContent === '20000', null, { timeout: 30000 });
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
  await page.fill('#tornado-to', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  await page.click('#tornado-next');
  await page.locator('#tornado-self-warn').waitFor({ timeout: 15000 });
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
  await page.click('#next');
  await page.locator('#wallet-name', { hasText: 'Second wallet' }).waitFor({ timeout: 90000 });
  const secondEth = await page.evaluate(() => window.wallet.addresses().then((a) => a.ETH));
  assert.notEqual(secondEth, firstEth, 'a different wallet');
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
  console.log('ok wallets: rename, cancel, add, switch, each with its own password and addresses');

  // Skipping the seed backup: warned once, wallet made, seed still readable later
  await page.click('#wallet-switch');
  await page.fill('#wallet-new-name', 'Third');
  await page.click('#wallet-add');
  await page.getByText('Create a new wallet').click();
  await page.fill('#pw', 'third wallet password');
  await page.fill('#pw2', 'third wallet password');
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
  assert.ok(!socks.log.some((d) => /sethforprivacy|cakewallet|monerodevs/.test(d.host)), 'no clearnet XMR nodes');
  await new Promise((r) => setTimeout(r, 200));
  const afterTor = connectionsToNode.slice(-3);
  for (const p of afterTor) assert.ok(socks.outboundPorts.has(p), `direct connection to the Tron node from ${p}`);
  console.log('ok Tor on: Tron and price traffic through the proxy, XMR uses onion nodes');

  // Sent screen must not open a browser in Tor mode
  await page.click('#tab-history');
  await page.locator('#hist .hist-row').first().click();
  await page.locator('#toast').waitFor({ timeout: 5000 });
  await shot('tor-explorer-copied');
  await page.click('#tab-assets');

  // Kill switch
  const before = connectionsToNode.length;
  await socks.close();
  await page.click('#refresh');
  await page.locator('#asset-TRX', { hasText: /Lookup failed|recent value/ }).waitFor({ timeout: 70000 });
  await shot('tor-lost');
  await page.waitForTimeout(1000);
  assert.equal(connectionsToNode.length, before, 'nothing reaches the node once Tor is gone');
  console.log('ok Tor lost: balances fail, no direct connection');

  const raw = fs.readFileSync(path.join(data, 'vault.json'), 'utf8');
  assert.ok(!raw.includes('abandon'), 'seed is not stored in plaintext');
  console.log('page errors:', JSON.stringify(errors).slice(0,800)); assert.deepEqual(errors, [], 'no page errors');
  await app.close();
  server.close();
  fs.rmSync(data, { recursive: true, force: true });
  console.log('ALL PASSED; screenshots in', shots);
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
