declare const wallet: any;
declare const jsQR: any;

type Asset = 'BTC' | 'XMR' | 'ETH' | 'TRX' | 'USDT' | 'USDTE' | 'LINK' | 'WLD' | 'SOL' | 'USDTS' | 'POL' | 'USDTP' | 'ARB' | 'ETHA' | 'USDTA' | 'BCH' | 'LTC' | 'DOGE' | 'DASH' | 'FIRO' | 'ZEC' | 'ZANO' | 'ARRR' | 'SCRT' | 'ETHP' | 'UNI' | 'PEPE' | 'AAVE' | 'BNB' | 'USDTB' | 'ASTER' | 'CAKE' | 'JUP' | 'RAY' | 'NEAR' | 'USDCE' | 'USDCB' | 'USDCS' | 'USDCP' | 'USDCA' | 'SSCRT' | 'HYPE' | 'SHIB' | 'SHIBB' | 'LINKB' | 'UNIB' | 'AAVEB' | 'LINKP' | 'UNIP' | 'AAVEP' | 'LINKA' | 'UNIA' | 'ORCA' | 'PUMP' | 'ADA';
type Attrs = Record<string, any>;
type Child = Node | string | null | undefined | false;

const ALL_ASSETS: Asset[] = ['XMR', 'BTC', 'ETH', 'USDTE', 'USDCE', 'LINK', 'WLD', 'UNI', 'PEPE', 'AAVE', 'SHIB', 'ZEC', 'SOL', 'USDTS', 'USDCS', 'JUP', 'RAY', 'ORCA', 'PUMP', 'TRX', 'USDT', 'HYPE', 'BNB', 'USDTB', 'USDCB', 'ASTER', 'CAKE', 'SHIBB', 'LINKB', 'UNIB', 'AAVEB', 'POL', 'ETHP', 'USDTP', 'USDCP', 'LINKP', 'UNIP', 'AAVEP', 'ARB', 'ETHA', 'USDTA', 'USDCA', 'LINKA', 'UNIA', 'BCH', 'LTC', 'ADA', 'NEAR', 'SCRT', 'SSCRT', 'DOGE', 'DASH', 'FIRO', 'ZANO', 'ARRR'];
/** Tokens shown under the coin of their chain on the home screen, folded until opened. */
const GROUPS: Partial<Record<Asset, Asset[]>> = { ETH: ['USDTE', 'USDCE', 'LINK', 'WLD', 'UNI', 'PEPE', 'AAVE', 'SHIB'], SOL: ['USDTS', 'USDCS', 'JUP', 'RAY', 'ORCA', 'PUMP'], TRX: ['USDT'], BNB: ['USDTB', 'USDCB', 'ASTER', 'CAKE', 'SHIBB', 'LINKB', 'UNIB', 'AAVEB'], POL: ['ETHP', 'USDTP', 'USDCP', 'LINKP', 'UNIP', 'AAVEP'], ARB: ['ETHA', 'USDTA', 'USDCA', 'LINKA', 'UNIA'], SCRT: ['SSCRT'] };
const IN_GROUP = new Set(Object.values(GROUPS).flat());
const GROUP_OF: Partial<Record<Asset, Asset>> = Object.fromEntries(Object.entries(GROUPS).flatMap(([parent, kids]) => (kids ?? []).map((k) => [k, parent])));
const EVM_ASSETS: Asset[] = ['ETH', 'USDTE', 'USDCE', 'LINK', 'WLD', 'ETHP', 'UNI', 'PEPE', 'AAVE', 'POL', 'USDTP', 'ARB', 'ETHA', 'USDTA', 'BNB', 'USDTB', 'ASTER', 'CAKE', 'USDCB', 'USDCP', 'USDCA', 'HYPE', 'SHIB', 'SHIBB', 'LINKB', 'UNIB', 'AAVEB', 'LINKP', 'UNIP', 'AAVEP', 'LINKA', 'UNIA'];
const SPL_ASSETS: Asset[] = ['USDTS', 'USDCS', 'JUP', 'RAY', 'ORCA', 'PUMP'];
const BSC_ASSETS: Asset[] = ['BNB', 'USDTB', 'USDCB', 'ASTER', 'CAKE', 'SHIBB', 'LINKB', 'UNIB', 'AAVEB'];
// These need their engines, which aren't in every build or on every phone.
let ASSETS: Asset[] = ALL_ASSETS.filter((a) => a !== 'ZEC' && a !== 'ZANO' && a !== 'ARRR');
let zecInSession = false;
let refreshNote = 'no answer yet';
const COIN: Record<Asset, { label: string; file: string; note: string }> = {
  BTC: { label: 'BTC', file: 'coins/btc.png', note: 'The fee depends on the network and is shown on the review screen.' },
  TRX: { label: 'TRX', file: 'coins/trx.png', note: 'The fee for sending USDT is also paid in TRX.' },
  USDT: { label: 'USDT (Tron)', file: 'coins/usdt.png', note: 'Tron network only. Don\'t send to addresses on other chains.' },
  XMR: { label: 'XMR', file: 'coins/xmr.png', note: '' },
  SOL: { label: 'SOL', file: 'coins/sol.png', note: 'Solana mainnet only. The fee is paid in SOL.' },
  USDTS: { label: 'USDT (Sol)', file: 'coins/usdt.png', note: 'Solana network (SPL) only. SOL is needed for the fee. Don\'t send to addresses on other chains.' },
  BCH: { label: 'BCH', file: 'coins/bch.png', note: 'Bitcoin Cash only, to CashAddr addresses (q…). The fee is paid in BCH.' },
  LTC: { label: 'LTC', file: 'coins/ltc.png', note: 'Litecoin only. The fee depends on the network and is shown on the review screen.' },
  SSCRT: { label: 'sSCRT', file: 'coins/scrt.png', note: 'Private SCRT on Secret Network. Its balance and transfers are encrypted, so only you and the other side can see them. The fee is paid in plain SCRT.' },
  SCRT: { label: 'SCRT', file: 'coins/scrt.png', note: 'Plain SCRT on Secret Network. These transfers are public on the chain. Sends carry no memo, so don\'t send to an exchange that asks for one.' },
  NEAR: { label: 'NEAR', file: 'coins/near.png', note: 'NEAR on its own network. The fee is paid in NEAR, and every account keeps a little NEAR for its storage.' },
  DOGE: { label: 'DOGE', file: 'coins/doge.png', note: 'Dogecoin mainnet only. The fee is paid in DOGE.' },
  ADA: { label: 'ADA', file: 'coins/ada.png', note: 'Cardano mainnet only. The fee is paid in ADA, and every payment must carry about 1 ADA or more. Coins holding other Cardano tokens are not spent from here.' },
  FIRO: { label: 'FIRO', file: 'coins/firo.png', note: 'Public FIRO plus a private (Spark) balance, whose amounts and addresses are hidden on the chain.' },
  DASH: { label: 'DASH', file: 'coins/dash.png', note: 'Dash mainnet only. The fee is paid in DASH.' },
  ARRR: { label: 'ARRR', file: 'coins/arrr.png', note: 'Every Pirate Chain transaction is shielded. The fee is paid in ARRR.' },
  ZANO: { label: 'ZANO', file: 'coins/zano.png', note: 'Received coins can be used after 10 confirmations. The fee is a fixed 0.01 ZANO.' },
  ZEC: { label: 'ZEC', file: 'coins/zec.png', note: 'Sent from your shielded balance. The fee is paid in ZEC.' },
  ETH: { label: 'ETH', file: 'coins/eth.png', note: 'The fee for sending USDT (Eth) is also paid in ETH.' },
  USDTE: { label: 'USDT (Eth)', file: 'coins/usdt.png', note: 'Ethereum network only. ETH is needed for the fee. Don\'t send to addresses on other chains.' },
  LINK: { label: 'LINK', file: 'coins/link.png', note: 'Chainlink on Ethereum (ERC-20) only. ETH is needed for the fee.' },
  WLD: { label: 'WLD', file: 'coins/wld.png', note: 'Worldcoin on Ethereum (ERC-20) only. ETH is needed for the fee.' },
  POL: { label: 'POL', file: 'coins/pol.png', note: 'Polygon network only. The fee is paid in POL.' },
  USDTP: { label: 'USDT (Pol)', file: 'coins/usdt.png', note: 'Polygon network only. POL is needed for the fee. Don\'t send to addresses on other chains.' },
  ARB: { label: 'ARB', file: 'coins/arb.png', note: 'The ARB token on Arbitrum One. The fee is paid in ETH (Arb).' },
  ETHA: { label: 'ETH (Arb)', file: 'coins/eth.png', note: 'ETH on Arbitrum One. It pays the fees for ARB and USDT (Arb).' },
  USDTA: { label: 'USDT (Arb)', file: 'coins/usdt.png', note: 'Arbitrum One only. ETH (Arb) is needed for the fee. Don\'t send to addresses on other chains.' },
  ETHP: { label: 'ETH (Pol)', file: 'coins/eth.png', note: 'ETH on Polygon (bridged, a POL-network token). It isn\'t ETH on Ethereum. POL is needed for the fee.' },
  UNI: { label: 'UNI', file: 'coins/uni.png', note: 'Uniswap on Ethereum (ERC-20) only. ETH is needed for the fee.' },
  PEPE: { label: 'PEPE', file: 'coins/pepe.png', note: 'PEPE on Ethereum (ERC-20) only. ETH is needed for the fee.' },
  AAVE: { label: 'AAVE', file: 'coins/aave.png', note: 'Aave on Ethereum (ERC-20) only. ETH is needed for the fee.' },
  BNB: { label: 'BNB', file: 'coins/bnb.png', note: 'BNB Smart Chain (BEP-20) only. The fee is paid in BNB. No free service lists BNB Smart Chain history, so past transfers show on bscscan.com, not here.' },
  USDTB: { label: 'USDT (BNB)', file: 'coins/usdt.png', note: 'BNB Smart Chain (BEP-20) only. BNB is needed for the fee. Don\'t send to addresses on other chains. No free service lists BNB Smart Chain history, so past transfers show on bscscan.com, not here.' },
  ASTER: { label: 'ASTER', file: 'coins/aster.png', note: 'Aster on BNB Smart Chain (BEP-20) only. BNB is needed for the fee. No free service lists BNB Smart Chain history, so past transfers show on bscscan.com, not here.' },
  CAKE: { label: 'CAKE', file: 'coins/cake.png', note: 'PancakeSwap on BNB Smart Chain (BEP-20) only. BNB is needed for the fee. No free service lists BNB Smart Chain history, so past transfers show on bscscan.com, not here.' },
  JUP: { label: 'JUP', file: 'coins/jup.png', note: 'Jupiter on Solana (SPL) only. SOL is needed for the fee.' },
  USDCE: { label: 'USDC (Eth)', file: 'coins/usdc.png', note: 'Ethereum network only (ERC-20). ETH is needed for the fee. Don\'t send to addresses on other chains.' },
  USDCB: { label: 'USDC (BNB)', file: 'coins/usdc.png', note: 'BNB Smart Chain (BEP-20) only. BNB is needed for the fee. No free service lists BNB Smart Chain history, so past transfers show on bscscan.com, not here.' },
  USDCS: { label: 'USDC (Sol)', file: 'coins/usdc.png', note: 'Solana (SPL) only. SOL is needed for the fee.' },
  USDCP: { label: 'USDC (Pol)', file: 'coins/usdc.png', note: 'Polygon network only (native USDC, not USDC.e). POL is needed for the fee.' },
  USDCA: { label: 'USDC (Arb)', file: 'coins/usdc.png', note: 'Arbitrum One only (native USDC, not USDC.e). ETH (Arb) is needed for the fee.' },
  HYPE: { label: 'HYPE', file: 'coins/hype.png', note: 'HYPE on HyperEVM (chain 999) only, not Hyperliquid\'s own trading chain. The fee is paid in HYPE. No free service lists HyperEVM history, so past transfers show on hyperevmscan.io, not here.' },
  RAY: { label: 'RAY', file: 'coins/ray.png', note: 'Raydium on Solana (SPL) only. SOL is needed for the fee.' },
  SHIB: { label: 'SHIB', file: 'coins/shib.png', note: 'Shiba Inu on Ethereum (ERC-20) only. ETH is needed for the fee.' },
  SHIBB: { label: 'SHIB (BNB)', file: 'coins/shib.png', note: 'Shiba Inu on BNB Smart Chain (BEP-20) only. BNB is needed for the fee. No free service lists BNB Smart Chain history, so past transfers show on bscscan.com, not here.' },
  LINKB: { label: 'LINK (BNB)', file: 'coins/link.png', note: 'Chainlink on BNB Smart Chain (BEP-20) only. BNB is needed for the fee. No free service lists BNB Smart Chain history, so past transfers show on bscscan.com, not here.' },
  UNIB: { label: 'UNI (BNB)', file: 'coins/uni.png', note: 'Uniswap on BNB Smart Chain (BEP-20) only. BNB is needed for the fee. No free service lists BNB Smart Chain history, so past transfers show on bscscan.com, not here.' },
  AAVEB: { label: 'AAVE (BNB)', file: 'coins/aave.png', note: 'Aave on BNB Smart Chain (BEP-20) only. BNB is needed for the fee. No free service lists BNB Smart Chain history, so past transfers show on bscscan.com, not here.' },
  LINKP: { label: 'LINK (Pol)', file: 'coins/link.png', note: 'Chainlink on Polygon only (bridged). POL is needed for the fee.' },
  UNIP: { label: 'UNI (Pol)', file: 'coins/uni.png', note: 'Uniswap on Polygon only (bridged). POL is needed for the fee.' },
  AAVEP: { label: 'AAVE (Pol)', file: 'coins/aave.png', note: 'Aave on Polygon only (bridged). POL is needed for the fee.' },
  LINKA: { label: 'LINK (Arb)', file: 'coins/link.png', note: 'Chainlink on Arbitrum One only. ETH (Arb) is needed for the fee.' },
  UNIA: { label: 'UNI (Arb)', file: 'coins/uni.png', note: 'Uniswap on Arbitrum One only. ETH (Arb) is needed for the fee.' },
  ORCA: { label: 'ORCA', file: 'coins/orca.png', note: 'Orca on Solana (SPL) only. SOL is needed for the fee.' },
  PUMP: { label: 'PUMP', file: 'coins/pump.png', note: 'pump.fun\'s PUMP on Solana only (a Token-2022 token). SOL is needed for the fee.' },
};
const coinName = (a: Asset): string => COIN[a]?.label ?? a;
/** The unit after an amount. The three USDTs are all just USDT there; the screen around them names the chain. */
/** The same token on another chain: its unit is still the token's own symbol. */
const SAME_TOKEN: Partial<Record<Asset, string>> = { SHIBB: 'SHIB', LINKB: 'LINK', LINKP: 'LINK', LINKA: 'LINK', UNIB: 'UNI', UNIP: 'UNI', UNIA: 'UNI', AAVEB: 'AAVE', AAVEP: 'AAVE' };
const unitOf = (a: Asset): string => (SAME_TOKEN[a] ? SAME_TOKEN[a]! : a === 'SSCRT' ? 'sSCRT' : a.startsWith('USDC') ? 'USDC' : a === 'USDTE' || a === 'USDTS' || a === 'USDTP' || a === 'USDTA' || a === 'USDTB' ? 'USDT' : a === 'ETHA' || a === 'ETHP' ? 'ETH' : a);

const root = document.getElementById('app') as HTMLElement;
let selected: Asset = 'TRX';
let overview: any = null;
let addresses: Record<Asset, string> | null = null;
let torState: any = null;
let prices: any = null;
let pollTimer: number | undefined;
let homeTab: 'assets' | 'history' = 'assets';
let onData: (() => void) | null = null;
let hideBalance = false;
try { hideBalance = localStorage.getItem('hideBalance') === '1'; } catch { /* no storage */ }

const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'polyline', 'line']);

