declare const wallet: any;
declare const jsQR: any;

type Asset = 'BTC' | 'XMR' | 'ETH' | 'TRX' | 'USDT' | 'USDTE' | 'SOL' | 'USDTS' | 'DOGE' | 'DASH' | 'FIRO' | 'ZEC' | 'ZANO' | 'ARRR';
type Attrs = Record<string, any>;
type Child = Node | string | null | undefined | false;

const ALL_ASSETS: Asset[] = ['XMR', 'BTC', 'ETH', 'ZEC', 'SOL', 'TRX', 'USDTE', 'USDT', 'USDTS', 'DOGE', 'DASH', 'FIRO', 'ZANO', 'ARRR'];
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
  DOGE: { label: 'DOGE', file: 'coins/doge.png', note: 'Dogecoin mainnet only. The fee is paid in DOGE.' },
  FIRO: { label: 'FIRO', file: 'coins/firo.png', note: 'Transparent transactions only. Addresses and amounts are public on the chain.' },
  DASH: { label: 'DASH', file: 'coins/dash.png', note: 'Dash mainnet only. The fee is paid in DASH.' },
  ARRR: { label: 'ARRR', file: 'coins/arrr.png', note: 'Every Pirate Chain transaction is shielded. The fee is paid in ARRR.' },
  ZANO: { label: 'ZANO', file: 'coins/zano.png', note: 'Received coins can be used after 10 confirmations. The fee is a fixed 0.01 ZANO.' },
  ZEC: { label: 'ZEC', file: 'coins/zec.png', note: 'Sent from your shielded balance. The fee is paid in ZEC.' },
  ETH: { label: 'ETH', file: 'coins/eth.png', note: 'The fee for sending USDT (Eth) is also paid in ETH.' },
  USDTE: { label: 'USDT (Eth)', file: 'coins/usdt.png', note: 'Ethereum network only. ETH is needed for the fee. Don\'t send to addresses on other chains.' },
};
const coinName = (a: Asset): string => COIN[a]?.label ?? a;
/** The unit after an amount. The three USDTs are all just USDT there; the screen around them names the chain. */
const unitOf = (a: Asset): string => (a === 'USDTE' || a === 'USDTS' ? 'USDT' : a);

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
  paste: 'M9 4h6v3H9zM9 5.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-3M9 13h6M9 17h4',
};

function coin(asset: Asset): HTMLElement {
  const img = h('img', { class: 'coin', src: COIN[asset].file, alt: '' });
  if (asset !== 'USDT' && asset !== 'USDTE' && asset !== 'USDTS') return img;
  // Same token on two chains: the badge is what tells them apart at a glance.
  return h('span', { class: 'coin-wrap' }, img, h('img', { class: 'coin-badge', src: asset === 'USDT' ? 'coins/trx.png' : asset === 'USDTS' ? 'coins/sol.png' : 'coins/eth.png', alt: '' }));
}

function usdFee(usd: number): string {
  return usd > 0 && usd < 0.01 ? '$0.01 or less' : usdFormat(Math.max(usd, 0));
}

/** Fees read in dollars. Without a price, the coin amount is all there is to show. */
function feeText(f: any): string {
  return typeof f.usd === 'number' ? `about ${usdFee(f.usd)}` : `about ${f.fee} ${f.asset}`;
}

