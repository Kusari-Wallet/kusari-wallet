export type NetworkId = 'mainnet' | 'testnet';
/**
 * USDT is the Tron token, USDTE the Ethereum one, USDTS Solana's, USDTP Polygon's and USDTA Arbitrum's.
 * ETHA is ETH on Arbitrum, which pays Arbitrum's fees; ARB is the token.
 */
export type Asset = 'BTC' | 'XMR' | 'ETH' | 'TRX' | 'USDT' | 'USDTE' | 'LINK' | 'WLD' | 'SOL' | 'USDTS' | 'POL' | 'USDTP' | 'ARB' | 'ETHA' | 'USDTA' | 'BCH' | 'LTC' | 'DOGE' | 'DASH' | 'FIRO' | 'ZEC' | 'ZANO' | 'ARRR' | 'SCRT' | 'SSCRT' | 'ETHP' | 'UNI' | 'PEPE' | 'AAVE' | 'BNB' | 'USDTB' | 'ASTER' | 'CAKE' | 'JUP' | 'RAY' | 'NEAR' | 'USDCE' | 'USDCB' | 'USDCS' | 'USDCP' | 'USDCA' | 'HYPE' | 'SHIB' | 'SHIBB' | 'LINKB' | 'UNIB' | 'AAVEB' | 'LINKP' | 'UNIP' | 'AAVEP' | 'LINKA' | 'UNIA' | 'ORCA' | 'PUMP' | 'ADA';

export const DECIMALS: Record<Asset, number> = { ADA: 6, SHIB: 18, SHIBB: 18, LINKB: 18, UNIB: 18, AAVEB: 18, LINKP: 18, UNIP: 18, AAVEP: 18, LINKA: 18, UNIA: 18, ORCA: 6, PUMP: 6, HYPE: 18, USDCE: 6, USDCB: 18, USDCS: 6, USDCP: 6, USDCA: 6, BTC: 8, XMR: 12, ETH: 18, TRX: 6, USDT: 6, USDTE: 6, LINK: 18, WLD: 18, SOL: 9, USDTS: 6, POL: 18, USDTP: 6, ARB: 18, ETHA: 18, USDTA: 6, BCH: 8, LTC: 8, DOGE: 8, DASH: 8, FIRO: 8, ZEC: 8, ZANO: 12, ARRR: 8, SCRT: 6, SSCRT: 6, ETHP: 18, UNI: 18, PEPE: 18, AAVE: 18, BNB: 18, USDTB: 18, ASTER: 18, CAKE: 18, JUP: 6, RAY: 6, NEAR: 24 };

export const BTC_APIS = ['https://mempool.space/api', 'https://blockstream.info/api'];
export const BTC_EXPLORER_TX = 'https://mempool.space/tx/';

export const SOL_RPCS = ['https://api.mainnet-beta.solana.com', 'https://api.mainnet.solana.com', 'https://solana-rpc.publicnode.com'];
export const SOL_EXPLORER_TX = 'https://solscan.io/tx/';
// Buying opens LocalCoinSwap's P2P marketplace in the browser. The code only credits the referral account.
export const BUY_PAGE = 'https://localcoinswap.com/?rc=FE969A35';
// BitPay's public Bitcore API. It needs no key.
// The Litecoin project's mempool site, the same API as mempool.space.
export const LTC_APIS = ['https://litecoinspace.org/api'];
export const LTC_EXPLORER_TX = 'https://litecoinspace.org/tx/';
// Public Secret Network REST (LCD) servers, from the Cosmos chain registry. Each is checked to be on secret-4 before use.
export const SCRT_LCDS = ['https://rest.lavenderfive.com:443/secretnetwork', 'https://lcd-secret.keplr.app', 'https://secretnetwork-api.lavenderfive.com:443', 'https://rest-secret.01node.com'];
// NEAR's own RPC keeps no history; NearBlocks' public API does, without a key.
export const NEAR_RPCS = ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org', 'https://rpc.mainnet.fastnear.com'];
export const NEAR_HISTORY = 'https://api.nearblocks.io/v1';
export const NEAR_EXPLORER_TX = 'https://nearblocks.io/txns/';
export const SCRT_EXPLORER_TX = 'https://www.mintscan.io/secret/tx/';
export const BCH_APIS = ['https://api.bitcore.io/api/BCH/mainnet'];
export const BCH_EXPLORER_TX = 'https://blockchair.com/bitcoin-cash/transaction/';
export const DOGE_APIS = ['https://api.blockcypher.com/v1/doge/main'];
// BlockCypher only takes POST with a token, which an app can't keep secret, so it reads and these two send.
// Sending the same transaction twice is harmless. BlockCypher then confirms it from outside.
// dogechain.info's push answers 404 now. Blockchair's was checked to answer; BlockCypher's is its documented push.
export const DOGE_PUSH_URLS = ['https://api.blockchair.com/dogecoin/push/transaction', 'https://api.blockcypher.com/v1/doge/main/txs/push'];
export const DOGE_EXPLORER_TX = 'https://dogechain.info/tx/';
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
export const POL_RPCS = ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com', 'https://1rpc.io/matic'];
export const POL_SCOUT = 'https://polygon.blockscout.com/api/v2';
export const POL_EXPLORER_TX = 'https://polygonscan.com/tx/';
export const ARB_RPCS = ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://1rpc.io/arb'];
export const ARB_SCOUT = 'https://arbitrum.blockscout.com/api/v2';
export const ARB_EXPLORER_TX = 'https://arbiscan.io/tx/';
export const BSC_RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.drpc.org'];
// No keyless history service covers BNB Smart Chain (checked: Blockscout doesn't run it, Routescan answers 'chain not
// supported', Etherscan's free tier excludes it, Blockchair blocks without a key). Empty means no history list.
export const BSC_SCOUT = '';
export const BSC_EXPLORER_TX = 'https://bscscan.com/tx/';
// HyperEVM, Hyperliquid's EVM chain (id 999), whose gas coin is HYPE. Like BNB Smart Chain, no keyless history
// service covers it (no Blockscout; HyperEVMScan wants a key), so there is no history list.
export const HYPE_RPCS = ['https://rpc.hyperliquid.xyz/evm', 'https://hyperliquid-rpc.publicnode.com', 'https://hyperliquid.drpc.org'];
export const HYPE_SCOUT = '';
export const HYPE_EXPLORER_TX = 'https://hyperevmscan.io/tx/';

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