function h(tag: string, attrs: Attrs = {}, ...children: Child[]): any {
  const el: any = SVG_TAGS.has(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function setKids(el: Element, ...kids: Child[]): void {
  el.replaceChildren(...kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false));
}

function icon(name: keyof typeof ICONS): SVGElement {
  return h('svg', { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, h('path', { d: ICONS[name] }));
}

const ICONS = {
  wallet: 'M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5zM15 12h5',
  send: 'M6 18 18 6M8 6h10v10',
  receive: 'M12 4v15M5 12l7 7 7-7',
  back: 'M20 12H4M11 5l-7 7 7 7',
  down: 'M6 9l6 6 6-6',
  refresh: 'M20 11a8 8 0 0 0-14-4.5L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14 4.5l2-2M20 20v-4.5h-4.5',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M4 4l16 16M10 5.2A10 10 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-3.2 4M6.5 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.4-1',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13.5l1.6 1.2-2 3.4-1.9-.8a7.6 7.6 0 0 1-2.1 1.2L14.7 21h-4l-.3-2.5a7.6 7.6 0 0 1-2.1-1.2l-1.9.8-2-3.4 1.6-1.2a7.5 7.5 0 0 1 0-3l-1.6-1.2 2-3.4 1.9.8a7.6 7.6 0 0 1 2.1-1.2L10.7 3h4l.3 2.5a7.6 7.6 0 0 1 2.1 1.2l1.9-.8 2 3.4-1.6 1.2a7.5 7.5 0 0 1 0 3z',
  home: 'M4 11l8-7 8 7v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19zM9 16.5h6',
  lock: 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7.5a4 4 0 0 1 8 0V11',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16',
  close: 'M5 5l14 14M19 5L5 19',
  swap: 'M17 3l4 4-4 4M21 7H8a4 4 0 0 0-4 4M7 21l-4-4 4-4M3 17h13a4 4 0 0 0 4-4',
  buy: 'M3.5 6.5h17a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM2.5 10.5h19M6.5 14.5h4',
  shield: 'M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z',
  chart: 'M4 19h16M6 15l4-5 3 3 5-7M15 6h3v3',
  paste: 'M9 4h6v3H9zM9 5.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-3M9 13h6M9 17h4',
};

function coin(asset: Asset): HTMLElement {
  const img = h('img', { class: 'coin', src: COIN[asset].file, alt: '' });
  // Same token on several chains: the badge is what tells them apart at a glance.
  const badge: Partial<Record<Asset, string>> = { USDT: 'trx', USDTE: 'eth', USDTS: 'sol', USDTP: 'pol', USDTA: 'arb', ETHA: 'arb', USDTB: 'bnb', ETHP: 'pol', USDCE: 'eth', USDCB: 'bnb', USDCS: 'sol', USDCP: 'pol', USDCA: 'arb' };
  if (asset === 'SSCRT') return h('span', { class: 'coin-wrap' }, img, h('span', { class: 'coin-badge private-badge', 'aria-hidden': 'true' }, icon('lock')));
  if (!badge[asset]) return img;
  return h('span', { class: 'coin-wrap' }, img, h('img', { class: 'coin-badge', src: `coins/${badge[asset]}.png`, alt: '' }));
}

const tiny = (usd: number) => usd > 0 && usd < 0.01;
function usdFee(usd: number): string {
  return tiny(usd) ? 'under $0.01' : usdFormat(Math.max(usd, 0));
}
/** "about $1.20", or "under $0.01" on its own: "about under" reads badly in every language. */
function aboutUsd(usd: number): string {
  return tiny(usd) ? 'under $0.01' : `about ${usdFormat(Math.max(usd, 0))}`;
}

/** Fees read in dollars. Without a price, the coin amount is all there is to show. */
function feeText(f: any): string {
  return typeof f.usd === 'number' ? aboutUsd(f.usd) : `about ${f.fee} ${f.asset}`;
}

/** On a review screen the exact coin amount stays beside the dollars. */
function reviewFee(fee: string, asset: string): string {
  const price = prices?.[asset]?.usd;
  return typeof price === 'number' ? `${aboutUsd(Number(fee) * price)} (${fee} ${asset})` : `${fee} ${asset}`;
}

/** pct percent of a decimal amount, less an optional fee, without floating-point rounding. Never below zero. */
function shareOf(amount: string, pct: number, minus = '0'): string {
  // Two more places than the inputs have, which is exactly enough for a whole percentage.
  const digits = Math.max((amount.split('.')[1] ?? '').length, (minus.split('.')[1] ?? '').length) + 2;
  const units = (v: string) => { const [w, f = ''] = v.split('.'); return BigInt(w || '0') * 10n ** BigInt(digits) + BigInt((f + '0'.repeat(digits)).slice(0, digits) || '0'); };
  if (!/^\d+(\.\d+)?$/.test(amount) || !/^\d+(\.\d+)?$/.test(minus)) return '0';
  let v = (units(amount) * BigInt(pct)) / 100n - units(minus);
  if (v < 0n) v = 0n;
  const scale = 10n ** BigInt(digits);
  const frac = digits ? (v % scale).toString().padStart(digits, '0').replace(/0+$/, '') : '';
  return `${v / scale}${frac ? `.${frac}` : ''}`;
}

/** Filled in after the screen is up, so a slow server never holds it back. */
function feeLine(asset: Asset, id: string, write: (f: any) => string): HTMLElement {
  const el = h('p', { class: 'small muted fee-line', id }, 'Checking the estimated fee…');
  wallet.feeEstimate(asset).then((f: any) => {
    el.textContent = f ? write(f) : 'The estimated fee isn\'t available right now. You can see it on the review screen before sending.';
  }, () => { el.textContent = 'The estimated fee isn\'t available right now.'; });
  return el;
}

/** Everything this service's swap costs: its margin in the rate, plus the network fee to pay it. */
/** What's left in dollars after every cost. Network fees come out of the wallet, so they're taken off here too. */
function netReceive(q: any, ...networks: any[]): { text: string; complete: boolean } | null {
  if (typeof q.cost?.receiveUsd !== 'number') return null;
  const complete = networks.every((n) => typeof n?.usd === 'number');
  const net = q.cost.receiveUsd - networks.reduce((sum, n) => sum + (typeof n?.usd === 'number' ? n.usd : 0), 0);
  return { text: usdFormat(Math.max(net, 0)), complete };
}

function netLine(q: any, ...networks: any[]): string {
  const net = netReceive(q, ...networks);
  if (!net) return '';
  return net.complete ? `After all fees about ${net.text}` : `about ${net.text}, network fee extra`;
}

function offerFee(q: any): { total: string; detail: string } {
  if (!q.cost) return { total: 'Fee not available', detail: 'Shown in USD once the price server connects.' };
  const provider = Math.max(q.cost.usd, 0);
  const network = typeof q.network?.usd === 'number' ? q.network.usd : null;
  if (network === null) return { total: tiny(provider) ? 'Fee under $0.01' : `Fee about ${usdFee(provider)}`, detail: `Provider ${usdFee(provider)} (${q.cost.percent.toFixed(2)}%), network extra` };
  return { total: tiny(provider + network) ? 'Fee under $0.01' : `Fee about ${usdFee(provider + network)}`, detail: `Provider ${usdFee(provider)} (${Math.max(q.cost.percent, 0).toFixed(2)}%) + network ${usdFee(network)}` };
}

function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function errorBox() {
  const el: HTMLElement = h('div', { class: 'error', role: 'alert', hidden: true });
  return {
    el,
    show: (e: unknown) => { el.textContent = errMsg(e); el.hidden = false; el.scrollIntoView({ block: 'nearest' }); },
    clear: () => { el.hidden = true; },
  };
}

function busy(button: HTMLButtonElement, label: string, box: ReturnType<typeof errorBox>, task: () => Promise<void>): void {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  box.clear();
  task().catch((e) => box.show(e)).finally(() => { button.disabled = false; button.textContent = original; });
}

function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast', role: 'status', id: 'toast' }, message);
  document.querySelector('.screen')?.append(el);
  window.setTimeout(() => el.remove(), 3500);
}

async function openExplorer(asset: Asset, hash: string): Promise<void> {
  const res = await wallet.openExplorer(asset, hash);
  if (res?.copied) toast('In Tor mode the browser isn\'t opened. The link was copied, so paste it into Tor Browser.');
}

function torLabel(s: any): { text: string; cls: string } {
  if (s.phase === 'ready') return { text: 'Tor connected', cls: 'ok' };
  if (s.phase === 'error') return { text: 'Tor disconnected', cls: 'bad' };
  return { text: `Tor ${s.percent}%`, cls: '' };
}

function show(kind: string, ...kids: Child[]): void {
  closeScanner?.();
  onData = null;
  setKids(root, h('div', { class: `screen ${kind}` },
    h('div', { class: 'fx fx-tr' }), h('div', { class: 'fx fx-bl' }), h('div', { class: 'fx fx-br' }),
    ...kids));
}

function subBar(title: string, back: () => void): HTMLElement {
  return h('div', { class: 'bar' },
    h('button', { class: 'icon-btn', id: 'back', 'aria-label': 'Back', onclick: back }, icon('back')),
    h('h2', {}, title), h('span', {}));
}

// ---- entry ----

function entry(...kids: Child[]): void {
  show('entry', h('div', { class: 'scroll' }, ...kids));
}

const entryLogo = () => h('img', { class: 'entry-logo', src: 'logo.png', alt: 'Kusari Wallet' });

/** Covers the screen with the logo during a wait, and keeps what's underneath so a failure can return to it. */
async function withSplash(message: string, task: () => Promise<void>): Promise<void> {
  const el = h('div', { class: 'splash overlay', id: 'loading', role: 'status' }, h('img', { src: 'logo.png', alt: '' }), message);
  document.body.append(el);
  try { await task(); } finally { el.remove(); }
}

// Chosen before a wallet is made or restored: whether it ever talks to dApps.
let chosenMode: 'private' | 'walletconnect' | null = null;

function chooseMode(): void {
  const pick = (m: 'private' | 'walletconnect') => () => { chosenMode = m; welcome(); };
  const addingBack = h('button', { type: 'button', class: 'ghost', id: 'wallet-add-cancel', hidden: true, onclick: async () => { await wallet.walletCancelAdd(); await boot(); } }, 'Cancel adding a wallet');
  void wallet.walletsList().then((r: any) => { addingBack.hidden = !r.adding; });
  entry(
    entryLogo(),
    h('h2', {}, 'How will you use this wallet?'),
    addingBack,
    h('button', { class: 'choice', id: 'mode-private', onclick: pick('private') },
      h('strong', {}, 'Maximum privacy'), h('span', { class: 'muted small' }, 'Never connects to dApps. Nothing about this wallet goes to a connection service. Recommended.')),
    h('button', { class: 'choice', id: 'mode-walletconnect', onclick: pick('walletconnect') },
      h('strong', {}, 'Use WalletConnect'), h('span', { class: 'muted small' }, 'Connects to dApps such as exchanges and NFT sites. Only the Ethereum, Polygon, Arbitrum and BNB address is shared with them, and connections go through the WalletConnect relay, outside Tor. For dApps, a separate wallet is safer than your main one.')));
}

function welcome(): void {
  if (!chosenMode) return chooseMode();
  const addingBack = h('button', { type: 'button', class: 'ghost', id: 'wallet-add-cancel', hidden: true, onclick: async () => { await wallet.walletCancelAdd(); await boot(); } }, 'Cancel adding a wallet');
  void wallet.walletsList().then((r: any) => { addingBack.hidden = !r.adding; });
  entry(
    entryLogo(),
    h('h2', {}, 'Get started'),
    addingBack,
    h('p', { class: 'lead' }, 'Seeds and keys are stored encrypted on this device only. This is mainnet, with real coins.'),
    h('p', { class: 'small muted', id: 'mode-chosen' }, chosenMode === 'walletconnect' ? 'Mode: WalletConnect. ' : 'Mode: Maximum privacy. ', h('button', { type: 'button', class: 'link', id: 'mode-change', onclick: () => { chosenMode = null; chooseMode(); } }, 'Change')),
    h('button', { class: 'choice', onclick: createStep1 },
      h('strong', {}, 'Create a new wallet'), h('span', { class: 'muted small' }, 'Generates new seed phrases.')),
    h('button', { class: 'choice', onclick: restoreForm },
      h('strong', {}, 'Restore from seeds'), h('span', { class: 'muted small' }, 'Needs both the BIP39 seed (BTC, ETH, TRX, USDT, SOL, DOGE, DASH, FIRO, ZEC, ZANO, ARRR) and the 25-word Monero seed.')));
}

function passwordFields() {
  const pw = h('input', { type: 'password', autocomplete: 'new-password', id: 'pw' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', id: 'pw2' });
  return {
    pw, pw2,
    nodes: [
      h('label', { class: 'field' }, h('span', {}, 'Password'), pw, h('div', { class: 'hint' }, 'At least 10 characters. If you forget it, you can only restore from the seeds.')),
      h('label', { class: 'field' }, h('span', {}, 'Confirm password'), pw2),
    ],
    check() {
      if (pw.value.length < 10) throw new Error('The password must be at least 10 characters.');
      if (pw.value !== pw2.value) throw new Error('The two passwords do not match.');
      return pw.value as string;
    },
  };
}

function createStep1(): void {
  const f = passwordFields();
  const box = errorBox();
  const next = h('button', { class: 'primary', id: 'next', onclick: () => busy(next, 'Generating…', box, async () => {
    const password = f.check();
    createStep2(password, await wallet.generateSeeds());
  }) }, 'Generate seeds');
  entry(h('h2', {}, 'Set a password'), h('p', { class: 'lead' }, 'Entered each time you open the wallet on this device or send coins.'), box.el, ...f.nodes,
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', onclick: welcome }, 'Back'), next));
}

function seedCard(title: string, note: string, phrase: string): HTMLElement {
  return h('div', { class: 'seed' }, h('h3', {}, title), note && h('p', { class: 'muted small' }, note),
    h('ol', { class: 'words' }, ...phrase.split(' ').map((w, i) => h('li', {}, h('i', {}, String(i + 1)), w))));
}

/** Both seeds in one QR code, which this wallet's restore screen reads: kusari-seeds:1?b=<12 words>&m=<25 words>. */
const seedQrText = (seeds: { tronMnemonic: string; moneroSeed: string }) => `kusari-seeds:1?b=${seeds.tronMnemonic.trim().split(/\s+/).join('-')}&m=${seeds.moneroSeed.trim().split(/\s+/).join('-')}`;

/** Reads a seed QR: this wallet's own (both seeds), or a plain list of 12/24 words (BIP39) or 25 words (Monero). */
function parseSeedQr(text: string): { bip39?: string; monero?: string } | null {
  const t = text.trim();
  const own = /^kusari-seeds:1\?b=([a-z-]+)&m=([a-z-]+)$/.exec(t);
  if (own) return { bip39: own[1].split('-').join(' '), monero: own[2].split('-').join(' ') };
  const words = t.toLowerCase().split(/\s+/);
  if (!words.every((w) => /^[a-z]+$/.test(w))) return null;
  if (words.length === 12 || words.length === 24) return { bip39: words.join(' ') };
  if (words.length === 25) return { monero: words.join(' ') };
  return null;
}

/** The seeds as a QR code, hidden until asked for: a picture of it is as good as the seeds themselves. */
function seedQrCard(seeds: { tronMnemonic: string; moneroSeed: string }): HTMLElement {
  const holder = h('div', { class: 'seed-qr', id: 'seed-qr' });
  const show: HTMLButtonElement = h('button', { type: 'button', class: 'secondary', id: 'seed-qr-show', onclick: async () => {
    if (holder.childElementCount) { setKids(holder); show.textContent = 'Show as QR code'; return; }
    const src = await wallet.qr(seedQrText(seeds));
    setKids(holder, h('img', { src, alt: 'Seed QR code', id: 'seed-qr-img' }));
    show.textContent = 'Hide QR code';
  } }, 'Show as QR code');
  return h('div', { class: 'seed' }, h('h3', {}, 'Both seeds as a QR code'),
    h('p', { class: 'muted small' }, 'For restoring this wallet by scanning instead of typing. Anyone who sees or photographs this code can take all your coins: show it only to restore, and keep the written words as the backup.'),
    show, holder);
}

function createStep2(password: string, seeds: { tronMnemonic: string; moneroSeed: string }): void {
  const ok = h('input', { type: 'checkbox', id: 'saved' });
  const go = h('button', { class: 'primary', id: 'next', disabled: true, onclick: () => createStep3(password, seeds) }, 'Continue to backup check');
  ok.addEventListener('change', () => { go.disabled = !ok.checked; });
  entry(
    h('h2', {}, 'Write both seed phrases on paper'),
    h('p', { class: 'lead' }, 'Anyone with these seeds can take all your coins. Don\'t save them in photos, cloud storage or messengers.'),
    seedCard('BTC·ETH·Tron·SOL·DOGE·DASH seed, 12 words', 'For BTC, ETH, TRX, USDT, SOL, DOGE, DASH, FIRO, ZEC, ZANO, ARRR. Restores in BIP39 wallets such as Sparrow, MetaMask, TronLink and Phantom.', seeds.tronMnemonic),
    seedCard('Monero seed, 25 words', 'For XMR. Works with Monero GUI and Cake Wallet.', seeds.moneroSeed),
    seedQrCard(seeds),
    h('label', { class: 'check' }, ok, h('span', {}, 'I wrote down both seeds.')),
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', onclick: welcome }, 'Cancel'), go),
    skipBackupButton(password, seeds, () => createStep2(password, seeds)));
}

function skipBackupButton(password: string, seeds: { tronMnemonic: string; moneroSeed: string }, back: () => void): HTMLElement {
  return h('button', { type: 'button', class: 'ghost skip-backup', id: 'skip-backup', onclick: () => createSkip(password, back) }, 'Skip');
}

function createSkip(password: string, back: () => void): void {
  const box = errorBox();
  const go = h('button', { class: 'danger', id: 'skip-confirm', onclick: () => busy(go, 'Creating the wallet…', box, async () => {
    await withSplash('Creating the wallet…', async () => {
      await wallet.setWalletMode(chosenMode ?? 'private'); // before the wallet exists, so its first session already follows it
      await wallet.finishCreate(password);
      chosenMode = null; // the next wallet added asks again
      await enterWallet();
    });
  }) }, 'Skip and create wallet');
  entry(h('h2', {}, 'Create without a backup?'),
    h('div', { class: 'warn', id: 'skip-warning' }, 'If your phone or PC breaks or the app is removed, nobody can recover coins without a written seed.'),
    h('p', { class: 'lead' }, 'You can see the seeds later in Settings with your password. Write them down before adding coins.'), box.el,
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', id: 'skip-back', onclick: back }, 'Back'), go));
}

function createStep3(password: string, seeds: { tronMnemonic: string; moneroSeed: string }): void {
  const pick = (n: number) => Math.floor(Math.random() * n);
  const qs = [
    { label: 'BTC·ETH·Tron', i: pick(12), words: seeds.tronMnemonic.split(' ') },
    { label: 'Monero', i: pick(25), words: seeds.moneroSeed.split(' ') },
  ].map((q) => ({ ...q, input: h('input', { autocomplete: 'off', spellcheck: 'false', class: 'quiz' }) }));
  const box = errorBox();
  const done = h('button', { class: 'primary', id: 'next', onclick: () => busy(done, 'Creating the wallet…', box, async () => {
    for (const q of qs) if (q.input.value.trim().toLowerCase() !== q.words[q.i]) throw new Error(`${q.label}: word ${q.i + 1} does not match.`);
    await withSplash('Creating the wallet…', async () => {
      await wallet.setWalletMode(chosenMode ?? 'private'); // before the wallet exists, so its first session already follows it
      await wallet.finishCreate(password);
      chosenMode = null; // the next wallet added asks again
      await enterWallet();
    });
  }) }, 'Create wallet');
  entry(h('h2', {}, 'Check your backup'), h('p', { class: 'lead' }, 'Enter these from your written copy.'), box.el,
    ...qs.map((q) => h('label', { class: 'field' }, h('span', {}, `${q.label} seed, word ${q.i + 1}`), q.input)),
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', onclick: () => createStep2(password, seeds) }, 'Show seeds again'), done),
    skipBackupButton(password, seeds, () => createStep3(password, seeds)));
}

function restoreForm(): void {
  const f = passwordFields();
  const tron = h('textarea', { spellcheck: 'false', autocomplete: 'off', id: 'tron-seed' });
  const xmr = h('textarea', { spellcheck: 'false', autocomplete: 'off', id: 'xmr-seed' });
  const from = h('input', { placeholder: '2025-06-01 or 3400000', autocomplete: 'off', id: 'from' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'next', onclick: () => busy(go, 'Restoring…', box, async () => {
    const pw = f.check();
    await withSplash('Restoring the wallet…', async () => {
      await wallet.setWalletMode(chosenMode ?? 'private'); // before the wallet exists, so its first session already follows it
      await wallet.restore(pw, tron.value, xmr.value, from.value);
      chosenMode = null; // the next wallet added asks again
      await enterWallet();
    });
  }) }, 'Restore');
  const scan = h('button', { type: 'button', class: 'secondary', id: 'seed-scan', onclick: () => void openScanner('XMR', () => undefined, {
    parse: (t) => (parseSeedQr(t) ? t : null),
    wrong: 'This is not a seed QR code.',
    onText: (t) => {
      const got = parseSeedQr(t)!;
      if (got.bip39) tron.value = got.bip39;
      if (got.monero) xmr.value = got.monero;
      toast(got.bip39 && got.monero ? 'Both seeds filled in.' : 'Seed filled in. Add the other one.');
    },
  }) }, icon('scan'), 'Scan seed QR code');
  entry(h('h2', {}, 'Restore from seeds'), h('p', { class: 'small muted' }, 'Type the words, or scan the QR code this wallet shows for your seeds.'), scan, h('br'), box.el,
    h('label', { class: 'field' }, h('span', {}, 'BTC·ETH·Tron seed (BIP39)'), tron),
    h('label', { class: 'field' }, h('span', {}, 'Monero seed (25 words)'), xmr),
    h('label', { class: 'field' }, h('span', {}, 'When Monero was first used'), from,
      h('div', { class: 'hint' }, 'A date or block height. Empty scans from the start, which can take hours. A date also sets where Zcash starts scanning.')),
    ...f.nodes,
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', onclick: welcome }, 'Back'), go));
}

function unlockScreen(): void {
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'unlock', type: 'submit' }, 'Open');
  const useBio = async () => {
    box.clear();
    try {
      const password: string = await wallet.biometric.unlock();
      await withSplash('Opening the wallet…', async () => { await wallet.unlock(password); await enterWallet(); });
    } catch (e) {
      if (errMsg(e) !== 'cancelled') box.show(e);
    }
  };
  const bio = h('button', { type: 'button', class: 'bio-btn', id: 'bio-unlock', hidden: true, onclick: useBio }, 'Open with fingerprint');
  void wallet.biometric?.enabled().then((on: boolean) => {
    if (!on) return;
    bio.hidden = false;
    void useBio();
  });
  const lead = h('p', { class: 'lead', id: 'unlock-name' }, 'Enter your password.');
  const others = h('button', { type: 'button', class: 'ghost', id: 'unlock-wallets', onclick: () => void renderWallets(unlockScreen) }, 'Other wallets');
  void wallet.walletsList().then((r: any) => { lead.textContent = `${r.list.find((w: any) => w.id === r.active)?.name ?? 'My wallet'}. Enter your password.`; });
  entry(entryLogo(), h('h2', {}, 'Open wallet'), lead,
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, 'Opening…', box, async () => {
        await withSplash('Opening the wallet…', async () => {
          await wallet.unlock(pw.value);
          pw.value = '';
          await enterWallet();
        });
      });
    } }, box.el, h('label', { class: 'field' }, h('span', {}, 'Password'), pw), go, bio), others);
  pw.focus();
}

// ---- data ----

async function enterWallet(): Promise<void> {
  overview = null;
  homeTab = 'assets';
  addresses = await wallet.addresses().catch(() => null);
  // Decided here because the first balance round can take a while on a phone, and the row shouldn't wait for it.
  zecInSession = await wallet.zecInfo().then((i: any) => Boolean(i.started)).catch(() => false);
  const zanoInSession = await wallet.zanoInfo().then((i: any) => Boolean(i.started)).catch(() => false);
  const arrrInSession = await wallet.arrrInfo().then((i: any) => Boolean(i.started)).catch(() => false);
  ASSETS = ALL_ASSETS.filter((a) => (a !== 'ZEC' || zecInSession) && (a !== 'ZANO' || zanoInSession) && (a !== 'ARRR' || arrrInSession));
  torState = (await wallet.torInfo().catch(() => null))?.enabled ? (await wallet.torInfo()).state : null;
  renderHome();
  void refresh(); // Balances fill in on the home screen; a slow node or Tor must not hold it back.
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => void refresh(), 20_000);
}

async function refresh(): Promise<void> {
  try {
    const [next, nextPrices] = await Promise.all([wallet.overview(), wallet.prices().catch(() => null)]);
    overview = next;
    refreshNote = `${new Date().toLocaleTimeString('en-US')} answer, ZEC ${next.balances.ZEC ? (next.balances.ZEC.ok ? 'has balance' : next.balances.ZEC.pending ? 'waiting' : 'failed') : 'none'}`;
    addresses = next.addresses;
    torState = next.tor;
    prices = nextPrices;
    onData?.();
  } catch (e) { refreshNote = `Error: ${(e as Error).message}`; /* usually just locked meanwhile */ }
}


function balanceText(a: Asset): string {
  const b = overview?.balances?.[a];
  if (hideBalance) return '••••';
  if (!b || b.pending) return '…';
  return b.ok ? shortAmount(b.total) : 'Lookup failed';
}

/**
 * A balance short enough to read: 4 decimals from 1 up, 6 below 1, and 4 significant digits for dust smaller than
 * that. Cut, never rounded up, so it never shows more than is held. The exact amount stays in the tooltip.
 */
function shortAmount(text: string): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m) return text;
  const [, whole, frac = ''] = m;
  let keep = whole !== '0' || /^0*$/.test(frac) ? 4 : 6;
  if (whole === '0' && /^0*$/.test(frac.slice(0, 6)) && !/^0*$/.test(frac)) keep = frac.search(/[1-9]/) + 4;
  const cut = frac.slice(0, keep).replace(/0+$/, '');
  return (cut ? `${Number(whole).toLocaleString('en-US')}.${cut}` : Number(whole).toLocaleString('en-US'));
}

