export type NetworkId = 'mainnet' | 'testnet';
/** USDT is the Tron token, USDTE the Ethereum one. */
export type Asset = 'BTC' | 'XMR' | 'ETH' | 'TRX' | 'USDT' | 'USDTE' | 'DCR' | 'DASH' | 'FIRO' | 'ZEC' | 'ZANO' | 'ARRR';

export const DECIMALS: Record<Asset, number> = { BTC: 8, XMR: 12, ETH: 18, TRX: 6, USDT: 6, USDTE: 6, DCR: 8, DASH: 8, FIRO: 8, ZEC: 8, ZANO: 12, ARRR: 8 };

export const BTC_APIS = ['https://mempool.space/api', 'https://blockstream.info/api'];
export const BTC_EXPLORER_TX = 'https://mempool.space/tx/';

export const DCR_APIS = ['https://dcrdata.decred.org/insight/api', 'https://explorer.dcrdata.org/insight/api'];
export const DCR_EXPLORER_TX = 'https://dcrdata.decred.org/tx/';
export const FIRO_APIS = ['https://insight.firo.org/insight-api-zcoin', 'https://explorer.firo.org/insight-api-zcoin'];
export const FIRO_EXPLORER_TX = 'https://explorer.firo.org/tx/';
export const DASH_APIS = ['https://insight.dash.org/insight-api'];
export const DASH_EXPLORER_TX = 'https://insight.dash.org/insight/tx/';
export const ARRR_SERVERS = ['https://pirate.mathnodes.com:443', 'https://lightwalletd1.cryptoforge.cc:443', 'https://arrr.qortal.link:443', 'https://lightwalletd2.cryptoforge.cc:443', 'https://arrr2.qortal.link:443'];
export const ARRR_EXPLORER_TX = 'https://explorer.pirate.black/tx/';
export const ZANO_NODE = '37.27.100.59:10500';
export const ZANO_EXPLORER_TX = 'https://explorer.zano.org/transaction/';
export const ZEC_SERVERS = ['https://zec.rocks:443', 'https://na.zec.rocks:443', 'https://eu.zec.rocks:443', 'https://ap.zec.rocks:443', 'https://sa.zec.rocks:443'];
export const ZEC_EXPLORER_TX = 'https://blockchair.com/zcash/transaction/';
export const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com', 'https://1rpc.io/eth'];
export const ETH_SCOUT = 'https://eth.blockscout.com/api/v2';
export const ETH_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
export const ETH_EXPLORER_TX = 'https://etherscan.io/tx/';

export interface NetworkConfig {
  id: NetworkId;
  tron: { host: string; usdt: string; explorerTx: string };
  monero: { type: 'mainnet' | 'stagenet'; nodes: string[]; onionNodes: string[]; explorerTx: string };
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  mainnet: {
    id: 'mainnet',
    tron: {
      host: 'https://api.trongrid.io',
      usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      explorerTx: 'https://tronscan.org/#/transaction/',
    },
    monero: {
      type: 'mainnet',
      nodes: [
        'http://node.sethforprivacy.com:18089',
        'http://xmr-node.cakewallet.com:18081',
        'http://node.monerodevs.org:18089',
        'http://node2.monerodevs.org:18089',
      ],
      onionNodes: [
        'http://plowsof3t5hogddwabaeiyrno25efmzfxyro2vligremt7sxpsclfaid.onion:18089',
        'http://plowsoffjexmxalw73tkjmf422gq6575fc7vicuu4javzn2ynnte6tyd.onion:18089',
        'http://loveanvthlsepingenr7opdqy6nlhn5jidwvzzxfmwsw2rry5mn2gfqd.onion:18089',
        'http://ravfxmrzi3eet62s4nkuu5sgpq6otgtffluk3ylb2kuvimtb34sonryd.onion:18089',
        'http://rucknium757bokwv3ss35ftgc3gzb7hgbvvglbg3hisp7tsj2fkd2nyd.onion:18081',
        'http://moneroxmrxw44lku6qniyarpwgznpcwml4drq7vb24ppatlcg4kmxpqd.onion:18089',
      ],
      explorerTx: 'https://xmrchain.net/tx/',
    },
  },
  testnet: {
    id: 'testnet',
    tron: {
      host: 'https://nile.trongrid.io',
      usdt: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
      explorerTx: 'https://nile.tronscan.org/#/transaction/',
    },
    monero: {
      type: 'stagenet',
      nodes: ['http://node.sethforprivacy.com:38089', 'http://xmr-lux.boldsuck.org:38081'],
      onionNodes: [
        'http://plowsof3t5hogddwabaeiyrno25efmzfxyro2vligremt7sxpsclfaid.onion:38089',
        'http://plowsoffjexmxalw73tkjmf422gq6575fc7vicuu4javzn2ynnte6tyd.onion:38089',
        'http://ct36dsbe3oubpbebpxmiqz4uqk6zb6nhmkhoekileo4fts23rvuse2qd.onion:38081',
      ],
      explorerTx: 'https://stagenet.xmrchain.net/tx/',
    },
  },
};

export interface Settings {
  network: NetworkId;
  customMoneroNode: string;
  tronApiKey: string;
  autoLockMinutes: number;
  showPrices: boolean;
  torEnabled: boolean;
  simpleSwapKey: string;
  ghostSwapKey: string;
  tornadoRelayer: string;
}

export const DEFAULT_SETTINGS: Settings = {
  network: 'mainnet',
  customMoneroNode: '',
  tronApiKey: '',
  autoLockMinutes: 10,
  showPrices: true,
  torEnabled: false,
  simpleSwapKey: '',
  ghostSwapKey: '',
  tornadoRelayer: '',
};

/** Rough mainnet height for a date. Biased low: too low only means a slower scan. */
export function estimateMainnetHeight(date: Date): number {
  const anchorHeight = 3_000_000;
  const anchorTime = Date.UTC(2023, 9, 31);
  const blocks = Math.floor((date.getTime() - anchorTime) / 120_000);
  return Math.max(0, anchorHeight + blocks);
}
