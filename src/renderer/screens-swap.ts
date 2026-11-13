// Swaps and switching between wallets.
// ---- swap ----

const SWAP_STATUS: Record<string, string> = {
  hold: 'Held for provider review', verifying: 'Under provider review', new: 'Waiting for deposit', waiting: 'Waiting for deposit', confirming: 'Checking the deposit', finished: 'Finished', failed: 'Failed', expired: 'Expired', halted: 'Held for provider review', 'paid partially': 'Partly deposited',
  deposit: 'Waiting for deposit', confirmations: 'Checking the deposit', wait: 'Waiting for deposit', confirmation: 'Checking the deposit', confirmed: 'Deposit confirmed', exchanging: 'Exchanging', sending: 'Sending',
  success: 'Finished', overdue: 'Expired', refund: 'Refunding', refunded: 'Refunded', unknown: 'Checking',
};

function coinSelect(id: string, current: Asset, onPick: (a: Asset) => void): HTMLElement {
  const menu = h('div', { class: 'menu', hidden: true, id: `${id}-menu` }, ...coinMenu(id, ASSETS.filter((a) => a !== 'SSCRT' && a !== 'KSR'), current, onPick));
  return h('div', { class: 'coin-select' },
    h('button', { type: 'button', id, class: 'coin-select-btn', 'aria-label': `Choose a coin, currently ${coinName(current)}`, onclick: () => { menu.hidden = !menu.hidden; } }, coin(current), h('span', {}, coinName(current)), icon('down')),
    menu);
}

// Every coin except XMR itself can go out through XMR and come back as another coin.
const PRIVACY_ASSETS: Asset[] = ALL_ASSETS.filter((a) => a !== 'XMR' && a !== 'SSCRT' && a !== 'KSR');

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