function usdFormat(n: number): string {
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

function assetUsd(a: Asset): number | null {
  const b = overview?.balances?.[a];
  const p = prices?.[a]?.usd;
  if (!b?.ok || typeof p !== 'number') return null;
  return Number(b.total) * p;
}

function totalUsd(): { value: string; note: string } {
  if (hideBalance) return { value: '••••', note: '' };
  if (!overview) return { value: '…', note: '' };
  if (!prices) return { value: '$0', note: 'Could not load prices. The amounts below are correct.' };
  const failed = ASSETS.filter((a) => !overview.balances[a].ok && !overview.balances[a].pending);
  const pending = ASSETS.filter((a) => overview.balances[a].pending);
  if (pending.length && !failed.length) return { value: '$0', note: overview.tor && overview.tor.phase !== 'ready' ? 'Tor is connecting. Balances load once it connects.' : `Loading ${pending.map(coinName).join(', ')} balances.` };
  if (failed.length) return { value: '$0', note: `${failed.map(coinName).join(', ')} lookup failed. Retrying automatically.` };
  const sum = ASSETS.reduce((s, a) => s + (assetUsd(a) ?? 0), 0);
  const notes: string[] = [];
  if (!overview.monero.synced) notes.push('XMR hasn\'t synced yet, so this may be lower than actual.');
  return { value: usdFormat(sum), note: notes.join(' ') };
}

function moneroStatus(): string {
  const m = overview?.monero;
  if (!m) return '';
  if (!m.connected) return m.error ? 'Node not connected' : 'Connecting to a node…';
  if (m.synced) return '';
  const pct = m.percent > 0 ? ` ${Math.min(Math.floor(m.percent * 1000) / 10, 99.9)}%` : '';
  return `Syncing transactions...${pct}`;
}

/** True while something is actively happening, not when a connection has failed. */
function moneroBusy(): boolean {
  const m = overview?.monero;
  return Boolean(m && !m.synced && (m.connected || !m.error));
}

function syncLabel(): HTMLElement {
  return h('span', { class: 'syncing', id: 'sync-status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), moneroStatus());
}

// ---- home ----

function renderHome(): void {
  const totalValue = h('div', { class: 'value', id: 'total' });
  const note = h('div', { class: 'total-note', id: 'total-note' });
  const eye = h('button', { class: 'icon-btn', id: 'eye', 'aria-label': 'Hide balances', onclick: () => {
    hideBalance = !hideBalance;
    try { localStorage.setItem('hideBalance', hideBalance ? '1' : '0'); } catch { /* no storage */ }
    paint();
  } });
  const spin = h('button', { class: 'icon-btn', id: 'refresh', 'aria-label': 'Refresh', onclick: () => void refresh() }, icon('refresh'));
  const torChip = h('span', { class: 'chip tor', id: 'tor-chip', hidden: true });
  const body = h('div', { class: 'scroll' });
  const tab = (id: typeof homeTab, label: string) => h('button', {
    role: 'tab', 'aria-selected': String(homeTab === id), id: `tab-${id}`,
    onclick: () => { homeTab = id; renderHome(); paint(); },
  }, label);
  const list = h('div', { class: 'list', id: 'asset-list' });
  const dappSlot = h('div', { class: 'row', id: 'dapp-slot' });
  void paintDappsChip(dappSlot);

  function paint(): void {
    const t = totalUsd();
    totalValue.textContent = t.value;
    note.textContent = t.note;
    setKids(eye, icon(hideBalance ? 'eyeOff' : 'eye'));
    torChip.hidden = !torState;
    if (torState) {
      const label = torLabel(torState);
      setKids(torChip, icon('shield'), label.text);
      torChip.setAttribute('class', `chip tor ${label.cls}`);
    }
    if (homeTab === 'assets') setKids(list, ...assetRows());
  }

  show('home',
    h('div', { class: 'top' }, h('div', { class: 'acct' }, walletButton(), torChip), dappSlot),
    h('div', { class: 'total' }, totalValue, spin, eye),
    note,
    h('div', { class: 'actions' },
      h('button', { class: 'action', id: 'go-send', onclick: () => renderSend() }, h('span', { class: 'box' }, icon('send')), 'Send'),
      h('button', { class: 'action', id: 'go-receive', onclick: () => void renderReceive() }, h('span', { class: 'box' }, icon('receive')), 'Receive'),
      h('button', { class: 'action swap-action', id: 'go-swap', onclick: () => void renderSwap() }, h('span', { class: 'box' }, icon('swap')), 'Swap'),
      h('button', { class: 'action', id: 'go-buy', onclick: () => void renderBuy() }, h('span', { class: 'box' }, icon('buy')), 'Buy')),
    h('div', { class: 'tabs', role: 'tablist' }, tab('assets', 'Assets'), tab('history', 'History')),
    body,
    bottomNav('home'));
  onData = paint;
  paint();
  if (homeTab === 'assets') setKids(body, list);
  else void renderAllHistory(body);
}

let openGroups = new Set<Asset>();
try { openGroups = new Set(JSON.parse(localStorage.getItem('kusari.openGroups') ?? '[]')); } catch { /* starts folded */ }

/** Coins in order, each token right under its chain's coin, shown when that coin is unfolded. */
function assetRows(): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const a of ASSETS) {
    if (IN_GROUP.has(a)) continue;
    const kids = (GROUPS[a] ?? []).filter((k) => ASSETS.includes(k));
    if (!kids.length) { rows.push(assetRow(a)); continue; }
    const open = openGroups.has(a);
    const flip = (e: Event) => {
      e.stopPropagation(); // the arrow sits inside the coin's row, which opens the coin
      e.preventDefault();
      if (openGroups.has(a)) openGroups.delete(a); else openGroups.add(a);
      try { localStorage.setItem('kusari.openGroups', JSON.stringify([...openGroups])); } catch { /* only this session */ }
      // Redrawing the screen would jump back to the top, so keep the list where it was.
      const top = document.querySelector<HTMLElement>('.scroll')?.scrollTop ?? 0;
      renderHome();
      const scroller = document.querySelector<HTMLElement>('.scroll');
      if (scroller) scroller.scrollTop = top;
      document.getElementById(`fold-${a}`)?.focus({ preventScroll: true });
    };
    // A span, since a button can't sit inside the row's own button.
    const toggle = h('span', { class: `fold${open ? ' open' : ''}`, id: `fold-${a}`, role: 'button', tabindex: '0', 'aria-expanded': String(open), 'aria-label': `${open ? 'Hide' : 'Show'} tokens on ${COIN[a].label}`, onclick: flip, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') flip(e); } }, icon('down'));
    rows.push(assetRow(a, false, toggle));
    if (open) rows.push(...kids.map((k) => assetRow(k, true)));
  }
  return rows;
}

function assetRow(a: Asset, child = false, toggle?: HTMLElement): HTMLElement {
  const p = prices?.[a];
  const status = a === 'XMR' ? moneroStatus() : '';
  const sub: Child = status
    ? (moneroBusy() ? syncLabel() : status)
    : p
      ? h('span', {}, usdFormat(p.usd), p.change !== null && h('span', { class: p.change >= 0 ? 'up' : 'down' }, `${p.change >= 0 ? '+' : ''}${p.change.toFixed(2)}%`))
      : a === 'BTC' ? 'Bitcoin' : a === 'HYPE' ? 'Hyperliquid' : a === 'SOL' ? 'Solana' : a === 'DOGE' ? 'Dogecoin' : a === 'ADA' ? 'Cardano' : a === 'BCH' ? 'Bitcoin Cash' : a === 'LTC' ? 'Litecoin' : a === 'SCRT' || a === 'SSCRT' ? 'Secret' : a === 'DASH' ? 'Dash' : a === 'FIRO' ? 'Firo' : a === 'ZEC' ? 'Zcash' : a === 'ZANO' ? 'Zano' : a === 'ARRR' ? 'Pirate Chain' : a === 'ETH' || a === 'ETHA' ? 'Ethereum' : a === 'POL' ? 'Polygon' : a === 'LINK' ? 'Chainlink' : a === 'WLD' ? 'Worldcoin' : a === 'ARB' ? 'Arbitrum' : a === 'UNI' ? 'Uniswap' : a === 'PEPE' ? 'Pepe' : a === 'AAVE' ? 'Aave' : a === 'NEAR' ? 'NEAR Protocol' : a === 'ETHP' ? 'Ethereum' : a === 'BNB' ? 'BNB Smart Chain' : a === 'ASTER' ? 'Aster' : a === 'CAKE' ? 'PancakeSwap' : a === 'JUP' ? 'Jupiter' : a === 'RAY' ? 'Raydium' : a === 'SHIB' || a === 'SHIBB' ? 'Shiba Inu' : a === 'LINKB' || a === 'LINKP' || a === 'LINKA' ? 'Chainlink' : a === 'UNIB' || a === 'UNIP' || a === 'UNIA' ? 'Uniswap' : a === 'AAVEB' || a === 'AAVEP' ? 'Aave' : a === 'ORCA' ? 'Orca' : a === 'PUMP' ? 'pump.fun' : a === 'USDT' || a === 'USDTE' || a === 'USDTS' || a === 'USDTP' || a === 'USDTA' ? 'Tether' : a === 'TRX' ? 'Tron' : 'Monero';
  const usd = assetUsd(a);
  return h('button', { class: `asset${child ? ' child' : ''}`, id: `asset-${a}`, onclick: () => { selected = a; void renderAsset(); } },
    coin(a),
    h('div', {}, h('div', { class: 'name' }, COIN[a].label, toggle), h('div', { class: 'sub' }, sub)),
    h('div', { class: 'right' }, h('div', { class: 'amt' }, balanceText(a)),
      h('div', { class: 'sub' }, hideBalance || usd === null ? '' : usdFormat(usd), overview?.balances?.[a]?.stale && !hideBalance ? ' · recent value' : '')));
}

function bottomNav(on: 'home' | 'settings' | 'perps'): HTMLElement {
  return h('nav', { class: 'nav' },
    h('button', { class: on === 'home' ? 'on' : undefined, id: 'nav-home', onclick: () => { homeTab = 'assets'; renderHome(); } }, icon('home'), 'Home'),
    // Perps (Aster futures) are in WalletConnect wallets only.
    h('button', { class: on === 'perps' ? 'on' : undefined, id: 'nav-perps', hidden: !wcOn, onclick: () => void renderPerps() }, icon('chart'), 'Perps'),
    h('button', { class: on === 'settings' ? 'on' : undefined, id: 'open-settings', onclick: () => void renderSettings() }, icon('gear'), 'Settings'),
    h('button', { id: 'lock', onclick: () => wallet.lock() }, icon('lock'), 'Lock'));
}

const when = (t: number) => new Date(t).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function historyRow(i: any): HTMLElement {
  const label = i.direction === 'in' ? 'Received' : i.direction === 'out' ? 'Sent' : 'To yourself';
  const status = i.status === 'failed' ? ' · failed' : i.status === 'pending' ? ' · pending'
    : i.asset === 'XMR' && i.confirmations < 10 ? ` · ${i.confirmations}/10 confirmations` : '';
  const sign = i.direction === 'in' ? '+' : i.direction === 'out' ? '-' : '';
  return h('button', { class: `hist-row${i.dust ? ' dust' : ''}`, title: 'Open in explorer', onclick: () => void openExplorer(i.asset, i.hash) },
    coin(i.asset),
    h('div', {}, h('div', {}, label + status), h('div', { class: 'small muted' }, when(i.timestamp))),
    h('div', { class: `amt${i.direction === 'in' ? ' in' : ''}` }, `${sign}${i.amount} ${coinName(i.asset)}`));
}

async function renderAllHistory(body: HTMLElement): Promise<void> {
  setKids(body, h('p', { class: 'empty' }, 'Loading…'));
  const results = await Promise.allSettled(ASSETS.map((a) => wallet.history(a)));
  if (!body.isConnected) return;
  const failed = ASSETS.filter((_, i) => results[i].status === 'rejected');
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value as any[] : [])).sort((a, b) => b.timestamp - a.timestamp).slice(0, 60);
  setKids(body,
    h('div', { class: 'list', id: 'hist' },
      failed.length > 0 && h('div', { class: 'warn' }, failed.length === 1 && failed[0] === 'XMR' ? 'XMR history is available once connected to a node.' : `Could not load ${failed.join(', ')} history.`),
      items.length > 0 && h('p', { class: 'small muted' }, 'Don\'t copy addresses from history. Scams that send tiny amounts from look-alike addresses are common. Dimmed entries are tiny deposits.'),
      items.length === 0 && failed.length === 0 && h('p', { class: 'empty', id: 'hist-empty' }, 'No transactions yet. See Receive for your address.'),
      ...items.map(historyRow)));
}

// ---- asset detail ----

async function renderAsset(): Promise<void> {
  const a = selected;
  const balance = h('div', { class: 'detail-balance', id: 'detail-balance' });
  const usd = h('div', { class: 'detail-usd' });
  const notes = h('div', {});
  const hist = h('div', {}, h('p', { class: 'empty' }, 'Loading…'));
  const paint = () => {
    const b = overview?.balances?.[a];
    const shown = balanceText(a);
    balance.textContent = hideBalance || shown === 'Lookup failed' ? shown : `${shown} ${unitOf(a)}`;
    balance.title = !hideBalance && b?.ok ? `${b.total} ${unitOf(a)}` : '';
    const v = assetUsd(a);
    usd.textContent = !hideBalance && v !== null ? usdFormat(v) : '';
    setKids(notes,
      b && !b.ok && !b.pending && h('div', { class: 'warn' }, `Lookup failed. Retrying automatically. (${b.error})`),
      b?.stale && h('div', { class: 'warn', id: 'stale-note' }, 'The server isn\'t answering for now, so this is a recent value. Your coins are safe, and it will check again automatically.'),
      a === 'BTC' && b?.ok && b.total !== b.spendable && h('div', { class: 'warn' }, `${b.spendable} BTC can be spent now. The rest unlocks after 1 confirmation.`),
      a === 'ZEC' && overview?.zec?.syncing && !overview.zec.firstScanDone && h('div', { class: 'sync-banner', id: 'zec-scan' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Scanning Zcash blocks. Closing the app before this finishes means scanning again from the start.'),
      a === 'ARRR' && overview?.arrr?.scanning && h('div', { class: 'sync-banner', id: 'arrr-scan' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), `Scanning Pirate Chain blocks. ${overview.arrr.percent}%`),
      a === 'ARRR' && b?.ok && b.total !== b.spendable && h('div', { class: 'warn' }, `${b.spendable} ARRR can be sent now. The rest is waiting for confirmations.`),
      a === 'ZANO' && b?.ok && b.total !== b.spendable && h('div', { class: 'warn' }, `${b.spendable} ZANO can be sent now. Received coins can be used after 10 confirmations.`),
      a === 'ZEC' && b?.ok && b.total !== b.spendable && h('div', { class: 'warn' }, `${b.spendable} ZEC can be sent now. The rest is waiting for confirmations or for shielding.`),
      a === 'ZEC' && overview?.zec?.canShield && h('div', { class: 'panel', id: 'zec-shield-panel' },
        h('p', { class: 'small' }, `You have ${overview.zec.transparent} ZEC in transparent balance. It's public on the chain and can't be sent directly. ZEC received from swaps arrives here too.`), h('br'),
        h('button', { class: 'primary', id: 'zec-shield', onclick: () => renderZecShield() }, 'Shield')),
      a === 'LTC' && overview?.mweb && h('div', { class: 'panel', id: 'mweb-panel' },
        overview.mweb.ready && overview.mweb.balance
          ? h('p', { class: 'small' }, `Private (MWEB): ${shortAmount(overview.mweb.balance.total)} LTC. Its amounts and addresses are hidden on the chain.`)
          : h('p', { class: 'small', id: 'mweb-sync' }, overview.mweb.error ? `Private (MWEB) balance: ${overview.mweb.error}` : `Syncing the private (MWEB) balance… ${overview.mweb.percent}%`),
        overview.mweb.ready && h('button', { class: 'secondary', id: 'mweb-pegin', onclick: () => void ltcPrivateStep() }, 'Make public LTC private')),
      a === 'FIRO' && overview?.spark && h('div', { class: 'panel', id: 'spark-panel' },
        overview.spark.ready && overview.spark.balance
          ? h('p', { class: 'small' }, `Private (Spark): ${shortAmount(overview.spark.balance.total)} FIRO. Its amounts and addresses are hidden on the chain.`)
          : h('p', { class: 'small', id: 'spark-sync' }, overview.spark.error ? `Private (Spark) balance: ${overview.spark.error}` : `Syncing the private (Spark) balance… ${overview.spark.percent}%`),
        overview.spark.ready && h('button', { class: 'secondary', id: 'spark-mint', onclick: () => void firoPrivateStep() }, 'Make public FIRO private')),
      a === 'SSCRT' && overview?.sscrt?.needsKey && h('div', { class: 'panel', id: 'sscrt-key-panel' },
        h('p', { class: 'small' }, 'The private balance is encrypted on the chain. Turn it on once so this wallet can read it: it sets a viewing key on the sSCRT contract, which costs a small SCRT fee.'), h('br'),
        h('button', { class: 'primary', id: 'sscrt-key', onclick: () => void scrtPrivateStep('key') }, 'Turn on private balance')),
      a === 'XMR' && b?.ok && b.total !== b.spendable && h('div', { class: 'warn' }, `${b.spendable} XMR can be spent now. The rest unlocks after 10 confirmations.`),
      a === 'XMR' && overview && !overview.monero.connected && h('div', { class: 'warn', id: 'node-note' }, `Not connected to a node, so the balance may be out of date. Retrying automatically.${overview.monero.error ? ' ' + overview.monero.error : ''}`),
      a === 'XMR' && moneroBusy() && h('div', { class: 'sync-banner' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), moneroStatus()),
      a === 'XMR' && overview?.monero.connected && !overview.monero.synced && h('p', { class: 'small muted' }, 'Until this finishes, the balance may look low and sending isn\'t available.'));
  };
  show('send',
    subBar(COIN[a].label, renderHome),
    h('div', { class: 'scroll' },
      h('div', { class: 'picker' }, h('div', { class: 'picker-btn' }, coin(a))),
      balance, usd, notes,
      h('div', { class: 'actions' },
        h('button', { class: 'action', id: 'detail-send', onclick: () => renderSend() }, h('span', { class: 'box' }, icon('send')), 'Send'),
        h('button', { class: 'action', id: 'detail-receive', onclick: () => void renderReceive() }, h('span', { class: 'box' }, icon('receive')), 'Receive')),
      (a === 'SCRT' || a === 'SSCRT') && h('div', { class: 'btn-row', id: 'sscrt-actions' },
        h('button', { class: 'secondary', id: 'sscrt-wrap', onclick: () => renderScrtPrivate('wrap') }, 'Make private'),
        h('button', { class: 'secondary', id: 'sscrt-unwrap', onclick: () => renderScrtPrivate('unwrap') }, 'Make public')),
      a === 'HYPE' && wcOn && hypeCorePanel(),
      a === 'ZEC' && h('button', { class: 'ghost', id: 'zec-rescan', onclick: () => renderZecRescan() }, 'Rescan past history'),
      a === 'ARRR' && h('button', { class: 'ghost', id: 'arrr-rescan', onclick: () => renderZecRescan('ARRR') }, 'Rescan past history'),
      hist));
  onData = paint;
  paint();
  try {
    const items: any[] = await wallet.history(a);
    if (!hist.isConnected) return;
    setKids(hist, items.length ? h('div', { id: 'hist' }, ...items.map(historyRow)) : h('p', { class: 'empty', id: 'hist-empty' }, `No ${coinName(a)} transactions yet.`));
  } catch (e) {
    if (hist.isConnected) setKids(hist, h('p', { class: 'empty' }, `Could not load history. ${errMsg(e)}`));
  }
}

// ---- Secret Network: private sSCRT ----

/** wrap: SCRT into private sSCRT. unwrap: sSCRT back to plain SCRT. Both show their amount on the chain. */
function renderScrtPrivate(kind: 'wrap' | 'unwrap'): void {
  const from: Asset = kind === 'wrap' ? 'SCRT' : 'SSCRT';
  const amount = numbersOnly(h('input', { id: 'sscrt-amount', class: 'amount-input', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' }) as HTMLInputElement);
  const box = errorBox();
  const have = overview?.balances?.[from];
  const next = h('button', { class: 'primary', id: 'sscrt-next', type: 'submit' }, 'Next');
  const form = h('form', { onsubmit: (e: Event) => { e.preventDefault(); busy(next, 'Preparing…', box, () => scrtPrivateStep(kind, amount.value)); } },
    h('p', { class: 'small muted' }, kind === 'wrap'
      ? 'Turns plain SCRT into sSCRT, its private form. Your sSCRT balance and transfers are then encrypted on the chain. The amount you turn private is public.'
      : 'Turns sSCRT back into plain SCRT, whose balance and transfers are public. The amount is public.'),
    h('br'), box.el,
    h('label', { class: 'field' }, h('span', {}, kind === 'wrap' ? 'SCRT to make private' : 'sSCRT to make public'), amount,
      h('div', { class: 'hint' }, have?.ok ? `Available: ${shortAmount(have.spendable || have.total)} ${unitOf(from)}` : ''),
      h('button', { type: 'button', class: 'link', id: 'sscrt-max', onclick: () => { amount.value = 'max'; } }, 'Max')),
    next);
  show('send', subBar(kind === 'wrap' ? 'Make private' : 'Make public', () => void renderAsset()), h('div', { class: 'scroll' }, form));
  amount.focus();
}

async function scrtPrivateStep(kind: 'wrap' | 'unwrap' | 'key', amount = ''): Promise<void> {
  const p = await wallet.prepareScrtPrivate(kind, amount);
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const label = kind === 'wrap' ? `Make ${p.amount} SCRT private` : kind === 'unwrap' ? `Make ${p.amount} sSCRT public` : 'Turn on private balance';
  const go = h('button', { class: 'primary', id: 'confirm-send', type: 'submit' }, label);
  const back = () => { void wallet.cancelSend(p.id); void renderAsset(); };
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Sending…', box, async () => {
      const res = await wallet.confirmSend(p.id, pw.value);
      pw.value = '';
      toast(kind === 'key' ? 'Sent. The private balance shows once it\'s in a block.' : 'Sent. Balances update once it\'s in a block.');
      void refresh();
      if (res?.hashes?.length) selected = kind === 'unwrap' ? 'SCRT' : 'SSCRT';
      void renderAsset();
    });
  } },
  box.el,
  ...p.warnings.map((w: string) => h('div', { class: 'warn' }, w)),
  h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
    kind !== 'key' && h('tr', {}, h('th', {}, 'Amount'), h('td', {}, h('div', { class: 'big-amount', id: 'review-amount' }, `${p.amount} ${kind === 'wrap' ? 'SCRT → sSCRT' : 'sSCRT → SCRT'}`))),
    h('tr', {}, h('th', {}, 'Fee'), h('td', { id: 'review-fee' }, reviewFee(p.fee, p.feeAsset)))))),
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
  go);
  show('send', subBar('Review', back), h('div', { class: 'scroll' }, form));
  pw.focus();
}

/** Peg-in: every confirmed public LTC coin into the private (MWEB) balance, after a review. */
async function ltcPrivateStep(): Promise<void> {
  let p: any;
  try { p = await wallet.prepareLtcPrivate(); } catch (e) { toast(errMsg(e)); return; }
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-send', type: 'submit' }, `Make ${p.amount} LTC private`);
  const back = () => { void wallet.cancelSend(p.id); void renderAsset(); };
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Sending…', box, async () => {
      await wallet.confirmSend(p.id, pw.value);
      pw.value = '';
      toast('Sent. Balances update once it\'s in a block.');
      void refresh();
      void renderAsset();
    });
  } },
  h('p', { class: 'small muted' }, 'Moves all your confirmed public LTC to your private (MWEB) address in this wallet. Nothing comes back as public change.'), h('br'),
  box.el,
  ...p.warnings.map((w: string) => h('div', { class: 'warn' }, w)),
  h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
    h('tr', {}, h('th', {}, 'Amount'), h('td', {}, h('div', { class: 'big-amount', id: 'review-amount' }, `${p.amount} LTC → MWEB`))),
    h('tr', {}, h('th', {}, 'Fee'), h('td', { id: 'review-fee' }, reviewFee(p.fee, p.feeAsset)))))),
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
  go);
  show('send', subBar('Review', back), h('div', { class: 'scroll' }, form));
  pw.focus();
}

/** Every confirmed public FIRO coin into the private (Spark) balance, after a review. */
async function firoPrivateStep(): Promise<void> {
  let p: any;
  try { p = await wallet.prepareFiroPrivate(); } catch (e) { toast(errMsg(e)); return; }
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-send', type: 'submit' }, `Make ${p.amount} FIRO private`);
  const back = () => { void wallet.cancelSend(p.id); void renderAsset(); };
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Sending…', box, async () => {
      await wallet.confirmSend(p.id, pw.value);
      pw.value = '';
      toast('Sent. Balances update once it\'s in a block.');
      void refresh();
      void renderAsset();
    });
  } },
  h('p', { class: 'small muted' }, 'Moves all your confirmed public FIRO to your private (Spark) address in this wallet. Nothing comes back as public change.'), h('br'),
  box.el,
  ...p.warnings.map((w: string) => h('div', { class: 'warn' }, w)),
  h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
    h('tr', {}, h('th', {}, 'Amount'), h('td', {}, h('div', { class: 'big-amount', id: 'review-amount' }, `${p.amount} FIRO → Spark`))),
    h('tr', {}, h('th', {}, 'Fee'), h('td', { id: 'review-fee' }, reviewFee(p.fee, p.feeAsset)))))),
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
  go);
  show('send', subBar('Review', back), h('div', { class: 'scroll' }, form));
  pw.focus();
}

// ---- Zcash ----

function renderZecShield(): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-shield', type: 'submit' }, 'Shield');
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Making the proof… This can take a few minutes', box, async () => {
      await wallet.zecShield(pw.value);
      pw.value = '';
      toast('Shielding transaction sent. It joins your shielded balance once confirmed.');
      await refresh();
      void renderAsset();
    });
  } },
  box.el,
  h('p', { class: 'small muted' }, `Moves all ${overview?.zec?.transparent ?? ''} ZEC of transparent balance to your shielded address. A small network fee is paid in ZEC. Right after a deposit, you may need to wait for confirmations.`),
  h('br'),
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
  go);
  show('send', subBar('Shield', () => void renderAsset()), h('div', { class: 'scroll' }, form));
  pw.focus();
}

function renderZecRescan(coin: 'ZEC' | 'ARRR' = 'ZEC'): void {
  const date = h('input', { id: 'zec-date', placeholder: '2025-06-01', autocomplete: 'off' });
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-rescan', type: 'submit' }, 'Rescan');
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Getting ready…', box, async () => {
      await (coin === 'ARRR' ? wallet.arrrRescan(date.value, pw.value) : wallet.zecRescan(date.value, pw.value));
      pw.value = '';
      await refresh();
      void renderAsset();
    });
  } },
  box.el,
  h('p', { class: 'small muted' }, `A wallet restored from a seed only shows transactions from now on. If you received ${coin} earlier, rescan from then. Earlier dates take longer, up to hours for months ago. Other coins work in the meantime.`),
  h('br'),
  h('label', { class: 'field' }, h('span', {}, `Date you first received ${coin}`), date),
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
  go);
  show('send', subBar('Rescan past history', () => void renderAsset()), h('div', { class: 'scroll' }, form));
  date.focus();
}

// ---- coin picker ----

/**
 * A coin list with each network's tokens folded under its own coin, as on the home screen: the arrow beside a coin
 * shows its tokens. The group holding the current coin starts open.
 */
function coinMenu(prefix: string, assets: Asset[], current: Asset, onPick: (a: Asset) => void): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const a of assets) {
    if (IN_GROUP.has(a) && assets.includes(GROUP_OF[a] as Asset)) continue;
    const pick = h('button', { type: 'button', id: `${prefix}-${a}`, onclick: () => onPick(a) }, coin(a), COIN[a].label);
    const kids = (GROUPS[a] ?? []).filter((k) => assets.includes(k));
    if (!kids.length) { rows.push(pick); continue; }
    const open = kids.includes(current);
    const sub = h('div', { class: 'menu-sub', id: `${prefix}-tokens-${a}`, hidden: !open },
      ...kids.map((k) => h('button', { type: 'button', class: 'menu-token', id: `${prefix}-${k}`, onclick: () => onPick(k) }, coin(k), COIN[k].label)));
    const fold: HTMLButtonElement = h('button', { type: 'button', class: 'menu-fold', id: `${prefix}-fold-${a}`, 'aria-expanded': String(open), 'aria-controls': `${prefix}-tokens-${a}`, 'aria-label': `${COIN[a].label} tokens`, onclick: (e: Event) => {
      e.stopPropagation();
      sub.hidden = !sub.hidden;
      fold.setAttribute('aria-expanded', String(!sub.hidden));
    } }, icon('down'));
    rows.push(h('div', { class: 'menu-group' }, h('div', { class: 'menu-row' }, pick, fold), sub));
  }
  return rows;
}

function picker(onPick: () => void): HTMLElement {
  const wrap = h('div', { class: 'picker' });
  const menu = h('div', { class: 'menu', hidden: true, id: 'coin-menu' }, ...coinMenu('pick', ASSETS, selected, (a) => { selected = a; onPick(); }));
  const btn = h('button', { type: 'button', class: 'picker-btn', id: 'coin-picker', 'aria-haspopup': 'true', 'aria-label': `Choose a coin, currently ${selected}`, onclick: () => { menu.hidden = !menu.hidden; } },
    coin(selected), h('span', { class: 'picker-label' }, COIN[selected].label, icon('down')));
  wrap.append(btn, menu);
  return wrap;
}

// ---- send ----

function renderSend(keep?: { to: string; amount: string }): void {
  const asset = selected;
  const to = h('input', { id: 'to', spellcheck: 'false', autocomplete: 'off', class: 'mono', placeholder: 'Enter, paste or scan an address', value: keep?.to ?? '' });
  const amount = numbersOnly(h('input', { id: 'amount', class: 'amount-input', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', value: keep?.amount ?? '' }) as HTMLInputElement);
  const usd = h('div', { class: 'usd', id: 'usd-preview' });
  const box = errorBox();
  const next = h('button', { class: 'primary', id: 'review', type: 'submit' }, 'Next');
  const update = () => {
    next.disabled = !to.value.trim() || !amount.value.trim();
    const p = prices?.[asset]?.usd;
    const raw = amount.value.trim();
    const n = raw.toLowerCase() === 'max' ? Number(overview?.balances?.[asset]?.spendable) : Number(raw);
    usd.textContent = typeof p === 'number' && Number.isFinite(n) && raw ? `≈ ${usdFormat(n * p)}` : '';
  };
  to.addEventListener('input', update);
  amount.addEventListener('input', update);
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(next, asset === 'XMR' ? 'Creating the transaction…' : 'Calculating the fee…', box, async () => {
      const preview = await wallet.prepareSend(asset, to.value, amount.value);
      renderReview(preview, { to: to.value, amount: amount.value });
    });
  } },
  box.el,
  h('div', { class: 'panel' }, h('label', { class: 'label', for: 'to' }, 'Receiving address'),
    h('div', { class: 'input-wrap' }, to, h('button', { type: 'button', class: 'icon-btn', id: 'paste', 'aria-label': 'Paste', title: 'Paste', onclick: async () => { to.value = await wallet.paste(); update(); } }, icon('paste')),
      h('button', { type: 'button', class: 'icon-btn', id: 'scan', 'aria-label': 'Scan QR code', title: 'Scan QR code', onclick: () => void openScanner(asset, (found) => {
        to.value = found.address;
        if (found.amount && !amount.value.trim()) amount.value = found.amount;
        update();
      }) }, icon('scan')))),
  h('div', { class: 'panel' }, h('label', { class: 'label', for: 'amount' }, 'Amount'),
    h('div', { class: 'input-wrap' }, amount, h('span', { class: 'unit' }, unitOf(asset)),
      h('button', { type: 'button', class: 'max', id: 'max', onclick: () => { amount.value = 'max'; update(); } }, 'Max'))),
  usd,
  feeLine(asset, 'send-fee', (f) => `Estimated fee: ${feeText(f)}. It depends on the amount and address, and the next screen shows the exact value.`),
  COIN[asset].note && h('p', { class: 'small muted' }, COIN[asset].note),
  h('br'),
  next);
  show('send', subBar('Send', renderHome), h('div', { class: 'scroll' }, picker(() => renderSend({ to: to.value, amount: '' })), form));
  onData = update;
  update();
}

// ---- QR scan ----

/** Reads an address out of a QR code. Accepts a bare address or a wallet link such as monero:4...?tx_amount=1. */
function parseScanned(asset: Asset, raw: string): { address: string; amount: string } | null {
  const text = raw.trim();
  const m = text.match(/^(?:(bitcoincash|bitcoin|btc|litecoin|ltc|secret|scrt|solana|sol|dogecoin|doge|dash|firo|zcash|zec|zano|pirate|arrr|ethereum|eth|tron|trx|usdt|monero|xmr)(?::\/\/|:))?([0-9A-Za-z]+)(?:@1)?(?:\?(.*))?$/i);
  if (!m) return null;
  const scheme = (m[1] ?? '').toLowerCase();
  const family = (a: Asset) => (a === 'BCH' ? ['bitcoincash'] : a === 'LTC' ? ['litecoin', 'ltc'] : a === 'SCRT' || a === 'SSCRT' ? ['secret', 'scrt'] : a === 'NEAR' ? ['near'] : a === 'SOL' ? ['solana', 'sol'] : SPL_ASSETS.includes(a) ? ['solana', 'sol', 'usdt', 'spl'] : BSC_ASSETS.includes(a) ? ['ethereum', 'bnb', 'bsc', 'usdt'] : a === 'POL' || a === 'USDTP' || a === 'ETHP' ? ['ethereum', 'polygon', 'pol', 'matic', 'usdt'] : a === 'ARB' || a === 'ETHA' || a === 'USDTA' ? ['ethereum', 'arbitrum', 'arb', 'eth', 'usdt'] : a === 'DOGE' ? ['dogecoin', 'doge'] : a === 'DASH' ? ['dash'] : a === 'FIRO' ? ['firo'] : a === 'ZEC' ? ['zcash', 'zec'] : a === 'ZANO' ? ['zano'] : a === 'ARRR' ? ['pirate', 'arrr'] : a === 'BTC' ? ['bitcoin', 'btc'] : a === 'XMR' ? ['monero', 'xmr'] : a === 'ETH' || a === 'USDTE' ? ['ethereum', 'eth', 'usdt'] : ['tron', 'trx', 'usdt']);
  if (scheme && !family(asset).includes(scheme)) return null;
  // Bech32 QR codes are often in upper case to make them smaller.
  const address = asset === 'BTC' && /^BC1/.test(m[2]) ? m[2].toLowerCase() : m[2];
  const valid = asset === 'BTC' ? /^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(address)
    : asset === 'SOL' || SPL_ASSETS.includes(asset) ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
    : asset === 'DOGE' ? /^[DA9][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    : asset === 'ADA' ? /^addr1[02-9ac-hj-np-z]{50,120}$/.test(address)
    : asset === 'BCH' ? /^[qp][02-9ac-hj-np-z]{41}$/i.test(address)
    : asset === 'LTC' ? /^(ltc1[02-9ac-hj-np-z]{8,87}|ltcmweb1[02-9ac-hj-np-z]{100,140}|[LM][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(address)
    : asset === 'SCRT' || asset === 'SSCRT' ? /^secret1[02-9ac-hj-np-z]{38}$/.test(address)
    : asset === 'NEAR' ? /^([0-9a-f]{64}|0x[0-9a-f]{40}|(([a-z\d]+[-_])*[a-z\d]+\.)+([a-z\d]+[-_])*[a-z\d]+)$/.test(address)
    : asset === 'FIRO' ? /^([a3][1-9A-HJ-NP-Za-km-z]{33}|sm1[02-9ac-hj-np-z]{100,200})$/.test(address)
    : asset === 'DASH' ? /^[X7][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    : asset === 'ARRR' ? /^(zs1[02-9ac-hj-np-z]{75}|pirate1[02-9ac-hj-np-z]{40,})$/.test(address)
    : asset === 'ZANO' ? /^(Zx|iZ|aZ|ai)[1-9A-HJ-NP-Za-km-z]{90,120}$/.test(address)
    : asset === 'ZEC' ? /^(t[13][1-9A-HJ-NP-Za-km-z]{33}|zs1[02-9ac-hj-np-z]{75}|u1[02-9ac-hj-np-z]{100,}|tex1[02-9ac-hj-np-z]{30,})$/.test(address)
    : asset === 'XMR' ? /^[48][1-9A-HJ-NP-Za-km-z]{94}([1-9A-HJ-NP-Za-km-z]{11})?$/.test(address)
      : EVM_ASSETS.includes(asset) ? /^0x[0-9a-fA-F]{40}$/.test(address)
      : /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  if (!valid) return null;
  // Ethereum links carry value in wei, so the amount is left for the person to type.
  const amount = EVM_ASSETS.includes(asset) ? '' : new URLSearchParams(m[3] ?? '').get(asset === 'XMR' ? 'tx_amount' : 'amount') ?? '';
  return { address, amount: /^\d+(\.\d+)?$/.test(amount) ? amount : '' };
}

let closeScanner: (() => void) | null = null;

/** custom reads something other than an address (a WalletConnect link): parse returns it, or null with the wrong message. */
async function openScanner(asset: Asset, onFound: (found: { address: string; amount: string }) => void, custom?: { parse: (text: string) => string | null; wrong: string; onText: (text: string) => void }): Promise<void> {
  closeScanner?.();
  const video = h('video', { playsinline: 'true', muted: 'true', autoplay: 'true', 'aria-label': 'Camera view' });
  const status = h('p', { class: 'scan-status', id: 'scan-status', role: 'status' }, 'Turning on the camera…');
  let stream: MediaStream | null = null;
  let timer: number | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeScanner = null;
    window.clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    document.removeEventListener('visibilitychange', onHidden);
    document.removeEventListener('keydown', onKey);
    el.remove();
  };
  const onHidden = () => { if (document.hidden) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const el = h('div', { class: 'scanner', id: 'scanner', role: 'dialog', 'aria-label': 'Scan QR code' },
    video, h('div', { class: 'scan-frame', 'aria-hidden': 'true' }), status,
    h('button', { class: 'icon-btn scan-close', id: 'scan-close', 'aria-label': 'Close', onclick: close }, icon('close')));
  document.querySelector('.screen')?.append(el);
  closeScanner = close;
  document.addEventListener('visibilitychange', onHidden);
  document.addEventListener('keydown', onKey);

  try {
    await wallet.cameraPermission?.();
    if (closed) return;
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    if (closed) { stream.getTracks().forEach((t) => t.stop()); return; }
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    const name = (e as Error)?.name;
    status.textContent = name === 'NotFoundError' ? 'No camera found. Paste the address instead.'
      : name === 'NotAllowedError' || errMsg(e) === 'camera-denied' ? 'No camera permission. Allow it in device settings or paste the address.'
        : 'Could not turn on the camera. Paste the address instead.';
    return;
  }
  status.textContent = 'Fit the QR code inside the square.';

  // Frames are only read here on the device. Nothing is saved or sent.
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const tick = () => {
    if (closed) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw && vh) {
      const scale = Math.min(1, 800 / Math.max(vw, vh));
      canvas.width = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
      if (code?.data) {
        if (custom) {
          const text = custom.parse(code.data);
          if (text) { close(); custom.onText(text); return; }
          status.textContent = custom.wrong;
          timer = window.setTimeout(tick, 180);
          return;
        }
        const found = parseScanned(asset, code.data);
        if (found) { close(); onFound(found); return; }
        status.textContent = `This is not a ${asset === 'XMR' ? 'Monero' : asset === 'SOL' || SPL_ASSETS.includes(asset) ? 'Solana' : asset === 'DOGE' ? 'Dogecoin' : asset === 'BCH' ? 'Bitcoin Cash' : asset === 'LTC' ? 'Litecoin' : asset === 'SCRT' || asset === 'SSCRT' ? 'Secret Network' : asset === 'NEAR' ? 'NEAR' : asset === 'DASH' ? 'Dash' : asset === 'FIRO' ? 'Firo' : asset === 'ZEC' ? 'Zcash' : asset === 'ZANO' ? 'Zano' : asset === 'ARRR' ? 'Pirate Chain' : asset === 'BTC' ? 'Bitcoin' : EVM_ASSETS.includes(asset) ? 'Ethereum' : 'Tron'} address QR. Try another one.`;
      }
    }
    timer = window.setTimeout(tick, 180);
  };
  tick();
}

function addressCheck(address: string): HTMLElement {
  // The ends are what address-poisoning attacks imitate, the middle is what they can't.
  const n = address.length;
  const mid = Math.floor(n / 2);
  return h('div', { class: 'addr-check', id: 'review-to' }, h('b', {}, address.slice(0, 6)), address.slice(6, mid - 4),
    h('b', {}, address.slice(mid - 4, mid + 4)), address.slice(mid + 4, n - 6), h('b', {}, address.slice(-6)));
}

function renderReview(p: any, keep: { to: string; amount: string }): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const send = h('button', { class: 'primary', id: 'confirm-send', type: 'submit' }, `Send ${p.amount} ${coinName(p.asset)}`);
  const back = () => { void wallet.cancelSend(p.id); renderSend(keep); };
  const price = prices?.[p.asset]?.usd;
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(send, 'Sending…', box, async () => {
      const res = await wallet.confirmSend(p.id, pw.value);
      pw.value = '';
      renderSent(p, res.hashes);
      void refresh();
    });
  } },
  h('p', { class: 'small muted' }, 'Blockchain sends can\'t be undone. Compare the start, middle and end of the address with the original.'),
  h('br'),
  box.el,
  ...p.warnings.map((w: string) => h('div', { class: 'warn' }, w)),
  h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
    h('tr', {}, h('th', {}, 'Amount'), h('td', {},
      h('div', { class: 'big-amount', id: 'review-amount' }, `${p.amount} ${coinName(p.asset)}`),
      typeof price === 'number' && h('div', { class: 'small muted' }, `≈ ${usdFormat(Number(p.amount) * price)}`))),
    h('tr', {}, h('th', {}, 'Receiving address'), h('td', {}, addressCheck(p.to))),
    h('tr', {}, h('th', {}, p.feeIsEstimate ? 'Estimated fee' : 'Fee'), h('td', { id: 'review-fee' }, reviewFee(p.fee, p.feeAsset)))))),
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
  send);
  show('send', subBar('Review', back), h('div', { class: 'scroll' }, form));
  pw.focus();
}

