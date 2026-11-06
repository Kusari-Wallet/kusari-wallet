// Smoke test of a built app: asar, fuses and the Monero worker all have to work together.
const { spawn } = require('node:child_process');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const exe = process.argv[2];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-pkg-'));
  const proc = spawn(exe, ['--no-sandbox', '--remote-debugging-port=9333'], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, VAULT_DEV_TRON_HOST: 'http://127.0.0.1:1', VAULT_WALLET_DATA: path.join(home, 'evil') }, stdio: 'pipe' });
  let log = '';
  proc.stderr.on('data', (d) => { log += d; });
  proc.stdout.on('data', (d) => { log += d; });
  try {
    let browser;
    for (let i = 0; i < 40 && !browser; i++) {
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:9333'); } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    assert.ok(browser, 'debug port never opened: ' + log);
    let page;
    for (let i = 0; i < 40 && !page; i++) { page = browser.contexts()[0]?.pages()[0]; if (!page) await new Promise((r) => setTimeout(r, 250)); }
    await page.getByText('Get started').waitFor({ timeout: 20000 });
    await page.getByText('Create a new wallet').click();
    await page.fill('#pw', 'correct horse battery');
    await page.fill('#pw2', 'correct horse battery');
    await page.click('#next');
    await page.getByText('Write both seed phrases on paper').waitFor({ timeout: 25000 }).catch(async (e) => {
      console.log('screen:', await page.locator('.entry-form').innerText().catch(() => '?'));
      console.log('log:', log.slice(-1500));
      throw e;
    });
    assert.equal(await page.locator('.seed').nth(1).locator('li').count(), 25);
    const words = (i) => page.locator('.seed').nth(i).locator('li').allInnerTexts().then((a) => a.map((t) => t.split('\n').pop().trim()));
    const [t, x] = [await words(0), await words(1)];
    await page.check('#saved');
    await page.click('#next');
    const labels = await page.locator('label.field > span').allInnerTexts();
    const idx = labels.map((l) => Number(l.match(/word (\d+)/)[1]) - 1);
    await page.locator('.quiz').first().fill(t[idx[0]]);
    await page.locator('.quiz').nth(1).fill(x[idx[1]]);
    await page.click('#next');
    await page.locator('#asset-XMR').waitFor({ timeout: 90000 });
    await page.click('#go-receive');
    await page.click('#coin-picker');
    await page.click('#pick-XMR');
    await page.locator('#copy:not([disabled])').waitFor({ timeout: 20000 });
    const addr = await page.locator('#my-address').innerText();
    assert.match(addr, /^4/, 'mainnet address from the WASM worker');
    // Tor install can't reach the network here: it must fail visibly and leave Tor off.
    await page.click('#back');
    await page.click('#open-settings');
    await page.check('#set-tor');
    await page.click('#save-settings');
    await page.locator('.section .error').first().waitFor({ timeout: 60000 });
    console.log('tor install error shown:', (await page.locator('.section .error').first().innerText()).slice(0, 90));
    assert.equal(await page.evaluate(() => wallet.torInfo().then((t) => t.enabled)), false, 'Tor stays off when install fails');
    await page.locator('#nav-home').click();
    const hasDevtools = await page.evaluate(() => typeof window.require);
    assert.equal(hasDevtools, 'undefined', 'no node in the renderer');
    assert.ok(!fs.existsSync(path.join(home, 'evil')), 'packaged app ignores dev env overrides');
    const dirs = fs.readdirSync(home);
    await page.click('#go-swap');
    await page.click('#go-tornado');
    await page.locator('#tornado-engine', { hasText: 'Ready' }).waitFor({ timeout: 60000 });
    console.log('ok Tornado proof engine starts from the packaged app');
    console.log('user data under', dirs, '| xmr address', addr.slice(0, 12) + '…');
    // A wallet made under the old app name must open, not ask to start over.
    const oldHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-old-'));
    const oldDir = path.join(oldHome, 'Shinobi Wallet');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.copyFileSync(path.join(home, 'Kusari Wallet', 'vault.json'), path.join(oldDir, 'vault.json'));
    const second = spawn(exe, ['--no-sandbox', '--remote-debugging-port=9334'], { env: { ...process.env, HOME: oldHome, XDG_CONFIG_HOME: oldHome } });
    try {
      let b2;
      for (let i = 0; i < 40 && !b2; i++) {
        try { b2 = await chromium.connectOverCDP('http://127.0.0.1:9334'); } catch { await new Promise((r) => setTimeout(r, 500)); }
      }
      let p2;
      for (let i = 0; i < 40 && !p2; i++) { p2 = b2.contexts()[0]?.pages()[0]; if (!p2) await new Promise((r) => setTimeout(r, 250)); }
      await p2.locator('input[type=password]').first().waitFor({ timeout: 20000 });
      assert.equal(await p2.getByText('Get started').count(), 0, 'old wallet must be found');
      await b2.close();
    } finally { second.kill('SIGKILL'); }
    console.log('ok wallet from the old app name is found');
    console.log('PACKAGED SMOKE PASSED');
    await browser.close();
  } finally {
    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 800));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
