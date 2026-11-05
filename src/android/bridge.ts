// Gives the shared screen the same window.wallet API that the desktop preload script provides.
import { runTornado } from './tornado-run';
import { Buffer } from 'buffer';
(globalThis as any).Buffer = (globalThis as any).Buffer ?? Buffer;
import { WalletService } from '../main/service';
import { kvDelPrefix, kvGet, kvSet } from './kv';
import { route } from './request';

declare const __TEST__: boolean;
const native: any = (window as any).VaultNative;
const store = (net: string, walletId: string) => {
  // The first wallet keeps the keys it has always had.
  const prefix = walletId === 'main' ? `xmr:${net}` : `xmr:${walletId}:${net}`;
  return {
  load: async () => {
    const keys = await kvGet<Uint8Array>(`${prefix}:keys`);
    const cache = await kvGet<Uint8Array>(`${prefix}:cache`);
    return keys ? { keys, cache: cache ?? new Uint8Array() } : null;
  },
  save: async (keys: Uint8Array, cache: Uint8Array) => {
    await kvSet(`${prefix}:keys`, keys);
    await kvSet(`${prefix}:cache`, cache);
  },
  };
};

const testConfig: any = __TEST__ ? (window as any).__VAULT_TEST__ ?? {} : {};
const service = new WalletService('/data', undefined, {
  route,
  moneroStore: store as any,
  nativeTor: true,
  allowFakechain: __TEST__ ? testConfig.allowFakechain : undefined,
  tronHost: __TEST__ ? testConfig.tronHost : undefined,
  priceUrl: __TEST__ ? testConfig.priceUrl : undefined,
  swapBase: __TEST__ ? testConfig.swapBase : undefined,
  simpleSwapBase: __TEST__ ? testConfig.simpleSwapBase : undefined,
  ghostSwapBase: __TEST__ ? testConfig.ghostSwapBase : undefined,
  btcApi: __TEST__ ? testConfig.btcApi : undefined,
  dcrApi: __TEST__ ? testConfig.dcrApi : undefined,
  dashApi: __TEST__ ? testConfig.dashApi : undefined,
  zecServers: __TEST__ ? testConfig.zecServers : undefined,
  ethRpc: __TEST__ ? testConfig.ethRpc : undefined,
  tornadoPools: __TEST__ ? testConfig.tornadoPools : undefined,
  tornadoLocalRelayer: __TEST__ ? testConfig.tornadoLocalRelayer : undefined,
  ethScout: __TEST__ ? testConfig.ethScout : undefined,
});
const ready = service.init();

const listeners = new Map<string, ((p: unknown) => void)[]>();
const emit = (name: string, payload?: unknown) => { for (const fn of listeners.get(name) ?? []) fn(payload); };
if (__TEST__) (window as any).__tornadoRun = runTornado;
service.on('monero-state', (s) => emit('monero-state', s));
service.on('balance-changed', () => emit('balance-changed'));
service.on('tron-tx', (t) => emit('tron-tx', t));
service.on('locked', () => emit('locked'));
service.on('tor-state', (s) => emit('tor-state', s));
service.on('tornado-progress', (m) => emit('tornado-progress', m));

let lockTimer: ReturnType<typeof setTimeout> | undefined;
const bump = () => {
  if (lockTimer) clearTimeout(lockTimer);
  lockTimer = setTimeout(() => { void service.lock(); }, service.settings.autoLockMinutes * 60_000);
};
const call = <A extends unknown[], R>(fn: (...a: A) => R) => async (...a: A) => { await ready; bump(); return fn(...a); };

let clipTimer: ReturnType<typeof setTimeout> | undefined;

// Biometric requests finish later, in a callback from the Android side.
const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
let nextId = 1;
(window as any).__bioResult = (id: number, ok: boolean, value: string) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (ok) p.resolve(value); else p.reject(new Error(value));
};
const bioCall = (fn: (id: number) => void) => new Promise<string>((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  fn(id);
});

(window as any).__appPaused = () => { void service.flush(); };
(window as any).__appBack = () => {
  const back = document.getElementById('back');
  if (back) { back.click(); return true; }
  return false;
};