/** A Uniswap or PancakeSwap swap: one or two transactions this wallet signs and sends itself. */
function renderDexReview(p: any, back: () => void): void {
  const pw = h('input', { type: 'password', id: 'dex-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'dex-confirm', type: 'submit' }, p.steps > 1 ? `Approve and swap (${p.steps} transactions)` : 'Swap');
  const price = prices?.[p.to]?.usd;
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Sending…', box, async () => {
      const res = await wallet.dexConfirm(p.id, pw.value);
      pw.value = '';
      show('receive', subBar('Swap sent', renderHome), h('div', { class: 'scroll' },
        h('h2', { id: 'dex-sent' }, `${p.amount} ${coinName(p.from)} → ${coinName(p.to)}`),
        h('p', { class: 'muted' }, `Sent to the network through ${p.provider}. The balance updates once it's in a block. If the price moves past your limit before then, the swap fails and only the fee is spent.`),
        ...res.hashes.map((hash: string, i: number) => h('div', { class: 'panel' },
          h('span', { class: 'label' }, res.hashes.length > 1 && i < res.hashes.length - 1 ? 'Permission transaction' : 'Swap transaction'),
          h('div', { class: 'mono' }, hash), h('br'),
          h('div', { class: 'row' }, h('button', { onclick: () => wallet.copy(hash) }, 'Copy'), h('button', { onclick: () => void openExplorer(p.from, hash) }, 'View in explorer')))),
        h('button', { class: 'primary', onclick: () => void renderSwap(p.from, p.to) }, 'Swap again')));
      void refresh();
    });
  } },
  box.el,
  ...p.warnings.map((w: string) => h('div', { class: 'warn' }, w)),
  h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
    h('tr', {}, h('th', {}, 'You send'), h('td', { id: 'dex-send' }, `${p.amount} ${coinName(p.from)}`)),
    h('tr', {}, h('th', {}, 'You receive'), h('td', {}, h('div', { class: 'big-amount', id: 'dex-receive' }, `about ${p.receive} ${coinName(p.to)}`),
      typeof price === 'number' && h('div', { class: 'small muted' }, `≈ ${usdFormat(Number(p.receive) * price)}`))),
    h('tr', {}, h('th', {}, 'At least'), h('td', { id: 'dex-min' }, `${p.minReceive} ${coinName(p.to)} (slippage limit ${p.slippage}%)`)),
    h('tr', {}, h('th', {}, 'Exchange'), h('td', {}, p.provider)),
    h('tr', {}, h('th', {}, 'Estimated fee'), h('td', { id: 'dex-fee' }, reviewFee(p.fee, p.feeAsset)))))),
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
  go);
  show('send', subBar('Review swap', () => { void wallet.cancelSend(p.id); back(); }), h('div', { class: 'scroll' }, form));
  pw.focus();
}

function renderSent(p: any, hashes: string[]): void {
  show('receive', subBar('Sent', renderHome), h('div', { class: 'scroll' },
    h('div', { class: 'picker' }, h('div', { class: 'picker-btn' }, coin(p.asset))),
    h('h2', { id: 'sent' }, `Sent ${p.amount} ${coinName(p.asset)}`),
    h('p', { class: 'muted' }, 'It\'s on the network. History shows it as confirmed once it\'s in a block.'),
    h('br'),
    ...hashes.map((hash) => h('div', { class: 'panel' },
      h('span', { class: 'label' }, 'Transaction hash'),
      h('div', { class: 'mono', id: 'sent-hash' }, hash),
      h('br'),
      h('div', { class: 'row' },
        h('button', { onclick: () => wallet.copy(hash) }, 'Copy'),
        h('button', { id: 'open-explorer', onclick: () => void openExplorer(p.asset, hash) }, 'View in explorer')))),
    h('button', { class: 'primary', id: 'send-again', onclick: () => renderSend() }, 'Send another')));
}

wallet.on('tron-tx', (t: { txid: string; status: string }) => {
  if (t.status === 'failed') {
    const el = document.getElementById('sent');
    const msg = `The transaction failed (${t.txid.slice(0, 10)}…). The fee may have been too low. Check on an explorer.`;
    if (el) { el.textContent = 'Send failed'; el.parentElement?.insertBefore(h('div', { class: 'error' }, msg), el.nextSibling); }
  }
  void refresh();
});

// ---- buy ----

async function renderBuy(): Promise<void> {
  const asset = selected;
  const addressEl = h('div', { class: 'mono', id: 'buy-address' }, 'Loading…');
  const status = h('span', { class: 'status', role: 'status' });
  const box = errorBox();
  let address = '';
  const copy = h('button', { class: 'icon-btn', id: 'buy-copy', disabled: true, 'aria-label': 'Copy address', title: 'Copy address', onclick: async () => {
    await wallet.copy(address); status.textContent = 'Copied. It clears from the clipboard in 60 seconds.';
  } }, icon('copy'));
  const tor = Boolean((await wallet.torInfo().catch(() => null))?.enabled);
  const open = h('button', { class: 'primary', id: 'buy-open', onclick: () => busy(open, 'Opening…', box, async () => {
    await wallet.openBuy(asset);
    status.textContent = 'LocalCoinSwap opened in your browser. Give this address to the seller as the receiving address.';
  }) }, 'Buy on LocalCoinSwap');
  if (asset === 'SSCRT') { (open as HTMLButtonElement).disabled = true; status.textContent = 'sSCRT isn\'t sold anywhere. Buy SCRT, then make it private on the SCRT screen.'; }
  show('send', subBar('Buy', renderHome), h('div', { class: 'scroll' },
    picker(() => void renderBuy()),
    h('div', { class: 'panel' },
      h('span', { class: 'label' }, `Your ${coinName(asset)} receiving address`),
      h('div', { class: 'addr-box' }, addressEl, copy),
      status),
    h('p', { class: 'small muted' }, 'Copy the address and use it as the receiving address on LocalCoinSwap. Check that the coin and network there match.'),
    h('p', { class: 'small muted' }, 'LocalCoinSwap is a peer-to-peer marketplace: you buy from other people, with the payment methods they offer, and its escrow holds the coins until the trade is done. LocalCoinSwap sets its own rules and fees and may not list every coin. This wallet adds no fee and sends them nothing.'),
    tor && h('p', { class: 'small muted' }, 'Your browser isn\'t behind Tor, so they can see your IP address.'),
    box.el,
    open));
  try {
    const list = await wallet.addresses();
    // Sellers pay Zcash to transparent addresses.
    address = asset === 'ZEC' ? list?.ZEC_T ?? '' : list?.[asset] ?? '';
    if (!address) throw new Error(asset === 'ZEC' ? 'The Zcash wallet is getting ready. See the Zcash engine section in Settings for progress.' : 'Could not load the address. Open this again.');
    if (!addressEl.isConnected) return;
    addressEl.textContent = address;
    copy.disabled = false;
  } catch (e) {
    box.show(e);
  }
}

/**
 * Amount fields take digits and one decimal point only. A comma counts as the decimal point, unless the text also
 * has a point, in which case commas are thousands separators and go.
 */
function numbersOnly(input: HTMLInputElement): HTMLInputElement {
  input.addEventListener('input', () => {
    const raw = input.value;
    let v = raw.includes('.') ? raw.replace(/,/g, '') : raw.replace(/,/g, '.');
    v = v.replace(/[^0-9.]/g, '');
    const dot = v.indexOf('.');
    if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, '');
    if (v !== raw) {
      const end = Math.max(0, (input.selectionEnd ?? v.length) - (raw.length - v.length));
      input.value = v;
      input.setSelectionRange(end, end);
    }
  });
  return input;
}

// ---- receive ----

async function renderReceive(current?: string): Promise<void> {
  const asset = selected;
  const qrFrame = h('div', { class: 'qr-frame' });
  const addressEl = h('div', { class: 'mono', id: 'my-address' }, 'Loading…');
  const status = h('span', { class: 'status', role: 'status' });
  const box = errorBox();
  const extra = h('div', {});
  let address = current ?? addresses?.[asset] ?? '';
  const copy = h('button', { class: 'icon-btn', id: 'copy', disabled: true, 'aria-label': 'Copy address', title: 'Copy address', onclick: async () => {
    await wallet.copy(address); status.textContent = 'Copied. It clears from the clipboard in 60 seconds.';
  } }, icon('copy'));
  const note = asset === 'ARRR' ? 'Receives ARRR on Pirate Chain mainnet only. Amounts and addresses don\'t show on the chain. Received coins can be used after confirmations.'
    : asset === 'ZANO' ? 'Receives ZANO on Zano mainnet only. Amounts and addresses don\'t show on the chain. Received coins can be used after 10 confirmations.'
    : asset === 'ZEC' ? (address.startsWith('t') ? 'This is a transparent address. The amount and address are public on the chain. Coins must be shielded after arrival before they can be sent.' : 'This is a shielded address. The amount and address don\'t show on the chain. Received ZEC can be used after a few confirmations. If a provider can\'t pay this address, use the transparent one.')
    : asset === 'SOL' ? 'The same address as USDT (Sol). Receives SOL on Solana mainnet only. Other Solana tokens aren\'t shown.'
    : asset === 'USDTS' ? 'Receives USDT on the Solana network (SPL) only. Sending needs a little SOL at this address for the fee.'
    : asset === 'LTC' && address.startsWith('ltcmweb1') ? 'A private (MWEB) Litecoin address. The amount and both addresses stay hidden on the chain. Senders need a wallet with MWEB support, such as Litecoin Core or Cake Wallet.'
    : asset === 'LTC' ? 'A Litecoin address (ltc1q). Coins sent from Bitcoin or other chains won\'t arrive. Once a deposit is seen, a new address appears next time.'
    : asset === 'SSCRT' ? 'The same secret1 address as plain SCRT. sSCRT sent to it arrives privately, and only after the private balance is turned on can this wallet show it.'
    : asset === 'SCRT' ? 'Receives SCRT on Secret Network mainnet only. The amount and address are public on the chain. No memo is needed.'
    : asset === 'BCH' ? 'Receives BCH on Bitcoin Cash only. Coins sent from Bitcoin or other chains won\'t arrive. Once a deposit is seen, a new address appears next time.'
    : asset === 'DOGE' ? 'Receives DOGE on Dogecoin mainnet only. Once a deposit is seen, a new address appears next time.'
    : asset === 'FIRO' && address.startsWith('sm1') ? 'A private (Spark) Firo address. The amount and both addresses stay hidden on the chain. Senders need a wallet with Spark support, such as Firo\'s own wallet or Stack Wallet. Coins show here once they are in a block.'
    : asset === 'FIRO' ? 'Receives FIRO on Firo mainnet only. This is a transparent address, so the amount and address are public on the chain. Once a deposit is seen, a new address appears next time.'
    : asset === 'DASH' ? 'Receives DASH on Dash mainnet only. Once a deposit is seen, a new address appears next time.'
    : asset === 'BTC' ? 'A Bitcoin Taproot (bc1p) address. Coins sent from other chains won\'t arrive. Once a deposit is seen, a new address appears next time.'
    : asset === 'ETH' ? 'The same address as USDT (Eth). Receives ETH on Ethereum mainnet only. Coins sent over L2s or other chains won\'t arrive.'
    : asset === 'USDTE' ? 'Receives USDT on the Ethereum network (ERC-20) only. Sending needs ETH at this address for the fee.'
    : asset === 'LINK' ? 'Receives LINK on Ethereum (ERC-20) only. Sending needs ETH at this address for the fee.'
    : asset === 'UNI' || asset === 'PEPE' || asset === 'AAVE' || asset === 'SHIB' ? `Receives ${asset} on Ethereum (ERC-20) only. Sending needs ETH at this address for the fee.`
    : asset === 'SHIBB' || asset === 'LINKB' || asset === 'UNIB' || asset === 'AAVEB' ? `Receives ${unitOf(asset)} on BNB Smart Chain (BEP-20) only. Sending needs BNB at this address for the fee.`
    : asset === 'LINKP' || asset === 'UNIP' || asset === 'AAVEP' ? `Receives ${unitOf(asset)} on Polygon only. Sending needs POL at this address for the fee.`
    : asset === 'LINKA' || asset === 'UNIA' ? `Receives ${unitOf(asset)} on Arbitrum One only. Sending needs ETH (Arb) at this address for the fee.`
    : asset === 'ETHP' ? 'Receives ETH on Polygon only (bridged ETH). ETH sent on Ethereum or Arbitrum won\'t show here. Sending needs POL at this address for the fee.'
    : asset === 'ADA' ? 'A Cardano base address (addr1…), the same as in Yoroi, Eternl and Lace for this seed. Receives ADA on Cardano mainnet only.'
    : asset === 'NEAR' ? 'Receives NEAR on the NEAR network only. This 64-character account becomes active when the first NEAR arrives. NEAR sent as a token on Ethereum or BNB Chain won\'t arrive.'
    : asset === 'HYPE' ? 'The same 0x address as on Ethereum. Receives HYPE on HyperEVM only. HYPE sent on Hyperliquid\'s trading chain (HyperCore) or another chain won\'t show here.'
    : asset === 'BNB' ? 'The same 0x address as on Ethereum. Receives BNB on BNB Smart Chain (BEP-20) only. BNB on other chains won\'t show here.'
    : asset === 'USDTB' || asset === 'ASTER' || asset === 'CAKE' ? `Receives ${asset === 'USDTB' ? 'USDT' : asset} on BNB Smart Chain (BEP-20) only. Sending needs BNB at this address for the fee.`
    : asset === 'JUP' || asset === 'RAY' || asset === 'ORCA' || asset === 'PUMP' ? `Receives ${asset} on Solana (SPL) only. Sending needs a little SOL at this address for the fee.`
    : asset === 'WLD' ? 'Receives WLD on Ethereum (ERC-20) only. Sending needs ETH at this address for the fee.'
    : asset === 'POL' ? 'The same 0x address as on Ethereum and Arbitrum. Receives POL on Polygon only.'
    : asset === 'USDTP' ? 'Receives USDT on Polygon only. Sending needs POL at this address for the fee.'
    : asset === 'ARB' ? 'Receives the ARB token on Arbitrum One only. Sending needs ETH (Arb) at this address for the fee.'
    : asset === 'ETHA' ? 'Receives ETH on Arbitrum One only. ETH sent on Ethereum mainnet won\'t show here.'
    : asset === 'USDTA' ? 'Receives USDT on Arbitrum One only. Sending needs ETH (Arb) at this address for the fee.'
    : asset === 'USDCE' ? 'Receives USDC on the Ethereum network (ERC-20) only. Sending needs ETH at this address for the fee.'
    : asset === 'USDCB' ? 'Receives USDC on BNB Smart Chain (BEP-20) only. Sending needs BNB at this address for the fee.'
    : asset === 'USDCS' ? 'Receives USDC on Solana (SPL) only. Sending needs a little SOL at this address for the fee.'
    : asset === 'USDCP' ? 'Receives native USDC on Polygon only. Bridged USDC.e won\'t show here. Sending needs POL at this address for the fee.'
    : asset === 'USDCA' ? 'Receives native USDC on Arbitrum One only. Bridged USDC.e won\'t show here. Sending needs ETH (Arb) at this address for the fee.'
    : asset === 'USDT' ? 'Receives USDT on the Tron network (TRC-20) only. Coins sent from other chains won\'t arrive.'
    : asset === 'TRX' ? 'The same address as USDT. Sending USDT needs TRX at this address for the fee.'
      : 'Received XMR can be used after 10 confirmations (about 20 minutes). A new address for each sender is better for privacy.';
  show('receive', subBar('Receive', renderHome), h('div', { class: 'scroll' },
    picker(() => void renderReceive()),
    qrFrame,
    feeLine(asset, 'receive-fee', (f) => `You pay no fee to receive. The sender pays the network fee. Sending this coin later costs ${feeText(f)}.`),
    h('div', { class: 'panel' },
      h('span', { class: 'label' }, `${coinName(asset)} address`),
      h('div', { class: 'addr-box' }, addressEl, copy),
      status),
    h('p', { class: 'small muted' }, note), h('br'),
    box.el,
    extra));

  try {
    if (!address) {
      addresses = await wallet.addresses();
      address = addresses?.[asset] ?? '';
    }
    if (!address) throw new Error(asset === 'ZEC' ? 'The Zcash wallet is getting ready. See the Zcash engine section in Settings for progress.' : 'Could not load the address. Open this again.');
    const qr = await wallet.qr(address);
    if (!addressEl.isConnected) return;
    setKids(qrFrame, h('img', { src: qr, alt: `QR code of your ${coinName(asset)} receiving address` }));
    addressEl.textContent = address;
    copy.disabled = false;
  } catch (e) {
    box.show(e);
    return;
  }

  if (asset === 'FIRO' && overview?.spark?.receive) {
    const priv = address.startsWith('sm1');
    const list = await wallet.addresses();
    setKids(extra, h('button', { class: 'ghost', id: 'firo-address-kind', onclick: () => void renderReceive(priv ? list.FIRO : overview.spark.receive) }, priv ? 'Show public address' : 'Show private (Spark) address'));
    return;
  }
  if (asset === 'LTC' && overview?.mweb?.receive) {
    const priv = address.startsWith('ltcmweb1');
    const list = await wallet.addresses();
    setKids(extra, h('button', { class: 'ghost', id: 'ltc-address-kind', onclick: () => void renderReceive(priv ? list.LTC : overview.mweb.receive) }, priv ? 'Show public address' : 'Show private (MWEB) address'));
    return;
  }
  if (asset === 'ZEC') {
    const list = await wallet.addresses();
    const shieldedOn = address === list.ZEC;
    setKids(extra, h('button', { class: 'ghost', id: 'zec-address-kind', onclick: () => void renderReceive(shieldedOn ? list.ZEC_T : list.ZEC) }, shieldedOn ? 'Show transparent address' : 'Show shielded address'));
    return;
  }
  if (asset !== 'XMR') return;
  const add = h('button', { class: 'ghost', id: 'new-sub', onclick: () => busy(add, 'Creating… This can take a while during sync', box, async () => { await renderReceive(await wallet.newSubaddress()); }) }, 'New address');
  setKids(extra, add);
  try {
    const list: { index: number; address: string }[] = await wallet.moneroAddresses();
    if (!extra.isConnected || list.length < 2) return;
    setKids(extra, add, h('div', { class: 'sub-list' }, ...list.map((s) => h('button', { class: `mono${s.address === address ? ' on' : ''}`, onclick: () => void renderReceive(s.address) },
      `${s.index === 0 ? 'Main' : '#' + s.index}  ${s.address.slice(0, 14)}…${s.address.slice(-10)}`))));
  } catch { /* the main address is already on screen */ }
}

// ---- swap ----

const SWAP_STATUS: Record<string, string> = {
  hold: 'Held for provider review', verifying: 'Under provider review', new: 'Waiting for deposit', waiting: 'Waiting for deposit', confirming: 'Checking the deposit', finished: 'Finished', failed: 'Failed', expired: 'Expired', halted: 'Held for provider review', 'paid partially': 'Partly deposited',
  deposit: 'Waiting for deposit', confirmations: 'Checking the deposit', wait: 'Waiting for deposit', confirmation: 'Checking the deposit', confirmed: 'Deposit confirmed', exchanging: 'Exchanging', sending: 'Sending',
  success: 'Finished', overdue: 'Expired', refund: 'Refunding', refunded: 'Refunded', unknown: 'Checking',
};

function coinSelect(id: string, current: Asset, onPick: (a: Asset) => void): HTMLElement {
  const menu = h('div', { class: 'menu', hidden: true, id: `${id}-menu` }, ...coinMenu(id, ASSETS.filter((a) => a !== 'SSCRT'), current, onPick));
  return h('div', { class: 'coin-select' },
    h('button', { type: 'button', id, class: 'coin-select-btn', 'aria-label': `Choose a coin, currently ${coinName(current)}`, onclick: () => { menu.hidden = !menu.hidden; } }, coin(current), h('span', {}, coinName(current)), icon('down')),
    menu);
}

// Every coin except XMR itself can go out through XMR and come back as another coin.
const PRIVACY_ASSETS: Asset[] = ALL_ASSETS.filter((a) => a !== 'XMR' && a !== 'SSCRT');

