import { useDcrNetwork } from './dcr';
import type { Asset } from './config';
import { app, BrowserWindow, clipboard, ipcMain, Menu, session, shell } from 'electron';
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WalletService } from './service';
import { configureMoneroWorker } from './monero';
import { DEVELOPER_BUILD } from './flavor';

// Keep stray output (node URLs, wallet paths) off the terminal; never log secrets.
process.on('unhandledRejection', (e) => console.error('unhandled:', (e as Error)?.message));

if (!app.isPackaged && process.env.VAULT_WALLET_DATA) app.setPath('userData', process.env.VAULT_WALLET_DATA);
// Wallets created before the rename stay in the old data folder.
// The app has had other names. A wallet made under one of them keeps its folder, so nothing moves or goes missing.
// Not for the developer build: it keeps to its own folder and never opens the regular wallet's data.
if (!DEVELOPER_BUILD && !process.env.VAULT_WALLET_DATA && !existsSync(path.join(app.getPath('userData'), 'vault.json'))) {
  for (const name of ['Vault Wallet', 'Shinobi Wallet']) {
    const legacyData = path.join(app.getPath('appData'), name);
    if (existsSync(path.join(legacyData, 'vault.json'))) { app.setPath('userData', legacyData); break; }
  }
}
if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
let service: WalletService;
let clipboardTimer: NodeJS.Timeout | null = null;

