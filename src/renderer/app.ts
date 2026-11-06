declare const wallet: any;
declare const jsQR: any;

type Asset = 'BTC' | 'XMR' | 'ETH' | 'TRX' | 'USDT' | 'USDTE' | 'DCR' | 'DASH' | 'FIRO' | 'ZEC' | 'ZANO' | 'ARRR';
type Attrs = Record<string, any>;
type Child = Node | string | null | undefined | false;

const ALL_ASSETS: Asset[] = ['XMR', 'BTC', 'ETH', 'TRX', 'USDTE', 'USDT', 'DCR', 'DASH', 'FIRO', 'ZEC', 'ZANO', 'ARRR'];
// These need their engines, which aren't in every build or on every phone.
let ASSETS: Asset[] = ALL_ASSETS.filter((a) => a !== 'ZEC' && a !== 'ZANO' && a !== 'ARRR');
let zecInSession = false;
let refreshNote = '아직 응답 없음';
const COIN: Record<Asset, { label: string; file: string; note: string }> = {
  BTC: { label: 'BTC', file: 'coins/btc.png', note: '수수료는 네트워크 상황에 따라 달라지고, 확인 화면에서 볼 수 있어.' },
  TRX: { label: 'TRX', file: 'coins/trx.png', note: 'USDT를 보낼 때 드는 수수료도 TRX로 나가.' },
  USDT: { label: 'USDT (Tron)', file: 'coins/usdt.png', note: 'Tron 네트워크 전용이야. 다른 체인 주소로 보내면 안 돼.' },
  XMR: { label: 'XMR', file: 'coins/xmr.png', note: '' },
  FIRO: { label: 'FIRO', file: 'coins/firo.png', note: '투명 거래만 지원해. 주소와 금액이 체인에 공개돼.' },
  DASH: { label: 'DASH', file: 'coins/dash.png', note: 'Dash 메인넷 전용이야. 수수료는 DASH로 나가.' },
  ARRR: { label: 'ARRR', file: 'coins/arrr.png', note: 'Pirate Chain은 전부 쉴드 거래야. 수수료는 ARRR로 나가.' },
  ZANO: { label: 'ZANO', file: 'coins/zano.png', note: '받은 코인은 10컨펌 뒤에 쓸 수 있어. 수수료는 0.01 ZANO로 고정이야.' },
  ZEC: { label: 'ZEC', file: 'coins/zec.png', note: '쉴드된 잔액에서 나가. 수수료는 ZEC로 나가.' },
  DCR: { label: 'DCR', file: 'coins/dcr.png', note: 'Decred 메인넷 전용이야. 수수료는 DCR로 나가.' },
  ETH: { label: 'ETH', file: 'coins/eth.png', note: 'USDT(Eth)를 보낼 때 드는 수수료도 ETH로 나가.' },
  USDTE: { label: 'USDT (Eth)', file: 'coins/usdt.png', note: 'Ethereum 네트워크 전용이야. 수수료용 ETH가 필요하고, 다른 체인 주소로 보내면 안 돼.' },
};
const coinName = (a: Asset): string => COIN[a]?.label ?? a;

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
  shield: 'M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z',
  paste: 'M9 4h6v3H9zM9 5.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-3M9 13h6M9 17h4',
};

function coin(asset: Asset): HTMLElement {
  const img = h('img', { class: 'coin', src: COIN[asset].file, alt: '' });
  if (asset !== 'USDT' && asset !== 'USDTE') return img;
  // Same token on two chains: the badge is what tells them apart at a glance.
  return h('span', { class: 'coin-wrap' }, img, h('img', { class: 'coin-badge', src: asset === 'USDT' ? 'coins/trx.png' : 'coins/eth.png', alt: '' }));
}

function usdFee(usd: number): string {
  return usd > 0 && usd < 0.01 ? '$0.01 미만' : usdFormat(Math.max(usd, 0));
}

/** Fees read in dollars. Without a price, the coin amount is all there is to show. */
function feeText(f: any): string {
  return typeof f.usd === 'number' ? `약 ${usdFee(f.usd)}` : `약 ${f.fee} ${f.asset}`;
}

/** On a review screen the exact coin amount stays beside the dollars. */
function reviewFee(fee: string, asset: string): string {
  const price = prices?.[asset]?.usd;
  return typeof price === 'number' ? `약 ${usdFee(Number(fee) * price)} (${fee} ${asset})` : `${fee} ${asset}`;
}

/** Filled in after the screen is up, so a slow server never holds it back. */
function feeLine(asset: Asset, id: string, write: (f: any) => string): HTMLElement {
  const el = h('p', { class: 'small muted fee-line', id }, '예상 수수료 확인 중…');
  wallet.feeEstimate(asset).then((f: any) => {
    el.textContent = f ? write(f) : '예상 수수료를 지금은 확인하지 못했어. 전송 전 확인 화면에서 볼 수 있어.';
  }, () => { el.textContent = '예상 수수료를 지금은 확인하지 못했어.'; });
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
  return net.complete ? `수수료 다 빼고 약 ${net.text}` : `약 ${net.text}, 네트워크 수수료 별도`;
}

function offerFee(q: any): { total: string; detail: string } {
  if (!q.cost) return { total: '수수료 확인 불가', detail: '시세 서버에 연결되면 달러로 보여줘.' };
  const provider = Math.max(q.cost.usd, 0);
  const network = typeof q.network?.usd === 'number' ? q.network.usd : null;
  if (network === null) return { total: `수수료 약 ${usdFee(provider)}`, detail: `업체 ${usdFee(provider)} (${q.cost.percent.toFixed(2)}%), 네트워크 별도` };
  return { total: `수수료 약 ${usdFee(provider + network)}`, detail: `업체 ${usdFee(provider)} (${Math.max(q.cost.percent, 0).toFixed(2)}%) + 네트워크 ${usdFee(network)}` };
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
  if (res?.copied) toast('Tor 모드라 브라우저를 열지 않았어. 링크를 복사했으니 Tor Browser에 붙여넣어.');
}

function torLabel(s: any): { text: string; cls: string } {
  if (s.phase === 'ready') return { text: 'Tor 연결됨', cls: 'ok' };
  if (s.phase === 'error') return { text: 'Tor 끊김', cls: 'bad' };
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
    h('button', { class: 'icon-btn', id: 'back', 'aria-label': '뒤로', onclick: back }, icon('back')),
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
  const addingBack = h('button', { type: 'button', class: 'ghost', id: 'wallet-add-cancel', hidden: true, onclick: async () => { await wallet.walletCancelAdd(); await boot(); } }, '지갑 추가 취소');
  void wallet.walletsList().then((r: any) => { addingBack.hidden = !r.adding; });
  entry(
    entryLogo(),
    h('h2', {}, '지갑 시작하기'),
    addingBack,
    h('p', { class: 'lead' }, '시드와 키는 이 기기에만 암호화해서 저장돼. 메인넷 전용이라 실제 코인을 다뤄.'),
    h('button', { class: 'choice', onclick: createStep1 },
      h('strong', {}, '새 지갑 만들기'), h('span', { class: 'muted small' }, '새 시드 문구를 생성해.')),
    h('button', { class: 'choice', onclick: restoreForm },
      h('strong', {}, '시드로 복구하기'), h('span', { class: 'muted small' }, 'BIP39 시드(BTC, ETH, TRX, USDT, DCR, DASH, FIRO, ZEC, ZANO, ARRR)와 Monero 25단어 시드가 모두 필요해.')));
}