async function renderSwap(from: Asset = selected, to: Asset = selected === 'XMR' ? 'BTC' : 'XMR', keep = '', privacy = false): Promise<void> {
  // sSCRT doesn't trade anywhere; from its screen, swapping starts from plain SCRT.
  if (from === 'SSCRT') from = 'SCRT';
  if (to === 'SSCRT') to = 'XMR';
  if (privacy && !(PRIVACY_ASSETS.includes(from) && PRIVACY_ASSETS.includes(to))) privacy = false;
  if (!privacy && from === to) to = from === 'XMR' ? 'BTC' : 'XMR';
  const amount = numbersOnly(h('input', { id: 'swap-amount', class: 'swap-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount to send', value: keep }) as HTMLInputElement);
  const receive = h('div', { class: 'swap-receive', id: 'swap-receive' }, '0');
  const receiveNet = h('div', { class: 'swap-net', id: 'swap-net' });
  const info = h('div', { class: 'small muted swap-info', id: 'swap-info' });
  const balance = h('span', { class: 'small muted', id: 'swap-balance' });
  const box = errorBox();
  let chosen: any = null;
  let slippage = 50; // basis points, for Uniswap and PancakeSwap
  const offers = h('div', { class: 'swap-offers', id: 'swap-offers' });
  const next = h('button', { class: 'primary', id: 'swap-next', disabled: true, onclick: () => busy(next, chosen?.dex ? 'Checking the route…' : 'Creating the order…', box, async () => {
    const again = () => void renderSwap(from, to, amount.value, privacy);
    if (chosen?.dex && !privacy) { renderDexReview(await wallet.dexPrepare(from, to, amount.value, chosen.providerId, slippage), again); return; }
    renderSwapReview(privacy
      ? await wallet.privacyPrepare(from, to, amount.value, chosen.providerId, dest.value)
      : await wallet.swapPrepare(from, to, amount.value, chosen.providerId, dest.value), again);
  }) }, 'Next');
  const dest = h('input', { id: 'swap-dest', spellcheck: 'false', autocomplete: 'off', placeholder: privacy ? 'Final receiving address' : 'Empty means your own wallet' });
  const privacyToggle = h('input', { type: 'checkbox', id: 'swap-privacy', checked: privacy, onchange: () => {
    void renderSwap(from, to, amount.value, !privacy);
  } });
  const paintOffers = (list: any[]) => {
    const good = list.filter((q) => !q.problem);
    // GhostSwap is the default whenever it has a quote. A provider the person picked stays picked.
    chosen = good.find((q) => q.providerId === chosen?.providerId) ?? good.find((q) => q.providerId === 'ghostswap') ?? good[0] ?? null;
    next.disabled = !chosen;
    receive.textContent = chosen ? `about ${chosen.receive}` : '0';
    receiveNet.textContent = chosen ? netLine(chosen, chosen.network) : '';
    info.textContent = chosen ? `1 ${coinName(from)} ≈ ${chosen.rate} ${coinName(to)}. Handled by ${chosen.provider}.` : (list[0]?.problem ?? '');
    const network = list[0]?.network;
    setKids(offers, h('span', { class: 'label' }, list.length > 1 ? 'Compare providers' : 'Estimated cost'), ...list.map((q) => h('button', {
      type: 'button', class: `swap-offer${q === chosen ? ' on' : ''}`, id: `offer-${q.providerId}`, disabled: Boolean(q.problem),
      onclick: () => { chosen = q; paintOffers(list); },
    }, h('span', {}, q.provider, q.dex && h('span', { class: 'offer-tag' }, 'on-chain')), h('span', { class: 'offer-right' }, q.problem ? 'No quote' : `about ${q.receive} ${coinName(to)}`, q.problem && h('span', { class: 'small muted offer-cost' }, q.problem), !q.problem && netReceive(q, q.network) && h('span', { class: 'offer-net' }, netLine(q, q.network)), !q.problem && h('span', { class: 'offer-cost' }, offerFee(q).total), !q.problem && h('span', { class: 'small muted offer-cost' }, offerFee(q).detail)))),
    list.some((q) => q.dex) && h('div', { class: 'swap-slippage', id: 'swap-slippage' }, h('span', { class: 'small muted' }, 'Slippage limit (Uniswap, PancakeSwap)'),
      h('div', { class: 'swap-chips' }, ...([[50, '0.5%'], [100, '1%'], [300, '3%']] as const).map(([bps, label]) => h('button', { type: 'button', class: `chip${slippage === bps ? ' on' : ''}`, id: `slip-${bps}`, onclick: () => { slippage = bps as number; refreshQuote(); } }, label)))),
    h('p', { class: 'small muted', id: 'swap-network-fee' }, `The provider fee is included in the rate, so this is an estimate from the gap between the market price and the amount received. The network fee is paid separately from your wallet at deposit.${network && typeof network.usd !== 'number' ? ` About ${network.fee} ${network.asset}.` : ''}`));
  };
  let ticket = 0;
  let timer: number | undefined;
  const refreshQuote = () => {
    window.clearTimeout(timer);
    const value = amount.value.trim();
    const mine = ++ticket;
    next.disabled = true;
    box.clear();
    receive.textContent = '0';
    receiveNet.textContent = '';
    info.textContent = '';
    setKids(offers);
    if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) return;
    info.textContent = 'Getting quotes…';
    timer = window.setTimeout(async () => {
      try {
        if (privacy) {
          const q = await wallet.privacyQuote(from, to, value);
          if (mine !== ticket) return;
          chosen = q.first && q.second && !q.problem ? q.first : null;
          next.disabled = !chosen;
          receive.textContent = chosen ? `about ${q.second.receive}` : '0';
          receiveNet.textContent = chosen ? netLine(q.second, q.first.network, q.second.network) : '';
          info.textContent = chosen
            ? `Step 1, ${q.first.provider}: about ${q.first.receive} XMR, ${offerFee(q.first).total}. Step 2, ${q.second.provider}: ${offerFee(q.second).total}.${q.sameProvider ? ' Only one provider is available, so it can see both sides.' : ''}`
            : (q.problem ?? '');
          return;
        }
        // Coins on one EVM chain can also swap on Uniswap or PancakeSwap, straight from the wallet.
        const [list, dex] = await Promise.all([wallet.swapQuote(from, to, value), wallet.dexQuote(from, to, value, slippage).catch(() => [])]);
        const onChain = [...dex].sort((a: any, b: any) => Number(Boolean(a.problem)) - Number(Boolean(b.problem)) || Number(b.receive) - Number(a.receive));
        if (mine === ticket) paintOffers([...onChain, ...list]);
      } catch (e) {
        if (mine === ticket) info.textContent = `Could not get quotes. ${errMsg(e)}`;
      }
    }, 600);
  };
  amount.addEventListener('input', refreshQuote);
  const change = (nf: Asset, nt: Asset) => { void renderSwap(nf, nt, amount.value, privacy); };
  const paintBalance = () => {
    const b = overview?.balances?.[from];
    balance.textContent = b?.ok ? `${b.spendable} ${coinName(from)}` : '';
  };
  // A share of the balance. At 100% the network fee is held back when it's paid in the same coin.
  const portion = (pct: number) => async () => {
    const b = overview?.balances?.[from];
    if (!b?.ok) return;
    let fee = '0';
    if (pct === 100) {
      const f = await wallet.feeEstimate(from).catch(() => null);
      if (f && (f.asset === from || (from === 'ETHA' && f.asset === 'ETH'))) fee = f.fee;
    }
    const value = shareOf(b.spendable, pct, fee);
    amount.value = value === '0' ? '' : value;
    refreshQuote();
  };
  const chips = h('div', { class: 'swap-chips' }, ...([[25, '25%'], [50, '50%'], [75, '75%'], [100, 'Max']] as const).map(([pct, label]) =>
    h('button', { type: 'button', class: 'chip', id: `swap-pct-${pct}`, onclick: () => void portion(pct)() }, label)));
  const list = h('div', { id: 'swap-list' });
  show('send', subBar('Swap', renderHome), h('div', { class: 'scroll' }, box.el,
    h('div', { class: 'swap-cards' },
      h('div', { class: 'swap-card' }, h('span', { class: 'label' }, 'Send'),
        h('div', { class: 'swap-row' }, amount, coinSelect('swap-from', from, (a) => change(a, a === to && !privacy ? from : to))),
        h('div', { class: 'swap-foot' }, balance, chips)),
      h('div', { class: 'swap-flip' }, h('button', { type: 'button', id: 'swap-flip', 'aria-label': 'Swap direction', onclick: () => change(to, from) }, icon('swap'))),
      h('div', { class: 'swap-card' }, h('span', { class: 'label' }, 'Receive'),
        h('div', { class: 'swap-row' }, receive, coinSelect('swap-to', to, (a) => change(a === from && !privacy ? to : from, a))),
        h('div', { class: 'swap-foot end' }, receiveNet))),
    h('div', { class: 'panel' }, h('div', { class: 'swap-head' }, h('span', { class: 'label' }, 'Receiving address'),
      h('button', { type: 'button', class: 'icon-btn', id: 'swap-scan', 'aria-label': 'Scan QR code', title: 'Scan QR code', onclick: () => void openScanner(to, (f) => { dest.value = f.address; }) }, icon('scan'))), dest),
    to === 'ZEC' && h('p', { class: 'small muted', id: 'zec-swap-note' }, 'The provider pays a transparent address. Shield it on the ZEC screen after it arrives to make it private and sendable.'),
    PRIVACY_ASSETS.includes(from) && PRIVACY_ASSETS.includes(to) && h('label', { class: 'swap-privacy' }, privacyToggle,
      h('span', {}, h('strong', {}, 'Privacy swap'), h('span', { class: 'small muted' }, 'Sends through XMR in two parts. XMR\'s lock makes it take at least 20 minutes, and step 2 needs approval in the app again.'))),
    info, h('br'), offers, next, h('br'),
    h('button', { type: 'button', class: 'primary', id: 'go-tornado', onclick: () => void renderTornado() }, 'Send ETH with Tornado'),
    h('br'), list));
  onData = paintBalance;
  paintBalance();
  if (keep) refreshQuote();
  void paintSwapList(list);
}

function swapRow(r: any): HTMLElement {
  return h('button', { class: 'hist-row swap-history', onclick: () => renderSwapStatus(r) }, coin(r.from),
    h('div', {}, h('div', {}, `${coinName(r.from)} → ${coinName(r.to)}`), h('div', { class: 'small muted' }, `${SWAP_STATUS[r.status] ?? r.status} · ${when(r.createdAt)}`)),
    h('div', { class: 'amt' }, `${r.amount} ${coinName(r.from)}`));
}

async function paintSwapList(el: HTMLElement): Promise<void> {
  const [records, privacy]: any[][] = await Promise.all([wallet.swapList(), wallet.privacyList()]);
  if (!el.isConnected) return;
  const active = privacy.filter((p) => p.stage !== 'done' && p.stage !== 'failed');
  setKids(el,
    active.length > 0 && h('h3', {}, 'Privacy swaps in progress'),
    ...active.map((p) => h('button', { class: 'hist-row swap-history', id: `privacy-${p.id}`, onclick: () => renderPrivacyStatus(p) }, coin(p.from),
      h('div', {}, h('div', {}, `${coinName(p.from)} → XMR → ${coinName(p.to)}`), h('div', { class: 'small muted' }, PRIVACY_STAGE[p.stage])),
      h('div', { class: 'amt' }, `${p.amount} ${coinName(p.from)}`))),
    records.length > 0 && h('h3', {}, 'Recent swaps'), ...records.slice(0, 20).map(swapRow));
}

function renderSwapReview(p: any, backTo: () => void): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-swap', type: 'submit' }, `Swap ${p.amount} ${coinName(p.asset)}`);
  const s = p.swap;
  const back = () => { void wallet.cancelSend(p.id); backTo(); };
  show('send', subBar('Review swap', back), h('div', { class: 'scroll' },
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, 'Sending…', box, async () => {
        const res = await wallet.swapConfirm(p.id, pw.value);
        pw.value = '';
        if (res.privacy) renderPrivacyStatus(res.privacy); else renderSwapStatus(res.record);
        void refresh();
      });
    } },
    box.el,
    ...p.warnings.map((w: string) => h('div', { class: 'warn' }, w)),
    s.external && h('div', { class: 'warn', id: 'review-external' }, 'This receives at an address outside your wallet. A wrong address can\'t be recovered, so check every character.'),
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'You send'), h('td', {}, h('div', { class: 'big-amount', id: 'review-amount' }, `${p.amount} ${coinName(p.asset)}`))),
      h('tr', {}, h('th', {}, 'You receive'), h('td', {}, h('div', { class: 'big-amount', id: 'review-receive' }, `${s.approximate ? 'about ' : ''}${s.receive} ${coinName(s.to)}`), h('div', { class: 'small muted' }, `1 ${coinName(s.from)} ≈ ${s.rate} ${coinName(s.to)}`))),
      h('tr', {}, h('th', {}, p.feeIsEstimate ? 'Estimated fee' : 'Network fee'), h('td', { id: 'review-fee' }, reviewFee(p.fee, p.feeAsset))),
      h('tr', {}, h('th', {}, 'Deposit address'), h('td', {}, addressCheck(p.to))),
      h('tr', {}, h('th', {}, s.external ? 'Receiving address' : s.privacy?.leg === 'first' ? 'Intermediate XMR address' : 'Your receiving address'), h('td', {}, h('div', { class: 'addr-check', id: 'review-receive-address' }, s.receiveAddress))),
      s.privacy?.leg === 'first' && h('tr', {}, h('th', {}, 'Final receiving address'), h('td', {}, h('div', { class: 'addr-check', id: 'review-final-address' }, s.privacy.destination))),
      h('tr', {}, h('th', {}, 'Provider'), h('td', {}, `${s.provider}, order ${s.id}`))))),
    h('p', { class: 'small muted' }, `The swap is handled by ${s.provider}, an outside provider. It holds the coins during the swap, so a deposit can't be cancelled, and it may hold funds for review or ask for KYC.${s.approximate ? ' The rate floats, so the amount received can change a little at deposit time.' : ''} ${s.providerId === 'ccecash' ? ' Trades are processed by CCECash under CCECash\'s service rules (cce.cash). CCECash takes no refund address in the order, so a refund is handled under those rules.' : ''} Test large amounts with a small one first.`),
    h('br'),
    h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
    go)));
  pw.focus();
}

function renderSwapStatus(record: any): void {
  const status = h('h2', { id: 'swap-status' }, SWAP_STATUS[record.status] ?? record.status);
  const out = h('div', { class: 'mono small', id: 'swap-out' });
  const box = errorBox();
  const done = (s: string) => ['success', 'finished', 'refunded', 'overdue', 'failed', 'expired'].includes(s);
  const paint = (r: any) => {
    status.textContent = SWAP_STATUS[r.status] ?? r.status;
    out.textContent = r.hashOut ? `Received in: ${r.hashOut}` : '';
  };
  show('receive', subBar('Swap status', () => void renderSwap()), h('div', { class: 'scroll' },
    h('div', { class: 'swap-pair' }, coin(record.from), icon('swap'), coin(record.to)),
    status, h('br'), box.el,
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'Sent'), h('td', {}, `${record.amount} ${coinName(record.from)}`)),
      h('tr', {}, h('th', {}, 'To receive'), h('td', {}, `${record.approximate ? 'about ' : ''}${record.receive} ${coinName(record.to)}`)),
      record.withdrawalAddress && h('tr', {}, h('th', {}, 'Receiving address'), h('td', { class: 'mono small' }, record.withdrawalAddress)),
      record.provider && h('tr', {}, h('th', {}, 'Provider'), h('td', {}, record.provider)),
      h('tr', {}, h('th', {}, 'Order number'), h('td', { class: 'mono', id: 'swap-id' }, record.id))))),
    out,
    h('p', { class: 'small muted' }, 'If there\'s a problem, give this order number to the provider\'s support. Confirmation and exchange can take a while, especially for XMR.')));
  paint(record);
  const poll = async () => {
    if (!status.isConnected) return;
    try {
      const r = await wallet.swapRefresh(record.id);
      if (!status.isConnected) return;
      paint(r);
      if (done(r.status)) { void refresh(); return; }
    } catch (e) { box.show(e); }
    window.setTimeout(() => void poll(), 20_000);
  };
  if (!done(record.status)) void poll();
}

// ---- WalletConnect ----

/** A small window over whatever is on screen, the way other wallets ask for a confirmation. */
function modal(id: string, ...kids: Child[]): { el: HTMLElement; close: () => void } {
  document.getElementById(id)?.remove();
  const card = h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true' }, ...kids);
  const el = h('div', { class: 'modal', id }, card);
  (document.querySelector('.screen') ?? document.body).append(el);
  return { el, close: () => el.remove() };
}

/** Other wallets' networks a dApp may ask for, by their CAIP-2 name: solana:… → Solana, eip155:10 → network 10. */
const chainLabel = (caip: string): string => {
  const [ns, ref] = caip.split(':');
  const known: Record<string, string> = { solana: 'Solana', bip122: 'Bitcoin', cosmos: 'Cosmos', polkadot: 'Polkadot', tron: 'Tron', near: 'NEAR', stellar: 'Stellar', sui: 'Sui', ton: 'TON' };
  return ns === 'eip155' ? (WC_NETWORK[caip] ?? `EVM network ${ref}`) : known[ns] ?? ns;
};
const WC_NETWORK: Record<string, string> = { 'eip155:1': 'Ethereum', 'eip155:137': 'Polygon', 'eip155:42161': 'Arbitrum', 'eip155:56': 'BNB Smart Chain' };
let wcOn = false; // this unlocked wallet is a WalletConnect wallet (they never use Tor)
let wcSeen = '';  // the last link taken from the clipboard, so the same one isn't used twice
let onWcSessions: ((s: any[]) => void) | null = null;

/** Opens a pairing; the dApp's connection request then shows up as its own window. */
async function wcPairNow(uri: string): Promise<void> {
  wcSeen = uri;
  await wallet.wcPair(uri);
  toast('Connecting to the dApp…');
}

/**
 * One button: a wc: link already copied is used; otherwise the computer's screen is read for the dApp's QR code;
 * on a phone the camera opens. Typing the link is only the last resort.
 */
async function connectDapp(box: ReturnType<typeof errorBox>): Promise<void> {
  const copied = String(await wallet.wcClipboard?.().catch(() => '') ?? '');
  if (copied && copied !== wcSeen) return wcPairNow(copied);
  if (wallet.wcScanScreen) {
    const found = String(await wallet.wcScanScreen().catch(() => '') ?? '');
    if (found) return wcPairNow(found);
  }
  wcHelp(box);
}

function wcHelp(box: ReturnType<typeof errorBox>): void {
  const uri = h('input', { id: 'wc-uri', placeholder: 'wc:…', spellcheck: 'false', autocomplete: 'off' });
  const local = errorBox();
  const go = h('button', { class: 'secondary', id: 'wc-connect-link', onclick: () => busy(go, 'Connecting…', local, async () => { await wcPairNow(uri.value.trim()); m.close(); }) }, 'Connect');
  const cam = h('button', { class: 'primary', id: 'wc-camera', onclick: () => {
    m.close();
    void openScanner('ETH', () => undefined, { parse: (t) => (/^wc:[0-9a-f]{64}@2\?/i.test(t.trim()) ? t.trim() : null), wrong: 'This is not a WalletConnect QR code. Try the one the dApp shows.', onText: (t) => { wcPairNow(t).catch((e) => box.show(e)); } });
  } }, icon('scan'), 'Scan with the camera');
  const m = modal('wc-help',
    h('h3', {}, 'Connect a dApp'),
    h('p', { class: 'small muted' }, wallet.wcScanScreen
      ? 'No WalletConnect QR code was found on the screen. Open the dApp, press its Connect Wallet button and choose WalletConnect, so the QR code is visible, then press Connect again.'
      : 'On the dApp, press Connect Wallet and choose WalletConnect. Scan the QR code it shows, or on this phone pick Kusari Wallet when the dApp offers to open a wallet.'),
    local.el, cam,
    h('details', { class: 'fold-more' }, h('summary', {}, 'Paste a link instead'), h('label', { class: 'field' }, h('span', {}, 'Connection link'), uri), go),
    h('button', { class: 'ghost', id: 'wc-help-close', onclick: () => m.close() }, 'Close'));
}

/** The connected dApps, each with Disconnect, plus Connect and the switch for WalletConnect itself. */
async function walletConnectSection(after: () => void = () => void renderSettings()): Promise<HTMLElement | null> {
  const info = await wallet.wcInfo().catch(() => null);
  const box = errorBox();
  const sec = h('div', { class: 'section', id: 'wc-section' }, h('h3', {}, 'WalletConnect'));
  if (!info || !info.available) return null;
  // A maximum-privacy wallet doesn't offer WalletConnect at all; a wallet for dApps is made with "Add wallet".
  if (info.mode !== 'walletconnect') return null;
  void wallet.wcRegisterLinks?.().catch(() => undefined);
  const go = h('button', { class: 'primary', id: 'wc-connect', onclick: () => busy(go, 'Looking for the QR code…', box, () => connectDapp(box)) }, 'Connect a dApp');
  const off = h('button', { class: 'ghost', id: 'wc-disconnect-all', onclick: () => busy(off, 'Disconnecting…', box, async () => { await wallet.wcDisconnectAll(); after(); }) }, 'Disconnect all dApps');
  const list = h('div', { id: 'wc-sessions' });
  const paint = (sessions: any[]) => setKids(list, ...(sessions.length ? sessions.map((x: any) => {
    const cut: HTMLButtonElement = h('button', { class: 'secondary wc-disconnect', onclick: () => busy(cut, 'Disconnecting…', box, () => wallet.wcDisconnect(x.topic)) }, 'Disconnect');
    return h('div', { class: 'panel wc-session' }, h('div', { class: 'wc-session-name' }, h('strong', {}, x.name), h('span', { class: 'small muted mono' }, x.url)), cut);
  }) : [h('p', { class: 'small muted' }, 'No dApps connected.')]));
  paint(info.sessions);
  onWcSessions = paint;
  sec.append(box.el,
    info.tor ? h('div', { class: 'warn' }, 'Tor is on, so WalletConnect is off: its relay can\'t be reached through Tor.')
      : h('p', { class: 'small muted' }, wallet.wcScanScreen
        ? 'Open the dApp, press its Connect Wallet button and choose WalletConnect. Then press Connect a dApp: the wallet reads the QR code from the screen. A copied wc: link works too.'
        : 'Press Connect a dApp and scan the dApp\'s QR code, or in this phone\'s browser choose WalletConnect and pick Kusari Wallet.'),
    info.tor ? null : go, h('h4', {}, 'Connected dApps'), list, off);
  return sec;
}

async function renderDapps(): Promise<void> {
  const sec = await walletConnectSection(() => void renderHome());
  show('send', subBar('dApps', () => renderHome()), h('div', { class: 'scroll' }, sec));
}

/** Home shows a dApps button in wallets that use WalletConnect, with how many are connected. */
async function paintDappsChip(slot: HTMLElement): Promise<void> {
  const info = await wallet.wcInfo().catch(() => null);
  wcOn = Boolean(info?.available && info.mode === 'walletconnect');
  const perps = document.getElementById('nav-perps');
  if (perps) perps.hidden = !wcOn;
  if (!info?.available || info.mode !== 'walletconnect') return;
  void wallet.wcRegisterLinks?.().catch(() => undefined);
  const n = info.sessions.length;
  setKids(slot, h('button', { class: 'chip dapps', id: 'go-dapps', onclick: () => void renderDapps() }, n ? `dApps · ${n}` : 'dApps'));
  void takeWcLink();
}

/** A wc: link the system handed over (a dApp's "open in wallet"). */
async function takeWcLink(): Promise<void> {
  if (!wcOn) return;
  const link = String(await wallet.wcTakeLink?.().catch(() => '') ?? '');
  if (link) await wcPairNow(link).catch((e) => toast(errMsg(e)));
}
wallet.on('wc-link', () => void takeWcLink());

// On a computer, coming back to the wallet with a wc: link copied connects it right away, no pasting.
window.addEventListener('focus', () => {
  if (!wcOn || !wallet.wcScanScreen || location.hash === '#wc-popup') return;
  void (async () => {
    const copied = String(await wallet.wcClipboard?.().catch(() => '') ?? '');
    if (copied && copied !== wcSeen) await wcPairNow(copied).catch(() => undefined);
  })();
});

wallet.on('wc-sessions', (s: any[]) => {
  onWcSessions?.(s);
  const chip = document.getElementById('go-dapps');
  if (chip) chip.textContent = s.length ? `dApps · ${s.length}` : 'dApps';
});

/** The site's host name, as the person will recognize it in the browser. */
function dappHost(url: string, name: string): string {
  try { return new URL(url).host || name; } catch { return name; }
}

/** A letter badge instead of the dApp's own icon: loading that picture would tell its server this wallet's IP. */
function dappHead(p: { name: string; url: string }, line: string): HTMLElement {
  const host = dappHost(p.url, p.name);
  const letter = (p.name.trim()[0] ?? host[0] ?? '?').toUpperCase();
  let hue = 0;
  for (const c of host) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  const badge = h('div', { class: 'dapp-badge', 'aria-hidden': 'true' }, letter);
  badge.style.setProperty('--hue', String(hue)); // set through the DOM: the page's rules allow no inline styles
  return h('div', { class: 'dapp-head' },
    badge,
    h('h3', { id: 'wc-dapp' }, host), h('p', { class: 'small muted' }, line));
}

/** A dApp asks to connect: who it says it is, which account it gets, and what that allows. */
/** dApp windows open only in an unlocked WalletConnect wallet; anything else is turned down unseen. */
async function inWcWallet(): Promise<boolean> {
  if (wcOn) return true;
  const info = await wallet.wcInfo().catch(() => null);
  wcOn = Boolean(info?.available && info.mode === 'walletconnect');
  return wcOn;
}

async function showProposal(p: any): Promise<void> {
  if (!overview) await refresh(); // the account's value, in the request window too
  if (!(await inWcWallet())) { void wallet.wcReject(p.id).catch(() => undefined); return; }
  const box = errorBox();
  const yes = h('button', { class: 'pill pill-light', id: 'wc-approve', onclick: () => busy(yes, 'Connecting…', box, async () => { await wallet.wcApprove(p.id); m.close(); toast(`Connected to ${dappHost(p.url, p.name)}.`); }) }, 'Connect');
  const no = h('button', { class: 'pill pill-dark', id: 'wc-reject', onclick: () => { void wallet.wcReject(p.id).catch(() => undefined); m.close(); } }, 'Cancel');
  const badge = p.scam ? h('span', { class: 'verify bad' }, icon('close'), 'Known scam')
    : p.verified === 'VALID' ? h('span', { class: 'verify ok', id: 'wc-verified' }, icon('shield'), 'Verified')
      : p.verified === 'INVALID' ? h('span', { class: 'verify bad' }, icon('close'), 'Domain mismatch')
        : h('span', { class: 'verify unknown' }, icon('shield'), 'Not verified');
  const warning = p.scam ? h('div', { class: 'error' }, 'WalletConnect flags this site as a known scam. Reject it.')
    : p.verified === 'INVALID' ? h('div', { class: 'warn' }, 'The site doesn\'t match the domain this dApp registered. It may be an impostor.')
      : p.verified === 'VALID' ? null : h('div', { class: 'warn' }, 'WalletConnect couldn\'t check this site. Make sure you opened the real one.');
  const nets = p.chains.length ? p.chains.map((c: string) => WC_NETWORK[c] ?? c).join(', ') : 'Ethereum';
  const acctName = h('strong', {}, 'My wallet');
  void wallet.walletsList().then((r: any) => { acctName.textContent = r.list.find((w: any) => w.id === r.active)?.name ?? 'My wallet'; }).catch(() => undefined);
  const perm = (ok: boolean, text: string) => h('li', { class: ok ? 'yes' : 'no' }, h('span', { class: 'perm-mark', 'aria-hidden': 'true' }, ok ? '✓' : '✕'), text);
  const m = modal('wc-proposal',
    dappHead(p, 'This site is asking for:'),
    h('div', { class: 'verify-row' }, badge),
    warning,
    h('div', { class: 'modal-section' }, h('span', { class: 'modal-label' }, 'Account'),
      h('div', { class: 'acct-card' }, h('span', { class: 'acct-icon' }, icon('wallet')), h('div', { class: 'acct-text' }, acctName, h('span', { class: 'small muted' }, totalUsd().value)))),
    h('div', { class: 'modal-section' }, h('span', { class: 'modal-label' }, 'Permissions'),
      h('ul', { class: 'perms' },
        perm(true, `See your address, balance and activity on ${nets}`),
        perm(true, 'Send transaction and signature requests'),
        perm(false, 'Can\'t move funds without your approval'))),
    p.unsupported.length ? h('p', { class: 'small muted' }, `Not offered: ${[...new Set(p.unsupported.map(chainLabel))].join(', ')}.`) : null,
    box.el,
    h('div', { class: 'pill-row' }, no, yes));
  void m;
}
wallet.on('wc-proposal', (p: any) => void showProposal(p));

