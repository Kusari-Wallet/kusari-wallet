// Balances, the home screen and a coin's own screen.
// ---- data ----

async function enterWallet(): Promise<void> {
  overview = null;
  homeTab = 'assets';
  addresses = await wallet.addresses().catch(() => null);
  // Decided here because the first balance round can take a while on a phone, and the row shouldn't wait for it.
  zecInSession = await wallet.zecInfo().then((i: any) => Boolean(i.started)).catch(() => false);
  const zanoInSession = await wallet.zanoInfo().then((i: any) => Boolean(i.started)).catch(() => false);
  const ksrInSession = await wallet.ksrInfo().then((i: any) => Boolean(i.started)).catch(() => false);
  const arrrInSession = await wallet.arrrInfo().then((i: any) => Boolean(i.started)).catch(() => false);
  ASSETS = ALL_ASSETS.filter((a) => (a !== 'ZEC' || zecInSession) && (a !== 'ZANO' || zanoInSession) && (a !== 'KSR' || ksrInSession) && (a !== 'ARRR' || arrrInSession));
  torState = (await wallet.torInfo().catch(() => null))?.enabled ? (await wallet.torInfo()).state : null;
  renderHome();
  void refresh(); // Balances fill in on the home screen; a slow node or Tor must not hold it back.
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => void refresh(), 20_000);
}

async function refresh(): Promise<void> {
  // Prices and balances arrive on their own: a slow price service no longer holds back every balance, or the reverse.
  const priced = wallet.prices().then((p: any) => { if (p) { prices = p; onData?.(); } }).catch(() => undefined);
  try {
    const next = await wallet.overview();
    overview = next;
    refreshNote = `${new Date().toLocaleTimeString('en-US')} answer, ZEC ${next.balances.ZEC ? (next.balances.ZEC.ok ? 'has balance' : next.balances.ZEC.pending ? 'waiting' : 'failed') : 'none'}`;
    addresses = next.addresses;
    torState = next.tor;
    onData?.();
  } catch (e) { refreshNote = `Error: ${(e as Error).message}`; /* usually just locked meanwhile */ }
  await priced;
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
  const sum = ASSETS.reduce((s, a) => s + (assetUsd(a) ?? 0), 0);
  if (pending.length && !failed.length) {
    if (overview.tor && overview.tor.phase !== 'ready') return { value: usdFormat(sum), note: 'Tor is connecting. Balances load once it connects.' };
    // A first sync reads the chain on this device and can take a long while: say so, with how far it is.
    const syncing = (a: Asset) => (a === 'ZEC' && overview.zec?.syncing && !overview.zec.firstScanDone) || (a === 'ARRR' && overview.arrr?.scanning) || (a === 'ZANO' && overview.balances.ZANO?.pending) || (a === 'KSR' && overview.balances.KSR?.pending);
    const first = pending.filter(syncing);
    const rest = pending.filter((a) => !syncing(a));
    const names = (list: Asset[]) => list.map((a) => (a === 'ARRR' && overview.arrr?.percent ? `${coinName(a)} ${overview.arrr.percent}%` : coinName(a))).join(', ');
    if (!first.length) return { value: usdFormat(sum), note: `Loading ${names(rest)} balances. The total doesn't include them yet.` };
    if (!rest.length) return { value: usdFormat(sum), note: `First sync of ${names(first)} on this device, which can take a while. The total doesn't include them yet.` };
    return { value: usdFormat(sum), note: `Loading ${names(rest)} balances. First sync of ${names(first)} on this device, which can take a while. The total doesn't include them yet.` };
  }
  if (failed.length) return { value: usdFormat(sum), note: `${failed.map(coinName).join(', ')} lookup failed, so the total leaves it out. Retrying automatically.` };
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
  const waiting = h('div', { id: 'make-private' });
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
    setKids(waiting, ...publicWaiting().map((w) => h('button', { class: 'warn private-prompt', id: `make-private-${w.asset}`, onclick: w.open },
      `${w.amount} ${coinName(w.asset)} is on a public address. Tap to make it private.`)));
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
    h('div', { class: 'top' }, h('div', { class: 'acct' }, walletButton(), torChip)),
    h('div', { class: 'total' }, totalValue, spin, eye),
    note,
    waiting,
    h('div', { class: 'actions' },
      h('button', { class: 'action', id: 'go-send', onclick: () => renderSend() }, h('span', { class: 'box' }, icon('send')), 'Send'),
      h('button', { class: 'action', id: 'go-receive', onclick: () => void renderReceive() }, h('span', { class: 'box' }, icon('receive')), 'Receive'),
      h('button', { class: 'action swap-action', id: 'go-swap', onclick: () => void renderSwap() }, h('span', { class: 'box' }, icon('swap')), 'Swap'),
      h('button', { class: 'action', id: 'go-buy', onclick: () => void openBuyPage() }, h('span', { class: 'box' }, icon('buy')), 'Buy')),
    h('div', { class: 'tabs', role: 'tablist' }, tab('assets', 'Assets'), tab('history', 'History')),
    body,
    bottomNav('home'));
  onData = paint;
  paint();
  if (homeTab === 'assets') setKids(body, list);
  else void renderAllHistory(body);
}