function passwordFields() {
  const pw = h('input', { type: 'password', autocomplete: 'new-password', id: 'pw' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', id: 'pw2' });
  return {
    pw, pw2,
    nodes: [
      h('label', { class: 'field' }, h('span', {}, '비밀번호'), pw, h('div', { class: 'hint' }, '10자 이상. 잊어버리면 시드로만 복구할 수 있어.')),
      h('label', { class: 'field' }, h('span', {}, '비밀번호 확인'), pw2),
    ],
    check() {
      if (pw.value.length < 10) throw new Error('비밀번호는 10자 이상이어야 해.');
      if (pw.value !== pw2.value) throw new Error('비밀번호 두 개가 달라.');
      return pw.value as string;
    },
  };
}

function createStep1(): void {
  const f = passwordFields();
  const box = errorBox();
  const next = h('button', { class: 'primary', id: 'next', onclick: () => busy(next, '생성 중…', box, async () => {
    const password = f.check();
    createStep2(password, await wallet.generateSeeds());
  }) }, '시드 생성');
  entry(h('h2', {}, '비밀번호 정하기'), h('p', { class: 'lead' }, '이 PC에서 지갑을 열고 코인을 보낼 때마다 입력해.'), box.el, ...f.nodes,
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', onclick: welcome }, '뒤로'), next));
}

function seedCard(title: string, note: string, phrase: string): HTMLElement {
  return h('div', { class: 'seed' }, h('h3', {}, title), note && h('p', { class: 'muted small' }, note),
    h('ol', { class: 'words' }, ...phrase.split(' ').map((w, i) => h('li', {}, h('i', {}, String(i + 1)), w))));
}

function createStep2(password: string, seeds: { tronMnemonic: string; moneroSeed: string }): void {
  const ok = h('input', { type: 'checkbox', id: 'saved' });
  const go = h('button', { class: 'primary', id: 'next', disabled: true, onclick: () => createStep3(password, seeds) }, '백업 확인으로');
  ok.addEventListener('change', () => { go.disabled = !ok.checked; });
  entry(
    h('h2', {}, '시드 문구 두 개를 종이에 적어'),
    h('p', { class: 'lead' }, '이 시드를 가진 사람은 네 코인을 전부 가져갈 수 있어. 사진, 클라우드, 메신저에 저장하지 마.'),
    seedCard('BTC·ETH·Tron·DCR·DASH 시드 12단어', 'BTC, ETH, TRX, USDT, DCR, DASH, FIRO, ZEC, ZANO, ARRR용. Sparrow, MetaMask, TronLink 등 BIP39 지갑에서 복구할 수 있어.', seeds.tronMnemonic),
    seedCard('Monero 시드 25단어', 'XMR용. Monero GUI, Cake Wallet과 호환돼.', seeds.moneroSeed),
    h('label', { class: 'check' }, ok, h('span', {}, '두 시드를 모두 적어뒀어.')),
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', onclick: welcome }, '취소'), go),
    skipBackupButton(password, seeds, () => createStep2(password, seeds)));
}

function skipBackupButton(password: string, seeds: { tronMnemonic: string; moneroSeed: string }, back: () => void): HTMLElement {
  return h('button', { type: 'button', class: 'ghost skip-backup', id: 'skip-backup', onclick: () => createSkip(password, back) }, '건너뛰기');
}

function createSkip(password: string, back: () => void): void {
  const box = errorBox();
  const go = h('button', { class: 'danger', id: 'skip-confirm', onclick: () => busy(go, '지갑 만드는 중…', box, async () => {
    await withSplash('지갑 만드는 중…', async () => {
      await wallet.finishCreate(password);
      await enterWallet();
    });
  }) }, '건너뛰고 지갑 만들기');
  entry(h('h2', {}, '백업 없이 만들까?'),
    h('div', { class: 'warn', id: 'skip-warning' }, '폰이나 PC가 고장 나거나 앱을 지우면, 시드를 적어두지 않은 코인은 아무도 되찾아줄 수 없어.'),
    h('p', { class: 'lead' }, '나중에 설정에서 비밀번호를 넣고 시드를 볼 수 있어. 코인을 넣기 전에 꼭 적어둬.'), box.el,
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', id: 'skip-back', onclick: back }, '뒤로'), go));
}

function createStep3(password: string, seeds: { tronMnemonic: string; moneroSeed: string }): void {
  const pick = (n: number) => Math.floor(Math.random() * n);
  const qs = [
    { label: 'BTC·ETH·Tron', i: pick(12), words: seeds.tronMnemonic.split(' ') },
    { label: 'Monero', i: pick(25), words: seeds.moneroSeed.split(' ') },
  ].map((q) => ({ ...q, input: h('input', { autocomplete: 'off', spellcheck: 'false', class: 'quiz' }) }));
  const box = errorBox();
  const done = h('button', { class: 'primary', id: 'next', onclick: () => busy(done, '지갑 만드는 중…', box, async () => {
    for (const q of qs) if (q.input.value.trim().toLowerCase() !== q.words[q.i]) throw new Error(`${q.label} ${q.i + 1}번째 단어가 달라.`);
    await withSplash('지갑 만드는 중…', async () => {
      await wallet.finishCreate(password);
      await enterWallet();
    });
  }) }, '지갑 만들기');
  entry(h('h2', {}, '백업 확인'), h('p', { class: 'lead' }, '적어둔 종이를 보고 입력해.'), box.el,
    ...qs.map((q) => h('label', { class: 'field' }, h('span', {}, `${q.label} 시드 ${q.i + 1}번째 단어`), q.input)),
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', onclick: () => createStep2(password, seeds) }, '시드 다시 보기'), done),
    skipBackupButton(password, seeds, () => createStep3(password, seeds)));
}

function restoreForm(): void {
  const f = passwordFields();
  const tron = h('textarea', { spellcheck: 'false', autocomplete: 'off', id: 'tron-seed' });
  const xmr = h('textarea', { spellcheck: 'false', autocomplete: 'off', id: 'xmr-seed' });
  const from = h('input', { placeholder: '2025-06-01 또는 3400000', autocomplete: 'off', id: 'from' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'next', onclick: () => busy(go, '복구 중…', box, async () => {
    const pw = f.check();
    await withSplash('지갑 복구하는 중…', async () => {
      await wallet.restore(pw, tron.value, xmr.value, from.value);
      await enterWallet();
    });
  }) }, '복구하기');
  entry(h('h2', {}, '시드로 복구'), h('br'), box.el,
    h('label', { class: 'field' }, h('span', {}, 'BTC·ETH·Tron 시드 (BIP39)'), tron),
    h('label', { class: 'field' }, h('span', {}, 'Monero 시드 (25단어)'), xmr),
    h('label', { class: 'field' }, h('span', {}, 'Monero 첫 사용 시점'), from,
      h('div', { class: 'hint' }, '날짜 또는 블록 높이. 비워두면 처음부터 스캔해서 몇 시간 걸릴 수 있어. 날짜를 넣으면 Zcash도 그때부터 스캔해.')),
    ...f.nodes,
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', onclick: welcome }, '뒤로'), go));
}

function unlockScreen(): void {
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'unlock', type: 'submit' }, '열기');
  const useBio = async () => {
    box.clear();
    try {
      const password: string = await wallet.biometric.unlock();
      await withSplash('지갑 여는 중…', async () => { await wallet.unlock(password); await enterWallet(); });
    } catch (e) {
      if (errMsg(e) !== 'cancelled') box.show(e);
    }
  };
  const bio = h('button', { type: 'button', class: 'bio-btn', id: 'bio-unlock', hidden: true, onclick: useBio }, '지문으로 열기');
  void wallet.biometric?.enabled().then((on: boolean) => {
    if (!on) return;
    bio.hidden = false;
    void useBio();
  });
  const lead = h('p', { class: 'lead', id: 'unlock-name' }, '비밀번호를 입력해.');
  const others = h('button', { type: 'button', class: 'ghost', id: 'unlock-wallets', onclick: () => void renderWallets(unlockScreen) }, '다른 지갑');
  void wallet.walletsList().then((r: any) => { lead.textContent = `${r.list.find((w: any) => w.id === r.active)?.name ?? '내 지갑'}. 비밀번호를 입력해.`; });
  entry(entryLogo(), h('h2', {}, '지갑 열기'), lead,
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, '여는 중…', box, async () => {
        await withSplash('지갑 여는 중…', async () => {
          await wallet.unlock(pw.value);
          pw.value = '';
          await enterWallet();
        });
      });
    } }, box.el, h('label', { class: 'field' }, h('span', {}, '비밀번호'), pw), go, bio), others);
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
    refreshNote = `${new Date().toLocaleTimeString('ko-KR')} 응답, ZEC ${next.balances.ZEC ? (next.balances.ZEC.ok ? '잔액 있음' : next.balances.ZEC.pending ? '대기' : '실패') : '없음'}`;
    addresses = next.addresses;
    torState = next.tor;
    prices = nextPrices;
    onData?.();
  } catch (e) { refreshNote = `오류: ${(e as Error).message}`; /* usually just locked meanwhile */ }
}


function balanceText(a: Asset): string {
  const b = overview?.balances?.[a];
  if (hideBalance) return '••••';
  if (!b || b.pending) return '…';
  return b.ok ? b.total : '조회 실패';
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
  if (!prices) return { value: '$—', note: '시세를 불러오지 못했어. 아래 수량은 정상이야.' };
  const failed = ASSETS.filter((a) => !overview.balances[a].ok && !overview.balances[a].pending);
  const pending = ASSETS.filter((a) => overview.balances[a].pending);
  if (pending.length && !failed.length) return { value: '$—', note: overview.tor && overview.tor.phase !== 'ready' ? 'Tor 연결 중이야. 연결되면 잔액을 불러와.' : `${pending.map(coinName).join(', ')} 잔액을 불러오는 중이야.` };
  if (failed.length) return { value: '$—', note: `${failed.map(coinName).join(', ')} 조회에 실패했어. 자동으로 다시 시도해.` };
  const sum = ASSETS.reduce((s, a) => s + (assetUsd(a) ?? 0), 0);
  const notes: string[] = [];
  if (!overview.monero.synced) notes.push('XMR 동기화 전이라 실제보다 적을 수 있어.');
  return { value: usdFormat(sum), note: notes.join(' ') };
}

function moneroStatus(): string {
  const m = overview?.monero;
  if (!m) return '';
  if (!m.connected) return m.error ? '노드 연결 안 됨' : '노드 연결 중…';
  if (m.synced) return '';
  const pct = m.percent > 0 ? ` ${Math.min(Math.floor(m.percent * 1000) / 10, 99.9)}%` : '';
  return `거래 동기화중...${pct}`;
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
  const eye = h('button', { class: 'icon-btn', id: 'eye', 'aria-label': '잔액 가리기', onclick: () => {
    hideBalance = !hideBalance;
    try { localStorage.setItem('hideBalance', hideBalance ? '1' : '0'); } catch { /* no storage */ }
    paint();
  } });
  const spin = h('button', { class: 'icon-btn', id: 'refresh', 'aria-label': '새로고침', onclick: () => void refresh() }, icon('refresh'));
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
      h('button', { class: 'action', id: 'go-send', onclick: () => renderSend() }, h('span', { class: 'box' }, icon('send')), '보내기'),
      h('button', { class: 'action', id: 'go-receive', onclick: () => void renderReceive() }, h('span', { class: 'box' }, icon('receive')), '받기'),
      h('button', { class: 'action swap-action', id: 'go-swap', onclick: () => void renderSwap() }, h('span', { class: 'box' }, icon('swap')), '스왑')),
    h('div', { class: 'tabs', role: 'tablist' }, tab('assets', '자산'), tab('history', '내역')),
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
      : a === 'BTC' ? 'Bitcoin' : a === 'DCR' ? 'Decred' : a === 'DASH' ? 'Dash' : a === 'FIRO' ? 'Firo' : a === 'ZEC' ? 'Zcash' : a === 'ZANO' ? 'Zano' : a === 'ARRR' ? 'Pirate Chain' : a === 'ETH' ? 'Ethereum' : a === 'USDT' || a === 'USDTE' ? 'Tether' : a === 'TRX' ? 'Tron' : 'Monero';
  const usd = assetUsd(a);
  return h('button', { class: 'asset', id: `asset-${a}`, onclick: () => { selected = a; void renderAsset(); } },
    coin(a),
    h('div', {}, h('div', { class: 'name' }, COIN[a].label), h('div', { class: 'sub' }, sub)),
    h('div', { class: 'right' }, h('div', { class: 'amt' }, balanceText(a)),
      h('div', { class: 'sub' }, hideBalance || usd === null ? '' : usdFormat(usd), overview?.balances?.[a]?.stale && !hideBalance ? ' · 최근 값' : '')));
}

function bottomNav(on: 'home' | 'settings'): HTMLElement {
  return h('nav', { class: 'nav' },
    h('button', { class: on === 'home' ? 'on' : undefined, id: 'nav-home', onclick: () => { homeTab = 'assets'; renderHome(); } }, icon('home'), '홈'),
    h('button', { class: on === 'settings' ? 'on' : undefined, id: 'open-settings', onclick: () => void renderSettings() }, icon('gear'), '설정'),
    h('button', { id: 'lock', onclick: () => wallet.lock() }, icon('lock'), '잠그기'));
}