/** Something a dApp asked for was turned down: said in a small window, never silently. */
function wcNotice(dapp: string, url: string, text: string): void {
  const m = modal('wc-notice', dappHead({ name: dapp, url }, 'Request turned down'), h('div', { class: 'warn', id: 'wc-notice-text' }, text),
    h('button', { class: 'pill pill-light', id: 'wc-notice-ok', onclick: () => m.close() }, 'OK'));
}

async function showRefused(r: any): Promise<void> {
  if (!(await inWcWallet())) return;
  wcNotice(r.dapp, r.url, r.network
    ? `${r.dapp} asked to use ${r.network}, which this wallet doesn't connect to dApps. Only Ethereum, Polygon, Arbitrum and BNB Smart Chain are offered.`
    : `${r.dapp} asked for ${r.method || 'something'}, which this wallet doesn't do.`);
}
wallet.on('wc-refused', (r: any) => void showRefused(r));

/** A dApp asks for a signature or a transaction. Nothing happens without the password. */
async function showRequest(q: any): Promise<void> {
  if (!(await inWcWallet())) { void wallet.wcDecline(q.id).catch(() => undefined); return; }
  let info: any;
  try { info = await wallet.wcRequestInfo(q.id); } catch (e) {
    void wallet.wcDecline(q.id).catch(() => undefined);
    wcNotice(q.dapp, q.url, `${q.dapp} sent a request that was turned down: ${errMsg(e)}`);
    return;
  }
  const box = errorBox();
  const tx = info.kind === 'transaction';
  const pw = h('input', { type: 'password', id: 'wc-pw', autocomplete: 'current-password', placeholder: 'Password' });
  const ok = h('button', { class: 'pill pill-light', id: 'wc-confirm', type: 'submit' }, tx ? 'Confirm' : 'Sign');
  const rows: [string, string][] = tx
    ? [['Action', info.action], ['To', info.to], ['Amount', `${info.value} ${info.symbol}`], ['Estimated fee', reviewFee(info.fee, info.symbol)]]
    : info.kind === 'typed' ? [['Type', info.type], ['For', `${info.domain} ${info.contract}`.trim()]]
      : [['Message', info.message]];
  const detail = tx ? info.data : info.kind === 'typed' ? info.message : '';
  const decline = () => { void wallet.wcDecline(q.id).catch(() => undefined); m.close(); };
  const m = modal('wc-request', h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(ok, tx ? 'Sending…' : 'Signing…', box, async () => { await wallet.wcConfirm(q.id, pw.value); pw.value = ''; m.close(); toast(tx ? 'Sent.' : 'Signed.'); void refresh(); });
  } },
  dappHead({ name: info.dapp, url: info.url }, `${tx ? 'Transaction request' : 'Signature request'} · ${info.network}`),
  ...info.warnings.map((w: string) => h('div', { class: 'warn' }, w)),
  h('table', { class: 'review-table' }, h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', { class: k === 'To' || k === 'Message' ? 'mono small' : '' }, v))))),
  detail ? h('details', { class: 'fold-more' }, h('summary', {}, 'Details'), h('div', { class: 'mono small wc-detail' }, detail)) : null,
  box.el, pw,
  h('div', { class: 'pill-row' }, h('button', { type: 'button', class: 'pill pill-dark', id: 'wc-decline', onclick: decline }, 'Reject'), ok)));
  pw.focus();
}
wallet.on('wc-request', (q: any) => void showRequest(q));

// ---- several wallets ----

function walletButton(): HTMLElement {
  const name = h('span', { id: 'wallet-name' }, 'My wallet');
  void wallet.walletsList().then((r: any) => { name.textContent = r.list.find((w: any) => w.id === r.active)?.name ?? 'My wallet'; });
  return h('button', { type: 'button', class: 'wallet-btn', id: 'wallet-switch', 'aria-label': 'Choose a wallet', onclick: () => void renderWallets(renderHome) }, name, icon('down'));
}

async function renderWallets(back: () => void): Promise<void> {
  const r = await wallet.walletsList();
  const box = errorBox();
  const newName = h('input', { id: 'wallet-new-name', autocomplete: 'off', maxlength: '20', value: `Wallet ${r.list.length + 1}` });
  const add = h('button', { class: 'primary', id: 'wallet-add', type: 'submit' }, 'Add wallet');
  const leave = async (task: () => Promise<void>) => {
    deleting = true; // Locking is expected here, so the lock screen must not jump in first.
    try { await task(); await boot(); } catch (e) { box.show(e); } finally { deleting = false; }
  };
  show('send', subBar('Wallets', back), h('div', { class: 'scroll' }, box.el,
    h('div', { id: 'wallet-list' }, ...r.list.map((w: any) => {
      const on = w.id === r.active;
      return h('div', { class: `panel wallet-row${on ? ' on' : ''}` },
        h('button', { type: 'button', class: 'wallet-pick', id: `wallet-${w.id}`, onclick: () => { if (on) back(); else void leave(() => wallet.walletSwitch(w.id)); } },
          h('strong', {}, w.name), h('span', { class: 'small muted' }, on ? 'In use' : 'Tap to switch')),
        h('button', { type: 'button', class: 'secondary', id: `rename-${w.id}`, onclick: () => renderWalletRename(w, () => void renderWallets(back)) }, 'Rename'));
    })),
    h('br'),
    h('form', { class: 'panel', onsubmit: (e: Event) => {
      e.preventDefault();
      void leave(() => wallet.walletBeginAdd(newName.value));
    } }, h('label', { class: 'field' }, h('span', {}, 'New wallet name'), newName),
    h('p', { class: 'small muted wallet-hint' }, 'A new wallet has its own seeds and password. Switching locks the current wallet.'), add)));
}

function renderWalletRename(w: any, back: () => void): void {
  const name = h('input', { id: 'wallet-rename-input', autocomplete: 'off', maxlength: '20', value: w.name });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'wallet-rename-save', type: 'submit' }, 'Save');
  show('send', subBar('Wallet name', back), h('div', { class: 'scroll' }, box.el, h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Saving…', box, async () => { await wallet.walletRename(w.id, name.value); back(); });
  } }, h('label', { class: 'field' }, h('span', {}, 'Name'), name), go)));
  name.focus();
}

// ---- Tornado Cash ----

let onTornadoProgress: ((m: string) => void) | null = null;
wallet.on('tornado-progress', (m: string) => onTornadoProgress?.(m));
const NOTE_STATUS: Record<string, string> = { sending: 'Sending', deposited: 'Deposited', withdrawing: 'Withdrawing', withdrawn: 'Withdrawn' };

async function renderTornado(message = ''): Promise<void> {
  const info = await wallet.tornadoInfo();
  const box = errorBox();
  const engine = h('p', { class: 'small muted', id: 'tornado-engine' }, 'Checking the proof engine…');
  const recoverPw = h('input', { type: 'password', id: 'tornado-recover-pw', autocomplete: 'current-password' });
  const recoverStatus = h('p', { class: 'small muted', id: 'tornado-recover-status', role: 'status' });
  const recover = h('button', { type: 'submit', id: 'tornado-recover' }, 'Find deposits from seed');
  show('send', subBar('Tornado', () => void renderSwap('ETH', 'XMR')), h('div', { class: 'scroll' }, box.el,
    message && h('div', { class: 'note-ok', id: 'tornado-message' }, message),
    h('div', { class: 'warn' }, 'Deposit and withdrawal addresses are public on the chain. Withdrawing right after depositing can be linked by timing, so wait a long time. Withdrawing needs a relayer to stay unlinked from the deposit address.'),
    h('div', { class: 'panel' }, h('span', { class: 'label' }, 'Deposit ETH (fixed amounts)'),
      h('div', { class: 'pool-row' }, ...info.pools.map((pool: string, i: number) => h('button', { type: 'button', id: `pool-${i}`, onclick: () => busy(document.getElementById(`pool-${i}`) as HTMLButtonElement, 'Checking…', box, async () => {
        renderTornadoDeposit(await wallet.tornadoDepositPrepare(pool));
      }) }, `${pool} ETH`)))),
    h('h3', {}, 'Your deposits'),
    info.notes.length
      ? h('div', { id: 'tornado-notes' }, ...info.notes.map((n: any) => h('div', { class: 'panel note-row' },
        h('div', {}, h('strong', {}, `${n.pool} ETH`), h('div', { class: 'small muted' }, `${NOTE_STATUS[n.status] ?? n.status} · ${when(n.createdAt)}`)),
        h('div', { class: 'note-actions' },
          n.status === 'deposited' && h('button', { type: 'button', class: 'secondary', id: `withdraw-${n.index}`, onclick: () => renderTornadoWithdraw(n, info.relayer) }, 'Withdraw'),
          h('button', { type: 'button', class: 'secondary', id: `backup-${n.index}`, onclick: () => renderTornadoBackup(n) }, 'Backup')))))
      : h('p', { class: 'empty', id: 'tornado-empty' }, 'No deposits yet.'),
    engine,
    h('form', { class: 'panel', onsubmit: (e: Event) => {
      e.preventDefault();
      onTornadoProgress = (m) => { recoverStatus.textContent = m; };
      busy(recover, 'Searching…', box, async () => {
        const r = await wallet.tornadoRecover(recoverPw.value);
        await renderTornado(`Found ${r.found} deposits.`);
      });
    } }, h('span', { class: 'label' }, 'If you reinstalled or restored from a seed'), h('label', { class: 'field' }, h('span', {}, 'Password'), recoverPw), recoverStatus, recover)));
  wallet.tornadoCheck().then(() => { engine.textContent = 'The proof engine is ready. Proofs are made on this device.'; }, (e: unknown) => {
    engine.textContent = `Could not start the proof engine: ${errMsg(e)}`;
  });
}

function renderTornadoDeposit(p: any): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-deposit', type: 'submit' }, `Deposit ${p.pool} ETH`);
  show('send', subBar('Tornado deposit', () => { void wallet.cancelSend(p.id); void renderTornado(); }), h('div', { class: 'scroll' },
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, 'Sending…', box, async () => {
        await wallet.tornadoDepositConfirm(p.id, p.pool, pw.value);
        pw.value = '';
        void refresh();
        await renderTornado(`Deposited ${p.pool} ETH. It can be withdrawn after confirmation.`);
      });
    } }, box.el,
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'Amount'), h('td', { id: 'review-amount' }, `${p.amount} ETH`)),
      h('tr', {}, h('th', {}, 'Estimated fee'), h('td', { id: 'review-fee' }, reviewFee(p.fee, 'ETH'))),
      h('tr', {}, h('th', {}, 'Pool address'), h('td', {}, h('div', { class: 'addr-check', id: 'review-pool' }, p.to)))))),
    h('p', { class: 'small muted' }, 'The deposit secret comes from your seed. Lose the seed and this amount is lost too. To use it in another tool, copy the note from Backup.'),
    h('br'),
    h('label', { class: 'field' }, h('span', {}, 'Password'), pw), go)));
  pw.focus();
}

function renderTornadoBackup(n: any): void {
  const pw = h('input', { type: 'password', id: 'backup-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const output = h('div', { class: 'mono small', id: 'backup-note' });
  const go = h('button', { class: 'primary', id: 'backup-show', type: 'submit' }, 'Show note');
  show('send', subBar('Note backup', () => void renderTornado()), h('div', { class: 'scroll' },
    h('div', { class: 'warn' }, 'Anyone with this note can withdraw this amount. Keep it like a seed.'), box.el,
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, 'Checking…', box, async () => {
        output.textContent = await wallet.tornadoExport(n.id, pw.value);
        pw.value = '';
      });
    } }, h('label', { class: 'field' }, h('span', {}, 'Password'), pw), go), h('br'), output));
}

function renderTornadoWithdraw(n: any, savedRelayer: string): void {
  const to = h('input', { id: 'tornado-to', spellcheck: 'false', autocomplete: 'off', placeholder: 'A new address unrelated to the deposit' });
  const relayer = h('input', { id: 'tornado-relayer', spellcheck: 'false', autocomplete: 'off', value: savedRelayer, placeholder: 'https://… or .onion' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'tornado-next', type: 'submit' }, 'Next');
  show('send', subBar(`Withdraw ${n.pool} ETH`, () => void renderTornado()), h('div', { class: 'scroll' }, box.el,
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, 'Checking…', box, async () => {
        renderTornadoWithdrawReview(n, await wallet.tornadoWithdrawQuote(n.id, to.value, relayer.value), to.value, relayer.value, savedRelayer);
      });
    } },
    h('label', { class: 'field' }, h('span', {}, 'Receiving ETH address'), to),
    h('label', { class: 'field' }, h('span', {}, 'Relayer address'), relayer, h('div', { class: 'hint' }, 'A relayer sends the transaction for you and takes its fee from the amount. Empty means this wallet sends it, which links it to the deposit address.')),
    go)));
}

function renderTornadoWithdrawReview(n: any, q: any, to: string, relayerUrl: string, savedRelayer: string): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const progress = h('p', { class: 'small muted', id: 'tornado-progress', role: 'status' });
  const go = h('button', { class: 'primary', id: 'confirm-withdraw', type: 'submit' }, 'Make proof and withdraw');
  show('send', subBar('Review withdrawal', () => renderTornadoWithdraw(n, savedRelayer)), h('div', { class: 'scroll' },
    q.mode === 'self' && h('div', { class: 'warn', id: 'tornado-self-warn' }, 'This wallet sends directly, with no relayer. The chain links the deposit and receiving addresses, so there is almost no privacy benefit.'),
    box.el,
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      onTornadoProgress = (m) => { progress.textContent = m; };
      busy(go, 'In progress…', box, async () => {
        if (relayerUrl.trim() && relayerUrl.trim() !== savedRelayer) void wallet.updateSettings({ tornadoRelayer: relayerUrl }).catch(() => undefined);
        await wallet.tornadoWithdraw(n.id, to, relayerUrl, pw.value);
        pw.value = '';
        void refresh();
        await renderTornado(`Sent the withdrawal of ${q.receive} ETH.`);
      });
    } },
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'You receive'), h('td', { id: 'review-receive' }, `${q.receive} ETH`)),
      h('tr', {}, h('th', {}, q.mode === 'self' ? 'Gas (from this wallet)' : 'Relayer fee'), h('td', { id: 'review-fee' }, reviewFee(q.fee, 'ETH'))),
      h('tr', {}, h('th', {}, 'Receiving address'), h('td', {}, h('div', { class: 'addr-check', id: 'review-to' }, q.recipient)))))),
    h('p', { class: 'small muted' }, 'This reads all deposit records and makes a proof, which takes minutes, longer on a phone. Don\'t close the app until it finishes. If it stops midway, the coins stay in the pool.'),
    h('br'), h('label', { class: 'field' }, h('span', {}, 'Password'), pw), progress, go)));
  pw.focus();
}

const PRIVACY_STAGE: Record<string, string> = {
  first: 'Step 1: waiting for XMR to arrive and unlock', ready: 'Waiting for step 2 approval', second: 'Step 2: sending to the final address', done: 'Finished', failed: 'Stopped',
};

function renderPrivacyStatus(initial: any): void {
  const status = h('h2', { id: 'privacy-stage' }, PRIVACY_STAGE[initial.stage]);
  const body = h('div', {});
  const box = errorBox();
  const row = (k: string, v: string) => h('tr', {}, h('th', {}, k), h('td', {}, v));
  let drawnReady = false;
  const paint = (p: any) => {
    status.textContent = PRIVACY_STAGE[p.stage];
    if (p.stage === 'ready') {
      if (drawnReady) return;
      drawnReady = true;
      paintSecond(p);
      return;
    }
    drawnReady = false;
    setKids(body, p.note && h('div', { class: 'warn', id: 'privacy-note' }, p.note), h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      row('Sent', `${p.amount} ${coinName(p.from)}`),
      row('Expected XMR', `about ${p.expectedXmr} XMR`),
      row('XMR received', `${p.received} XMR (${p.unlocked} available)`),
      row('Final receiving address', p.destination),
      row('Step 1 order', p.firstId),
      p.secondId ? row('Step 2 order', p.secondId) : false))),
      p.stage === 'first' && h('p', { class: 'small muted' }, 'The XMR arrives in this wallet. You can close the app, and it continues here when reopened. The next step opens after 10 confirmations.'));
  };
  const paintSecond = (p: any) => {
    const available = Math.max(0, Number(p.unlocked) - 0.001);
    const amount = numbersOnly(h('input', { id: 'pv-amount', class: 'amount-input', inputmode: 'decimal', autocomplete: 'off', value: available > 0 ? available.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : '' }) as HTMLInputElement);
    const quote = h('div', { class: 'small muted', id: 'pv-quote' });
    const offers = h('div', { class: 'swap-offers', id: 'pv-offers' });
    let chosen: any = null;
    const go = h('button', { class: 'primary', id: 'pv-next', disabled: true, onclick: () => busy(go, 'Creating the order…', box, async () => {
      renderSwapReview(await wallet.privacySecond(p.id, amount.value, chosen.providerId), () => renderPrivacyStatus(p));
    }) }, 'Continue to step 2');
    const paintOffers = (list: any[]) => {
      const good = list.filter((q) => !q.problem);
      chosen = good.find((q) => q.providerId === chosen?.providerId) ?? good.find((q) => q.providerId === 'ghostswap') ?? good[0] ?? null;
      go.disabled = !chosen;
      quote.textContent = chosen ? `about ${chosen.receive} ${coinName(p.to)}. Handled by ${chosen.provider}.` : (list[0]?.problem ?? '');
      setKids(offers, ...list.map((q) => h('button', { type: 'button', class: `swap-offer${q === chosen ? ' on' : ''}`, id: `pv-offer-${q.providerId}`, disabled: Boolean(q.problem), onclick: () => { chosen = q; paintOffers(list); } },
        h('span', {}, q.provider + (q.providerId === p.firstProviderId ? ' (same as step 1)' : '')), h('span', { class: 'offer-right' }, q.problem ? 'No quote' : `about ${q.receive}`, q.problem && h('span', { class: 'small muted offer-cost' }, q.problem), !q.problem && h('span', { class: 'offer-cost' }, offerFee(q).total), !q.problem && h('span', { class: 'small muted offer-cost' }, offerFee(q).detail)))));
    };
    let ticket = 0;
    const requote = async () => {
      const mine = ++ticket;
      go.disabled = true;
      quote.textContent = 'Getting quotes…';
      try {
        const list = await wallet.privacySecondQuote(p.id, amount.value);
        if (mine === ticket) paintOffers(list);
      } catch (e) { if (mine === ticket) quote.textContent = errMsg(e); }
    };
    let timer: number | undefined;
    amount.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => void requote(), 600); });
    setKids(body,
      h('div', { class: 'panel' }, h('span', { class: 'label' }, `XMR to send (up to ${p.unlocked})`), h('div', { class: 'swap-row' }, amount)),
      quote, h('br'), offers,
      h('div', { class: 'panel' }, h('span', { class: 'label' }, 'Final receiving address'), h('div', { class: 'addr-check', id: 'pv-dest' }, p.destination)),
      h('p', { class: 'small muted' }, 'It helps to wait rather than send right away. Sending a different amount than came in is harder to link. Any remaining XMR stays in your wallet.'),
      go);
    void requote();
  };
  show('receive', subBar('Privacy swap', () => void renderSwap()), h('div', { class: 'scroll' },
    h('div', { class: 'swap-pair' }, coin(initial.from), icon('swap'), coin('XMR'), icon('swap'), coin(initial.to)),
    status, h('br'), box.el, body));
  paint(initial);
  const poll = async () => {
    if (!status.isConnected) return;
    try {
      const r = await wallet.privacyRefresh(initial.id);
      if (!status.isConnected) return;
      paint(r);
      if (r.stage === 'done' || r.stage === 'failed') { void refresh(); return; }
    } catch (e) { box.show(e); }
    window.setTimeout(() => void poll(), 20_000);
  };
  if (initial.stage !== 'done' && initial.stage !== 'failed') void poll();
}

// ---- settings ----

async function renderSettings(): Promise<void> {
  const s = await wallet.getSettings();
  const netBox = errorBox(), pwBox = errorBox(), seedBox = errorBox(), delBox = errorBox();
  const node = h('input', { id: 'set-node', value: s.customMoneroNode, placeholder: 'http://127.0.0.1:18081', spellcheck: 'false' });
  const key = h('input', { id: 'set-key', value: s.tronApiKey, spellcheck: 'false', autocomplete: 'off' });
  const auto = h('input', { id: 'set-auto', type: 'number', min: '1', max: '240', value: String(s.autoLockMinutes) });
  const showPrices = h('input', { type: 'checkbox', id: 'set-prices', checked: s.showPrices });
  const zecInfo = await wallet.zecInfo();
  const zanoInfo = await wallet.zanoInfo();
  const arrrInfo = await wallet.arrrInfo();
  const tor = await wallet.torInfo();
  const torBox = errorBox();
  const useTor = h('input', { type: 'checkbox', id: 'set-tor', checked: tor.setting ?? tor.enabled });
  const torProgress = h('div', { class: 'tor-status', id: 'tor-status' });
  const paintTor = (info: { enabled: boolean; installed: boolean; state: any }) => {
    const st = info.state;
    let text = info.installed ? `Ready${st.installedVersion ? ` (bundled ${st.installedVersion})` : ''}. It's off.` : 'Not installed yet. Turning it on downloads the official files and checks their signature before installing.';
    if (info.enabled && st.phase === 'starting') text = `Connecting ${st.percent}%`;
    if (info.enabled && st.phase === 'error') text = st.error ?? 'Connection failed';
    if (info.enabled && st.phase === 'ready') {
      text = st.verified === true ? `Tor connection verified. Visible IP: ${st.exitIp}`
        : st.verified === false ? 'Warning: the check service says this isn\'t a Tor connection.' : 'Connected. Waiting for the Tor check service to answer.';
    }
    torProgress.textContent = text;
  };
  paintTor(tor);
  onTorInstallMessage = (m) => { torProgress.textContent = m; };
  onTorState = (st) => paintTor({ enabled: tor.enabled, installed: tor.installed, state: st });
  const updateTor = h('button', { class: 'ghost', id: 'tor-update', hidden: !tor.installed || tor.updatable === false, onclick: () => busy(updateTor, 'Downloading…', torBox, async () => {
    await wallet.installTor();
    toast('Downloaded the latest Tor. It applies when you reopen the wallet.');
    if (tor.enabled) await wallet.lock();
  }) }, 'Update Tor');
  const copyLog = h('button', { class: 'ghost', id: 'copy-connection-log', onclick: async () => {
    await wallet.copy(await wallet.connectionLog());
    toast('Copied. It has no addresses, amounts or IP addresses.');
  } }, 'Copy connection log');
  const saved = h('span', { class: 'small muted', role: 'status' });
  const saveBtn = h('button', { id: 'save-settings', onclick: () => busy(saveBtn, 'Saving…', netBox, async () => {
    if (tor.allowed !== false && useTor.checked && !tor.installed) {
      await wallet.installTor();
      tor.installed = true;
    }
    const relocked = await wallet.updateSettings({ customMoneroNode: node.value, tronApiKey: key.value, autoLockMinutes: Number(auto.value), showPrices: showPrices.checked, ...(tor.allowed === false ? {} : { torEnabled: useTor.checked }) });
    if (!relocked) { saved.textContent = 'Saved.'; void refresh(); }
  }) }, 'Save');

  const curPw = h('input', { type: 'password', autocomplete: 'current-password' });
  const newPw = h('input', { type: 'password', autocomplete: 'new-password' });
  const chgDone = h('span', { class: 'small muted', role: 'status' });
  const chg = h('button', { onclick: () => busy(chg, 'Changing…', pwBox, async () => {
    await wallet.changePassword(curPw.value, newPw.value);
    await wallet.biometric?.disable();
    curPw.value = ''; newPw.value = ''; chgDone.textContent = 'Password changed.';
  }) }, 'Change password');

  const seedPw = h('input', { type: 'password', autocomplete: 'current-password', id: 'seed-pw' });
  const seedOut = h('div', {});
  const rev = h('button', { id: 'reveal', onclick: () => busy(rev, 'Opening…', seedBox, async () => {
    const seeds = await wallet.revealSeeds(seedPw.value);
    seedPw.value = '';
    setKids(seedOut, h('br'), seedCard('BTC·ETH·Tron seed', '', seeds.tronMnemonic), seedCard('Monero seed', '', seeds.moneroSeed), seedQrCard(seeds),
      h('button', { class: 'ghost', onclick: () => setKids(seedOut) }, 'Hide'));
  }) }, 'Show seeds');

  let bioSection: Child = null;
  if (wallet.biometric && await wallet.biometric.available()) {
    const bioBox = errorBox();
    const bioPw = h('input', { type: 'password', autocomplete: 'current-password', id: 'bio-pw' });
    const bioArea = h('div', {});
    const paintBio = async () => {
      if (await wallet.biometric.enabled()) {
        const off = h('button', { class: 'ghost', id: 'bio-off', onclick: async () => { await wallet.biometric.disable(); await paintBio(); } }, 'Turn off fingerprint login');
        setKids(bioArea, h('p', { class: 'small muted' }, 'Fingerprint login is on. You can also open with your password.'), h('br'), off);
      } else {
        const on = h('button', { id: 'bio-on', onclick: () => busy(on, 'Touch the fingerprint sensor…', bioBox, async () => {
          await wallet.revealSeeds(bioPw.value); // confirms the password before it is protected
          await wallet.biometric.enable(bioPw.value);
          bioPw.value = '';
          await paintBio();
        }) }, 'Turn on fingerprint login');
        setKids(bioArea, h('label', { class: 'field' }, h('span', {}, 'Password'), bioPw), on);
      }
    };
    await paintBio();
    bioSection = h('div', { class: 'section' }, h('h3', {}, 'Fingerprint login'), bioBox.el, bioArea,
      h('p', { class: 'hint' }, 'For opening the wallet. Sending coins still needs your password. Enrolling a new fingerprint on the phone turns this off for security.'));
  }

  const delPw = h('input', { type: 'password', autocomplete: 'current-password', id: 'del-pw' });
  const del = h('button', { class: 'danger', id: 'delete', onclick: () => busy(del, 'Deleting…', delBox, async () => {
    deleting = true;
    try {
      await wallet.deleteWallet(delPw.value);
      await boot();
    } finally {
      deleting = false;
    }
  }) }, 'Delete wallet from this device');

  show('send',
    h('div', { class: 'bar' }, h('span', {}), h('h2', {}, 'Settings'), h('span', {})),
    h('div', { class: 'scroll' },
      h('div', { class: 'section', id: 'language-section' }, h('h3', {}, 'Language'),
        h('select', { id: 'set-language', 'aria-label': 'Language', 'data-no-translate': '', onchange: (e: Event) => (window as any).kusariI18n.set((e.target as HTMLSelectElement).value) },
          ...(window as any).kusariI18n.languages.map(([code, name]: [string, string]) => h('option', { value: code, selected: code === (window as any).kusariI18n.current() }, name)))),
      h('div', { class: 'section' }, h('h3', {}, 'Connections'), netBox.el,
        h('label', { class: 'field' }, h('span', {}, 'Custom Monero node'), node, h('div', { class: 'hint' }, 'Enter your own node if you have one. Empty chooses a public node automatically. Public nodes can see your IP.')),
        h('label', { class: 'field' }, h('span', {}, 'TronGrid API key'), key, h('div', { class: 'hint' }, 'Works without one. Add a free key if lookups are often limited.')),
        h('label', { class: 'field' }, h('span', {}, 'Auto-lock (minutes)'), auto),
        h('label', { class: 'check' }, showPrices, h('span', {}, 'Show USD prices', h('div', { class: 'hint' }, 'Prices come from CoinGecko, then from other price services and exchanges if it\'s blocked or a coin is missing. Addresses and balances aren\'t sent, but your IP can be seen.'))),
        // Tor is only in maximum-privacy wallets; a WalletConnect wallet doesn't show or use it.
        tor.allowed === false ? copyLog : h('div', { class: 'tor-block', id: 'tor-block' },
          h('h3', {}, 'Tor'), torBox.el, torProgress,
          h('label', { class: 'check' }, useTor, h('span', {}, 'Connect through Tor',
            h('div', { class: 'hint' }, 'Sends node, TronGrid and price connections through Tor to hide your IP. It doesn\'t hide public Tron history, and lookups and sync get slower.'),
            h('div', { class: 'hint' }, tor.updatable === false ? 'If Tor drops, connections stop rather than falling back to the plain internet.' : 'If Tor drops, connections stop rather than falling back to the plain internet. Only the first install uses the plain internet, to download the files.'))),
          updateTor, copyLog),
        h('div', { class: 'row' }, saveBtn, saved),
        h('p', { class: 'hint' }, tor.allowed === false ? 'Changing the node or API key locks the wallet. It applies when reopened.' : 'Changing the node, API key or Tor locks the wallet. It applies when reopened.')),
      bioSection,
      h('div', { class: 'section', id: 'arrr-info' }, h('h3', {}, 'Pirate Chain engine'),
        h('p', { class: 'small', id: 'arrr-info-state' }, arrrInfo.available ? (arrrInfo.started ? `Running: ${arrrInfo.phase}` : 'Found but not running') : 'Not found'),
        arrrInfo.error && h('p', { class: 'small' }, arrrInfo.error)),
      h('div', { class: 'section', id: 'zano-info' }, h('h3', {}, 'Zano engine'),
        h('p', { class: 'small', id: 'zano-info-state' }, zanoInfo.available ? (zanoInfo.started ? `Running: ${zanoInfo.phase}` : 'Found but not running') : 'Not found'),
        zanoInfo.error && h('p', { class: 'small' }, zanoInfo.error)),
      h('div', { class: 'section', id: 'zec-info' }, h('h3', {}, 'Zcash engine'),
        h('p', { class: 'small', id: 'zec-info-state' }, zecInfo.available ? (zecInfo.started ? `Running: ${zecInfo.phase}` : 'Found but not running') : 'Not found'),
        zecInfo.error && h('p', { class: 'small' }, zecInfo.error),
        h('p', { class: 'small', id: 'zec-info-list' }, `List: ${ASSETS.includes('ZEC') ? 'includes ZEC' : 'no ZEC'} / balance check: ${refreshNote}`),
        h('p', { class: 'muted small mono' }, zecInfo.detail)),
      h('div', { class: 'section' }, h('h3', {}, 'Seed backup'), seedBox.el,
        h('label', { class: 'field' }, h('span', {}, 'Password'), seedPw), rev, seedOut),
      h('div', { class: 'section' }, h('h3', {}, 'Change password'), pwBox.el,
        h('label', { class: 'field' }, h('span', {}, 'Current password'), curPw),
        h('label', { class: 'field' }, h('span', {}, 'New password (at least 10 characters)'), newPw),
        h('div', { class: 'row' }, chg, chgDone)),
      await walletConnectSection(),
      h('div', { class: 'section', id: 'support-section' }, h('h3', {}, 'Support'),
        h('button', { class: 'ghost', id: 'support', 'aria-expanded': 'false', onclick: (e: Event) => {
          const note = document.getElementById('support-note');
          if (!note) return;
          note.hidden = !note.hidden;
          (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(!note.hidden));
        } }, 'Support'),
        h('p', { class: 'small', id: 'support-note', hidden: true }, 'Need help? Email kusari_wallet@proton.me, or message @Kusari_Wallet on Telegram.')),
      h('div', { class: 'section' }, h('h3', {}, 'Delete wallet'), delBox.el,
        h('p', { class: 'muted small' }, 'Coins stay on the blockchain, but can never be reached without the seeds. Check your seeds before deleting.'), h('br'),
        h('label', { class: 'field' }, h('span', {}, 'Password'), delPw), del)),
    bottomNav('settings'));
}

