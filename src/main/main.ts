import type { Asset } from './config';
import { app, BrowserWindow, clipboard, desktopCapturer, ipcMain, Menu, Notification, screen, session, shell } from 'electron';
import { findWcQr } from './qr-scan';
import { isWcLink, wcLinkOf } from './wc-link';
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
// A WalletConnect link the system handed over (a dApp's "open wallet"), kept until the unlocked wallet takes it.
let pendingWcLink = wcLinkOf(process.argv);

function bringToFront(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  // Windows won't let a background app take focus, so the dApp's browser would stay on top and hide the request:
  // stay on top for a moment, take the focus, and flash in the taskbar.
  win.setAlwaysOnTop(true);
  win.focus();
  app.focus({ steal: true });
  setTimeout(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); }, 1500);
  if (!win.isFocused()) win.flashFrame(true);
}

// dApp requests waiting for the request window, and the ones it is showing (answered or not when it closes).
const popupQueue: { e: string; d: any }[] = [];
const popupShown = new Map<number, string>();
let popup: BrowserWindow | null = null;

/** A small window just for a dApp's request, on top of the browser, like other wallets' confirmation windows. */
function openPopup(e: string, d: any): void {
  popupQueue.push({ e, d });
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send('wallet:wc-popup-more');
    popup.show(); popup.focus();
    return;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  popup = new BrowserWindow({
    width: 400, height: 640, x: area.x + area.width - 420, y: area.y + 20, resizable: true, minimizable: false, maximizable: false,
    alwaysOnTop: true, title: 'Kusari Wallet', backgroundColor: '#070707', show: false,
    icon: path.join(__dirname, '../renderer/icon.png'),
    webPreferences: { preload: path.join(__dirname, '../preload/preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, devTools: !app.isPackaged },
  });
  popup.setMenuBarVisibility(false);
  popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popup.webContents.on('will-navigate', (ev) => ev.preventDefault());
  popup.once('ready-to-show', () => { popup?.show(); popup?.focus(); app.focus({ steal: true }); });
  popup.on('closed', () => {
    // Closing the window without answering turns the request down, so the dApp isn't left waiting.
    for (const [id, kind] of popupShown) {
      if (kind === 'wc-proposal') void service.wcReject(id).catch(() => undefined);
      if (kind === 'wc-request') void service.wcDecline(id).catch(() => undefined);
    }
    popupShown.clear();
    popupQueue.length = 0;
    popup = null;
  });
  notifyRequest(e, d);
  void popup.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'wc-popup' });
}

/** A request from a dApp, said on the desktop too, in case the wallet is behind other windows. */
function notifyRequest(e: string, d: any): void {
  if (!Notification.isSupported() || (win && !win.isDestroyed() && win.isFocused())) return;
  const what = e === 'wc-proposal' ? 'wants to connect' : e === 'wc-refused' ? 'asked for something this wallet doesn\'t do' : 'asks for your approval';
  const n = new Notification({ title: 'Kusari Wallet', body: `${String(d?.name ?? d?.dapp ?? 'A dApp').slice(0, 60)} ${what}.`, silent: false });
  n.on('click', bringToFront);
  n.show();
}

/** dApp features answer only in an unlocked WalletConnect wallet; a maximum-privacy wallet never reads the screen or clipboard for them. */
const wcWallet = async (): Promise<boolean> => (await service.walletMode()) === 'walletconnect' && Boolean((await service.wcInfo()).available);

