export type NetworkId = 'mainnet' | 'testnet';
/**
 * USDT is the Tron token, USDTE the Ethereum one, USDTS Solana's, USDTP Polygon's and USDTA Arbitrum's.
 * ETHA is ETH on Arbitrum, which pays Arbitrum's fees; ARB is the token.
 */
export type Asset = 'BTC' | 'XMR' | 'ETH' | 'TRX' | 'USDT' | 'USDTE' | 'LINK' | 'SOL' | 'USDTS' | 'POL' | 'USDTP' | 'ARB' | 'ETHA' | 'USDTA' | 'BCH' | 'LTC' | 'DOGE' | 'DASH' | 'FIRO' | 'ZEC' | 'ZANO' | 'ARRR' | 'ETHP' | 'PEPE' | 'BNB' | 'USDTB' | 'USDCE' | 'USDCB' | 'USDCS' | 'USDCP' | 'USDCA' | 'SHIB' | 'ORCA' | 'PUMP' | 'DCR' | 'GRAM' | 'USDTT';

export const DECIMALS: Record<Asset, number> = { GRAM: 9, USDTT: 6, DCR: 8, SHIB: 18, ORCA: 6, PUMP: 6, USDCE: 6, USDCB: 18, USDCS: 6, USDCP: 6, USDCA: 6, BTC: 8, XMR: 12, ETH: 18, TRX: 6, USDT: 6, USDTE: 6, LINK: 18, SOL: 9, USDTS: 6, POL: 18, USDTP: 6, ARB: 18, ETHA: 18, USDTA: 6, BCH: 8, LTC: 8, DOGE: 8, DASH: 8, FIRO: 8, ZEC: 8, ZANO: 12, ARRR: 8, ETHP: 18, PEPE: 18, BNB: 18, USDTB: 18 };

export const BTC_APIS = ['https://mempool.space/api', 'https://blockstream.info/api'];
/**
 * The same two explorers' own onion services (from their Onion-Location headers). Over Tor these come first: no exit
 * node in between, so nothing for the site to block and no exit to time out.
 */
/**
 * Silent Payments tweaks for each block (a BlindBit index server, v1 API: /tweak-index/<height>). Every block's list
 * is fetched, so the server learns nothing about the wallet; reached through Tor.
 */
export const SP_TWEAK_SERVER = 'https://silentpayments.dev/blindbit/mainnet';
/** More tweaks than one block can have transactions (a 4 MB block holds about 12,000 of the smallest). */
export const SP_MAX_TWEAKS = 15_000;
export const BTC_ONION_APIS = ['http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api', 'http://explorerzydxu5ecjrkwceayqybizmpjjznk5izmitf2modhcusuqlid.onion/api'];
export const BTC_EXPLORER_TX = 'https://mempool.space/tx/';

// TON's toncenter (v2 JSON-RPC and v3 index).
export const TON_APIS = ['https://toncenter.com'];
export const SOL_RPCS = ['https://api.mainnet-beta.solana.com', 'https://api.mainnet.solana.com', 'https://solana-rpc.publicnode.com'];
export const SOL_EXPLORER_TX = 'https://solscan.io/tx/';
// Buying opens LocalCoinSwap's P2P marketplace in the browser. The code only credits the referral account.
export const BUY_PAGE = 'https://localcoinswap.com/';
// BitPay's public Bitcore API. It needs no key.
// The Litecoin project's mempool site, the same API as mempool.space.
/** A blockbook+ entry is a Blockbook server, read through an Esplora-shaped adapter. */
export const LTC_APIS = ['https://litecoinspace.org/api', 'blockbook+https://litecoinblockexplorer.net'];
export const LTC_EXPLORER_TX = 'https://litecoinspace.org/tx/';
// Public Secret Network REST (LCD) servers, from the Cosmos chain registry. Each is checked to be on secret-4 before use.
export const BCH_APIS = ['https://api.bitcore.io/api/BCH/mainnet', 'blockbook+https://blockbook.bch.zelcore.io'];
export const BCH_EXPLORER_TX = 'https://blockchair.com/bitcoin-cash/transaction/';
export const DOGE_APIS = ['https://api.blockcypher.com/v1/doge/main'];
// BlockCypher only takes POST with a token, which an app can't keep secret, so it reads and these two send.
// Sending the same transaction twice is harmless. BlockCypher then confirms it from outside.
// dogechain.info's push answers 404 now. Blockchair's was checked to answer; BlockCypher's is its documented push.
export const DOGE_PUSH_URLS = ['https://api.blockchair.com/dogecoin/push/transaction', 'https://api.blockcypher.com/v1/doge/main/txs/push', 'https://dogechain.com/api/v1/pushtx'];
/** Asked when BlockCypher can't answer: coins and used addresses, per address. */
export const DOGE_BACKUP = 'https://dogechain.com/api/v1';
export const DOGE_RAW_URLS = ['https://api.blockchair.com/dogecoin/raw/transaction/'];
export const DOGE_EXPLORER_TX = 'https://dogechain.info/tx/';
export const FIRO_APIS = ['https://insight.firo.org/insight-api-zcoin', 'https://explorer.firo.org/insight-api-zcoin'];
export const FIRO_EXPLORER_TX = 'https://explorer.firo.org/tx/';
export const DASH_APIS = ['https://insight.dash.org/insight-api', 'https://explorer.dash.org/insight-api'];
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

