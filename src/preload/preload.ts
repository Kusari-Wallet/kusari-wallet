import { contextBridge, ipcRenderer } from 'electron';

const call = (name: string) => (...args: unknown[]) => ipcRenderer.invoke(`wallet:${name}`, ...args);
const methods = ['status', 'generateSeeds', 'finishCreate', 'restore', 'unlock', 'lock', 'overview', 'history', 'zecInfo', 'zanoInfo', 'ksrInfo', 'arrrInfo', 'arrrRescan', 'zecShield', 'prepareScrtPrivate', 'prepareLtcPrivate', 'prepareFiroPrivate', 'prepareDashMix', 'prepareDashPrivate', 'coinjoinPause', 'dexQuote', 'dexPrepare', 'dexConfirm', 'zecRescan',
  'moneroAddresses', 'newSubaddress', 'ethAddresses', 'ethAddressNew', 'ethAddressesFind', 'qr', 'prepareSend', 'btcCoins', 'btcCoinSet', 'btcMixInfo', 'btcMixStart', 'btcMixStop', 'cancelSend', 'confirmSend', 'revealSeeds',
  'changePassword', 'getSettings', 'updateSettings', 'deleteWallet', 'openExplorer', 'openBuy', 'activity', 'copy', 'prices', 'paste', 'addresses', 'torInfo', 'installTor', 'connectionLog', 'swapQuote', 'swapPrepare', 'swapConfirm', 'swapRefresh', 'swapList', 'privacyQuote', 'privacyPrepare', 'privacyRefresh', 'privacySecondQuote', 'privacySecond', 'privacyList', 'walletsList', 'walletRename', 'duressStatus', 'duressSet', 'duressRemove', 'btcSpeedUp', 'delayedSends', 'walletSwitch', 'walletBeginAdd', 'walletCancelAdd', 'feeEstimate', 'tornadoInfo', 'tornadoCheck', 'tornadoDepositPrepare', 'tornadoDepositConfirm', 'tornadoExport', 'tornadoWithdrawQuote', 'tornadoWithdraw', 'tornadoSplitPrepare', 'tornadoSplitConfirm', 'tornadoRecover', 'dcrStakeInfo', 'dcrVspList', 'dcrStakeQuote', 'dcrStakeBuy', 'dcrStakeFinish', 'dcrTickets'];
const events = ['monero-state', 'balance-changed', 'tron-tx', 'locked', 'tor-state', 'tor-install', 'tornado-progress'];

contextBridge.exposeInMainWorld('wallet', {
  ...Object.fromEntries(methods.map((m) => [m, call(m)])),
  on: (event: string, fn: (payload: unknown) => void) => {
    if (!events.includes(event)) throw new Error('unknown event');
    ipcRenderer.on(`wallet:${event}`, (_e, payload) => fn(payload));
  },
});