// ---- boot ----

let deleting = false;
let onTorInstallMessage: ((m: string) => void) | null = null;
let onTorState: ((s: any) => void) | null = null;
wallet.on('tor-install', (m: string) => onTorInstallMessage?.(m));
wallet.on('tor-state', (s: any) => {
  if (torState) torState = s;
  onTorState?.(s);
  onData?.();
});

wallet.on('monero-state', (m: any) => {
  if (overview) { overview.monero = m; onData?.(); }
});
wallet.on('balance-changed', () => void refresh());
wallet.on('locked', () => {
  closeScanner?.();
  wcOn = false;
  document.querySelectorAll('.modal').forEach((m) => m.remove());
  window.clearInterval(pollTimer);
  overview = null;
  addresses = null;
  torState = null;
  prices = null;
  if (!deleting) void boot();
});
for (const type of ['mousedown', 'keydown']) {
  let last = 0;
  window.addEventListener(type, () => {
    const now = Date.now();
    if (now - last > 30_000) { last = now; void wallet.activity(); }
  }, { passive: true });
}

/**
 * The request window the desktop app opens over the dApp's browser: it shows one dApp request after another, then
 * closes. Closing it unanswered turns the request down.
 */
async function runRequestWindow(): Promise<void> {
  show('send', h('div', { class: 'scroll popup-shell' }));
  wcOn = true;
  void refresh();
  let taking = false;
  const next = async () => {
    if (taking || document.querySelector('.modal')) return;
    taking = true;
    try {
      const item = await wallet.wcPopupTake();
      if (!item) { window.close(); return; }
      if (item.e === 'wc-proposal') await showProposal(item.d);
      else if (item.e === 'wc-request') await showRequest(item.d);
      else await showRefused(item.d);
    } finally { taking = false; }
  };
  new MutationObserver(() => { if (!document.querySelector('.modal')) void next(); }).observe(root, { childList: true, subtree: true });
  wallet.on('wc-popup-more', () => void next());
  await next();
}

async function boot(first = false): Promise<void> {
  const [s] = await Promise.all([wallet.status(), first ? new Promise((r) => setTimeout(r, 900)) : null]);
  if (!s.hasWallet) welcome();
  else if (s.unlocked) await enterWallet();
  else unlockScreen();
}
if (location.hash === '#wc-popup') void runRequestWindow(); else void boot(true);

// ---- Hyperliquid perps: WalletConnect wallets only ----

let perpSearch = '';
/** Sizes set through the style object: the page's CSP refuses style attributes. */
function sized<T extends HTMLElement>(el: T, css: Record<string, string>): T { Object.assign(el.style, css); return el; }
let perpFrame = '1h';

/** Money in USDC, two decimals, or hidden like every other balance. */
function usdc(n: number, sign = false): string {
  if (hideBalance) return '••••';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign ? (n > 0 ? '+' : n < 0 ? '-' : '') : n < 0 ? '-' : ''}$${s}`;
}
/** A price with as many decimals as it needs. */
function px(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = n >= 1000 ? 1 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d });
}
const pct = (rate: number, digits = 3) => `${(rate * 100).toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}%`;
function compact(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0);
}
/** Liquidation estimate of an isolated position: maintenance margin is half the initial margin at the highest leverage. */
function liqEstimate(side: 'long' | 'short', entry: number, size: number, margin: number, maxLev: number): number {
  if (!(size > 0) || !(entry > 0) || !(maxLev > 0)) return 0;
  const s = side === 'long' ? 1 : -1;
  const l = 1 / (2 * maxLev);
  const p = entry - (s * (margin - size * entry * l)) / size / (1 - l * s);
  return p > 0 ? p : 0;
}

async function renderPerps(): Promise<void> {
  const body = h('div', { class: 'scroll', id: 'perps' }, h('p', { class: 'empty' }, 'Loading…'));
  show('home', h('div', { class: 'bar' }, h('span', {}), h('h2', {}, 'Perps'), h('span', {})), body, bottomNav('perps'));
  let info: any;
  try { info = await wallet.perpsInfo(); } catch (e) { setKids(body, h('div', { class: 'error' }, errMsg(e))); return; }
  const top: Child[] = [];
  const acctEl = h('div', { class: 'panel', id: 'perps-account' }, h('p', { class: 'empty' }, 'Loading…'));
  top.push(acctEl);
  if (!info.ready) {
    const pw = h('input', { type: 'password', id: 'perps-pw', autocomplete: 'current-password' });
    const box = errorBox();
    const go = h('button', { class: 'primary', id: 'perps-enable', type: 'submit' }, info.agent || info.builder ? 'Turn trading back on' : 'Turn on trading');
    top.push(h('div', { class: 'panel', id: 'perps-setup' },
      h('h3', {}, 'Trade perpetual futures'),
      h('p', { class: 'small muted' }, 'Long or short with leverage, from this wallet. Your USDT or USDC stays in your own futures account, which only this wallet controls.'),
      h('ol', { class: 'small steps' },
        h('li', {}, 'Deposit USDT or USDC from BNB Chain, Arbitrum or Ethereum. Your futures account opens with the first deposit.'),
        h('li', {}, `Turn on trading. This approves a trading key made from your seed for ${info.days} days. It can open and close trades but can never withdraw or send your funds.`)),
      h('p', { class: 'small muted', id: 'perps-fee-note' }, `Kusari fee: ${pct(info.fee.maker)} on post-only orders, ${pct(info.fee.taker)} on all other orders, on top of the exchange's own trading fee. Turning on trading also approves this fee.`),
      h('form', { onsubmit: (e: Event) => {
        e.preventDefault();
        busy(go, 'Approving…', box, async () => {
          await wallet.perpsEnable(pw.value);
          pw.value = '';
          toast('Trading is on.');
          await renderPerps();
        });
      } }, box.el, h('label', { class: 'field' }, h('span', {}, 'Password'), pw), go)));
  }
  void (async () => {
    let a: any;
    try { a = await wallet.perpsAccount(); } catch (e) { setKids(acctEl, h('div', { class: 'error' }, errMsg(e))); return; }
    setKids(acctEl,
      h('span', { class: 'label' }, 'Perps account'),
      h('div', { class: 'big-amount', id: 'perps-equity' }, usdc(a.margin)),
      h('div', { class: 'small muted' }, 'Free: ', h('span', { id: 'perps-free' }, usdc(a.available)), ' · Open P&L: ', h('span', { class: a.pnl >= 0 ? 'up' : 'down', id: 'perps-pnl' }, usdc(a.pnl, true))),
      h('div', { class: 'row' },
        h('button', { id: 'perps-deposit', onclick: () => void renderPerpDeposit() }, 'Deposit'),
        h('button', { id: 'perps-withdraw', onclick: () => renderPerpWithdraw(a.available) }, 'Withdraw')));
    const extra: HTMLElement[] = [];
    if (a.positions.length) {
      extra.push(h('h3', { class: 'perp-head' }, 'Positions'));
      for (const p of a.positions) {
        const away = p.liquidation > 0 && p.mark > 0 ? Math.abs(p.mark - p.liquidation) / p.mark : 0;
        extra.push(h('div', { class: 'panel perp-pos', id: `pos-${p.symbol}` },
          h('div', { class: 'row spread' }, h('strong', { 'data-no-translate': '' }, p.symbol), h('span', { class: `perp-tag ${p.side === 'long' ? 'up' : 'down'}` }, `${p.side === 'long' ? 'Long' : 'Short'} ${p.leverage}x`), h('span', { class: p.pnl >= 0 ? 'up' : 'down' }, usdc(p.pnl, true))),
          h('div', { class: 'row spread small muted' }, h('span', {}, `${p.size} · entry ${px(p.entry)}`), h('span', {}, `Liq. ${px(p.liquidation)}`)),
          away > 0 && h('div', { class: 'liq-bar', 'aria-hidden': 'true' }, sized(h('span', {}), { width: `${Math.min(100, Math.round(away * 400))}%` })),
          away > 0 && h('div', { class: 'small muted' }, p.side === 'long' ? `Price can fall ${(away * 100).toFixed(1)}% before liquidation` : `Price can rise ${(away * 100).toFixed(1)}% before liquidation`),
          h('div', { class: 'row' },
            h('button', { onclick: () => void renderPerpMarket(p.symbol) }, 'Trade'),
            h('button', { class: 'danger', id: `close-${p.symbol}`, onclick: () => void renderPerpClose(p.symbol) }, 'Close'))));
      }
    }
    if (a.orders.length) {
      extra.push(h('h3', { class: 'perp-head' }, 'Open orders'));
      for (const o of a.orders) {
        const cancel = h('button', { id: `cancel-${o.orderId}` }, 'Cancel');
        cancel.onclick = () => { cancel.disabled = true; void wallet.perpsCancel(o.symbol, o.orderId).then(() => { toast('Order cancelled.'); void renderPerps(); }, (e: unknown) => { cancel.disabled = false; toast(errMsg(e)); }); };
        extra.push(h('div', { class: 'hist-row perp-order', id: `order-${o.orderId}` },
          h('div', {}, h('div', {}, h('span', { 'data-no-translate': '' }, o.symbol), ' ', h('span', { class: o.side === 'BUY' ? 'up' : 'down' }, o.side === 'BUY' ? (o.reduceOnly ? 'Close short' : 'Buy') : (o.reduceOnly ? 'Close long' : 'Sell'))),
            h('div', { class: 'small muted' }, `${o.qty} @ ${px(Number(o.price))}${o.postOnly ? ' · post-only' : ''}`)),
          cancel));
      }
    }
    acctEl.after(...extra);
  })();
  const list = h('div', { class: 'list', id: 'perp-markets' }, h('p', { class: 'empty' }, 'Loading markets…'));
  const search = h('input', { type: 'search', id: 'perp-search', placeholder: 'Search markets', value: perpSearch, autocomplete: 'off' });
  let markets: any[] = [];
  const paintMarkets = () => {
    const q = perpSearch.trim().toUpperCase();
    const shown = (q ? markets.filter((m) => m.symbol.toUpperCase().includes(q)) : markets).slice(0, q ? 60 : 30);
    setKids(list, ...(shown.length ? shown.map((m) => h('button', { class: 'asset perp-market', id: `mkt-${m.symbol}`, onclick: () => void renderPerpMarket(m.symbol) },
      h('div', {}, h('div', { class: 'name', 'data-no-translate': '' }, m.base, h('span', { class: 'muted small' }, `-${m.quote}`), m.maxLeverage ? h('span', { class: 'lev-tag', id: `lev-${m.symbol}` }, `${m.maxLeverage}x`) : null), h('div', { class: 'sub' }, `Vol $${compact(m.volume)}`)),
      h('div', { class: 'right' }, h('div', { class: 'amt' }, px(m.price)), h('div', { class: `sub ${m.change >= 0 ? 'up' : 'down'}` }, `${m.change >= 0 ? '+' : ''}${m.change.toFixed(2)}%`)))) : [h('p', { class: 'empty' }, 'No market matches.')]));
  };
  search.addEventListener('input', () => { perpSearch = search.value; paintMarkets(); });
  setKids(body, ...top, h('h3', { class: 'perp-head' }, 'Markets'), search, list,
    h('p', { class: 'small muted' }, 'Futures with leverage can lose all the margin put in.'));
  try { markets = await wallet.perpsMarkets(); paintMarkets(); } catch (e) { setKids(list, h('div', { class: 'error' }, errMsg(e))); }
}

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

/**
 * A candle chart on a canvas you can move and stretch: drag to move it in time and price, the wheel (or a pinch)
 * to zoom in time, Shift+wheel or a drag on the price scale to stretch the prices, a double click to reset.
 */