const when = (t: number) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function historyRow(i: any): HTMLElement {
  const label = i.direction === 'in' ? '받음' : i.direction === 'out' ? '보냄' : '내 주소로';
  const status = i.status === 'failed' ? ' · 실패' : i.status === 'pending' ? ' · 대기 중'
    : i.asset === 'XMR' && i.confirmations < 10 ? ` · ${i.confirmations}/10 컨펌` : '';
  const sign = i.direction === 'in' ? '+' : i.direction === 'out' ? '-' : '';
  return h('button', { class: `hist-row${i.dust ? ' dust' : ''}`, title: '탐색기에서 열기', onclick: () => void openExplorer(i.asset, i.hash) },
    coin(i.asset),
    h('div', {}, h('div', {}, label + status), h('div', { class: 'small muted' }, when(i.timestamp))),
    h('div', { class: `amt${i.direction === 'in' ? ' in' : ''}` }, `${sign}${i.amount} ${coinName(i.asset)}`));
}

async function renderAllHistory(body: HTMLElement): Promise<void> {
  setKids(body, h('p', { class: 'empty' }, '불러오는 중…'));
  const results = await Promise.allSettled(ASSETS.map((a) => wallet.history(a)));
  if (!body.isConnected) return;
  const failed = ASSETS.filter((_, i) => results[i].status === 'rejected');
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value as any[] : [])).sort((a, b) => b.timestamp - a.timestamp).slice(0, 60);
  setKids(body,
    h('div', { class: 'list', id: 'hist' },
      failed.length > 0 && h('div', { class: 'warn' }, failed.length === 1 && failed[0] === 'XMR' ? 'XMR 내역은 노드에 연결되면 볼 수 있어.' : `${failed.join(', ')} 내역을 불러오지 못했어.`),
      items.length > 0 && h('p', { class: 'small muted' }, '내역의 주소는 복사하지 마. 비슷한 주소로 소액을 보내 복사를 노리는 사기가 흔해. 흐린 항목이 소액 입금이야.'),
      items.length === 0 && failed.length === 0 && h('p', { class: 'empty', id: 'hist-empty' }, '아직 거래가 없어. 받기에서 주소를 확인해.'),
      ...items.map(historyRow)));
}

// ---- asset detail ----

async function renderAsset(): Promise<void> {
  const a = selected;
  const balance = h('div', { class: 'detail-balance', id: 'detail-balance' });
  const usd = h('div', { class: 'detail-usd' });
  const notes = h('div', {});
  const hist = h('div', {}, h('p', { class: 'empty' }, '불러오는 중…'));
  const paint = () => {
    const b = overview?.balances?.[a];
    balance.textContent = `${balanceText(a)} ${hideBalance ? '' : a}`;
    const v = assetUsd(a);
    usd.textContent = !hideBalance && v !== null ? usdFormat(v) : '';
    setKids(notes,
      b && !b.ok && !b.pending && h('div', { class: 'warn' }, `조회에 실패했어. 자동으로 다시 시도해. (${b.error})`),
      b?.stale && h('div', { class: 'warn', id: 'stale-note' }, '서버가 잠시 응답하지 않아서 최근 값을 보여줘. 코인은 그대로고, 자동으로 다시 확인해.'),
      a === 'BTC' && b?.ok && b.total !== b.spendable && h('div', { class: 'warn' }, `바로 쓸 수 있는 금액은 ${b.spendable} BTC야. 나머지는 1컨펌 뒤에 풀려.`),
      a === 'ZEC' && overview?.zec?.syncing && !overview.zec.firstScanDone && h('div', { class: 'sync-banner', id: 'zec-scan' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Zcash 블록을 스캔하는 중이야. 중간에 앱을 닫으면 처음부터 다시 스캔해.'),
      a === 'ARRR' && overview?.arrr?.scanning && h('div', { class: 'sync-banner', id: 'arrr-scan' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), `Pirate Chain 블록을 스캔하는 중이야. ${overview.arrr.percent}%`),
      a === 'ARRR' && b?.ok && b.total !== b.spendable && h('div', { class: 'warn' }, `바로 보낼 수 있는 금액은 ${b.spendable} ARRR야. 나머지는 컨펌 대기 중이야.`),
      a === 'ZANO' && b?.ok && b.total !== b.spendable && h('div', { class: 'warn' }, `바로 보낼 수 있는 금액은 ${b.spendable} ZANO야. 받은 코인은 10컨펌 뒤에 쓸 수 있어.`),
      a === 'ZEC' && b?.ok && b.total !== b.spendable && h('div', { class: 'warn' }, `바로 보낼 수 있는 금액은 ${b.spendable} ZEC야. 나머지는 컨펌 대기 중이거나 쉴드 전이야.`),
      a === 'ZEC' && overview?.zec?.canShield && h('div', { class: 'panel', id: 'zec-shield-panel' },
        h('p', { class: 'small' }, `투명 잔액 ${overview.zec.transparent} ZEC가 있어. 투명 잔액은 체인에 공개되고 바로 보낼 수 없어. 스왑으로 받은 ZEC도 여기로 들어와.`), h('br'),
        h('button', { class: 'primary', id: 'zec-shield', onclick: () => renderZecShield() }, '쉴드하기')),
      a === 'XMR' && b?.ok && b.total !== b.spendable && h('div', { class: 'warn' }, `바로 쓸 수 있는 금액은 ${b.spendable} XMR이야. 나머지는 10컨펌 뒤에 풀려.`),
      a === 'XMR' && overview && !overview.monero.connected && h('div', { class: 'warn', id: 'node-note' }, `노드에 연결되지 않아서 잔액이 최신이 아닐 수 있어. 자동으로 다시 시도해.${overview.monero.error ? ' ' + overview.monero.error : ''}`),
      a === 'XMR' && moneroBusy() && h('div', { class: 'sync-banner' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), moneroStatus()),
      a === 'XMR' && overview?.monero.connected && !overview.monero.synced && h('p', { class: 'small muted' }, '끝나기 전엔 잔액이 실제보다 적게 보일 수 있고 보낼 수 없어.'));
  };
  show('send',
    subBar(COIN[a].label, renderHome),
    h('div', { class: 'scroll' },
      h('div', { class: 'picker' }, h('div', { class: 'picker-btn' }, coin(a))),
      balance, usd, notes,
      h('div', { class: 'actions' },
        h('button', { class: 'action', id: 'detail-send', onclick: () => renderSend() }, h('span', { class: 'box' }, icon('send')), '보내기'),
        h('button', { class: 'action', id: 'detail-receive', onclick: () => void renderReceive() }, h('span', { class: 'box' }, icon('receive')), '받기')),
      a === 'ZEC' && h('button', { class: 'ghost', id: 'zec-rescan', onclick: () => renderZecRescan() }, '과거 내역 다시 스캔'),
      a === 'ARRR' && h('button', { class: 'ghost', id: 'arrr-rescan', onclick: () => renderZecRescan('ARRR') }, '과거 내역 다시 스캔'),
      hist));
  onData = paint;
  paint();
  try {
    const items: any[] = await wallet.history(a);
    if (!hist.isConnected) return;
    setKids(hist, items.length ? h('div', { id: 'hist' }, ...items.map(historyRow)) : h('p', { class: 'empty', id: 'hist-empty' }, `아직 ${coinName(a)} 거래가 없어.`));
  } catch (e) {
    if (hist.isConnected) setKids(hist, h('p', { class: 'empty' }, `내역을 불러오지 못했어. ${errMsg(e)}`));
  }
}

// ---- Zcash ----

function renderZecShield(): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-shield', type: 'submit' }, '쉴드하기');
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, '증명 만드는 중… 몇 분 걸릴 수 있어', box, async () => {
      await wallet.zecShield(pw.value);
      pw.value = '';
      toast('쉴드 거래를 보냈어. 컨펌되면 쉴드 잔액에 들어와.');
      await refresh();
      void renderAsset();
    });
  } },
  box.el,
  h('p', { class: 'small muted' }, `투명 잔액 ${overview?.zec?.transparent ?? ''} ZEC 전부를 내 쉴드 주소로 옮겨. 네트워크 수수료가 ZEC로 조금 나가. 입금 직후엔 컨펌을 기다려야 할 수 있어.`),
  h('br'),
  h('label', { class: 'field' }, h('span', {}, '비밀번호'), pw),
  go);
  show('send', subBar('쉴드하기', () => void renderAsset()), h('div', { class: 'scroll' }, form));
  pw.focus();
}

function renderZecRescan(coin: 'ZEC' | 'ARRR' = 'ZEC'): void {
  const date = h('input', { id: 'zec-date', placeholder: '2025-06-01', autocomplete: 'off' });
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-rescan', type: 'submit' }, '다시 스캔');
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, '준비 중…', box, async () => {
      await (coin === 'ARRR' ? wallet.arrrRescan(date.value, pw.value) : wallet.zecRescan(date.value, pw.value));
      pw.value = '';
      await refresh();
      void renderAsset();
    });
  } },
  box.el,
  h('p', { class: 'small muted' }, `시드로 복구한 지갑은 지금부터의 거래만 보여. 예전에 받은 ${coin}가 있으면 그 시기부터 다시 스캔해. 날짜가 멀수록 오래 걸리고, 몇 달 전이면 몇 시간까지 걸릴 수 있어. 다른 코인은 그동안에도 쓸 수 있어.`),
  h('br'),
  h('label', { class: 'field' }, h('span', {}, `처음 ${coin}를 받은 날짜`), date),
  h('label', { class: 'field' }, h('span', {}, '비밀번호'), pw),
  go);
  show('send', subBar('과거 내역 다시 스캔', () => void renderAsset()), h('div', { class: 'scroll' }, form));
  date.focus();
}

// ---- coin picker ----

function picker(onPick: () => void): HTMLElement {
  const wrap = h('div', { class: 'picker' });
  const menu = h('div', { class: 'menu', hidden: true, id: 'coin-menu' },
    ...ASSETS.map((a) => h('button', { type: 'button', id: `pick-${a}`, onclick: () => { selected = a; onPick(); } }, coin(a), COIN[a].label)));
  const btn = h('button', { type: 'button', class: 'picker-btn', id: 'coin-picker', 'aria-haspopup': 'true', 'aria-label': `코인 선택, 현재 ${selected}`, onclick: () => { menu.hidden = !menu.hidden; } },
    coin(selected), h('span', { class: 'picker-label' }, COIN[selected].label, icon('down')));
  wrap.append(btn, menu);
  return wrap;
}

// ---- send ----