(window as any).wallet = {
  status: async () => { await ready; return service.status(); },
  generateSeeds: call(() => service.generateSeeds()),
  finishCreate: call((pw: string) => service.finishCreate(pw)),
  restore: call((pw: string, t: string, m: string, f: string) => service.restore(pw, t, m, f)),
  unlock: call((pw: string) => service.unlock(pw)),
  lock: call(() => service.lock()),
  overview: call(() => service.overview()),
  history: call((a: any) => service.history(a)),
  moneroAddresses: call(() => service.moneroAddresses()),
  newSubaddress: call(() => service.newSubaddress()),
  qr: call((t: string) => service.qr(t)),
  prepareSend: call((a: any, to: string, amt: string) => service.prepareSend(a, to, amt)),
  cancelSend: call((id: string) => service.cancelSend(id)),
  confirmSend: call((id: string, pw: string) => service.confirmSend(id, pw)),
  revealSeeds: call((pw: string) => service.revealSeeds(pw)),
  changePassword: call((c: string, n: string) => service.changePassword(c, n)),
  getSettings: call(() => service.settings),
  updateSettings: call((p: any) => service.updateSettings(p)),
  deleteWallet: call(async (pw: string) => {
    const id = await service.deleteWallet(pw);
    native.bioDisable(id);
    if (id === 'main') { await kvDelPrefix('xmr:mainnet:'); await kvDelPrefix('xmr:testnet:'); } else await kvDelPrefix(`xmr:${id}:`);
  }),
  openExplorer: call(async (a: any, h: string) => {
    const url = service.explorerUrl(a, h);
    // The phone's browser isn't behind Tor, so it would reveal the IP and the transaction together.
    if (service.settings.torEnabled) { native.copy(url); return { copied: true }; }
    native.openExternal(url);
    return { copied: false };
  }),
  activity: call(() => undefined),
  prices: call(() => service.prices()),
  paste: call(() => String(native.paste() ?? '').trim().slice(0, 200)),
  addresses: call(() => service.addresses()),
  swapQuote: call((a: any, b: any, c: string) => service.swapQuote(a, b, c)),
  swapPrepare: call((a: any, b: any, c: string, d: any, e: string) => service.swapPrepare(a, b, c, d, e)),
  privacyQuote: call((a: any, b: any, c: string) => service.privacyQuote(a, b, c)),
  privacyPrepare: call((a: any, b: any, c: string, d: any, e: string) => service.privacyPrepare(a, b, c, d, e)),
  privacyRefresh: call((id: string) => service.privacyRefresh(id)),
  privacySecondQuote: call((id: string, a: string) => service.privacySecondQuote(id, a)),
  privacySecond: call((id: string, a: string, b: any) => service.privacySecond(id, a, b)),
  privacyList: call(() => service.privacyList()),
  zecInfo: call(() => service.zecInfo()),
  zecShield: call((pw: string) => service.zecShield(pw)),
  zecRescan: call((d: string, pw: string) => service.zecRescan(d, pw)),
  walletsList: call(() => service.walletsList()),
  walletRename: call((i: string, n: string) => service.walletRename(i, n)),
  walletSwitch: call((i: string) => service.walletSwitch(i)),
  walletBeginAdd: call((n: string) => service.walletBeginAdd(n)),
  walletCancelAdd: call(() => service.walletCancelAdd()),
  feeEstimate: call((a: any) => service.feeEstimate(a)),
  tornadoInfo: call(() => service.tornadoInfo()),
  tornadoCheck: call(() => service.tornadoCheck()),
  tornadoDepositPrepare: call((p: string) => service.tornadoDepositPrepare(p)),
  tornadoDepositConfirm: call((i: string, p: string, w: string) => service.tornadoDepositConfirm(i, p, w)),
  tornadoExport: call((i: string, w: string) => service.tornadoExport(i, w)),
  tornadoWithdrawQuote: call((i: string, r: string, l: string) => service.tornadoWithdrawQuote(i, r, l)),
  tornadoWithdraw: call((i: string, r: string, l: string, w: string) => service.tornadoWithdraw(i, r, l, w)),
  tornadoRecover: call((w: string) => service.tornadoRecover(w)),
  swapConfirm: call((id: string, pw: string) => service.swapConfirm(id, pw)),
  swapRefresh: call((id: string) => service.swapRefresh(id)),
  swapList: call(() => service.swapList()),
  torInfo: call(() => service.torInfo()),
  installTor: call(() => service.installTor()),
  copy: call((text: string) => {
    native.copy(text);
    if (clipTimer) clearTimeout(clipTimer);
    clipTimer = setTimeout(() => native.clearClip(text), 60_000);
  }),
  on: (name: string, fn: (p: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
  cameraPermission: () => bioCall((id) => native.cameraPermission(id)),
  biometric: {
    available: async () => Boolean(native.bioAvailable()),
    enabled: async () => { await ready; return Boolean(native.bioEnabled(service.activeWallet)); },
    enable: (password: string) => bioCall((id) => native.bioEnable(id, service.activeWallet, password)),
    unlock: () => bioCall((id) => native.bioUnlock(id, service.activeWallet)),
    disable: async () => { native.bioDisable(service.activeWallet); },
  },
};