/**
 * Coins that arrived on a public address while a private balance is ready for them. Moving them needs the password,
 * so the home screen asks, and one tap opens that step.
 */
function publicWaiting(): { asset: Asset; amount: string; open: () => void }[] {
  if (!overview || hideBalance) return [];
  const out: { asset: Asset; amount: string; open: () => void }[] = [];
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const zecT = num(overview.zec?.transparent);
  if (zecT > 0) out.push({ asset: 'ZEC', amount: shortAmount(String(overview.zec.transparent)), open: () => { selected = 'ZEC'; renderZecShield(); } });
  const ltcPublic = num(overview.balances?.LTC?.total) - num(overview.mweb?.balance?.total);
  if (overview.mweb?.ready && overview.balances?.LTC?.ok && !overview.balances.LTC.stale && ltcPublic > 0) out.push({ asset: 'LTC', amount: shortAmount(ltcPublic.toFixed(8)), open: () => { selected = 'LTC'; void ltcPrivateStep(); } });
  const firoPublic = num(overview.balances?.FIRO?.total) - num(overview.spark?.balance?.total);
  if (overview.spark?.ready && overview.balances?.FIRO?.ok && !overview.balances.FIRO.stale && firoPublic > 0) out.push({ asset: 'FIRO', amount: shortAmount(firoPublic.toFixed(8)), open: () => { selected = 'FIRO'; void firoPrivateStep(); } });
  return out;
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
      : a === 'BTC' ? 'Bitcoin' : a === 'SOL' ? 'Solana' : a === 'DOGE' ? 'Dogecoin' : a === 'ADA' ? 'Cardano' : a === 'BCH' ? 'Bitcoin Cash' : a === 'LTC' ? 'Litecoin' : a === 'SCRT' || a === 'SSCRT' ? 'Secret' : a === 'DASH' ? 'Dash' : a === 'FIRO' ? 'Firo' : a === 'ZEC' ? 'Zcash' : a === 'ZANO' ? 'Zano' : a === 'KSR' ? 'Kusari' : a === 'ARRR' ? 'Pirate Chain' : a === 'ETH' || a === 'ETHA' ? 'Ethereum' : a === 'POL' ? 'Polygon' : a === 'LINK' ? 'Chainlink' : a === 'WLD' ? 'Worldcoin' : a === 'ARB' ? 'Arbitrum' : a === 'UNI' ? 'Uniswap' : a === 'PEPE' ? 'Pepe' : a === 'AAVE' ? 'Aave' : a === 'ETHP' ? 'Ethereum' : a === 'BNB' ? 'BNB Smart Chain' : a === 'SHIB' ? 'Shiba Inu' : a === 'ORCA' ? 'Orca' : a === 'PUMP' ? 'pump.fun' : a === 'USDT' || a === 'USDTE' || a === 'USDTS' || a === 'USDTP' || a === 'USDTA' ? 'Tether' : a === 'TRX' ? 'Tron' : 'Monero';
  const usd = assetUsd(a);
  return h('button', { class: `asset${child ? ' child' : ''}`, id: `asset-${a}`, onclick: () => { selected = a; void renderAsset(); } },
    coin(a),
    h('div', {}, h('div', { class: 'name' }, COIN[a].label, toggle), h('div', { class: 'sub' }, sub)),
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
      a === 'KSR' && b?.ok && b.total !== b.spendable && h('div', { class: 'warn' }, `${b.spendable} KSR can be sent now. Received coins can be used after 10 confirmations.`),
      a === 'ZEC' && b?.ok && b.total !== b.spendable && h('div', { class: 'warn' }, `${b.spendable} ZEC can be sent now. The rest is waiting for confirmations or for shielding.`),
      a === 'ZEC' && overview?.zec?.canShield && h('div', { class: 'panel', id: 'zec-shield-panel' },
        h('p', { class: 'small' }, `You have ${overview.zec.transparent} ZEC in transparent balance. It's public on the chain and can't be sent directly. ZEC received from swaps arrives here too.`), h('br'),
        h('button', { class: 'primary', id: 'zec-shield', onclick: () => renderZecShield() }, 'Shield')),
      a === 'LTC' && overview?.mweb && h('div', { class: 'panel', id: 'mweb-panel' },
        overview.mweb.ready && overview.mweb.balance
          ? h('p', { class: 'small' }, `Private (MWEB): ${shortAmount(overview.mweb.balance.total)} LTC. Its amounts and addresses are hidden on the chain.`)
          : h('p', { class: 'small', id: 'mweb-sync' }, overview.mweb.error ? `Private (MWEB) balance: ${overview.mweb.error}` : `Syncing the private (MWEB) balance… ${overview.mweb.percent}%`),
        overview.mweb.ready && h('button', { class: 'secondary', id: 'mweb-pegin', onclick: () => void ltcPrivateStep() }, 'Make public LTC private')),
      a === 'DASH' && overview?.coinjoin && coinjoinPanel(overview.coinjoin),
      a === 'BTC' && overview?.btcMix && btcMixPanel(overview.btcMix),
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