function renderSend(keep?: { to: string; amount: string }): void {
  const asset = selected;
  const to = h('input', { id: 'to', spellcheck: 'false', autocomplete: 'off', class: 'mono', placeholder: '주소 입력, 붙여넣기, QR 스캔', value: keep?.to ?? '' });
  const amount = h('input', { id: 'amount', class: 'amount-input', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', value: keep?.amount ?? '' });
  const usd = h('div', { class: 'usd', id: 'usd-preview' });
  const box = errorBox();
  const next = h('button', { class: 'primary', id: 'review', type: 'submit' }, '다음');
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
    busy(next, asset === 'XMR' ? '거래 만드는 중…' : '수수료 계산 중…', box, async () => {
      const preview = await wallet.prepareSend(asset, to.value, amount.value);
      renderReview(preview, { to: to.value, amount: amount.value });
    });
  } },
  box.el,
  h('div', { class: 'panel' }, h('label', { class: 'label', for: 'to' }, '받는 주소'),
    h('div', { class: 'input-wrap' }, to, h('button', { type: 'button', class: 'icon-btn', id: 'paste', 'aria-label': '붙여넣기', title: '붙여넣기', onclick: async () => { to.value = await wallet.paste(); update(); } }, icon('paste')),
      h('button', { type: 'button', class: 'icon-btn', id: 'scan', 'aria-label': 'QR 코드 스캔', title: 'QR 코드 스캔', onclick: () => void openScanner(asset, (found) => {
        to.value = found.address;
        if (found.amount && !amount.value.trim()) amount.value = found.amount;
        update();
      }) }, icon('scan')))),
  h('div', { class: 'panel' }, h('label', { class: 'label', for: 'amount' }, '금액'),
    h('div', { class: 'input-wrap' }, amount, h('span', { class: 'unit' }, asset),
      h('button', { type: 'button', class: 'max', id: 'max', onclick: () => { amount.value = 'max'; update(); } }, '최대'))),
  usd,
  feeLine(asset, 'send-fee', (f) => `예상 수수료: ${feeText(f)}. 금액과 받는 주소에 따라 달라지고, 다음 화면에서 정확한 값을 보여줘.`),
  COIN[asset].note && h('p', { class: 'small muted' }, COIN[asset].note),
  h('br'),
  next);
  show('send', subBar('보내기', renderHome), h('div', { class: 'scroll' }, picker(() => renderSend({ to: to.value, amount: '' })), form));
  onData = update;
  update();
}

// ---- QR scan ----

/** Reads an address out of a QR code. Accepts a bare address or a wallet link such as monero:4...?tx_amount=1. */
function parseScanned(asset: Asset, raw: string): { address: string; amount: string } | null {
  const text = raw.trim();
  const m = text.match(/^(?:(bitcoin|btc|decred|dcr|dash|firo|zcash|zec|zano|pirate|arrr|ethereum|eth|tron|trx|usdt|monero|xmr)(?::\/\/|:))?([0-9A-Za-z]+)(?:@1)?(?:\?(.*))?$/i);
  if (!m) return null;
  const scheme = (m[1] ?? '').toLowerCase();
  const family = (a: Asset) => (a === 'DCR' ? ['decred', 'dcr'] : a === 'DASH' ? ['dash'] : a === 'FIRO' ? ['firo'] : a === 'ZEC' ? ['zcash', 'zec'] : a === 'ZANO' ? ['zano'] : a === 'ARRR' ? ['pirate', 'arrr'] : a === 'BTC' ? ['bitcoin', 'btc'] : a === 'XMR' ? ['monero', 'xmr'] : a === 'ETH' || a === 'USDTE' ? ['ethereum', 'eth', 'usdt'] : ['tron', 'trx', 'usdt']);
  if (scheme && !family(asset).includes(scheme)) return null;
  // Bech32 QR codes are often in upper case to make them smaller.
  const address = asset === 'BTC' && /^BC1/.test(m[2]) ? m[2].toLowerCase() : m[2];
  const valid = asset === 'BTC' ? /^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(address)
    : asset === 'DCR' ? /^Ds[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
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
  const video = h('video', { playsinline: 'true', muted: 'true', autoplay: 'true', 'aria-label': '카메라 화면' });
  const status = h('p', { class: 'scan-status', id: 'scan-status', role: 'status' }, '카메라를 켜는 중…');
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
  const el = h('div', { class: 'scanner', id: 'scanner', role: 'dialog', 'aria-label': 'QR 코드 스캔' },
    video, h('div', { class: 'scan-frame', 'aria-hidden': 'true' }), status,
    h('button', { class: 'icon-btn scan-close', id: 'scan-close', 'aria-label': '닫기', onclick: close }, icon('close')));
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
    status.textContent = name === 'NotFoundError' ? '카메라를 찾지 못했어. 주소를 붙여넣어줘.'
      : name === 'NotAllowedError' || errMsg(e) === 'camera-denied' ? '카메라 권한이 없어. 기기 설정에서 허용하거나 주소를 붙여넣어줘.'
        : '카메라를 켜지 못했어. 주소를 붙여넣어줘.';
    return;
  }
  status.textContent = 'QR 코드를 네모 안에 맞춰줘.';

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
        status.textContent = `${asset === 'XMR' ? 'Monero' : asset === 'DCR' ? 'Decred' : asset === 'DASH' ? 'Dash' : asset === 'FIRO' ? 'Firo' : asset === 'ZEC' ? 'Zcash' : asset === 'ZANO' ? 'Zano' : asset === 'ARRR' ? 'Pirate Chain' : asset === 'BTC' ? 'Bitcoin' : asset === 'ETH' || asset === 'USDTE' ? 'Ethereum' : 'Tron'} 주소 QR이 아니야. 다른 QR을 비춰줘.`;
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
  const send = h('button', { class: 'primary', id: 'confirm-send', type: 'submit' }, `${p.amount} ${coinName(p.asset)} 전송`);
  const back = () => { void wallet.cancelSend(p.id); renderSend(keep); };
  const price = prices?.[p.asset]?.usd;
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(send, '전송 중…', box, async () => {
      const res = await wallet.confirmSend(p.id, pw.value);
      pw.value = '';
      renderSent(p, res.hashes);
      void refresh();
    });
  } },
  h('p', { class: 'small muted' }, '블록체인 전송은 되돌릴 수 없어. 주소의 앞, 가운데, 끝을 원본과 대조해.'),
  h('br'),
  box.el,
  ...p.warnings.map((w: string) => h('div', { class: 'warn' }, w)),
  h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
    h('tr', {}, h('th', {}, '금액'), h('td', {},
      h('div', { class: 'big-amount', id: 'review-amount' }, `${p.amount} ${coinName(p.asset)}`),
      typeof price === 'number' && h('div', { class: 'small muted' }, `≈ ${usdFormat(Number(p.amount) * price)}`))),
    h('tr', {}, h('th', {}, '받는 주소'), h('td', {}, addressCheck(p.to))),
    h('tr', {}, h('th', {}, p.feeIsEstimate ? '예상 수수료' : '수수료'), h('td', { id: 'review-fee' }, reviewFee(p.fee, p.feeAsset)))))),
  h('label', { class: 'field' }, h('span', {}, '비밀번호'), pw),
  send);
  show('send', subBar('내용 확인', back), h('div', { class: 'scroll' }, form));
  pw.focus();
}

function renderSent(p: any, hashes: string[]): void {
  show('receive', subBar('전송 완료', renderHome), h('div', { class: 'scroll' },
    h('div', { class: 'picker' }, h('div', { class: 'picker-btn' }, coin(p.asset))),
    h('h2', { id: 'sent' }, `${p.amount} ${coinName(p.asset)} 전송했어`),
    h('p', { class: 'muted' }, '네트워크에 올라갔어. 블록에 포함되면 내역에 확정으로 표시돼.'),
    h('br'),
    ...hashes.map((hash) => h('div', { class: 'panel' },
      h('span', { class: 'label' }, '거래 해시'),
      h('div', { class: 'mono', id: 'sent-hash' }, hash),
      h('br'),
      h('div', { class: 'row' },
        h('button', { onclick: () => wallet.copy(hash) }, '복사'),
        h('button', { id: 'open-explorer', onclick: () => void openExplorer(p.asset, hash) }, '탐색기에서 보기')))),
    h('button', { class: 'primary', id: 'send-again', onclick: () => renderSend() }, '새로 보내기')));
}

wallet.on('tron-tx', (t: { txid: string; status: string }) => {
  if (t.status === 'failed') {
    const el = document.getElementById('sent');
    const msg = `거래가 실패했어 (${t.txid.slice(0, 10)}…). 수수료가 부족했을 수 있어. 탐색기에서 확인해.`;
    if (el) { el.textContent = '전송 실패'; el.parentElement?.insertBefore(h('div', { class: 'error' }, msg), el.nextSibling); }
  }
  void refresh();
});

// ---- receive ----