const emit = (channel: string, payload?: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function createWindow(): void {
  win = new BrowserWindow({
    width: 500, height: 880, minWidth: 420, minHeight: 640,
    title: 'Kusari Wallet', backgroundColor: '#070707', show: false,
    icon: path.join(__dirname, '../renderer/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  // The taskbar button, and a pin made from it, take their icon and target from this exe.
  if (process.platform === 'win32') win.setAppDetails({ appId: APP_ID, appIconPath: process.execPath, appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'Kusari Wallet' });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

/** Only our own page may call wallet functions. */
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    const url = event.senderFrame?.url ?? '';
    if (!url.startsWith('file://') || !url.endsWith('/renderer/index.html')) throw new Error('This call is not allowed.');
    return fn(...args);
  });
}

// Windows groups a window with any taskbar pin or shortcut of the same app ID. One left from a version whose folder
// was deleted has no icon to show, so the window showed a blank page. Each folder gets its own ID.
const APP_ID = `dev.edge.kusariwallet.${createHash('sha256').update(path.dirname(process.execPath).toLowerCase()).digest('hex').slice(0, 12)}`;
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

app.whenReady().then(async () => {
  if (app.isPackaged) Menu.setApplicationMenu(null);
  // The only thing the page may ask for is the camera, video only, for QR scanning.
  const isOurPage = (url: string) => url.startsWith('file://') && url.includes('/renderer/index.html');
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details: any) => {
    const videoOnly = perm === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((t: string) => t === 'video');
    cb(videoOnly && isOurPage(details.requestingUrl ?? ''));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, perm, origin, details: any) => {
    return perm === 'media' && details?.mediaType === 'video' && (origin ?? '').startsWith('file://');
  });
  configureMoneroWorker();

  // Unpacked development runs only: a packaged app can't be redirected to another Tron host.
  // A local Decred simnet (tests/dcr-simnet.js) in place of mainnet, for development builds only.
  if (!app.isPackaged && process.env.VAULT_DEV_DCR_NET === 'simnet') useDcrNetwork('simnet');
  const dev = app.isPackaged ? {} : { tronHost: process.env.VAULT_DEV_TRON_HOST, priceUrl: process.env.VAULT_DEV_PRICE_URL, firoApi: process.env.VAULT_DEV_FIRO_API, solRpc: process.env.VAULT_DEV_SOL_RPC, solPoolRelayer: process.env.VAULT_DEV_SOLPOOL_RELAYER, dogeApi: process.env.VAULT_DEV_DOGE_API, dcrApi: process.env.VAULT_DEV_DCR_API, dashApi: process.env.VAULT_DEV_DASH_API, dashConnect: process.env.VAULT_DEV_DASH_CONNECT, dashSeeds: process.env.VAULT_DEV_DASH_SEEDS ? process.env.VAULT_DEV_DASH_SEEDS.split(',') : undefined, zecBin: process.env.VAULT_DEV_ZEC_BIN, arrrBin: process.env.VAULT_DEV_ARRR_BIN, arrrServers: process.env.VAULT_DEV_ARRR_SERVER ? [process.env.VAULT_DEV_ARRR_SERVER] : undefined, zanoBin: process.env.VAULT_DEV_ZANO_BIN, zanoNode: process.env.VAULT_DEV_ZANO_NODE, ksrBin: process.env.VAULT_DEV_KSR_BIN, ksrNode: process.env.VAULT_DEV_KSR_NODE, zecServers: process.env.VAULT_DEV_ZEC_SERVER ? [process.env.VAULT_DEV_ZEC_SERVER] : undefined, ethRpc: process.env.VAULT_DEV_ETH_RPC, tornadoPools: process.env.VAULT_DEV_TORNADO ? JSON.parse(process.env.VAULT_DEV_TORNADO) : undefined, ethScout: process.env.VAULT_DEV_ETH_SCOUT, bchApi: process.env.VAULT_DEV_BCH_API, ltcApi: process.env.VAULT_DEV_LTC_API, mwebBin: process.env.VAULT_DEV_MWEB_BIN, mwebConnect: process.env.VAULT_DEV_MWEB_CONNECT, sparkBin: process.env.VAULT_DEV_SPARK_BIN, sparkServer: process.env.VAULT_DEV_SPARK_SERVER, sparkConnect: process.env.VAULT_DEV_SPARK_CONNECT, polRpc: process.env.VAULT_DEV_POL_RPC, polScout: process.env.VAULT_DEV_POL_SCOUT, arbRpc: process.env.VAULT_DEV_ARB_RPC, arbScout: process.env.VAULT_DEV_ARB_SCOUT, bscRpc: process.env.VAULT_DEV_BSC_RPC, uniswapBase: process.env.VAULT_DEV_UNISWAP_BASE, uniswapKey: process.env.VAULT_DEV_UNISWAP_KEY, bscScout: process.env.VAULT_DEV_BSC_SCOUT, swapBase: process.env.VAULT_DEV_SWAP_BASE, simpleSwapBase: process.env.VAULT_DEV_SIMPLESWAP_BASE, ghostSwapBase: process.env.VAULT_DEV_GHOSTSWAP_BASE, btcApi: process.env.VAULT_DEV_BTC_API, coinjoinCoordinator: process.env.VAULT_DEV_COINJOIN, coinjoinTest: process.env.VAULT_DEV_COINJOIN_TEST ? JSON.parse(process.env.VAULT_DEV_COINJOIN_TEST) : undefined, torBin: process.env.VAULT_DEV_TOR_BIN, socks: process.env.VAULT_DEV_SOCKS };
  service = new WalletService(app.getPath('userData'), undefined, dev);
  void service.removeLeftovers().catch(() => undefined);
  await service.init();
  service.on('monero-state', (s) => emit('wallet:monero-state', s));
  service.on('balance-changed', () => emit('wallet:balance-changed'));
  service.on('tron-tx', (t) => emit('wallet:tron-tx', t));
  service.on('locked', () => emit('wallet:locked'));
  service.on('tor-state', (s) => emit('wallet:tor-state', s));
  service.on('tor-install', (m) => emit('wallet:tor-install', m));
  service.on('tornado-progress', (m) => emit('wallet:tornado-progress', m));
  service.on('sol-pool-progress', (m) => emit('wallet:sol-pool-progress', m));
  handle('wallet:status', () => service.status());
  handle('wallet:arrrInfo', () => service.arrrInfo());
  handle('wallet:arrrRescan', (date: string, pw: string) => service.arrrRescan(date, pw));
  handle('wallet:zanoInfo', () => service.zanoInfo());
  handle('wallet:ksrInfo', () => service.ksrInfo());
  handle('wallet:zecInfo', () => service.zecInfo());
  handle('wallet:zecShield', (pw: string) => service.zecShield(pw));
  handle('wallet:dexQuote', (from: Asset, to: Asset, amount: string, bps: number) => service.dexQuote(from, to, amount, bps));
  handle('wallet:dexPrepare', (from: Asset, to: Asset, amount: string, id: 'uniswap' | 'pancakeswap', bps: number) => service.dexPrepare(from, to, amount, id, bps));
  handle('wallet:dexConfirm', (id: string, pw: string) => service.dexConfirm(id, pw));
  handle('wallet:prepareLtcPrivate', () => service.prepareLtcPrivate());
  handle('wallet:prepareFiroPrivate', () => service.prepareFiroPrivate());
  handle('wallet:prepareDashMix', (amount: string) => service.prepareDashMix(amount));
  handle('wallet:prepareDashPrivate', (to: string, amount: string) => service.prepareDashPrivate(to, amount));
  handle('wallet:coinjoinPause', (paused: boolean) => service.coinjoinPause(Boolean(paused)));
  handle('wallet:zecRescan', (date: string, pw: string) => service.zecRescan(date, pw));
  handle('wallet:generateSeeds', () => service.generateSeeds());
  handle('wallet:finishCreate', (pw: string, pass?: string) => service.finishCreate(pw, typeof pass === 'string' ? pass : ''));
  handle('wallet:restore', (pw: string, t: string, m: string, from: string, pass?: string) => service.restore(pw, t, m, from, typeof pass === 'string' ? pass : ''));
  handle('wallet:unlock', (pw: string) => service.unlock(pw));
  handle('wallet:lock', () => service.lock());
  handle('wallet:overview', () => service.overview());
  handle('wallet:history', (asset) => service.history(asset));
  handle('wallet:moneroAddresses', () => service.moneroAddresses());
  handle('wallet:newSubaddress', () => service.newSubaddress());
  handle('wallet:qr', (text: string) => service.qr(text));
  handle('wallet:prepareSend', (asset, to: string, amount: string, opts?: { coins?: string[]; fromMixed?: boolean; fromAddress?: number; memo?: string; payjoin?: { pj?: string; pjos?: string } }) => service.prepareSend(asset, to, amount, opts ?? {}));
  handle('wallet:ethAddresses', () => service.ethAddresses());
  handle('wallet:ethAddressNew', () => service.ethAddressNew());
  handle('wallet:ethAddressesFind', () => service.ethAddressesFind());
  handle('wallet:btcCoins', () => service.btcCoins());
  handle('wallet:btcMixInfo', (coins?: string[]) => service.btcMixInfo(Array.isArray(coins) ? coins : undefined));
  handle('wallet:btcMixStart', (password: string, coins?: string[]) => service.btcMixStart(String(password ?? ''), Array.isArray(coins) ? coins : undefined));
  handle('wallet:btcMixStop', () => service.btcMixStop());
  handle('wallet:payjoinReceiveStart', (password: string, amount?: string) => service.payjoinReceiveStart(password, amount));
  handle('wallet:payjoinReceiveStatus', () => service.payjoinReceiveStatus());
  handle('wallet:payjoinReceiveEnd', () => service.payjoinReceiveEnd());
  handle('wallet:btcCoinSet', (id: string, change: { label?: string; frozen?: boolean }) => service.btcCoinSet(id, change ?? {}));
  handle('wallet:cancelSend', (id: string) => service.cancelSend(id));
  handle('wallet:confirmSend', (id: string, pw: string, opts?: { delayMinutes?: number }) => service.confirmSend(id, pw, opts && typeof opts === 'object' ? { delayMinutes: Number(opts.delayMinutes) || 0 } : {}));
  handle('wallet:delayedSends', () => service.delayedSends());
  handle('wallet:revealSeeds', (pw: string) => service.revealSeeds(pw));
  handle('wallet:changePassword', (cur: string, next: string) => service.changePassword(cur, next));
  handle('wallet:getSettings', () => ({ ...service.settings, developer: DEVELOPER_BUILD }));
  handle('wallet:updateSettings', (patch) => service.updateSettings(patch));
  handle('wallet:deleteWallet', (pw: string) => service.deleteWallet(pw));
  handle('wallet:openExplorer', async (asset, hash: string) => {
    const url = service.explorerUrl(asset, hash);
    // The system browser isn't behind Tor, so opening it here would reveal the IP and the transaction together.
    if (service.torOn) { await clipboard.writeText(url); return { copied: true }; }
    await shell.openExternal(url);
    return { copied: false };
  });
  // The purchase page needs a normal browser: card payment pages refuse Tor, and the person signs in there.
  handle('wallet:openBuy', async (asset) => {
    const url = service.buyUrl(asset);
    // Development builds only: the UI test records the link instead of starting a browser.
    if (!app.isPackaged && process.env.VAULT_DEV_EXTERNAL_LOG) { appendFileSync(process.env.VAULT_DEV_EXTERNAL_LOG, url + '\n'); return; }
    await shell.openExternal(url);
  });
  handle('wallet:addresses', () => service.addresses());
  handle('wallet:swapQuote', (a, b, c: string) => service.swapQuote(a, b, c));
  handle('wallet:swapPrepare', (a, b, c: string, d, e: string) => service.swapPrepare(a, b, c, d, e));
  handle('wallet:privacyQuote', (a, b, c: string) => service.privacyQuote(a, b, c));
  handle('wallet:privacyPrepare', (a, b, c: string, d, e: string) => service.privacyPrepare(a, b, c, d, e));
  handle('wallet:privacyRefresh', (id: string) => service.privacyRefresh(id));
  handle('wallet:privacySecondQuote', (id: string, a: string) => service.privacySecondQuote(id, a));
  handle('wallet:privacySecond', (id: string, a: string, b) => service.privacySecond(id, a, b));
  handle('wallet:privacyList', () => service.privacyList());
  handle('wallet:walletsList', () => service.walletsList());
  handle('wallet:walletRename', (i: string, n: string) => service.walletRename(i, n));
  handle('wallet:duressStatus', () => service.duressStatus());
  handle('wallet:btcSpeedUp', (txid: string) => service.btcSpeedUp(txid));
  handle('wallet:duressSet', (c: string, d: string) => service.duressSet(c, d));
  handle('wallet:duressRemove', (c: string) => service.duressRemove(c));
  handle('wallet:walletSwitch', (i: string) => service.walletSwitch(i));
  handle('wallet:walletBeginAdd', (n: string) => service.walletBeginAdd(n));
  handle('wallet:walletCancelAdd', () => service.walletCancelAdd());
  handle('wallet:feeEstimate', (a) => service.feeEstimate(a));
  handle('wallet:tornadoInfo', (c?: string) => service.tornadoInfo(typeof c === 'string' ? c : undefined));
  handle('wallet:tornadoCheck', () => service.tornadoCheck());
  handle('wallet:tornadoDepositPrepare', (p: string, c?: string) => service.tornadoDepositPrepare(String(p), typeof c === 'string' ? c : undefined));
  handle('wallet:tornadoDepositConfirm', (i: string, p: string, w: string, o?: { chain?: string; sendTo?: string }) => service.tornadoDepositConfirm(String(i), String(p), String(w), o && typeof o === 'object' ? { chain: typeof o.chain === 'string' ? o.chain : undefined, sendTo: typeof o.sendTo === 'string' ? o.sendTo : undefined } : {}));
  handle('wallet:tornadoExport', (i: string, w: string) => service.tornadoExport(i, w));
  handle('wallet:tornadoWithdrawQuote', (i: string, r: string, l: string) => service.tornadoWithdrawQuote(i, r, l));
  handle('wallet:tornadoWithdraw', (i: string, r: string, l: string, w: string, o?: { delayMinutes?: number }) => service.tornadoWithdraw(i, r, l, w, o && typeof o === 'object' ? { delayMinutes: Number(o.delayMinutes) || 0 } : {}));
  handle('wallet:tornadoSplitPrepare', (a: string, sp: boolean) => service.tornadoSplitPrepare(String(a), Boolean(sp)));
  handle('wallet:tornadoSplitConfirm', (i: string, w: string) => service.tornadoSplitConfirm(i, w));
  handle('wallet:tornadoRecover', (w: string) => service.tornadoRecover(w));
  handle('wallet:dcrStakeInfo', () => service.dcrStakeInfo());
  handle('wallet:dcrVspList', () => service.dcrVspList());
  handle('wallet:dcrStakeQuote', (n: number, v: string, m?: boolean) => service.dcrStakeQuote(n, v, !!m));
  handle('wallet:dcrStakeBuy', (n: number, v: string, p: string, m?: boolean) => service.dcrStakeBuy(n, v, p, !!m));
  handle('wallet:dcrMixInfo', () => service.dcrMixInfo());
  handle('wallet:dcrMixStart', (p: string) => service.dcrMixStart(p));
  handle('wallet:dcrMixStop', () => service.dcrMixStop());
  handle('wallet:solPoolInfo', (a: string) => service.solPoolInfo(String(a)));
  handle('wallet:solPoolEnable', (a: string, f: boolean) => service.solPoolEnable(String(a), f === true));
  handle('wallet:solPoolDepositQuote', (a: string, m: string) => service.solPoolDepositQuote(String(a), String(m)));
  handle('wallet:solPoolDeposit', (a: string, m: string, w: string, o?: { sendTo?: string }) => service.solPoolDeposit(String(a), String(m), String(w), o && typeof o === 'object' && typeof o.sendTo === 'string' ? { sendTo: o.sendTo } : {}));
  handle('wallet:solPoolWithdrawQuote', (a: string, m: string, t: string) => service.solPoolWithdrawQuote(String(a), String(m), String(t)));
  handle('wallet:solPoolWithdraw', (a: string, m: string, t: string, w: string, o?: { delayMinutes?: number }) => service.solPoolWithdraw(String(a), String(m), String(t), String(w), o && typeof o === 'object' ? { delayMinutes: Number(o.delayMinutes) || 0 } : {}));
  handle('wallet:solPoolCancelLater', (i: string) => service.solPoolCancelLater(String(i)));
  handle('wallet:dcrStakeFinish', (p: string) => service.dcrStakeFinish(p));
  handle('wallet:dcrTickets', (force?: boolean) => service.dcrTickets(!!force));
  handle('wallet:swapConfirm', (id: string, pw: string) => service.swapConfirm(id, pw));
  handle('wallet:swapRefresh', (id: string) => service.swapRefresh(id));
  handle('wallet:swapList', () => service.swapHistory());
  handle('wallet:torInfo', () => service.torInfo());
  handle('wallet:installTor', () => service.installTor());
  handle('wallet:connectionLog', () => service.connectionLog());
  handle('wallet:activity', () => undefined);
  handle('wallet:prices', () => service.prices());
  handle('wallet:paste', async () => (await clipboard.readText()).trim().slice(0, 200));
  handle('wallet:copy', async (text: string) => {
    await clipboard.writeText(text);
    if (clipboardTimer) clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(async () => {
      if ((await clipboard.readText()) === text) await clipboard.clear();
    }, 60_000);
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('window-all-closed', () => app.quit());

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !service) return;
  e.preventDefault();
  quitting = true;
  const done = () => app.exit(0);
  Promise.race([service.lock(), new Promise((r) => setTimeout(r, 8000))]).finally(done);
});
