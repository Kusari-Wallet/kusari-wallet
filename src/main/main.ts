import { app, BrowserWindow, clipboard, ipcMain, Menu, session, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WalletService } from './service';
import { configureMoneroWorker } from './monero';

// Keep stray output (node URLs, wallet paths) off the terminal; never log secrets.
process.on('unhandledRejection', (e) => console.error('unhandled:', (e as Error)?.message));

if (!app.isPackaged && process.env.VAULT_WALLET_DATA) app.setPath('userData', process.env.VAULT_WALLET_DATA);
// Wallets created before the rename stay in the old data folder.
// The app has had other names. A wallet made under one of them keeps its folder, so nothing moves or goes missing.
if (!process.env.VAULT_WALLET_DATA && !existsSync(path.join(app.getPath('userData'), 'vault.json'))) {
  for (const name of ['Vault Wallet', 'Shinobi Wallet']) {
    const legacyData = path.join(app.getPath('appData'), name);
    if (existsSync(path.join(legacyData, 'vault.json'))) { app.setPath('userData', legacyData); break; }
  }
}
if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
let service: WalletService;
let lockTimer: NodeJS.Timeout | null = null;
let clipboardTimer: NodeJS.Timeout | null = null;

const emit = (channel: string, payload?: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function bumpAutoLock(): void {
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = setTimeout(() => { void service.lock(); }, service.settings.autoLockMinutes * 60_000);
}

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
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

/** Only our own page may call wallet functions. */
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    const url = event.senderFrame?.url ?? '';
    if (!url.startsWith('file://') || !url.endsWith('/renderer/index.html')) throw new Error('허용되지 않은 호출이야.');
    if (channel !== 'wallet:status') bumpAutoLock();
    return fn(...args);
  });
}