async function renderReceive(current?: string): Promise<void> {
  const asset = selected;
  const qrFrame = h('div', { class: 'qr-frame' });
  const addressEl = h('div', { class: 'mono', id: 'my-address' }, '불러오는 중…');
  const status = h('span', { class: 'status', role: 'status' });
  const box = errorBox();
  const extra = h('div', {});
  let address = current ?? addresses?.[asset] ?? '';
  const copy = h('button', { class: 'icon-btn', id: 'copy', disabled: true, 'aria-label': '주소 복사', title: '주소 복사', onclick: async () => {
    await wallet.copy(address); status.textContent = '복사했어. 60초 뒤 클립보드에서 지워져.';
  } }, icon('copy'));
  const note = asset === 'ARRR' ? 'Pirate Chain 메인넷 ARRR만 받아. 금액과 주소는 체인에 드러나지 않아. 받은 코인은 컨펌 뒤에 쓸 수 있어.'
    : asset === 'ZANO' ? 'Zano 메인넷 ZANO만 받아. 금액과 주소는 체인에 드러나지 않아. 받은 코인은 10컨펌 뒤에 쓸 수 있어.'
    : asset === 'ZEC' ? (address.startsWith('t') ? '투명 주소야. 받는 금액과 주소가 체인에 공개돼. 받은 뒤 쉴드해야 보낼 수 있어.' : '쉴드 주소야. 금액과 주소가 체인에 드러나지 않아. 받은 ZEC는 몇 컨펌 뒤에 쓸 수 있어. 업체가 이 주소를 못 받으면 투명 주소를 써.')
    : asset === 'FIRO' ? 'Firo 메인넷 FIRO만 받을 수 있어. 투명 주소라 금액과 주소가 체인에 공개돼. 입금이 확인되면 다음 받을 때는 새 주소가 나와.'
    : asset === 'DASH' ? 'Dash 메인넷 DASH만 받을 수 있어. 입금이 확인되면 다음 받을 때는 새 주소가 나와.'
    : asset === 'DCR' ? 'Decred 메인넷 DCR만 받을 수 있어. 입금이 확인되면 다음 받을 때는 새 주소가 나와.'
    : asset === 'BTC' ? 'Bitcoin 탭루트(bc1p) 주소야. 다른 체인으로 보내면 받을 수 없어. 입금이 확인되면 다음 받을 때는 새 주소가 나와.'
    : asset === 'ETH' ? 'USDT(Eth)와 같은 주소야. Ethereum 메인넷 ETH만 받을 수 있어. L2나 다른 체인으로 보내면 받을 수 없어.'
    : asset === 'USDTE' ? 'Ethereum 네트워크(ERC-20) USDT만 받을 수 있어. 보내려면 이 주소에 수수료용 ETH가 있어야 해.'
    : asset === 'USDT' ? 'Tron 네트워크(TRC-20) USDT만 받을 수 있어. 다른 체인으로 보내면 받을 수 없어.'
    : asset === 'TRX' ? 'USDT와 같은 주소야. USDT를 보내려면 이 주소에 수수료용 TRX가 있어야 해.'
      : '받은 XMR은 10컨펌(약 20분) 뒤에 쓸 수 있어. 받을 곳마다 새 주소를 쓰면 프라이버시에 좋아.';
  show('receive', subBar('받기', renderHome), h('div', { class: 'scroll' },
    picker(() => void renderReceive()),
    qrFrame,
    feeLine(asset, 'receive-fee', (f) => `받을 때 내가 내는 수수료는 없어. 보내는 쪽이 네트워크 수수료를 내. 나중에 이 코인을 보낼 땐 ${feeText(f)} 들어.`),
    h('div', { class: 'panel' },
      h('span', { class: 'label' }, `${coinName(asset)} 주소`),
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
    if (!address) throw new Error(asset === 'ZEC' ? 'Zcash 지갑을 준비하는 중이야. 진행 상태는 설정의 Zcash 엔진에서 볼 수 있어.' : '주소를 불러오지 못했어. 다시 열어봐.');
    const qr = await wallet.qr(address);
    if (!addressEl.isConnected) return;
    setKids(qrFrame, h('img', { src: qr, alt: `${coinName(asset)} 받는 주소 QR 코드` }));
    addressEl.textContent = address;
    copy.disabled = false;
  } catch (e) {
    box.show(e);
    return;
  }

  if (asset === 'ZEC') {
    const list = await wallet.addresses();
    const shieldedOn = address === list.ZEC;
    setKids(extra, h('button', { class: 'ghost', id: 'zec-address-kind', onclick: () => void renderReceive(shieldedOn ? list.ZEC_T : list.ZEC) }, shieldedOn ? '투명 주소 보기' : '쉴드 주소 보기'));
    return;
  }
  if (asset !== 'XMR') return;
  const add = h('button', { class: 'ghost', id: 'new-sub', onclick: () => busy(add, '만드는 중… 동기화 중엔 오래 걸릴 수 있어', box, async () => { await renderReceive(await wallet.newSubaddress()); }) }, '새 주소 만들기');
  setKids(extra, add);
  try {
    const list: { index: number; address: string }[] = await wallet.moneroAddresses();
    if (!extra.isConnected || list.length < 2) return;
    setKids(extra, add, h('div', { class: 'sub-list' }, ...list.map((s) => h('button', { class: `mono${s.address === address ? ' on' : ''}`, onclick: () => void renderReceive(s.address) },
      `${s.index === 0 ? '기본' : '#' + s.index}  ${s.address.slice(0, 14)}…${s.address.slice(-10)}`))));
  } catch { /* the main address is already on screen */ }
}

// ---- swap ----

const SWAP_STATUS: Record<string, string> = {
  hold: '업체 심사로 보류 중', verifying: '업체 심사 중', new: '입금 대기 중', waiting: '입금 대기 중', confirming: '입금 확인 중', finished: '완료', failed: '실패', expired: '기한 만료', halted: '업체 심사로 보류 중', 'paid partially': '일부만 입금됨',
  wait: '입금 대기 중', confirmation: '입금 확인 중', confirmed: '입금 확인됨', exchanging: '교환 중', sending: '보내는 중',
  success: '완료', overdue: '기한 만료', refund: '환불 중', refunded: '환불 완료', unknown: '확인 중',
};

function coinSelect(id: string, current: Asset, onPick: (a: Asset) => void): HTMLElement {
  const menu = h('div', { class: 'menu', hidden: true, id: `${id}-menu` }, ...ASSETS.map((a) => h('button', { type: 'button', id: `${id}-${a}`, onclick: () => onPick(a) }, coin(a), COIN[a].label)));
  return h('div', { class: 'coin-select' },
    h('button', { type: 'button', id, class: 'coin-select-btn', 'aria-label': `코인 선택, 현재 ${coinName(current)}`, onclick: () => { menu.hidden = !menu.hidden; } }, coin(current), h('span', {}, coinName(current)), icon('down')),
    menu);
}

const PRIVACY_ASSETS: Asset[] = ['BTC', 'ETH', 'USDTE'];

async function renderSwap(from: Asset = selected, to: Asset = selected === 'XMR' ? 'BTC' : 'XMR', keep = '', privacy = false): Promise<void> {
  if (privacy && !(PRIVACY_ASSETS.includes(from) && PRIVACY_ASSETS.includes(to))) privacy = false;
  if (!privacy && from === to) to = from === 'XMR' ? 'BTC' : 'XMR';
  const amount = h('input', { id: 'swap-amount', class: 'amount-input', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', value: keep });
  const receive = h('div', { class: 'swap-receive', id: 'swap-receive' }, '0');
  const receiveNet = h('div', { class: 'swap-net', id: 'swap-net' });
  const info = h('div', { class: 'small muted swap-info', id: 'swap-info' });
  const balance = h('span', { class: 'small muted', id: 'swap-balance' });
  const box = errorBox();
  let chosen: any = null;
  const offers = h('div', { class: 'swap-offers', id: 'swap-offers' });
  const next = h('button', { class: 'primary', id: 'swap-next', disabled: true, onclick: () => busy(next, '주문 만드는 중…', box, async () => {
    const again = () => void renderSwap(from, to, amount.value, privacy);
    renderSwapReview(privacy
      ? await wallet.privacyPrepare(from, to, amount.value, chosen.providerId, dest.value)
      : await wallet.swapPrepare(from, to, amount.value, chosen.providerId, dest.value), again);
  }) }, '다음');
  const dest = h('input', { id: 'swap-dest', spellcheck: 'false', autocomplete: 'off', placeholder: privacy ? '최종으로 받을 주소' : '비우면 내 지갑으로 받아' });
  const privacyToggle = h('input', { type: 'checkbox', id: 'swap-privacy', checked: privacy, onchange: () => {
    void renderSwap(from, to, amount.value, !privacy);
  } });
  const paintOffers = (list: any[]) => {
    const good = list.filter((q) => !q.problem);
    chosen = good.find((q) => q.providerId === chosen?.providerId) ?? good[0] ?? null;
    next.disabled = !chosen;
    receive.textContent = chosen ? `약 ${chosen.receive}` : '0';
    receiveNet.textContent = chosen ? netLine(chosen, chosen.network) : '';
    info.textContent = chosen ? `1 ${coinName(from)} ≈ ${chosen.rate} ${coinName(to)}. ${chosen.provider}에서 처리해.` : (list[0]?.problem ?? '');
    const network = list[0]?.network;
    setKids(offers, h('span', { class: 'label' }, list.length > 1 ? '업체 비교' : '예상 비용'), ...list.map((q) => h('button', {
      type: 'button', class: `swap-offer${q === chosen ? ' on' : ''}`, id: `offer-${q.providerId}`, disabled: Boolean(q.problem),
      onclick: () => { chosen = q; paintOffers(list); },
    }, h('span', {}, q.provider), h('span', { class: 'offer-right' }, q.problem ? '견적 없음' : `약 ${q.receive} ${coinName(to)}`, !q.problem && netReceive(q, q.network) && h('span', { class: 'offer-net' }, netLine(q, q.network)), !q.problem && h('span', { class: 'offer-cost' }, offerFee(q).total), !q.problem && h('span', { class: 'small muted offer-cost' }, offerFee(q).detail)))),
    h('p', { class: 'small muted', id: 'swap-network-fee' }, `업체 수수료는 환율에 포함돼 있어서, 시세와 받는 금액의 차이로 계산한 추정치야. 네트워크 수수료는 입금할 때 지갑에서 따로 나가.${network && typeof network.usd !== 'number' ? ` 약 ${network.fee} ${network.asset}이야.` : ''}`));
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
    info.textContent = '견적 받는 중…';
    timer = window.setTimeout(async () => {
      try {
        if (privacy) {
          const q = await wallet.privacyQuote(from, to, value);
          if (mine !== ticket) return;
          chosen = q.first && q.second && !q.problem ? q.first : null;
          next.disabled = !chosen;
          receive.textContent = chosen ? `약 ${q.second.receive}` : '0';
          receiveNet.textContent = chosen ? netLine(q.second, q.first.network, q.second.network) : '';
          info.textContent = chosen
            ? `1단계 ${q.first.provider}: 약 ${q.first.receive} XMR, ${offerFee(q.first).total}. 2단계 ${q.second.provider}: ${offerFee(q.second).total}.${q.sameProvider ? ' 업체가 하나뿐이라 그 업체는 양쪽을 다 볼 수 있어.' : ''}`
            : (q.problem ?? '');
          return;
        }
        const list = await wallet.swapQuote(from, to, value);
        if (mine === ticket) paintOffers(list);
      } catch (e) {
        if (mine === ticket) info.textContent = `견적을 받지 못했어. ${errMsg(e)}`;
      }
    }, 600);
  };
  amount.addEventListener('input', refreshQuote);
  const change = (nf: Asset, nt: Asset) => { void renderSwap(nf, nt, amount.value, privacy); };
  const paintBalance = () => {
    const b = overview?.balances?.[from];
    balance.textContent = b?.ok ? `잔액 ${b.spendable} ${coinName(from)}` : '';
  };
  const list = h('div', { id: 'swap-list' });
  show('send', subBar('스왑', renderHome), h('div', { class: 'scroll' }, box.el,
    h('div', { class: 'panel' }, h('div', { class: 'swap-head' }, h('span', { class: 'label' }, '보내기'), balance),
      h('div', { class: 'swap-row' }, coinSelect('swap-from', from, (a) => change(a, a === to && !privacy ? from : to)), amount)),
    h('div', { class: 'swap-flip' }, h('button', { type: 'button', class: 'icon-btn', id: 'swap-flip', 'aria-label': '방향 바꾸기', onclick: () => change(to, from) }, icon('swap'))),
    h('div', { class: 'panel' }, h('span', { class: 'label' }, '받기'),
      h('div', { class: 'swap-row' }, coinSelect('swap-to', to, (a) => change(a === from && !privacy ? to : from, a)), receive), receiveNet),
    h('div', { class: 'panel' }, h('div', { class: 'swap-head' }, h('span', { class: 'label' }, '받을 주소'),
      h('button', { type: 'button', class: 'icon-btn', id: 'swap-scan', 'aria-label': 'QR 코드 스캔', title: 'QR 코드 스캔', onclick: () => void openScanner(to, (f) => { dest.value = f.address; }) }, icon('scan'))), dest),
    to === 'ZEC' && h('p', { class: 'small muted', id: 'zec-swap-note' }, '업체는 투명 주소로 보내. 받은 뒤 ZEC 화면에서 쉴드해야 프라이빗해지고 보낼 수 있어.'),
    PRIVACY_ASSETS.includes(from) && PRIVACY_ASSETS.includes(to) && h('label', { class: 'swap-privacy' }, privacyToggle,
      h('span', {}, h('strong', {}, '프라이버시 스왑'), h('span', { class: 'small muted' }, 'XMR을 거쳐 두 번에 나눠 보내. XMR 잠금 때문에 최소 20분 넘게 걸리고, 2단계는 앱에서 다시 승인해야 해.'))),
    info, h('br'), offers, next, h('br'),
    h('button', { type: 'button', class: 'primary', id: 'go-tornado', onclick: () => void renderTornado() }, 'Tornado로 ETH 보내기'),
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
    active.length > 0 && h('h3', {}, '진행 중인 프라이버시 스왑'),
    ...active.map((p) => h('button', { class: 'hist-row swap-history', id: `privacy-${p.id}`, onclick: () => renderPrivacyStatus(p) }, coin(p.from),
      h('div', {}, h('div', {}, `${coinName(p.from)} → XMR → ${coinName(p.to)}`), h('div', { class: 'small muted' }, PRIVACY_STAGE[p.stage])),
      h('div', { class: 'amt' }, `${p.amount} ${coinName(p.from)}`))),
    records.length > 0 && h('h3', {}, '최근 스왑'), ...records.slice(0, 20).map(swapRow));
}

function renderSwapReview(p: any, backTo: () => void): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-swap', type: 'submit' }, `${p.amount} ${coinName(p.asset)} 스왑`);
  const s = p.swap;
  const back = () => { void wallet.cancelSend(p.id); backTo(); };
  show('send', subBar('스왑 확인', back), h('div', { class: 'scroll' },
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, '전송 중…', box, async () => {
        const res = await wallet.swapConfirm(p.id, pw.value);
        pw.value = '';
        if (res.privacy) renderPrivacyStatus(res.privacy); else renderSwapStatus(res.record);
        void refresh();
      });
    } },
    box.el,
    ...p.warnings.map((w: string) => h('div', { class: 'warn' }, w)),
    s.external && h('div', { class: 'warn', id: 'review-external' }, '내 지갑이 아닌 주소로 받아. 주소가 틀리면 되찾을 수 없으니 한 글자씩 확인해.'),
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, '보내는 금액'), h('td', {}, h('div', { class: 'big-amount', id: 'review-amount' }, `${p.amount} ${coinName(p.asset)}`))),
      h('tr', {}, h('th', {}, '받는 금액'), h('td', {}, h('div', { class: 'big-amount', id: 'review-receive' }, `${s.approximate ? '약 ' : ''}${s.receive} ${s.to}`), h('div', { class: 'small muted' }, `1 ${s.from} ≈ ${s.rate} ${s.to}`))),
      h('tr', {}, h('th', {}, p.feeIsEstimate ? '예상 수수료' : '네트워크 수수료'), h('td', { id: 'review-fee' }, reviewFee(p.fee, p.feeAsset))),
      h('tr', {}, h('th', {}, '입금 주소'), h('td', {}, addressCheck(p.to))),
      h('tr', {}, h('th', {}, s.external ? '받을 주소' : s.privacy?.leg === 'first' ? '중간 XMR 주소' : '내 받는 주소'), h('td', {}, h('div', { class: 'addr-check', id: 'review-receive-address' }, s.receiveAddress))),
      s.privacy?.leg === 'first' && h('tr', {}, h('th', {}, '최종 받을 주소'), h('td', {}, h('div', { class: 'addr-check', id: 'review-final-address' }, s.privacy.destination))),
      h('tr', {}, h('th', {}, '업체'), h('td', {}, `${s.provider}, 주문 ${s.id}`))))),
    h('p', { class: 'small muted' }, `스왑은 ${s.provider} 외부 업체가 처리해. 보내는 동안은 업체가 코인을 맡고 있어서, 입금 후에는 취소할 수 없고 업체가 심사로 보류할 수도 있어.${s.approximate ? ' 변동 환율이라 받는 양은 입금 시점에 조금 달라질 수 있어.' : ''} 큰 금액은 먼저 소액으로 시험해.`),
    h('br'),
    h('label', { class: 'field' }, h('span', {}, '비밀번호'), pw),
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
    out.textContent = r.hashOut ? `받은 거래: ${r.hashOut}` : '';
  };
  show('receive', subBar('스왑 상태', () => void renderSwap()), h('div', { class: 'scroll' },
    h('div', { class: 'swap-pair' }, coin(record.from), icon('swap'), coin(record.to)),
    status, h('br'), box.el,
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, '보낸 금액'), h('td', {}, `${record.amount} ${coinName(record.from)}`)),
      h('tr', {}, h('th', {}, '받을 금액'), h('td', {}, `${record.approximate ? '약 ' : ''}${record.receive} ${coinName(record.to)}`)),
      record.withdrawalAddress && h('tr', {}, h('th', {}, '받을 주소'), h('td', { class: 'mono small' }, record.withdrawalAddress)),
      record.provider && h('tr', {}, h('th', {}, '업체'), h('td', {}, record.provider)),
      h('tr', {}, h('th', {}, '주문 번호'), h('td', { class: 'mono', id: 'swap-id' }, record.id))))),
    out,
    h('p', { class: 'small muted' }, '문제가 생기면 업체 고객센터에 주문 번호를 알려줘. 입금 확인과 교환까지 XMR은 특히 시간이 걸릴 수 있어.')));
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
  const name = h('span', { id: 'wallet-name' }, '내 지갑');
  void wallet.walletsList().then((r: any) => { name.textContent = r.list.find((w: any) => w.id === r.active)?.name ?? '내 지갑'; });
  return h('button', { type: 'button', class: 'wallet-btn', id: 'wallet-switch', 'aria-label': '지갑 선택', onclick: () => void renderWallets(renderHome) }, name, icon('down'));
}