export interface NetworkConfig {
  id: NetworkId;
  /** backup: a second full node for balances and broadcasts when TronGrid limits or drops a request. */
  tron: { host: string; backup?: string; usdt: string; explorerTx: string };
  monero: { type: 'mainnet' | 'stagenet'; nodes: string[]; onionNodes: string[]; explorerTx: string };
}

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  mainnet: {
    id: 'mainnet',
    tron: {
      host: 'https://api.trongrid.io',
      backup: 'https://tron-rpc.publicnode.com',
      usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      explorerTx: 'https://tronscan.org/#/transaction/',
    },
    monero: {
      type: 'mainnet',
      nodes: [
        'http://node.sethforprivacy.com:18089',
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
  /** The person's own servers: a BTC Esplora/mempool API, a Zano node. Empty uses the public ones. */
  customBtcServer: string;
  customZanoNode: string;
  /** A server of one's own per coin (see OWN_SERVER_COINS), asked instead of the public ones. */
  customServers?: Record<string, string>;
  /** The CoinJoin coordinator for Bitcoin, as its address. */
  coinjoinCoordinator: string;
  /** Mix until each Bitcoin coin hides among this many others (1: mix once). */
  coinjoinTarget: number;
  tronApiKey: string;
  showPrices: boolean;
  torEnabled: boolean;
  /** Set once Tor has been turned on by default (0.57): older settings files had it off without anyone choosing that. */
  torDefaultOn?: boolean;
  /** The open wallet's EVM layout (each chain its own address); kept with the wallet, not in the settings file. */
  evmSeparate?: boolean;
  /** A developer build (see flavor.ts); never saved. */
  developer?: boolean;
  /**
   * Private Bitcoin sync with block filters for the open wallet, and the date it scans from (YYYY-MM-DD). Kept with
   * the wallet, encrypted, not in the settings file.
   */
  btcFilters?: boolean;
  /** The open wallet has a BIP39 passphrase (never the passphrase itself). Not saved. */
  passphrase?: boolean;
  btcFiltersFrom?: string;
  /** How Tor connects: auto, straight, or through Snowflake, obfs4 or the user's own bridges. */
  torBridge: 'auto' | 'none' | 'snowflake' | 'obfs4' | 'custom';
  torBridgeLines: string;
  simpleSwapKey: string;
  ghostSwapKey: string;
  tornadoRelayer: string;
}

export const DEFAULT_SETTINGS: Settings = {
  network: 'mainnet',
  customMoneroNode: '',
  customBtcServer: '',
  customZanoNode: '',
  customServers: {},
  coinjoinCoordinator: 'https://coinjoin.kruw.io/',
  coinjoinTarget: 5,
  tronApiKey: '',
  showPrices: true,
  torEnabled: true,
  torDefaultOn: true,
  torBridge: 'auto',
  torBridgeLines: '',
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

/**
 * Coins that can use a server of one's own, and what kind of server each one speaks. EVM chains and Solana take any
 * JSON-RPC node, Tron a java-tron HTTP API, Litecoin an Esplora API (or Blockbook, written blockbook+https://...),
 * Bitcoin Cash Bitcore (or Blockbook), Dash, Firo and Decred an Insight API (Decred: dcrdata's /insight/api), Secret a REST (LCD) server,
 * Zcash and Pirate Chain a lightwalletd.
 */
export const OWN_SERVER_COINS: { coin: string; kind: string; example: string; blockbook?: boolean }[] = [
  { coin: 'ETH', kind: 'JSON-RPC', example: 'http://192.168.1.20:8545' },
  { coin: 'BSC', kind: 'JSON-RPC', example: 'https://bsc.example/rpc' },
  { coin: 'POL', kind: 'JSON-RPC', example: 'https://polygon.example/rpc' },
  { coin: 'ARB', kind: 'JSON-RPC', example: 'https://arbitrum.example/rpc' },
  { coin: 'SOL', kind: 'JSON-RPC', example: 'http://192.168.1.20:8899' },
  { coin: 'TRX', kind: 'java-tron HTTP API', example: 'http://192.168.1.20:8090' },
  { coin: 'LTC', kind: 'Esplora or Blockbook', example: 'http://umbrel.local:3006/api', blockbook: true },
  { coin: 'BCH', kind: 'Bitcore or Blockbook', example: 'blockbook+https://bch.example', blockbook: true },
  { coin: 'DASH', kind: 'Insight API', example: 'http://192.168.1.20:3001/insight-api' },
  { coin: 'FIRO', kind: 'Insight API', example: 'http://192.168.1.20:3001/insight-api-zcoin' },
  { coin: 'DCR', kind: 'Insight API (dcrdata)', example: 'http://192.168.1.20:7777/insight/api' },
  { coin: 'ZEC', kind: 'lightwalletd', example: 'https://192.168.1.20:9067' },
  { coin: 'ARRR', kind: 'lightwalletd', example: 'https://192.168.1.20:9067' },
];