/** Reads the WalletConnect QR a dApp shows, from the open windows and then the whole screen. Nothing is saved. */
async function scanScreenForWc(): Promise<string> {
  const side = Math.min(2400, Math.max(1280, ...screen.getAllDisplays().map((d) => Math.round(Math.max(d.size.width, d.size.height) * d.scaleFactor))));
  const own = win && !win.isDestroyed() ? win.getMediaSourceId() : '';
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: side, height: side }, fetchWindowIcons: false });
  const ordered = [...sources.filter((s) => s.id.startsWith('window:') && s.id !== own).slice(0, 30), ...sources.filter((s) => s.id.startsWith('screen:'))];
  for (const s of ordered) {
    if (s.thumbnail.isEmpty()) continue;
    const { width, height } = s.thumbnail.getSize();
    const found = findWcQr(s.thumbnail.toBitmap(), width, height, 'bgra');
    if (found) return found;
  }
  return '';
}

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
    if (!url.startsWith('file://') || !url.replace(/#wc-popup$/, '').endsWith('/renderer/index.html')) throw new Error('This call is not allowed.');
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
  const dev = app.isPackaged ? {} : { tronHost: process.env.VAULT_DEV_TRON_HOST, priceUrl: process.env.VAULT_DEV_PRICE_URL, firoApi: process.env.VAULT_DEV_FIRO_API, solRpc: process.env.VAULT_DEV_SOL_RPC, dogeApi: process.env.VAULT_DEV_DOGE_API, dashApi: process.env.VAULT_DEV_DASH_API, zecBin: process.env.VAULT_DEV_ZEC_BIN, arrrBin: process.env.VAULT_DEV_ARRR_BIN, arrrServers: process.env.VAULT_DEV_ARRR_SERVER ? [process.env.VAULT_DEV_ARRR_SERVER] : undefined, zanoBin: process.env.VAULT_DEV_ZANO_BIN, zanoNode: process.env.VAULT_DEV_ZANO_NODE, zecServers: process.env.VAULT_DEV_ZEC_SERVER ? [process.env.VAULT_DEV_ZEC_SERVER] : undefined, ethRpc: process.env.VAULT_DEV_ETH_RPC, tornadoPools: process.env.VAULT_DEV_TORNADO ? JSON.parse(process.env.VAULT_DEV_TORNADO) : undefined, ethScout: process.env.VAULT_DEV_ETH_SCOUT, bchApi: process.env.VAULT_DEV_BCH_API, ltcApi: process.env.VAULT_DEV_LTC_API, scrtLcd: process.env.VAULT_DEV_SCRT_LCD, mwebBin: process.env.VAULT_DEV_MWEB_BIN, mwebConnect: process.env.VAULT_DEV_MWEB_CONNECT, sparkBin: process.env.VAULT_DEV_SPARK_BIN, sparkServer: process.env.VAULT_DEV_SPARK_SERVER, sparkConnect: process.env.VAULT_DEV_SPARK_CONNECT, nearRpc: process.env.VAULT_DEV_NEAR_RPC, hlApi: process.env.VAULT_DEV_HL_API, asterApi: process.env.VAULT_DEV_ASTER_API, asterBapi: process.env.VAULT_DEV_ASTER_BAPI, hypeRpc: process.env.VAULT_DEV_HYPE_RPC, kindexBase: process.env.VAULT_DEV_KINDEX, nearHistory: process.env.VAULT_DEV_NEAR_HISTORY, polRpc: process.env.VAULT_DEV_POL_RPC, polScout: process.env.VAULT_DEV_POL_SCOUT, arbRpc: process.env.VAULT_DEV_ARB_RPC, arbScout: process.env.VAULT_DEV_ARB_SCOUT, bscRpc: process.env.VAULT_DEV_BSC_RPC, uniswapBase: process.env.VAULT_DEV_UNISWAP_BASE, uniswapKey: process.env.VAULT_DEV_UNISWAP_KEY, bscScout: process.env.VAULT_DEV_BSC_SCOUT, swapBase: process.env.VAULT_DEV_SWAP_BASE, simpleSwapBase: process.env.VAULT_DEV_SIMPLESWAP_BASE, ghostSwapBase: process.env.VAULT_DEV_GHOSTSWAP_BASE, btcApi: process.env.VAULT_DEV_BTC_API, torBin: process.env.VAULT_DEV_TOR_BIN, socks: process.env.VAULT_DEV_SOCKS };
  service = new WalletService(app.getPath('userData'), undefined, dev);
  void service.removeLeftovers().catch(() => undefined);
  await service.init();
  service.on('monero-state', (s) => emit('wallet:monero-state', s));
  service.on('balance-changed', () => emit('wallet:balance-changed'));
  service.on('tron-tx', (t) => emit('wallet:tron-tx', t));
  service.on('locked', () => { emit('wallet:locked'); if (popup && !popup.isDestroyed()) popup.close(); });
  service.on('tor-state', (s) => emit('wallet:tor-state', s));
  service.on('tor-install', (m) => emit('wallet:tor-install', m));
  service.on('tornado-progress', (m) => emit('wallet:tornado-progress', m));
  for (const e of ['wc-proposal', 'wc-request', 'wc-sessions', 'wc-refused']) service.on(e, (d) => {
    // The wallet in front: the request opens over its screen. Otherwise (the person is in the dApp's browser) it opens
    // in its own small window on top, as other wallets do.
    if (e !== 'wc-sessions' && !(win && !win.isDestroyed() && win.isFocused() && win.isVisible())) { openPopup(e, d); return; }
    emit(`wallet:${e}`, d);
  });
  // Development builds only: puts a made-up dApp request into the request window, for the UI test.
  if (!app.isPackaged) handle('wallet:devWcPopup', (e: string, d: unknown) => openPopup(e, d));
  handle('wallet:wcPopupTake', () => { const next = popupQueue.shift() ?? null; if (next) popupShown.set(next.d?.id, next.e); return next; });

  handle('wallet:status', () => service.status());
  handle('wallet:arrrInfo', () => service.arrrInfo());
  handle('wallet:arrrRescan', (date: string, pw: string) => service.arrrRescan(date, pw));
  handle('wallet:zanoInfo', () => service.zanoInfo());
  handle('wallet:zecInfo', () => service.zecInfo());
  handle('wallet:zecShield', (pw: string) => service.zecShield(pw));
  handle('wallet:dexQuote', (from: Asset, to: Asset, amount: string, bps: number) => service.dexQuote(from, to, amount, bps));
  handle('wallet:dexPrepare', (from: Asset, to: Asset, amount: string, id: 'uniswap' | 'pancakeswap', bps: number) => service.dexPrepare(from, to, amount, id, bps));
  handle('wallet:dexConfirm', (id: string, pw: string) => service.dexConfirm(id, pw));
  handle('wallet:walletMode', () => service.walletMode());
  handle('wallet:wcClipboard', async () => { if (!(await wcWallet())) return ''; const t = (await clipboard.readText()).trim(); return isWcLink(t) ? t : ''; });
  handle('wallet:wcScanScreen', async () => ((await wcWallet()) ? scanScreenForWc() : ''));
  handle('wallet:wcTakeLink', async () => { if (!(await wcWallet())) return ''; const l = pendingWcLink; pendingWcLink = ''; return l; });
  // Links a dApp opens with wc: come to this app, once a wallet uses WalletConnect.
  handle('wallet:wcRegisterLinks', async () => { if (await wcWallet() && app.isPackaged && !app.isDefaultProtocolClient('wc')) app.setAsDefaultProtocolClient('wc'); });
  handle('wallet:setWalletMode', (m: 'private' | 'walletconnect') => service.setWalletMode(m));
  handle('wallet:wcInfo', () => service.wcInfo());
  handle('wallet:wcPair', (uri: string) => service.wcPair(uri));
  handle('wallet:wcApprove', (id: number) => service.wcApprove(id));
  handle('wallet:wcReject', (id: number) => service.wcReject(id));
  handle('wallet:wcDisconnect', (topic: string) => service.wcDisconnect(topic));
  handle('wallet:wcDisconnectAll', () => service.wcDisconnectAll());
  handle('wallet:wcDecline', (id: number) => service.wcDecline(id));
  handle('wallet:wcRequestInfo', (id: number) => service.wcRequestInfo(id));
  handle('wallet:wcConfirm', (id: number, pw: string) => service.wcConfirm(id, pw));
  // Aster perps: the service refuses these outside WalletConnect wallets.
  handle('wallet:perpsInfo', () => service.perpsInfo());
  handle('wallet:perpsMarkets', () => service.perpsMarkets());
  handle('wallet:perpsAccount', () => service.perpsAccount());
  handle('wallet:perpsMarket', (s: string) => service.perpsMarket(s));
  handle('wallet:perpsEnable', (pw: string) => service.perpsEnable(pw));
  handle('wallet:perpsPrepareOrder', (i: any) => service.perpsPrepareOrder(i));
  handle('wallet:perpsPrepareClose', (s: string) => service.perpsPrepareClose(s));
  handle('wallet:perpsPlace', (id: string) => service.perpsPlace(id));
  handle('wallet:perpsCancel', (s: string, o: number) => service.perpsCancel(s, o));
  handle('wallet:hypeCore', () => service.hypeCore());
  handle('wallet:hypeToCorePrepare', (a: string) => service.hypeToCorePrepare(a));
  handle('wallet:hypeToCoreConfirm', (id: string, pw: string) => service.hypeToCoreConfirm(id, pw));
  handle('wallet:hypeToEvmPrepare', (a: string) => service.hypeToEvmPrepare(a));
  handle('wallet:hypeToEvmConfirm', (id: string, pw: string) => service.hypeToEvmConfirm(id, pw));
  handle('wallet:perpsIndex', (s: string) => service.perpsIndex(s));
  handle('wallet:perpsBook', (s: string) => service.perpsBook(s));
  handle('wallet:perpsCandles', (s: string, i: string) => service.perpsCandles(s, i));
  handle('wallet:perpsDepositPrepare', (asset: Asset, amt: string) => service.perpsDepositPrepare(asset, amt));
  handle('wallet:perpsDepositConfirm', (id: string, pw: string) => service.perpsDepositConfirm(id, pw));
  handle('wallet:perpsWithdrawPrepare', (chainId: number, token: 'USDT' | 'USDC', amt: string) => service.perpsWithdrawPrepare(chainId, token, amt));
  handle('wallet:perpsWithdrawConfirm', (id: string, pw: string) => service.perpsWithdrawConfirm(id, pw));
  handle('wallet:prepareLtcPrivate', () => service.prepareLtcPrivate());
  handle('wallet:prepareFiroPrivate', () => service.prepareFiroPrivate());
  handle('wallet:prepareScrtPrivate', (kind: 'wrap' | 'unwrap' | 'key', amount: string) => service.prepareScrtPrivate(kind, amount));
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
    if (service.torOn) { await clipboard.writeText(url); return { copied: true }; }
    await shell.openExternal(url);
    return { copied: false };
  });
  // The purchase page needs a normal browser: card payment pages refuse Tor, and the person signs in there.
  handle('wallet:openBuy', async (asset) => { await shell.openExternal(service.buyUrl(asset)); });
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

  bumpAutoLock();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('second-instance', (_e, argv) => {
  const link = wcLinkOf(argv);
  if (link) { pendingWcLink = link; emit('wallet:wc-link'); }
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  const link = wcLinkOf([url]);
  if (link) { pendingWcLink = link; emit('wallet:wc-link'); bringToFront(); }
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