/** On a review screen the exact coin amount stays beside the dollars. */
function reviewFee(fee: string, asset: string): string {
  const price = prices?.[asset]?.usd;
  return typeof price === 'number' ? `about ${usdFee(Number(fee) * price)} (${fee} ${asset})` : `${fee} ${asset}`;
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
  if (network === null) return { total: `Fee about ${usdFee(provider)}`, detail: `Provider ${usdFee(provider)} (${q.cost.percent.toFixed(2)}%), network extra` };
  return { total: `Fee about ${usdFee(provider + network)}`, detail: `Provider ${usdFee(provider)} (${Math.max(q.cost.percent, 0).toFixed(2)}%) + network ${usdFee(network)}` };
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

function welcome(): void {
  const addingBack = h('button', { type: 'button', class: 'ghost', id: 'wallet-add-cancel', hidden: true, onclick: async () => { await wallet.walletCancelAdd(); await boot(); } }, 'Cancel adding a wallet');
  void wallet.walletsList().then((r: any) => { addingBack.hidden = !r.adding; });
  entry(
    entryLogo(),
    h('h2', {}, 'Get started'),
    addingBack,
    h('p', { class: 'lead' }, 'Seeds and keys are stored encrypted on this device only. This is mainnet, with real coins.'),
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

function createStep2(password: string, seeds: { tronMnemonic: string; moneroSeed: string }): void {
  const ok = h('input', { type: 'checkbox', id: 'saved' });
  const go = h('button', { class: 'primary', id: 'next', disabled: true, onclick: () => createStep3(password, seeds) }, 'Continue to backup check');
  ok.addEventListener('change', () => { go.disabled = !ok.checked; });
  entry(
    h('h2', {}, 'Write both seed phrases on paper'),
    h('p', { class: 'lead' }, 'Anyone with these seeds can take all your coins. Don\'t save them in photos, cloud storage or messengers.'),
    seedCard('BTC·ETH·Tron·SOL·DOGE·DASH seed, 12 words', 'For BTC, ETH, TRX, USDT, SOL, DOGE, DASH, FIRO, ZEC, ZANO, ARRR. Restores in BIP39 wallets such as Sparrow, MetaMask, TronLink and Phantom.', seeds.tronMnemonic),
    seedCard('Monero seed, 25 words', 'For XMR. Works with Monero GUI and Cake Wallet.', seeds.moneroSeed),
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
      await wallet.finishCreate(password);
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
      await wallet.finishCreate(password);
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
      await wallet.restore(pw, tron.value, xmr.value, from.value);
      await enterWallet();
    });
  }) }, 'Restore');
  entry(h('h2', {}, 'Restore from seeds'), h('br'), box.el,
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
  return b.ok ? b.total : 'Lookup failed';
}