async function renderWallets(back: () => void): Promise<void> {
  const r = await wallet.walletsList();
  const box = errorBox();
  const newName = h('input', { id: 'wallet-new-name', autocomplete: 'off', maxlength: '20', value: `지갑 ${r.list.length + 1}` });
  const add = h('button', { class: 'primary', id: 'wallet-add', type: 'submit' }, '지갑 추가');
  const leave = async (task: () => Promise<void>) => {
    deleting = true; // Locking is expected here, so the lock screen must not jump in first.
    try { await task(); await boot(); } catch (e) { box.show(e); } finally { deleting = false; }
  };
  show('send', subBar('지갑', back), h('div', { class: 'scroll' }, box.el,
    h('div', { id: 'wallet-list' }, ...r.list.map((w: any) => {
      const on = w.id === r.active;
      return h('div', { class: `panel wallet-row${on ? ' on' : ''}` },
        h('button', { type: 'button', class: 'wallet-pick', id: `wallet-${w.id}`, onclick: () => { if (on) back(); else void leave(() => wallet.walletSwitch(w.id)); } },
          h('strong', {}, w.name), h('span', { class: 'small muted' }, on ? '사용 중' : '눌러서 전환')),
        h('button', { type: 'button', class: 'secondary', id: `rename-${w.id}`, onclick: () => renderWalletRename(w, () => void renderWallets(back)) }, '이름 변경'));
    })),
    h('br'),
    h('form', { class: 'panel', onsubmit: (e: Event) => {
      e.preventDefault();
      void leave(() => wallet.walletBeginAdd(newName.value));
    } }, h('label', { class: 'field' }, h('span', {}, '새 지갑 이름'), newName),
    h('p', { class: 'small muted wallet-hint' }, '새 지갑은 시드와 비밀번호가 따로야. 전환하면 지금 지갑은 잠겨.'), add)));
}

function renderWalletRename(w: any, back: () => void): void {
  const name = h('input', { id: 'wallet-rename-input', autocomplete: 'off', maxlength: '20', value: w.name });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'wallet-rename-save', type: 'submit' }, '저장');
  show('send', subBar('지갑 이름', back), h('div', { class: 'scroll' }, box.el, h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, '저장 중…', box, async () => { await wallet.walletRename(w.id, name.value); back(); });
  } }, h('label', { class: 'field' }, h('span', {}, '이름'), name), go)));
  name.focus();
}

// ---- Tornado Cash ----

let onTornadoProgress: ((m: string) => void) | null = null;
wallet.on('tornado-progress', (m: string) => onTornadoProgress?.(m));
const NOTE_STATUS: Record<string, string> = { sending: '전송 중', deposited: '입금됨', withdrawing: '출금 중', withdrawn: '출금 완료' };

