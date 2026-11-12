// Shared screen pieces: coin list, labels, element helpers, fees and messages. Loaded first.
declare const wallet: any;
declare const jsQR: any;

type Asset = 'BTC' | 'XMR' | 'ETH' | 'TRX' | 'USDT' | 'USDTE' | 'LINK' | 'WLD' | 'SOL' | 'USDTS' | 'POL' | 'USDTP' | 'ARB' | 'ETHA' | 'USDTA' | 'BCH' | 'LTC' | 'DOGE' | 'DASH' | 'FIRO' | 'ZEC' | 'ZANO' | 'ARRR' | 'SCRT' | 'ETHP' | 'UNI' | 'PEPE' | 'AAVE' | 'BNB' | 'USDTB' | 'USDCE' | 'USDCB' | 'USDCS' | 'USDCP' | 'USDCA' | 'SSCRT' | 'SHIB' | 'ORCA' | 'PUMP' | 'ADA';
type Attrs = Record<string, any>;
type Child = Node | string | null | undefined | false;

const ALL_ASSETS: Asset[] = ['XMR', 'BTC', 'ETH', 'USDTE', 'USDCE', 'LINK', 'WLD', 'UNI', 'PEPE', 'AAVE', 'SHIB', 'ZEC', 'SOL', 'USDTS', 'USDCS', 'ORCA', 'PUMP', 'TRX', 'USDT', 'BNB', 'USDTB', 'USDCB', 'POL', 'ETHP', 'USDTP', 'USDCP', 'ARB', 'ETHA', 'USDTA', 'USDCA', 'BCH', 'LTC', 'ADA', 'SCRT', 'SSCRT', 'DOGE', 'DASH', 'FIRO', 'ZANO', 'ARRR'];
/** Tokens shown under the coin of their chain on the home screen, folded until opened. */
const GROUPS: Partial<Record<Asset, Asset[]>> = { ETH: ['USDTE', 'USDCE', 'LINK', 'WLD', 'UNI', 'PEPE', 'AAVE', 'SHIB'], SOL: ['USDTS', 'USDCS', 'ORCA', 'PUMP'], TRX: ['USDT'], BNB: ['USDTB', 'USDCB'], POL: ['ETHP', 'USDTP', 'USDCP'], ARB: ['ETHA', 'USDTA', 'USDCA'], SCRT: ['SSCRT'] };
const IN_GROUP = new Set(Object.values(GROUPS).flat());
const GROUP_OF: Partial<Record<Asset, Asset>> = Object.fromEntries(Object.entries(GROUPS).flatMap(([parent, kids]) => (kids ?? []).map((k) => [k, parent])));
const EVM_ASSETS: Asset[] = ['ETH', 'USDTE', 'USDCE', 'LINK', 'WLD', 'ETHP', 'UNI', 'PEPE', 'AAVE', 'POL', 'USDTP', 'ARB', 'ETHA', 'USDTA', 'BNB', 'USDTB', 'USDCB', 'USDCP', 'USDCA', 'SHIB'];
const SPL_ASSETS: Asset[] = ['USDTS', 'USDCS', 'ORCA', 'PUMP'];
const BSC_ASSETS: Asset[] = ['BNB', 'USDTB', 'USDCB'];
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
  USDCE: { label: 'USDC (Eth)', file: 'coins/usdc.png', note: 'Ethereum network only (ERC-20). ETH is needed for the fee. Don\'t send to addresses on other chains.' },
  USDCB: { label: 'USDC (BNB)', file: 'coins/usdc.png', note: 'BNB Smart Chain (BEP-20) only. BNB is needed for the fee. No free service lists BNB Smart Chain history, so past transfers show on bscscan.com, not here.' },
  USDCS: { label: 'USDC (Sol)', file: 'coins/usdc.png', note: 'Solana (SPL) only. SOL is needed for the fee.' },
  USDCP: { label: 'USDC (Pol)', file: 'coins/usdc.png', note: 'Polygon network only (native USDC, not USDC.e). POL is needed for the fee.' },
  USDCA: { label: 'USDC (Arb)', file: 'coins/usdc.png', note: 'Arbitrum One only (native USDC, not USDC.e). ETH (Arb) is needed for the fee.' },
  SHIB: { label: 'SHIB', file: 'coins/shib.png', note: 'Shiba Inu on Ethereum (ERC-20) only. ETH is needed for the fee.' },
  ORCA: { label: 'ORCA', file: 'coins/orca.png', note: 'Orca on Solana (SPL) only. SOL is needed for the fee.' },
  PUMP: { label: 'PUMP', file: 'coins/pump.png', note: 'pump.fun\'s PUMP on Solana only (a Token-2022 token). SOL is needed for the fee.' },
};
const coinName = (a: Asset): string => COIN[a]?.label ?? a;
/** The unit after an amount. The three USDTs are all just USDT there; the screen around them names the chain. */
/** The same token on another chain: its unit is still the token's own symbol. */
const SAME_TOKEN: Partial<Record<Asset, string>> = {};
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