function usdFormat(n: number): string {
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 6 : 2;
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
    if (homeTab === 'assets') setKids(list, ...ASSETS.map(assetRow));
  }

  show('home',
    h('div', { class: 'top' }, h('div', { class: 'acct' }, walletButton(), torChip), h('div', { class: 'row' })),
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

function assetRow(a: Asset): HTMLElement {
  const p = prices?.[a];
  const status = a === 'XMR' ? moneroStatus() : '';
  const sub: Child = status
    ? (moneroBusy() ? syncLabel() : status)
    : p
      ? h('span', {}, usdFormat(p.usd), p.change !== null && h('span', { class: p.change >= 0 ? 'up' : 'down' }, `${p.change >= 0 ? '+' : ''}${p.change.toFixed(2)}%`))
      : a === 'BTC' ? 'Bitcoin' : a === 'SOL' ? 'Solana' : a === 'DOGE' ? 'Dogecoin' : a === 'DASH' ? 'Dash' : a === 'FIRO' ? 'Firo' : a === 'ZEC' ? 'Zcash' : a === 'ZANO' ? 'Zano' : a === 'ARRR' ? 'Pirate Chain' : a === 'ETH' ? 'Ethereum' : a === 'USDT' || a === 'USDTE' || a === 'USDTS' ? 'Tether' : a === 'TRX' ? 'Tron' : 'Monero';
  const usd = assetUsd(a);
  return h('button', { class: 'asset', id: `asset-${a}`, onclick: () => { selected = a; void renderAsset(); } },
    coin(a),
    h('div', {}, h('div', { class: 'name' }, COIN[a].label), h('div', { class: 'sub' }, sub)),
    h('div', { class: 'right' }, h('div', { class: 'amt' }, balanceText(a)),
      h('div', { class: 'sub' }, hideBalance || usd === null ? '' : usdFormat(usd), overview?.balances?.[a]?.stale && !hideBalance ? ' · recent value' : '')));
}

function bottomNav(on: 'home' | 'settings'): HTMLElement {
  return h('nav', { class: 'nav' },
    h('button', { class: on === 'home' ? 'on' : undefined, id: 'nav-home', onclick: () => { homeTab = 'assets'; renderHome(); } }, icon('home'), 'Home'),
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

function picker(onPick: () => void): HTMLElement {
  const wrap = h('div', { class: 'picker' });
  const menu = h('div', { class: 'menu', hidden: true, id: 'coin-menu' },
    ...ASSETS.map((a) => h('button', { type: 'button', id: `pick-${a}`, onclick: () => { selected = a; onPick(); } }, coin(a), COIN[a].label)));
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
  const m = text.match(/^(?:(bitcoin|btc|solana|sol|dogecoin|doge|dash|firo|zcash|zec|zano|pirate|arrr|ethereum|eth|tron|trx|usdt|monero|xmr)(?::\/\/|:))?([0-9A-Za-z]+)(?:@1)?(?:\?(.*))?$/i);
  if (!m) return null;
  const scheme = (m[1] ?? '').toLowerCase();
  const family = (a: Asset) => (a === 'SOL' ? ['solana', 'sol'] : a === 'USDTS' ? ['solana', 'sol', 'usdt'] : a === 'DOGE' ? ['dogecoin', 'doge'] : a === 'DASH' ? ['dash'] : a === 'FIRO' ? ['firo'] : a === 'ZEC' ? ['zcash', 'zec'] : a === 'ZANO' ? ['zano'] : a === 'ARRR' ? ['pirate', 'arrr'] : a === 'BTC' ? ['bitcoin', 'btc'] : a === 'XMR' ? ['monero', 'xmr'] : a === 'ETH' || a === 'USDTE' ? ['ethereum', 'eth', 'usdt'] : ['tron', 'trx', 'usdt']);
  if (scheme && !family(asset).includes(scheme)) return null;
  // Bech32 QR codes are often in upper case to make them smaller.
  const address = asset === 'BTC' && /^BC1/.test(m[2]) ? m[2].toLowerCase() : m[2];
  const valid = asset === 'BTC' ? /^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(address)
    : asset === 'SOL' || asset === 'USDTS' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
    : asset === 'DOGE' ? /^[DA9][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    : asset === 'FIRO' ? /^[a3][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    : asset === 'DASH' ? /^[X7][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    : asset === 'ARRR' ? /^(zs1[02-9ac-hj-np-z]{75}|pirate1[02-9ac-hj-np-z]{40,})$/.test(address)
    : asset === 'ZANO' ? /^(Zx|iZ|aZ|ai)[1-9A-HJ-NP-Za-km-z]{90,120}$/.test(address)
    : asset === 'ZEC' ? /^(t[13][1-9A-HJ-NP-Za-km-z]{33}|zs1[02-9ac-hj-np-z]{75}|u1[02-9ac-hj-np-z]{100,}|tex1[02-9ac-hj-np-z]{30,})$/.test(address)
    : asset === 'XMR' ? /^[48][1-9A-HJ-NP-Za-km-z]{94}([1-9A-HJ-NP-Za-km-z]{11})?$/.test(address)
      : asset === 'ETH' || asset === 'USDTE' ? /^0x[0-9a-fA-F]{40}$/.test(address)
      : /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  if (!valid) return null;
  // Ethereum links carry value in wei, so the amount is left for the person to type.
  const amount = asset === 'ETH' || asset === 'USDTE' ? '' : new URLSearchParams(m[3] ?? '').get(asset === 'XMR' ? 'tx_amount' : 'amount') ?? '';
  return { address, amount: /^\d+(\.\d+)?$/.test(amount) ? amount : '' };
}

let closeScanner: (() => void) | null = null;

async function openScanner(asset: Asset, onFound: (found: { address: string; amount: string }) => void): Promise<void> {
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
        const found = parseScanned(asset, code.data);
        if (found) { close(); onFound(found); return; }
        status.textContent = `This is not a ${asset === 'XMR' ? 'Monero' : asset === 'SOL' || asset === 'USDTS' ? 'Solana' : asset === 'DOGE' ? 'Dogecoin' : asset === 'DASH' ? 'Dash' : asset === 'FIRO' ? 'Firo' : asset === 'ZEC' ? 'Zcash' : asset === 'ZANO' ? 'Zano' : asset === 'ARRR' ? 'Pirate Chain' : asset === 'BTC' ? 'Bitcoin' : asset === 'ETH' || asset === 'USDTE' ? 'Ethereum' : 'Tron'} address QR. Try another one.`;
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
  const tor = !!(await wallet.getSettings().catch(() => null))?.torEnabled;
  const open = h('button', { class: 'primary', id: 'buy-open', onclick: () => busy(open, 'Opening…', box, async () => {
    await wallet.openBuy(asset);
    status.textContent = 'ChangeNOW opened in your browser. Paste this address there as the receiving address.';
  }) }, 'Buy with ChangeNOW');
  show('send', subBar('Buy', renderHome), h('div', { class: 'scroll' },
    picker(() => void renderBuy()),
    h('div', { class: 'panel' },
      h('span', { class: 'label' }, `Your ${coinName(asset)} receiving address`),
      h('div', { class: 'addr-box' }, addressEl, copy),
      status),
    h('p', { class: 'small muted' }, 'Copy the address, then paste it on ChangeNOW\'s page as the receiving address. Check that the coin and network there match.'),
    h('p', { class: 'small muted' }, `Purchases are made on ChangeNOW's page in your browser, by card or another payment method they offer. ChangeNOW and its payment partners ask for identity checks (KYC), set the fees, and may not offer every coin or country. This wallet adds no fee and sends them nothing.`),
    tor && h('p', { class: 'small muted' }, 'Your browser isn\'t behind Tor, so they can see your IP address.'),
    box.el,
    open));
  try {
    const list = await wallet.addresses();
    // ChangeNOW pays Zcash to transparent addresses only.
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
    : asset === 'DOGE' ? 'Receives DOGE on Dogecoin mainnet only. Once a deposit is seen, a new address appears next time.'
    : asset === 'FIRO' ? 'Receives FIRO on Firo mainnet only. This is a transparent address, so the amount and address are public on the chain. Once a deposit is seen, a new address appears next time.'
    : asset === 'DASH' ? 'Receives DASH on Dash mainnet only. Once a deposit is seen, a new address appears next time.'
    : asset === 'BTC' ? 'A Bitcoin Taproot (bc1p) address. Coins sent from other chains won\'t arrive. Once a deposit is seen, a new address appears next time.'
    : asset === 'ETH' ? 'The same address as USDT (Eth). Receives ETH on Ethereum mainnet only. Coins sent over L2s or other chains won\'t arrive.'
    : asset === 'USDTE' ? 'Receives USDT on the Ethereum network (ERC-20) only. Sending needs ETH at this address for the fee.'
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
  const menu = h('div', { class: 'menu', hidden: true, id: `${id}-menu` }, ...ASSETS.map((a) => h('button', { type: 'button', id: `${id}-${a}`, onclick: () => onPick(a) }, coin(a), COIN[a].label)));
  return h('div', { class: 'coin-select' },
    h('button', { type: 'button', id, class: 'coin-select-btn', 'aria-label': `Choose a coin, currently ${coinName(current)}`, onclick: () => { menu.hidden = !menu.hidden; } }, coin(current), h('span', {}, coinName(current)), icon('down')),
    menu);
}

const PRIVACY_ASSETS: Asset[] = ['BTC', 'ETH', 'USDTE'];

async function renderSwap(from: Asset = selected, to: Asset = selected === 'XMR' ? 'BTC' : 'XMR', keep = '', privacy = false): Promise<void> {
  if (privacy && !(PRIVACY_ASSETS.includes(from) && PRIVACY_ASSETS.includes(to))) privacy = false;
  if (!privacy && from === to) to = from === 'XMR' ? 'BTC' : 'XMR';
  const amount = numbersOnly(h('input', { id: 'swap-amount', class: 'amount-input', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', value: keep }) as HTMLInputElement);
  const receive = h('div', { class: 'swap-receive', id: 'swap-receive' }, '0');
  const receiveNet = h('div', { class: 'swap-net', id: 'swap-net' });
  const info = h('div', { class: 'small muted swap-info', id: 'swap-info' });
  const balance = h('span', { class: 'small muted', id: 'swap-balance' });
  const box = errorBox();
  let chosen: any = null;
  const offers = h('div', { class: 'swap-offers', id: 'swap-offers' });
  const next = h('button', { class: 'primary', id: 'swap-next', disabled: true, onclick: () => busy(next, 'Creating the order…', box, async () => {
    const again = () => void renderSwap(from, to, amount.value, privacy);
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
    }, h('span', {}, q.provider), h('span', { class: 'offer-right' }, q.problem ? 'No quote' : `about ${q.receive} ${coinName(to)}`, q.problem && h('span', { class: 'small muted offer-cost' }, q.problem), !q.problem && netReceive(q, q.network) && h('span', { class: 'offer-net' }, netLine(q, q.network)), !q.problem && h('span', { class: 'offer-cost' }, offerFee(q).total), !q.problem && h('span', { class: 'small muted offer-cost' }, offerFee(q).detail)))),
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
        const list = await wallet.swapQuote(from, to, value);
        if (mine === ticket) paintOffers(list);
      } catch (e) {
        if (mine === ticket) info.textContent = `Could not get quotes. ${errMsg(e)}`;
      }
    }, 600);
  };
  amount.addEventListener('input', refreshQuote);
  const change = (nf: Asset, nt: Asset) => { void renderSwap(nf, nt, amount.value, privacy); };
  const paintBalance = () => {
    const b = overview?.balances?.[from];
    balance.textContent = b?.ok ? `Balance ${b.spendable} ${coinName(from)}` : '';
  };
  const list = h('div', { id: 'swap-list' });
  show('send', subBar('Swap', renderHome), h('div', { class: 'scroll' }, box.el,
    h('div', { class: 'panel' }, h('div', { class: 'swap-head' }, h('span', { class: 'label' }, 'Send'), balance),
      h('div', { class: 'swap-row' }, coinSelect('swap-from', from, (a) => change(a, a === to && !privacy ? from : to)), amount)),
    h('div', { class: 'swap-flip' }, h('button', { type: 'button', class: 'icon-btn', id: 'swap-flip', 'aria-label': 'Swap direction', onclick: () => change(to, from) }, icon('swap'))),
    h('div', { class: 'panel' }, h('span', { class: 'label' }, 'Receive'),
      h('div', { class: 'swap-row' }, coinSelect('swap-to', to, (a) => change(a === from && !privacy ? to : from, a)), receive), receiveNet),
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
  const useTor = h('input', { type: 'checkbox', id: 'set-tor', checked: tor.enabled });
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
    if (useTor.checked && !tor.installed) {
      await wallet.installTor();
      tor.installed = true;
    }
    const relocked = await wallet.updateSettings({ customMoneroNode: node.value, tronApiKey: key.value, autoLockMinutes: Number(auto.value), showPrices: showPrices.checked, torEnabled: useTor.checked });
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
    setKids(seedOut, h('br'), seedCard('BTC·ETH·Tron seed', '', seeds.tronMnemonic), seedCard('Monero seed', '', seeds.moneroSeed),
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
        h('div', { class: 'tor-block' },
          h('h3', {}, 'Tor'), torBox.el, torProgress,
          h('label', { class: 'check' }, useTor, h('span', {}, 'Connect through Tor',
            h('div', { class: 'hint' }, 'Sends node, TronGrid and price connections through Tor to hide your IP. It doesn\'t hide public Tron history, and lookups and sync get slower.'),
            h('div', { class: 'hint' }, tor.updatable === false ? 'If Tor drops, connections stop rather than falling back to the plain internet.' : 'If Tor drops, connections stop rather than falling back to the plain internet. Only the first install uses the plain internet, to download the files.'))),
          updateTor, copyLog),
        h('div', { class: 'row' }, saveBtn, saved),
        h('p', { class: 'hint' }, 'Changing the node, API key or Tor locks the wallet. It applies when reopened.')),
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

async function boot(first = false): Promise<void> {
  const [s] = await Promise.all([wallet.status(), first ? new Promise((r) => setTimeout(r, 900)) : null]);
  if (!s.hasWallet) welcome();
  else if (s.unlocked) await enterWallet();
  else unlockScreen();
}
void boot(true);