async function renderTornado(message = ''): Promise<void> {
  const info = await wallet.tornadoInfo();
  const box = errorBox();
  const engine = h('p', { class: 'small muted', id: 'tornado-engine' }, '증명 엔진 확인 중…');
  const recoverPw = h('input', { type: 'password', id: 'tornado-recover-pw', autocomplete: 'current-password' });
  const recoverStatus = h('p', { class: 'small muted', id: 'tornado-recover-status', role: 'status' });
  const recover = h('button', { type: 'submit', id: 'tornado-recover' }, '시드로 입금 찾기');
  show('send', subBar('Tornado', () => void renderSwap('ETH', 'XMR')), h('div', { class: 'scroll' }, box.el,
    message && h('div', { class: 'note-ok', id: 'tornado-message' }, message),
    h('div', { class: 'warn' }, '넣는 주소와 빼는 주소는 체인에 공개돼. 넣고 바로 빼면 시간으로 연결될 수 있으니 오래 두고 빼. 출금은 릴레이어를 써야 입금 주소와 안 이어져.'),
    h('div', { class: 'panel' }, h('span', { class: 'label' }, 'ETH 넣기 (고정 금액)'),
      h('div', { class: 'pool-row' }, ...info.pools.map((pool: string, i: number) => h('button', { type: 'button', id: `pool-${i}`, onclick: () => busy(document.getElementById(`pool-${i}`) as HTMLButtonElement, '확인 중…', box, async () => {
        renderTornadoDeposit(await wallet.tornadoDepositPrepare(pool));
      }) }, `${pool} ETH`)))),
    h('h3', {}, '내 입금'),
    info.notes.length
      ? h('div', { id: 'tornado-notes' }, ...info.notes.map((n: any) => h('div', { class: 'panel note-row' },
        h('div', {}, h('strong', {}, `${n.pool} ETH`), h('div', { class: 'small muted' }, `${NOTE_STATUS[n.status] ?? n.status} · ${when(n.createdAt)}`)),
        h('div', { class: 'note-actions' },
          n.status === 'deposited' && h('button', { type: 'button', class: 'secondary', id: `withdraw-${n.index}`, onclick: () => renderTornadoWithdraw(n, info.relayer) }, '출금'),
          h('button', { type: 'button', class: 'secondary', id: `backup-${n.index}`, onclick: () => renderTornadoBackup(n) }, '백업')))))
      : h('p', { class: 'empty', id: 'tornado-empty' }, '아직 입금이 없어.'),
    engine,
    h('form', { class: 'panel', onsubmit: (e: Event) => {
      e.preventDefault();
      onTornadoProgress = (m) => { recoverStatus.textContent = m; };
      busy(recover, '찾는 중…', box, async () => {
        const r = await wallet.tornadoRecover(recoverPw.value);
        await renderTornado(`입금 ${r.found}건을 찾았어.`);
      });
    } }, h('span', { class: 'label' }, '다시 설치했거나 시드로 복구했다면'), h('label', { class: 'field' }, h('span', {}, '비밀번호'), recoverPw), recoverStatus, recover)));
  wallet.tornadoCheck().then(() => { engine.textContent = '증명 엔진 준비됨. 증명은 이 기기에서 만들어져.'; }, (e: unknown) => {
    engine.textContent = `증명 엔진을 시작하지 못했어: ${errMsg(e)}`;
  });
}

function renderTornadoDeposit(p: any): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-deposit', type: 'submit' }, `${p.pool} ETH 넣기`);
  show('send', subBar('Tornado 입금', () => { void wallet.cancelSend(p.id); void renderTornado(); }), h('div', { class: 'scroll' },
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, '전송 중…', box, async () => {
        await wallet.tornadoDepositConfirm(p.id, p.pool, pw.value);
        pw.value = '';
        void refresh();
        await renderTornado(`${p.pool} ETH를 넣었어. 컨펌 뒤에 출금할 수 있어.`);
      });
    } }, box.el,
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, '금액'), h('td', { id: 'review-amount' }, `${p.amount} ETH`)),
      h('tr', {}, h('th', {}, '예상 수수료'), h('td', { id: 'review-fee' }, reviewFee(p.fee, 'ETH'))),
      h('tr', {}, h('th', {}, '풀 주소'), h('td', {}, h('div', { class: 'addr-check', id: 'review-pool' }, p.to)))))),
    h('p', { class: 'small muted' }, '입금 비밀은 시드에서 만들어져. 시드를 잃으면 이 금액도 잃어. 다른 도구에서 쓰려면 백업에서 노트를 복사해.'),
    h('br'),
    h('label', { class: 'field' }, h('span', {}, '비밀번호'), pw), go)));
  pw.focus();
}

function renderTornadoBackup(n: any): void {
  const pw = h('input', { type: 'password', id: 'backup-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const output = h('div', { class: 'mono small', id: 'backup-note' });
  const go = h('button', { class: 'primary', id: 'backup-show', type: 'submit' }, '노트 보기');
  show('send', subBar('노트 백업', () => void renderTornado()), h('div', { class: 'scroll' },
    h('div', { class: 'warn' }, '노트를 가진 사람은 이 금액을 뺄 수 있어. 시드처럼 보관해.'), box.el,
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, '확인 중…', box, async () => {
        output.textContent = await wallet.tornadoExport(n.id, pw.value);
        pw.value = '';
      });
    } }, h('label', { class: 'field' }, h('span', {}, '비밀번호'), pw), go), h('br'), output));
}

function renderTornadoWithdraw(n: any, savedRelayer: string): void {
  const to = h('input', { id: 'tornado-to', spellcheck: 'false', autocomplete: 'off', placeholder: '입금과 상관없는 새 주소' });
  const relayer = h('input', { id: 'tornado-relayer', spellcheck: 'false', autocomplete: 'off', value: savedRelayer, placeholder: 'https://… 또는 .onion' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'tornado-next', type: 'submit' }, '다음');
  show('send', subBar(`${n.pool} ETH 출금`, () => void renderTornado()), h('div', { class: 'scroll' }, box.el,
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, '확인 중…', box, async () => {
        renderTornadoWithdrawReview(n, await wallet.tornadoWithdrawQuote(n.id, to.value, relayer.value), to.value, relayer.value, savedRelayer);
      });
    } },
    h('label', { class: 'field' }, h('span', {}, '받을 ETH 주소'), to),
    h('label', { class: 'field' }, h('span', {}, '릴레이어 주소'), relayer, h('div', { class: 'hint' }, '릴레이어가 대신 거래를 보내고 수수료를 금액에서 떼어가. 비우면 이 지갑이 직접 보내는데, 그러면 입금 주소와 이어져.')),
    go)));
}

function renderTornadoWithdrawReview(n: any, q: any, to: string, relayerUrl: string, savedRelayer: string): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const progress = h('p', { class: 'small muted', id: 'tornado-progress', role: 'status' });
  const go = h('button', { class: 'primary', id: 'confirm-withdraw', type: 'submit' }, '증명 만들고 출금');
  show('send', subBar('출금 확인', () => renderTornadoWithdraw(n, savedRelayer)), h('div', { class: 'scroll' },
    q.mode === 'self' && h('div', { class: 'warn', id: 'tornado-self-warn' }, '릴레이어 없이 이 지갑이 직접 보내. 체인에서 입금 주소와 받는 주소가 이어져서 프라이버시 효과가 거의 없어.'),
    box.el,
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      onTornadoProgress = (m) => { progress.textContent = m; };
      busy(go, '진행 중…', box, async () => {
        if (relayerUrl.trim() && relayerUrl.trim() !== savedRelayer) void wallet.updateSettings({ tornadoRelayer: relayerUrl }).catch(() => undefined);
        await wallet.tornadoWithdraw(n.id, to, relayerUrl, pw.value);
        pw.value = '';
        void refresh();
        await renderTornado(`${q.receive} ETH 출금을 보냈어.`);
      });
    } },
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, '받는 금액'), h('td', { id: 'review-receive' }, `${q.receive} ETH`)),
      h('tr', {}, h('th', {}, q.mode === 'self' ? '가스비 (지갑에서)' : '릴레이어 수수료'), h('td', { id: 'review-fee' }, reviewFee(q.fee, 'ETH'))),
      h('tr', {}, h('th', {}, '받을 주소'), h('td', {}, h('div', { class: 'addr-check', id: 'review-to' }, q.recipient)))))),
    h('p', { class: 'small muted' }, '입금 기록 전체를 읽고 증명을 만들어서 몇 분, 휴대폰은 더 오래 걸릴 수 있어. 끝날 때까지 앱을 닫지 마. 중간에 끊겨도 코인은 풀에 그대로 있어.'),
    h('br'), h('label', { class: 'field' }, h('span', {}, '비밀번호'), pw), progress, go)));
  pw.focus();
}