if (process.platform === 'win32') app.setAppUserModelId('dev.edge.vaultwallet');

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
  const dev = app.isPackaged ? {} : { tronHost: process.env.VAULT_DEV_TRON_HOST, priceUrl: process.env.VAULT_DEV_PRICE_URL, dcrApi: process.env.VAULT_DEV_DCR_API, dashApi: process.env.VAULT_DEV_DASH_API, zecBin: process.env.VAULT_DEV_ZEC_BIN, arrrBin: process.env.VAULT_DEV_ARRR_BIN, arrrServers: process.env.VAULT_DEV_ARRR_SERVER ? [process.env.VAULT_DEV_ARRR_SERVER] : undefined, zanoBin: process.env.VAULT_DEV_ZANO_BIN, zanoNode: process.env.VAULT_DEV_ZANO_NODE, zecServers: process.env.VAULT_DEV_ZEC_SERVER ? [process.env.VAULT_DEV_ZEC_SERVER] : undefined, ethRpc: process.env.VAULT_DEV_ETH_RPC, tornadoPools: process.env.VAULT_DEV_TORNADO ? JSON.parse(process.env.VAULT_DEV_TORNADO) : undefined, ethScout: process.env.VAULT_DEV_ETH_SCOUT, swapBase: process.env.VAULT_DEV_SWAP_BASE, simpleSwapBase: process.env.VAULT_DEV_SIMPLESWAP_BASE, ghostSwapBase: process.env.VAULT_DEV_GHOSTSWAP_BASE, btcApi: process.env.VAULT_DEV_BTC_API, torBin: process.env.VAULT_DEV_TOR_BIN, socks: process.env.VAULT_DEV_SOCKS };
  service = new WalletService(app.getPath('userData'), undefined, dev);
  await service.init();
  service.on('monero-state', (s) => emit('wallet:monero-state', s));
  service.on('balance-changed', () => emit('wallet:balance-changed'));
  service.on('tron-tx', (t) => emit('wallet:tron-tx', t));
  service.on('locked', () => emit('wallet:locked'));
  service.on('tor-state', (s) => emit('wallet:tor-state', s));
  service.on('tor-install', (m) => emit('wallet:tor-install', m));
  service.on('tornado-progress', (m) => emit('wallet:tornado-progress', m));

  handle('wallet:status', () => service.status());
  handle('wallet:arrrInfo', () => service.arrrInfo());
  handle('wallet:arrrRescan', (date: string, pw: string) => service.arrrRescan(date, pw));
  handle('wallet:zanoInfo', () => service.zanoInfo());
  handle('wallet:zecInfo', () => service.zecInfo());
  handle('wallet:zecShield', (pw: string) => service.zecShield(pw));
  handle('wallet:zecRescan', (date: string, pw: string) => service.zecRescan(date, pw));
  handle('wallet:generateSeeds', () => service.generateSeeds());
  handle('wallet:finishCreate', (pw: string) => service.finishCreate(pw));
  handle('wallet:restore', (pw: string, t: string, m: string, from: string) => service.restore(pw, t, m, from));
  handle('wallet:unlock', (pw: string) => service.unlock(pw));
  handle('wallet:lock', () => service.lock());
  handle('wallet:overview', () => service.overview());
  handle('wallet:history', (asset) => service.history(asset));
  handle('wallet:moneroAddresses', () => service.moneroAddresses());
  handle('wallet:newSubaddress', () => service.newSubaddress());
  handle('wallet:qr', (text: string) => service.qr(text));
  handle('wallet:prepareSend', (asset, to: string, amount: string) => service.prepareSend(asset, to, amount));
  handle('wallet:cancelSend', (id: string) => service.cancelSend(id));
  handle('wallet:confirmSend', (id: string, pw: string) => service.confirmSend(id, pw));
  handle('wallet:revealSeeds', (pw: string) => service.revealSeeds(pw));
  handle('wallet:changePassword', (cur: string, next: string) => service.changePassword(cur, next));
  handle('wallet:getSettings', () => service.settings);
  handle('wallet:updateSettings', (patch) => service.updateSettings(patch));
  handle('wallet:deleteWallet', (pw: string) => service.deleteWallet(pw));
  handle('wallet:openExplorer', async (asset, hash: string) => {
    const url = service.explorerUrl(asset, hash);
    // The system browser isn't behind Tor, so opening it here would reveal the IP and the transaction together.
    if (service.settings.torEnabled) { await clipboard.writeText(url); return { copied: true }; }
    await shell.openExternal(url);
    return { copied: false };
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
  handle('wallet:walletSwitch', (i: string) => service.walletSwitch(i));
  handle('wallet:walletBeginAdd', (n: string) => service.walletBeginAdd(n));
  handle('wallet:walletCancelAdd', () => service.walletCancelAdd());
  handle('wallet:feeEstimate', (a) => service.feeEstimate(a));
  handle('wallet:tornadoInfo', () => service.tornadoInfo());
  handle('wallet:tornadoCheck', () => service.tornadoCheck());
  handle('wallet:tornadoDepositPrepare', (p: string) => service.tornadoDepositPrepare(p));
  handle('wallet:tornadoDepositConfirm', (i: string, p: string, w: string) => service.tornadoDepositConfirm(i, p, w));
  handle('wallet:tornadoExport', (i: string, w: string) => service.tornadoExport(i, w));
  handle('wallet:tornadoWithdrawQuote', (i: string, r: string, l: string) => service.tornadoWithdrawQuote(i, r, l));
  handle('wallet:tornadoWithdraw', (i: string, r: string, l: string, w: string) => service.tornadoWithdraw(i, r, l, w));
  handle('wallet:tornadoRecover', (w: string) => service.tornadoRecover(w));
  handle('wallet:swapConfirm', (id: string, pw: string) => service.swapConfirm(id, pw));
  handle('wallet:swapRefresh', (id: string) => service.swapRefresh(id));
  handle('wallet:swapList', () => service.swapList());
  handle('wallet:torInfo', () => service.torInfo());
  handle('wallet:installTor', () => service.installTor());
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

  bumpAutoLock();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting || !service) return;
  e.preventDefault();
  quitting = true;
  const done = () => app.exit(0);
  Promise.race([service.lock(), new Promise((r) => setTimeout(r, 8000))]).finally(done);
});