function candleChart(label: string) {
  const AXIS = 58;
  const TIME = 18;
  const H = 230;
  const canvas = h('canvas', { class: 'chart-canvas', role: 'img', 'aria-label': label }) as HTMLCanvasElement;
  const wrap = h('div', { class: 'chart-wrap', id: 'perp-chart' }, canvas);
  let cs: Candle[] = [];
  let interval = 3600e3;
  let bars = 60;
  let end = 0;
  let manual: { lo: number; hi: number } | null = null;
  let last = 0;
  let hover: { x: number; y: number } | null = null;
  const css = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const nice = (raw: number) => { const p = 10 ** Math.floor(Math.log10(raw)); const f = raw / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; };
  const clampView = () => {
    bars = Math.max(10, Math.min(Math.max(10, cs.length), bars));
    end = Math.max(Math.min(bars, cs.length) * 0.25, Math.min(cs.length + bars * 0.5, end));
  };
  const range = (): { lo: number; hi: number } => {
    if (manual) return manual;
    const vis = cs.slice(Math.max(0, Math.floor(end - bars)), Math.ceil(end));
    if (!vis.length) return { lo: 0, hi: 1 };
    const lo = Math.min(...vis.map((c) => c.l));
    const hi = Math.max(...vis.map((c) => c.h));
    const pad = (hi - lo || hi * 0.01 || 1) * 0.08;
    return { lo: lo - pad, hi: hi + pad };
  };
  const timeText = (t: number) => {
    const d = new Date(t);
    const two = (n: number) => String(n).padStart(2, '0');
    return interval >= 86400e3 ? `${two(d.getMonth() + 1)}/${two(d.getDate())}` : interval >= 3600e3 && d.getHours() === 0 ? `${two(d.getMonth() + 1)}/${two(d.getDate())}` : `${two(d.getHours())}:${two(d.getMinutes())}`;
  };

  function draw(): void {
    const w = wrap.clientWidth || 360;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${H}px`;
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, H);
    const pw = w - AXIS;
    const ph = H - TIME;
    const muted = color('--muted', '#9b9b97');
    g.font = '10.5px Pretendard, system-ui, sans-serif';
    if (!cs.length) { g.fillStyle = muted; g.fillText('No chart data.', 8, 20); return; }
    const { lo, hi } = range();
    const y = (v: number) => ((hi - v) / (hi - lo)) * ph;
    const bw = pw / bars;
    const x0 = end - bars;
    // Faint grid: prices across, times down.
    g.strokeStyle = 'rgba(255,255,255,0.055)';
    g.lineWidth = 1;
    g.fillStyle = muted;
    const step = nice((hi - lo) / 5);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      g.beginPath(); g.moveTo(0, yy); g.lineTo(pw, yy); g.stroke();
      g.fillText(px(v), pw + 6, yy + 3.5);
    }
    const every = Math.max(1, nice(bars / 5));
    for (let i = Math.ceil(Math.max(0, x0) / every) * every; i < Math.min(cs.length, end); i += every) {
      const xx = Math.round((i - x0 + 0.5) * bw) + 0.5;
      g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, ph); g.stroke();
      const text = timeText(cs[i].t);
      g.fillText(text, Math.min(pw - g.measureText(text).width, Math.max(0, xx - g.measureText(text).width / 2)), H - 5);
    }
    // Candles.
    const up = color('--green', '#17b26a');
    const down = '#ff4d3d';
    g.save();
    g.beginPath(); g.rect(0, 0, pw, ph); g.clip();
    for (let i = Math.max(0, Math.floor(x0)); i < Math.min(cs.length, Math.ceil(end)); i++) {
      const c = cs[i];
      const cx = (i - x0 + 0.5) * bw;
      g.fillStyle = g.strokeStyle = c.c >= c.o ? up : down;
      g.beginPath(); g.moveTo(Math.round(cx) + 0.5, y(c.h)); g.lineTo(Math.round(cx) + 0.5, y(c.l)); g.stroke();
      const top = y(Math.max(c.o, c.c));
      g.fillRect(cx - Math.max(1, bw * 0.35), top, Math.max(1, bw * 0.7), Math.max(1, y(Math.min(c.o, c.c)) - top));
    }
    g.restore();
    // The last price, dashed, with its label on the scale.
    const lp = last || cs[cs.length - 1].c;
    if (lp >= lo && lp <= hi) {
      const yy = Math.round(y(lp)) + 0.5;
      g.strokeStyle = color('--orange', '#ff6a13');
      g.setLineDash([4, 3]); g.beginPath(); g.moveTo(0, yy); g.lineTo(pw, yy); g.stroke(); g.setLineDash([]);
      g.fillStyle = color('--orange', '#ff6a13');
      g.fillRect(pw + 2, yy - 8, AXIS - 3, 16);
      g.fillStyle = '#140700';
      g.fillText(px(lp), pw + 5, yy + 3.5);
    }
    // Crosshair, with the candle under it.
    if (hover && hover.x < pw && hover.y < ph) {
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(hover.x + 0.5, 0); g.lineTo(hover.x + 0.5, ph); g.moveTo(0, hover.y + 0.5); g.lineTo(pw, hover.y + 0.5); g.stroke();
      g.setLineDash([]);
      const v = hi - (hover.y / ph) * (hi - lo);
      g.fillStyle = '#262626'; g.fillRect(pw + 2, hover.y - 8, AXIS - 3, 16);
      g.fillStyle = color('--text', '#f5f5f3'); g.fillText(px(v), pw + 5, hover.y + 3.5);
      const c = cs[Math.floor(x0 + hover.x / bw)];
      if (c) {
        g.fillStyle = muted;
        g.fillText(`${timeText(c.t)}  O ${px(c.o)}  H ${px(c.h)}  L ${px(c.l)}  C ${px(c.c)}`, 6, 12);
      }
    }
  }

  // Moving and stretching.
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; end: number; lo: number; hi: number; axis: boolean; pinch?: number; bars?: number } | null = null;
  const local = (e: { clientX: number; clientY: number }) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const zoomAt = (x: number, factor: number) => {
    const pw = (wrap.clientWidth || 360) - AXIS;
    const anchor = end - bars + (Math.min(x, pw) / pw) * bars;
    const nb = Math.max(10, Math.min(Math.max(10, cs.length), bars * factor));
    end = anchor + (end - anchor) * (nb / bars);
    bars = nb;
    clampView();
  };
  const stretch = (factor: number) => {
    const r = range();
    const mid = (r.lo + r.hi) / 2;
    const half = ((r.hi - r.lo) / 2) * factor;
    manual = { lo: mid - half, hi: mid + half };
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, p);
    const r = range();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      drag = { x: (a.x + b.x) / 2, y: 0, end, lo: r.lo, hi: r.hi, axis: false, pinch: Math.abs(a.x - b.x) || 1, bars };
    } else {
      drag = { x: p.x, y: p.y, end, lo: r.lo, hi: r.hi, axis: p.x > (wrap.clientWidth || 360) - AXIS };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (e.pointerType === 'mouse') hover = p;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (drag) {
      const pw = (wrap.clientWidth || 360) - AXIS;
      const ph = H - TIME;
      if (drag.pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.abs(a.x - b.x) || 1;
        bars = drag.bars!; end = drag.end;
        zoomAt(drag.x, drag.pinch / dist);
      } else if (drag.axis) {
        const f = Math.exp((p.y - drag.y) * 0.01);
        const mid = (drag.lo + drag.hi) / 2;
        manual = { lo: mid - ((drag.hi - drag.lo) / 2) * f, hi: mid + ((drag.hi - drag.lo) / 2) * f };
      } else {
        end = drag.end - (p.x - drag.x) / (pw / bars);
        if (manual || Math.abs(p.y - drag.y) > 6) {
          const per = (drag.hi - drag.lo) / ph;
          manual = { lo: drag.lo + (p.y - drag.y) * per, hi: drag.hi + (p.y - drag.y) * per };
        }
        clampView();
      }
    }
    draw();
  });
  const up = (e: PointerEvent) => { pointers.delete(e.pointerId); if (!pointers.size) drag = null; };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => { hover = null; draw(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    const f = Math.exp((e.deltaY || e.deltaX) * 0.0015);
    if (e.shiftKey || p.x > (wrap.clientWidth || 360) - AXIS) stretch(f); else zoomAt(p.x, f);
    draw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => { bars = 60; end = cs.length; manual = null; clampView(); draw(); });
  new ResizeObserver(() => draw()).observe(wrap);

  return {
    el: wrap,
    /** New candles; the view stays where it was, following the newest candle when it was already at the right edge. */
    set(list: Candle[], ms: number, fresh: boolean): void {
      const atEdge = end >= cs.length - 0.5;
      cs = list;
      interval = ms;
      if (fresh) { bars = 60; end = cs.length; manual = null; } else if (atEdge) end = cs.length;
      clampView();
      draw();
    },
    price(p: number): void { last = p; draw(); },
  };
}

interface TradeState { side: 'long' | 'short'; kind: 'market' | 'limit' | 'post'; margin: string; pctOn: boolean; leverage: number; price: string }

/** Design A: chart and order book on top, the order form with margin and leverage sliders below, Long / Short at the bottom. */
async function renderPerpMarket(symbol: string, keep?: TradeState): Promise<void> {
  const body = h('div', { class: 'scroll perp-trade', id: 'perp-trade' }, h('p', { class: 'empty' }, 'Loading…'));
  show('send', h('div', { class: 'bar' },
    h('button', { class: 'icon-btn', id: 'back', 'aria-label': 'Back', onclick: () => void renderPerps() }, icon('back')),
    h('h2', { 'data-no-translate': '' }, symbol), h('span', {})), body);
  let info: any; let ready = false; let acct: any = null;
  try {
    [info, ready, acct] = await Promise.all([wallet.perpsMarket(symbol), wallet.perpsInfo().then((i: any) => i.ready), wallet.perpsAccount().catch(() => null)]);
  } catch (e) { setKids(body, h('div', { class: 'error' }, errMsg(e))); return; }
  const m = info.market;
  const maxLev = info.maxLeverage || 1;
  const free = acct?.available ?? 0;
  const pos = acct?.positions?.find((p: any) => p.symbol === symbol);
  const st: TradeState = keep ?? { side: 'long', kind: 'market', margin: '', pctOn: false, leverage: Math.min(10, maxLev), price: '' };
  let mark = info.mark;

  // Price block.
  const priceEl = h('div', { class: 'hl-price', id: 'perp-mark' }, px(mark));
  const changeEl = h('div', { class: `small ${m.change >= 0 ? 'up' : 'down'}` }, `${m.change >= 0 ? '+' : ''}${m.change.toFixed(2)}% 24h`);
  const head = h('div', { class: 'hl-head' },
    h('div', {}, h('div', { class: 'row' }, priceEl, h('span', { class: 'lev-tag', id: 'perp-max-lev' }, `${maxLev}x`)), changeEl),
    h('div', { class: 'hl-stats' },
      h('span', { class: 'muted' }, 'Mark'), h('span', { id: 'perp-mark-2' }, px(mark)),
      // Hyperliquid's index: a weighted median of spot prices on the big exchanges, which marks and funding follow.
      h('span', { class: 'muted', title: 'Weighted median of spot prices on major exchanges' }, 'Index'), h('span', { id: 'perp-index' }, px(m.oracle)),
      // Kusari's own, read from the exchanges directly; for comparison, it decides nothing.
      h('button', { type: 'button', class: 'link small kx-toggle', id: 'perp-kindex-toggle', 'aria-expanded': 'false', onclick: () => { kxList.hidden = !kxList.hidden; kxToggle().setAttribute('aria-expanded', String(!kxList.hidden)); } }, 'Kusari index'), h('span', { id: 'perp-kindex' }, '…'),
      h('span', { class: 'muted' }, 'Funding'), h('span', { class: info.funding >= 0 ? 'warn-text' : 'up' }, pct(info.funding, 4)),
      h('span', { class: 'muted' }, 'Open int.'), h('span', {}, `$${compact(info.openInterest)}`)));

  // Kusari index: each exchange's price, behind the toggle.
  const kxList = h('div', { class: 'panel kx-list small', id: 'perp-kindex-list', hidden: true });
  const kxToggle = () => document.getElementById('perp-kindex-toggle')!;
  async function loadIndex(): Promise<void> {
    let k: any;
    try { k = await wallet.perpsIndex(symbol); } catch { return; }
    const el = document.getElementById('perp-kindex');
    if (el) el.textContent = k.price ? px(k.price) : '—';
    const gap = k.price && m.oracle ? ((k.price - m.oracle) / m.oracle) * 100 : null;
    setKids(kxList,
      h('div', { class: 'muted' }, 'Weighted median of spot mid prices read directly from these exchanges. For comparison only: Index sets marks, funding and liquidations.'),
      ...k.quotes.map((q: any) => h('div', { class: 'row spread' }, h('span', {}, `${q.name} ×${q.weight}`), h('span', {}, px(q.price)))),
      ...(k.failed.length ? [h('div', { class: 'muted' }, `Not reached: ${k.failed.join(', ')}`)] : []),
      gap !== null && h('div', { class: 'row spread' }, h('span', { class: 'muted' }, 'Difference from Index'), h('span', { id: 'perp-kindex-gap' }, `${gap >= 0 ? '+' : ''}${gap.toFixed(3)}%`)));
  }

  // Chart.
  const frames = ['1m', '5m', '15m', '1h', '4h', '1d'];
  const FRAME_MS: Record<string, number> = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
  const chart = candleChart(`${symbol} price chart`);
  let chartFrame = '';
  const frameBtns = frames.map((f) => h('button', { type: 'button', class: 'tf', id: `tf-${f}`, 'aria-pressed': String(f === perpFrame), onclick: () => { perpFrame = f; frameBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(frames[i] === f))); void loadChart(); } }, f === '1d' ? '1D' : f));
  async function loadChart(): Promise<void> {
    const frame = perpFrame;
    let cs: any[] = [];
    try { cs = await wallet.perpsCandles(symbol, frame); } catch { /* keep the old chart */ return; }
    if (frame !== perpFrame) return;
    chart.set(cs, FRAME_MS[frame], frame !== chartFrame);
    chartFrame = frame;
  }

  // Order book.
  const bidsEl = h('div', { class: 'book-side', id: 'perp-bids' });
  const asksEl = h('div', { class: 'book-side', id: 'perp-asks' });
  async function loadBook(): Promise<void> {
    let b: any;
    try { b = await wallet.perpsBook(symbol); } catch { return; }
    const most = Math.max(1e-12, ...b.bids.slice(0, 5).map((l: any) => l.sz), ...b.asks.slice(0, 5).map((l: any) => l.sz));
    const row = (l: any, side: 'bid' | 'ask') => h('button', { type: 'button', class: `book-row ${side}`, onclick: () => { if (st.kind !== 'market') { price.value = String(l.px); paint(); } } },
      sized(h('span', { class: 'depth' }), { width: `${Math.round((l.sz / most) * 100)}%` }), h('span', { class: 'bp' }, px(l.px)), h('span', { class: 'bs' }, String(l.sz)));
    setKids(bidsEl, h('div', { class: 'book-label' }, h('span', {}, 'Bid'), h('span', {}, 'Size')), ...b.bids.slice(0, 5).map((l: any) => row(l, 'bid')));
    setKids(asksEl, h('div', { class: 'book-label' }, h('span', {}, 'Ask'), h('span', {}, 'Size')), ...b.asks.slice(0, 5).map((l: any) => row(l, 'ask')));
    if (b.bids[0] && b.asks[0]) { mark = (b.bids[0].px + b.asks[0].px) / 2; priceEl.textContent = px(mark); chart.price(mark); paint(); }
  }

  // Order form.
  const kinds = [['market', 'Market'], ['limit', 'Limit'], ['post', 'Post-only']] as const;
  const kindBtns = kinds.map(([k, label]) => h('button', { type: 'button', class: 'seg', id: `kind-${k}`, 'aria-pressed': String(st.kind === k), onclick: () => { st.kind = k; paint(); } }, label));
  const price = h('input', { id: 'perp-price', inputmode: 'decimal', autocomplete: 'off', value: st.price, placeholder: px(mark).replace(/,/g, '') });
  const priceRow = h('label', { class: 'field' }, h('span', {}, 'Limit price (USD)'), price);
  const marginRange = h('input', { type: 'range', id: 'perp-margin-range', min: '0', max: '100', step: '1', value: '0', 'aria-label': 'Margin as a share of free balance' });
  const margin = h('input', { id: 'perp-margin', class: 'num-box', inputmode: 'decimal', autocomplete: 'off', value: st.margin, placeholder: '0.00', 'aria-label': 'Margin (USDC)' });
  const levRange = h('input', { type: 'range', id: 'perp-lev', min: '1', max: String(maxLev), step: '1', value: String(Math.min(st.leverage, maxLev)), 'aria-label': 'Leverage' });
  const levNum = h('input', { id: 'perp-lev-num', class: 'num-box lev', inputmode: 'numeric', autocomplete: 'off', value: String(Math.min(st.leverage, maxLev)), 'aria-label': 'Leverage' });
  const levTicks = [1, ...[0.25, 0.5, 0.75].map((f) => Math.max(1, Math.round(maxLev * f))), maxLev];
  const sizeText = h('span', { id: 'perp-size' });
  const liqText = h('span', { id: 'perp-liq', class: 'warn-text' });
  const feeText = h('div', { class: 'small muted', id: 'perp-fees' });
  const box = errorBox();
  const longBtn = h('button', { type: 'button', class: 'big-long', id: 'perp-long', disabled: !ready }, 'Long');
  const shortBtn = h('button', { type: 'button', class: 'big-short', id: 'perp-short', disabled: !ready }, 'Short');

  function paint(fromBox = false): void {
    st.price = price.value; st.leverage = Number(levRange.value);
    if (!fromBox) levNum.value = String(st.leverage);
    st.margin = margin.value;
    kindBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(kinds[i][0] === st.kind)));
    priceRow.hidden = st.kind === 'market';
    const mg = Number(st.margin.replace(/,/g, '')) || 0;
    if (!st.pctOn) marginRange.value = String(free > 0 ? Math.min(100, Math.round((mg / free) * 100)) : 0);
    const size = mg * st.leverage;
    const ref = st.kind === 'market' ? mark : Number(st.price) || mark;
    sizeText.textContent = size > 0 ? usdc(size) : '—';
    const liq = size > 0 ? liqEstimate('long', ref, size / ref, mg, maxLev) : 0;
    const liqS = size > 0 ? liqEstimate('short', ref, size / ref, mg, maxLev) : 0;
    liqText.textContent = size > 0 ? `${px(liq)} / ${px(liqS)}` : '—';
    const maker = st.kind === 'post';
    const k = maker ? info.kusariFee.maker : info.kusariFee.taker;
    const v = info.venueFee ? (maker ? info.venueFee.maker : info.venueFee.taker) : null;
    feeText.textContent = v === null ? `Fees: trading fee + Kusari ${pct(k)} of the position size` : `Fees: trading ${pct(v)} + Kusari ${pct(k)} of the position size`;
  }
  marginRange.addEventListener('input', () => {
    const v = Math.floor((free * Number(marginRange.value)) / 100 * 100) / 100;
    margin.value = v > 0 ? String(v) : '';
    st.pctOn = true; paint(); st.pctOn = false;
  });
  margin.addEventListener('input', () => paint());
  levRange.addEventListener('input', () => paint());
  levNum.addEventListener('input', () => { const n = Math.floor(Number(levNum.value)); if (n >= 1) { levRange.value = String(Math.min(n, maxLev)); paint(true); } });
  levNum.addEventListener('change', () => paint());
  price.addEventListener('input', () => paint());
  const go = (side: 'long' | 'short') => {
    st.side = side;
    const btn = side === 'long' ? longBtn : shortBtn;
    busy(btn, 'Checking…', box, async () => {
      const p = await wallet.perpsPrepareOrder({ symbol, side, type: st.kind === 'market' ? 'MARKET' : 'LIMIT', margin: st.margin.replace(/,/g, ''), leverage: st.leverage, price: st.price, postOnly: st.kind === 'post' });
      renderPerpReview(p, () => void renderPerpMarket(symbol, st));
    });
  };
  longBtn.onclick = () => go('long');
  shortBtn.onclick = () => go('short');

  setKids(body,
    head,
    kxList,
    h('div', { class: 'tfs' }, ...frameBtns),
    chart.el,
    h('div', { class: 'book' }, bidsEl, asksEl),
    pos && h('button', { type: 'button', class: 'panel perp-mini-pos', id: 'perp-pos', onclick: () => void renderPerpClose(symbol) },
      h('div', {}, h('div', { class: 'small muted' }, 'Your position'), h('strong', {}, h('span', { class: pos.side === 'long' ? 'up' : 'down' }, `${pos.side === 'long' ? 'Long' : 'Short'} ${pos.leverage}x`), ` · ${pos.size} ${symbol}`)),
      h('div', { class: 'right' }, h('div', { class: pos.pnl >= 0 ? 'up' : 'down' }, usdc(pos.pnl, true)), h('div', { class: 'small muted' }, `Liq. ${px(pos.liquidation)}`))),
    !ready && h('div', { class: 'warn', id: 'perp-not-ready' }, 'Turn on trading on the Perps screen first.', h('br'), h('button', { type: 'button', class: 'link', onclick: () => void renderPerps() }, 'Go to Perps')),
    h('div', { class: 'panel order-panel' },
      h('div', { class: 'segs' }, ...kindBtns),
      priceRow,
      h('div', { class: 'slider-head' }, h('span', {}, 'Margin (USDT)'), h('span', { class: 'small muted', id: 'perp-free' }, `Free ${usdc(free)}`)),
      marginRange,
      h('div', { class: 'ticks' }, ...['0%', '25%', '50%', '75%', '100%'].map((t) => h('span', {}, t))),
      h('label', { class: 'num-row' }, margin, h('span', { class: 'unit' }, 'USDT')),
      h('div', { class: 'slider-head' }, h('span', {}, 'Leverage'), h('span', { class: 'small muted' }, `Max ${maxLev}x`)),
      levRange,
      h('div', { class: 'ticks' }, ...levTicks.map((t) => h('button', { type: 'button', class: 'tick', id: `lev-pick-${t}`, onclick: () => { levRange.value = String(t); paint(); } }, `${t}x`))),
      h('label', { class: 'num-row lev' }, levNum, h('span', { class: 'unit' }, 'x')),
      h('div', { class: 'row spread small summary' }, h('span', { class: 'muted' }, 'Size ', sizeText), h('span', { class: 'muted' }, 'Liq. long/short ≈ ', liqText)),
      feeText, box.el),
    h('p', { class: 'small muted' }, 'Positions use isolated margin: if one is liquidated, only the margin in it is lost.'));
  root.querySelector('.screen')!.append(h('div', { class: 'lr-bar' }, longBtn, shortBtn));
  paint();
  void loadChart();
  void loadBook();
  void loadIndex();
  // Live while this screen is open.
  const timer = window.setInterval(() => {
    if (!body.isConnected) { window.clearInterval(timer); return; }
    void loadBook();
  }, 4000);
  const slow = window.setInterval(() => {
    if (!body.isConnected) { window.clearInterval(slow); return; }
    void loadChart();
  }, 30_000);
  const mid = window.setInterval(() => {
    if (!body.isConnected) { window.clearInterval(mid); return; }
    void loadIndex();
  }, 15_000);
}

function renderPerpReview(p: any, back: () => void): void {
  const box = errorBox();
  const go = h('button', { class: `primary ${p.side === 'long' ? '' : 'danger'}`, id: 'perp-place' }, p.side === 'long' ? 'Open long' : 'Open short');
  go.onclick = () => busy(go, 'Placing…', box, async () => {
    const r = await wallet.perpsPlace(p.id);
    toast(r.status === 'FILLED' ? 'Order filled.' : 'Order placed.');
    await renderPerps();
  });
  show('send', subBar('Review order', back), h('div', { class: 'scroll' },
    ...p.warnings.map((w: string) => h('div', { class: 'warn' }, w)),
    h('div', { class: 'panel' }, h('table', { class: 'review-table', id: 'perp-review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'Market'), h('td', { 'data-no-translate': '' }, `${p.symbol}-USD`)),
      h('tr', {}, h('th', {}, 'Side'), h('td', { class: p.side === 'long' ? 'up' : 'down' }, `${p.side === 'long' ? 'Long' : 'Short'} ${p.leverage}x`)),
      h('tr', {}, h('th', {}, 'Order'), h('td', {}, p.type === 'MARKET' ? 'Market' : p.postOnly ? 'Limit, post-only' : 'Limit')),
      h('tr', {}, h('th', {}, 'Size'), h('td', { id: 'perp-r-size' }, `${p.quantity} ${p.base} (${usdc(p.notional)})`)),
      h('tr', {}, h('th', {}, p.type === 'MARKET' ? 'Price now' : 'Price'), h('td', {}, px(p.price))),
      h('tr', {}, h('th', {}, 'Margin'), h('td', { id: 'perp-r-margin' }, usdc(p.margin))),
      h('tr', {}, h('th', {}, 'Liquidation price'), h('td', { class: 'warn-text', id: 'perp-r-liq' }, p.liquidation ? `about ${px(p.liquidation)}` : 'Shown once the position is open')),
      h('tr', {}, h('th', {}, 'Trading fee'), h('td', { id: 'perp-r-venue' }, p.venueFee === null ? 'Standard rate' : `${usdc(p.venueFee)} (${pct(p.venueRate)})`)),
      h('tr', {}, h('th', {}, 'Kusari fee'), h('td', { id: 'perp-r-kusari' }, `${usdc(p.kusariFee)} (${pct(p.kusariRate)})`))))),
    box.el, go));
}

async function renderPerpClose(symbol: string): Promise<void> {
  let p: any;
  try { p = await wallet.perpsPrepareClose(symbol); } catch (e) { toast(errMsg(e)); return; }
  const box = errorBox();
  const go = h('button', { class: 'primary danger', id: 'perp-close-confirm' }, 'Close position');
  go.onclick = () => busy(go, 'Closing…', box, async () => {
    await wallet.perpsPlace(p.id);
    toast('Position closed.');
    await renderPerps();
  });
  show('send', subBar(`Close ${symbol}`, () => void renderPerps()), h('div', { class: 'scroll' },
    h('div', { class: 'warn' }, 'Closes the whole position at the market price.'),
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'Position'), h('td', {}, `${p.side === 'long' ? 'Long' : 'Short'} ${p.quantity} ${p.base}`)),
      h('tr', {}, h('th', {}, 'Price now'), h('td', {}, px(p.price))),
      h('tr', {}, h('th', {}, 'P&L now'), h('td', { class: p.pnl >= 0 ? 'up' : 'down' }, usdc(p.pnl, true))),
      h('tr', {}, h('th', {}, 'Trading fee'), h('td', {}, p.venueFee === null ? 'Standard rate' : `${usdc(p.venueFee)} (${pct(p.venueRate)})`)),
      h('tr', {}, h('th', {}, 'Kusari fee'), h('td', {}, `${usdc(p.kusariFee)} (${pct(p.kusariRate)})`))))),
    box.el, go));
}

/** Coins the futures account takes, on the chains it takes them on. */
const PERP_DEPOSIT_ASSETS: Asset[] = ['USDTB', 'USDCB', 'USDTA', 'USDCA', 'USDTE', 'USDCE'];

function renderPerpDeposit(pick: Asset = 'USDTB'): void {
  const amount = h('input', { id: 'perp-dep-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'perp-dep-review', type: 'submit' }, 'Review deposit');
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Checking…', box, async () => renderPerpDepositReview(await wallet.perpsDepositPrepare(pick, amount.value), pick));
  } },
  h('div', { class: 'list' }, ...PERP_DEPOSIT_ASSETS.map((a) => h('button', { type: 'button', class: `asset${a === pick ? ' on' : ''}`, id: `dep-${a}`, onclick: () => renderPerpDeposit(a) },
    coin(a), h('div', {}, h('div', { class: 'name' }, coinName(a))), h('div', { class: 'right' }, h('div', { class: 'amt' }, balanceText(a)))))),
  h('p', { class: 'small muted' }, 'The coin goes to the futures exchange\'s deposit contract on its chain and shows in your futures account once the chain confirms it. A first deposit of a token also approves the contract to take it, in the same review. The network fee is paid in that chain\'s own coin.'),
  h('label', { class: 'field' }, h('span', {}, 'Amount'), amount),
  h('button', { type: 'button', class: 'link', id: 'perp-dep-max', onclick: () => { amount.value = String(overview?.balances?.[pick]?.spendable ?? '').replace(/,/g, ''); } }, 'Use all'),
  box.el, go);
  show('send', subBar('Deposit to Perps', () => void renderPerps()), h('div', { class: 'scroll' }, form));
}

function renderPerpDepositReview(p: any, pick: Asset): void {
  const pw = h('input', { type: 'password', id: 'perp-dep-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'perp-dep-confirm', type: 'submit' }, 'Deposit');
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Sending…', box, async () => {
      const r = await wallet.perpsDepositConfirm(p.id, pw.value);
      pw.value = '';
      show('receive', subBar('Deposit sent', () => void renderPerps()), h('div', { class: 'scroll' },
        h('h2', { id: 'perp-dep-sent' }, `${p.amount} ${coinName(p.asset)} → Perps`),
        h('p', { class: 'muted' }, 'Sent to the network. It shows in your futures account once the chain confirms it.'),
        ...r.hashes.map((hash: string) => h('div', { class: 'panel' }, h('div', { class: 'mono' }, hash), h('br'),
          h('div', { class: 'row' }, h('button', { onclick: () => wallet.copy(hash) }, 'Copy'), h('button', { onclick: () => void openExplorer(p.asset, hash) }, 'View in explorer')))),
        h('button', { class: 'primary', onclick: () => void renderPerps() }, 'Back to Perps')));
      void refresh();
    });
  } },
  h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
    h('tr', {}, h('th', {}, 'Deposit'), h('td', { id: 'perp-dep-r-amount' }, `${p.amount} ${coinName(p.asset)}`)),
    h('tr', {}, h('th', {}, 'To'), h('td', {}, 'Your futures account')),
    h('tr', {}, h('th', {}, 'Transactions'), h('td', {}, String(p.steps))),
    h('tr', {}, h('th', {}, 'Network fee'), h('td', {}, reviewFee(p.fee, p.feeAsset)))))),
  box.el, h('label', { class: 'field' }, h('span', {}, 'Password'), pw), go);
  show('send', subBar('Review deposit', () => { void wallet.cancelSend(p.id); renderPerpDeposit(pick); }), h('div', { class: 'scroll' }, form));
  pw.focus();
}

const PERP_PAYOUT: { chainId: number; name: string }[] = [{ chainId: 56, name: 'BNB Chain' }, { chainId: 42161, name: 'Arbitrum' }, { chainId: 1, name: 'Ethereum' }];

function renderPerpWithdraw(available: number): void {
  const amount = h('input', { id: 'perp-wd-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' });
  const chain = h('select', { id: 'perp-wd-chain', 'aria-label': 'Network' }, ...PERP_PAYOUT.map((c) => h('option', { value: String(c.chainId) }, c.name))) as HTMLSelectElement;
  const token = h('select', { id: 'perp-wd-token', 'aria-label': 'Coin' }, h('option', { value: 'USDT' }, 'USDT'), h('option', { value: 'USDC' }, 'USDC')) as HTMLSelectElement;
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'perp-wd-review', type: 'submit' }, 'Review withdrawal');
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Checking…', box, async () => renderPerpWithdrawReview(await wallet.perpsWithdrawPrepare(Number(chain.value), token.value, amount.value), available));
  } },
  h('p', { class: 'small muted' }, `Free to withdraw: ${usdc(available)}. It goes to this wallet's own address on the network you choose, usually within a few minutes. The exchange charges a withdrawal fee, shown before you confirm.`),
  h('label', { class: 'field' }, h('span', {}, 'Network'), chain),
  h('label', { class: 'field' }, h('span', {}, 'Coin'), token),
  h('label', { class: 'field' }, h('span', {}, 'Amount'), amount),
  h('button', { type: 'button', class: 'link', id: 'perp-wd-max', onclick: () => { amount.value = String(Math.floor(available * 100) / 100); } }, 'Use all'),
  box.el, go);
  show('send', subBar('Withdraw from Perps', () => void renderPerps()), h('div', { class: 'scroll' }, form));
}

function renderPerpWithdrawReview(p: any, available: number): void {
  const pw = h('input', { type: 'password', id: 'perp-wd-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'perp-wd-confirm', type: 'submit' }, 'Withdraw');
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Sending…', box, async () => {
      await wallet.perpsWithdrawConfirm(p.id, pw.value);
      pw.value = '';
      toast('Withdrawal requested. It usually arrives within minutes.');
      await renderPerps();
    });
  } },
  h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
    h('tr', {}, h('th', {}, 'Withdraw'), h('td', {}, `${p.amount} ${p.token}`)),
    h('tr', {}, h('th', {}, 'Network'), h('td', {}, PERP_PAYOUT.find((c) => c.chainId === p.chainId)?.name ?? String(p.chainId))),
    h('tr', {}, h('th', {}, 'Withdrawal fee'), h('td', {}, `${p.fee} ${p.token}`)),
    h('tr', {}, h('th', {}, 'You receive'), h('td', { id: 'perp-wd-receive' }, `${p.receive} ${p.token}`)),
    h('tr', {}, h('th', {}, 'To'), h('td', { class: 'mono' }, p.to))))),
  box.el, h('label', { class: 'field' }, h('span', {}, 'Password'), pw), go);
  show('send', subBar('Review withdrawal', () => renderPerpWithdraw(available)), h('div', { class: 'scroll' }, form));
  pw.focus();
}

// ---- HYPE between HyperEVM (this wallet) and HyperCore (the trading engine): WalletConnect wallets ----

function hypeCorePanel(): HTMLElement {
  const line = h('p', { class: 'small', id: 'hype-core-balance' }, 'HyperCore balance: …');
  const panel = h('div', { class: 'panel', id: 'hype-core' },
    line,
    h('p', { class: 'small muted' }, 'HyperCore is the trading side of the same chain, with a separate balance at this same address. HYPE moves between the two in about a minute.'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'secondary', id: 'hype-to-core', onclick: () => renderHypeMove('core') }, 'Move to HyperCore'),
      h('button', { class: 'secondary', id: 'hype-to-evm', onclick: () => renderHypeMove('evm') }, 'Move to HyperEVM')));
  void wallet.hypeCore().then((c: any) => { line.textContent = `HyperCore balance: ${hideBalance ? '••••' : shortAmount(String(c.available))} HYPE`; }, () => { line.textContent = 'HyperCore balance: not available right now'; });
  return panel;
}

function renderHypeMove(dir: 'core' | 'evm'): void {
  const amount = h('input', { id: 'hype-move-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'hype-move-review', type: 'submit' }, 'Review');
  const useAll = h('button', { type: 'button', class: 'link', id: 'hype-move-max' }, 'Use all');
  useAll.onclick = async () => {
    if (dir === 'core') { amount.value = String(overview?.balances?.HYPE?.spendable ?? '').replace(/,/g, ''); return; }
    try { const c = await wallet.hypeCore(); amount.value = String(Math.max(0, Math.floor((c.available - c.reserve) * 1e6) / 1e6)); } catch (e) { box.show(e); }
  };
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Checking…', box, async () => renderHypeMoveReview(dir === 'core' ? await wallet.hypeToCorePrepare(amount.value) : await wallet.hypeToEvmPrepare(amount.value)));
  } },
  h('p', { class: 'small muted' }, dir === 'core'
    ? 'From this wallet (HyperEVM) to HyperCore, at the same address. HyperEVM\'s network fee is paid in HYPE.'
    : 'From HyperCore to this wallet (HyperEVM), at the same address. HyperCore keeps 0.001 HYPE for the move\'s gas.'),
  h('label', { class: 'field' }, h('span', {}, 'Amount (HYPE)'), amount), useAll, box.el, go);
  show('send', subBar(dir === 'core' ? 'Move to HyperCore' : 'Move to HyperEVM', () => { selected = 'HYPE'; void renderAsset(); }), h('div', { class: 'scroll' }, form));
}

function renderHypeMoveReview(p: any): void {
  const pw = h('input', { type: 'password', id: 'hype-move-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'hype-move-confirm', type: 'submit' }, 'Move');
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Sending…', box, async () => {
      if (p.direction === 'core') await wallet.hypeToCoreConfirm(p.id, pw.value); else await wallet.hypeToEvmConfirm(p.id, pw.value);
      pw.value = '';
      toast(p.direction === 'core' ? 'Sent. It shows on HyperCore in about a minute.' : 'Sent. It shows in this wallet in about a minute.');
      selected = 'HYPE';
      void refresh();
      await renderAsset();
    });
  } },
  h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
    h('tr', {}, h('th', {}, 'Move'), h('td', { id: 'hype-move-r-amount' }, `${p.amount} HYPE`)),
    h('tr', {}, h('th', {}, 'From'), h('td', {}, p.direction === 'core' ? 'HyperEVM (this wallet)' : 'HyperCore')),
    h('tr', {}, h('th', {}, 'To'), h('td', {}, p.direction === 'core' ? 'HyperCore' : 'HyperEVM (this wallet)')),
    p.direction === 'core' && h('tr', {}, h('th', {}, 'Network fee'), h('td', {}, reviewFee(p.fee, 'HYPE')))))),
  box.el, h('label', { class: 'field' }, h('span', {}, 'Password'), pw), go);
  show('send', subBar('Review move', () => renderHypeMove(p.direction)), h('div', { class: 'scroll' }, form));
  pw.focus();
}