const PRIVACY_STAGE: Record<string, string> = {
  first: '1단계: XMR 도착과 잠금 해제 기다리는 중', ready: '2단계 승인을 기다리는 중', second: '2단계: 최종 주소로 보내는 중', done: '완료', failed: '중단됨',
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
      row('보낸 금액', `${p.amount} ${coinName(p.from)}`),
      row('예상 XMR', `약 ${p.expectedXmr} XMR`),
      row('도착한 XMR', `${p.received} XMR (사용 가능 ${p.unlocked})`),
      row('최종 받을 주소', p.destination),
      row('1단계 주문', p.firstId),
      p.secondId ? row('2단계 주문', p.secondId) : false))),
      p.stage === 'first' && h('p', { class: 'small muted' }, 'XMR은 이 지갑에 들어와. 앱을 닫아도 괜찮고, 다시 열면 여기서 이어서 진행돼. 10컨펌이 지나야 다음 단계로 넘어가.'));
  };
  const paintSecond = (p: any) => {
    const available = Math.max(0, Number(p.unlocked) - 0.001);
    const amount = h('input', { id: 'pv-amount', class: 'amount-input', inputmode: 'decimal', autocomplete: 'off', value: available > 0 ? available.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : '' });
    const quote = h('div', { class: 'small muted', id: 'pv-quote' });
    const offers = h('div', { class: 'swap-offers', id: 'pv-offers' });
    let chosen: any = null;
    const go = h('button', { class: 'primary', id: 'pv-next', disabled: true, onclick: () => busy(go, '주문 만드는 중…', box, async () => {
      renderSwapReview(await wallet.privacySecond(p.id, amount.value, chosen.providerId), () => renderPrivacyStatus(p));
    }) }, '2단계 진행');
    const paintOffers = (list: any[]) => {
      const good = list.filter((q) => !q.problem);
      chosen = good.find((q) => q.providerId === chosen?.providerId) ?? good[0] ?? null;
      go.disabled = !chosen;
      quote.textContent = chosen ? `약 ${chosen.receive} ${coinName(p.to)}. ${chosen.provider}에서 처리해.` : (list[0]?.problem ?? '');
      setKids(offers, ...list.map((q) => h('button', { type: 'button', class: `swap-offer${q === chosen ? ' on' : ''}`, id: `pv-offer-${q.providerId}`, disabled: Boolean(q.problem), onclick: () => { chosen = q; paintOffers(list); } },
        h('span', {}, q.provider + (q.providerId === p.firstProviderId ? ' (1단계와 같음)' : '')), h('span', { class: 'offer-right' }, q.problem ? '견적 없음' : `약 ${q.receive}`, !q.problem && h('span', { class: 'offer-cost' }, offerFee(q).total), !q.problem && h('span', { class: 'small muted offer-cost' }, offerFee(q).detail)))));
    };
    let ticket = 0;
    const requote = async () => {
      const mine = ++ticket;
      go.disabled = true;
      quote.textContent = '견적 받는 중…';
      try {
        const list = await wallet.privacySecondQuote(p.id, amount.value);
        if (mine === ticket) paintOffers(list);
      } catch (e) { if (mine === ticket) quote.textContent = errMsg(e); }
    };
    let timer: number | undefined;
    amount.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(() => void requote(), 600); });
    setKids(body,
      h('div', { class: 'panel' }, h('span', { class: 'label' }, `보낼 XMR (최대 ${p.unlocked})`), h('div', { class: 'swap-row' }, amount)),
      quote, h('br'), offers,
      h('div', { class: 'panel' }, h('span', { class: 'label' }, '최종 받을 주소'), h('div', { class: 'addr-check', id: 'pv-dest' }, p.destination)),
      h('p', { class: 'small muted' }, '바로 보내지 말고 시간을 두면 좋아. 들어온 금액과 다르게 보내면 연결하기 더 어려워져. 남은 XMR은 지갑에 그대로 있어.'),
      go);
    void requote();
  };
  show('receive', subBar('프라이버시 스왑', () => void renderSwap()), h('div', { class: 'scroll' },
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
    let text = info.installed ? `준비됨${st.installedVersion ? ` (번들 ${st.installedVersion})` : ''}. 꺼져 있어.` : '아직 설치 안 됨. 켜면 공식 파일을 받아 서명을 확인한 뒤 설치해.';
    if (info.enabled && st.phase === 'starting') text = `연결 중 ${st.percent}%`;
    if (info.enabled && st.phase === 'error') text = st.error ?? '연결 실패';
    if (info.enabled && st.phase === 'ready') {
      text = st.verified === true ? `Tor 연결 확인됨. 외부에 보이는 IP: ${st.exitIp}`
        : st.verified === false ? '경고: 확인 서비스가 Tor 연결이 아니라고 응답했어.' : '연결됨. Tor 확인 서비스 응답을 기다리는 중이야.';
    }
    torProgress.textContent = text;
  };
  paintTor(tor);
  onTorInstallMessage = (m) => { torProgress.textContent = m; };
  onTorState = (st) => paintTor({ enabled: tor.enabled, installed: tor.installed, state: st });
  const updateTor = h('button', { class: 'ghost', id: 'tor-update', hidden: !tor.installed || tor.updatable === false, onclick: () => busy(updateTor, '받는 중…', torBox, async () => {
    await wallet.installTor();
    toast('Tor를 최신 버전으로 받았어. 지갑을 다시 열면 적용돼.');
    if (tor.enabled) await wallet.lock();
  }) }, 'Tor 업데이트');
  const saved = h('span', { class: 'small muted', role: 'status' });
  const saveBtn = h('button', { id: 'save-settings', onclick: () => busy(saveBtn, '저장 중…', netBox, async () => {
    if (useTor.checked && !tor.installed) {
      await wallet.installTor();
      tor.installed = true;
    }
    const relocked = await wallet.updateSettings({ customMoneroNode: node.value, tronApiKey: key.value, autoLockMinutes: Number(auto.value), showPrices: showPrices.checked, torEnabled: useTor.checked });
    if (!relocked) { saved.textContent = '저장했어.'; void refresh(); }
  }) }, '저장');

  const curPw = h('input', { type: 'password', autocomplete: 'current-password' });
  const newPw = h('input', { type: 'password', autocomplete: 'new-password' });
  const chgDone = h('span', { class: 'small muted', role: 'status' });
  const chg = h('button', { onclick: () => busy(chg, '변경 중…', pwBox, async () => {
    await wallet.changePassword(curPw.value, newPw.value);
    await wallet.biometric?.disable();
    curPw.value = ''; newPw.value = ''; chgDone.textContent = '비밀번호를 바꿨어.';
  }) }, '비밀번호 변경');

  const seedPw = h('input', { type: 'password', autocomplete: 'current-password', id: 'seed-pw' });
  const seedOut = h('div', {});
  const rev = h('button', { id: 'reveal', onclick: () => busy(rev, '여는 중…', seedBox, async () => {
    const seeds = await wallet.revealSeeds(seedPw.value);
    seedPw.value = '';
    setKids(seedOut, h('br'), seedCard('BTC·ETH·Tron 시드', '', seeds.tronMnemonic), seedCard('Monero 시드', '', seeds.moneroSeed),
      h('button', { class: 'ghost', onclick: () => setKids(seedOut) }, '가리기'));
  }) }, '시드 보기');

  let bioSection: Child = null;
  if (wallet.biometric && await wallet.biometric.available()) {
    const bioBox = errorBox();
    const bioPw = h('input', { type: 'password', autocomplete: 'current-password', id: 'bio-pw' });
    const bioArea = h('div', {});
    const paintBio = async () => {
      if (await wallet.biometric.enabled()) {
        const off = h('button', { class: 'ghost', id: 'bio-off', onclick: async () => { await wallet.biometric.disable(); await paintBio(); } }, '지문 로그인 끄기');
        setKids(bioArea, h('p', { class: 'small muted' }, '지문 로그인이 켜져 있어. 비밀번호로도 열 수 있어.'), h('br'), off);
      } else {
        const on = h('button', { id: 'bio-on', onclick: () => busy(on, '지문을 인식해줘…', bioBox, async () => {
          await wallet.revealSeeds(bioPw.value); // confirms the password before it is protected
          await wallet.biometric.enable(bioPw.value);
          bioPw.value = '';
          await paintBio();
        }) }, '지문 로그인 켜기');
        setKids(bioArea, h('label', { class: 'field' }, h('span', {}, '비밀번호'), bioPw), on);
      }
    };
    await paintBio();
    bioSection = h('div', { class: 'section' }, h('h3', {}, '지문 로그인'), bioBox.el, bioArea,
      h('p', { class: 'hint' }, '지갑을 열 때 쓸 수 있어. 코인을 보낼 때는 지금처럼 비밀번호를 입력해야 해. 휴대폰에 지문을 새로 등록하면 보안을 위해 다시 켜야 해.'));
  }

  const delPw = h('input', { type: 'password', autocomplete: 'current-password', id: 'del-pw' });
  const del = h('button', { class: 'danger', id: 'delete', onclick: () => busy(del, '삭제 중…', delBox, async () => {
    deleting = true;
    try {
      await wallet.deleteWallet(delPw.value);
      await boot();
    } finally {
      deleting = false;
    }
  }) }, '이 PC에서 지갑 삭제');

  show('send',
    h('div', { class: 'bar' }, h('span', {}), h('h2', {}, '설정'), h('span', {})),
    h('div', { class: 'scroll' },
      h('div', { class: 'section' }, h('h3', {}, '연결'), netBox.el,
        h('label', { class: 'field' }, h('span', {}, 'Monero 노드 직접 지정'), node, h('div', { class: 'hint' }, '내 노드가 있으면 입력해. 비워두면 공개 노드를 자동으로 골라. 공개 노드는 네 IP를 볼 수 있어.')),
        h('label', { class: 'field' }, h('span', {}, 'TronGrid API 키'), key, h('div', { class: 'hint' }, '없어도 동작해. 조회가 자주 막히면 무료 키를 넣어.')),
        h('label', { class: 'field' }, h('span', {}, '자동 잠금 (분)'), auto),
        h('label', { class: 'check' }, showPrices, h('span', {}, '달러 시세 표시', h('div', { class: 'hint' }, 'CoinGecko에서 시세를 받아오고, 막히면 Kraken과 CryptoCompare를 써. 주소나 잔액은 보내지 않지만 네 IP는 보일 수 있어.'))),
        h('div', { class: 'tor-block' },
          h('h3', {}, 'Tor'), torBox.el, torProgress,
          h('label', { class: 'check' }, useTor, h('span', {}, 'Tor로 연결하기',
            h('div', { class: 'hint' }, 'XMR 노드, TronGrid, 시세 연결을 모두 Tor로 보내서 네 IP를 숨겨. 공개된 Tron 거래 내역은 숨겨주지 않고, 조회와 동기화가 느려져.'),
            h('div', { class: 'hint' }, tor.updatable === false ? 'Tor가 끊기면 일반 인터넷으로 넘어가지 않고 연결이 멈춰.' : 'Tor가 끊기면 일반 인터넷으로 넘어가지 않고 연결이 멈춰. 처음 설치할 때 파일을 받는 동안만 일반 인터넷을 써.'))),
          updateTor),
        h('div', { class: 'row' }, saveBtn, saved),
        h('p', { class: 'hint' }, '노드, API 키, Tor를 바꾸면 지갑이 잠겨. 다시 열면 적용돼.')),
      bioSection,
      h('div', { class: 'section', id: 'arrr-info' }, h('h3', {}, 'Pirate Chain 엔진'),
        h('p', { class: 'small', id: 'arrr-info-state' }, arrrInfo.available ? (arrrInfo.started ? `실행됨: ${arrrInfo.phase}` : '찾았지만 실행 안 됨') : '못 찾음'),
        arrrInfo.error && h('p', { class: 'small' }, arrrInfo.error)),
      h('div', { class: 'section', id: 'zano-info' }, h('h3', {}, 'Zano 엔진'),
        h('p', { class: 'small', id: 'zano-info-state' }, zanoInfo.available ? (zanoInfo.started ? `실행됨: ${zanoInfo.phase}` : '찾았지만 실행 안 됨') : '못 찾음'),
        zanoInfo.error && h('p', { class: 'small' }, zanoInfo.error)),
      h('div', { class: 'section', id: 'zec-info' }, h('h3', {}, 'Zcash 엔진'),
        h('p', { class: 'small', id: 'zec-info-state' }, zecInfo.available ? (zecInfo.started ? `실행됨: ${zecInfo.phase}` : '찾았지만 실행 안 됨') : '못 찾음'),
        zecInfo.error && h('p', { class: 'small' }, zecInfo.error),
        h('p', { class: 'small', id: 'zec-info-list' }, `목록: ${ASSETS.includes('ZEC') ? 'ZEC 포함' : 'ZEC 없음'} / 잔액 조회: ${refreshNote}`),
        h('p', { class: 'muted small mono' }, zecInfo.detail)),
      h('div', { class: 'section' }, h('h3', {}, '시드 백업'), seedBox.el,
        h('label', { class: 'field' }, h('span', {}, '비밀번호'), seedPw), rev, seedOut),
      h('div', { class: 'section' }, h('h3', {}, '비밀번호 변경'), pwBox.el,
        h('label', { class: 'field' }, h('span', {}, '현재 비밀번호'), curPw),
        h('label', { class: 'field' }, h('span', {}, '새 비밀번호 (10자 이상)'), newPw),
        h('div', { class: 'row' }, chg, chgDone)),
      h('div', { class: 'section' }, h('h3', {}, '지갑 삭제'), delBox.el,
        h('p', { class: 'muted small' }, '코인은 블록체인에 그대로 남지만, 시드 없이는 다시는 꺼낼 수 없어. 시드를 확인한 뒤에 삭제해.'), h('br'),
        h('label', { class: 'field' }, h('span', {}, '비밀번호'), delPw), del)),
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
