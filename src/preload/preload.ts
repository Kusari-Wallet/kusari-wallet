import { contextBridge, ipcRenderer } from 'electron';

const call = (name: string) => (...args: unknown[]) => ipcRenderer.invoke(`wallet:${name}`, ...args);
const methods = ['status', 'generateSeeds', 'finishCreate', 'restore', 'unlock', 'lock', 'overview', 'history', 'zecInfo', 'zanoInfo', 'arrrInfo', 'arrrRescan', 'zecShield', 'prepareScrtPrivate', 'prepareLtcPrivate', 'dexQuote', 'dexPrepare', 'dexConfirm', 'walletMode', 'setWalletMode', 'wcInfo', 'wcPair', 'wcApprove', 'wcReject', 'wcDisconnect', 'wcDisconnectAll', 'wcDecline', 'wcRequestInfo', 'wcConfirm', 'wcPopupTake', 'devWcPopup', 'wcClipboard', 'wcScanScreen', 'wcTakeLink', 'wcRegisterLinks', 'zecRescan',
  'perpsInfo', 'perpsMarkets', 'perpsAccount', 'perpsMarket', 'perpsEnable', 'perpsPrepareOrder', 'perpsPrepareClose', 'perpsPlace', 'perpsCancel', 'perpsIndex', 'hypeCore', 'hypeToCorePrepare', 'hypeToCoreConfirm', 'hypeToEvmPrepare', 'hypeToEvmConfirm', 'perpsBook', 'perpsCandles', 'perpsDepositPrepare', 'perpsDepositConfirm', 'perpsWithdrawPrepare', 'perpsWithdrawConfirm',
  'moneroAddresses', 'newSubaddress', 'qr', 'prepareSend', 'cancelSend', 'confirmSend', 'revealSeeds',
  'changePassword', 'getSettings', 'updateSettings', 'deleteWallet', 'openExplorer', 'openBuy', 'activity', 'copy', 'prices', 'paste', 'addresses', 'torInfo', 'installTor', 'connectionLog', 'swapQuote', 'swapPrepare', 'swapConfirm', 'swapRefresh', 'swapList', 'privacyQuote', 'privacyPrepare', 'privacyRefresh', 'privacySecondQuote', 'privacySecond', 'privacyList', 'walletsList', 'walletRename', 'walletSwitch', 'walletBeginAdd', 'walletCancelAdd', 'feeEstimate', 'tornadoInfo', 'tornadoCheck', 'tornadoDepositPrepare', 'tornadoDepositConfirm', 'tornadoExport', 'tornadoWithdrawQuote', 'tornadoWithdraw', 'tornadoRecover'];
const events = ['monero-state', 'balance-changed', 'tron-tx', 'locked', 'tor-state', 'tor-install', 'tornado-progress', 'wc-proposal', 'wc-request', 'wc-sessions', 'wc-link', 'wc-refused', 'wc-popup-more'];

contextBridge.exposeInMainWorld('wallet', {
  ...Object.fromEntries(methods.map((m) => [m, call(m)])),
  on: (event: string, fn: (payload: unknown) => void) => {
    if (!events.includes(event)) throw new Error('unknown event');
    ipcRenderer.on(`wallet:${event}`, (_e, payload) => fn(payload));
  },
});
