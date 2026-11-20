// Tornado Cash and the privacy swap status.
// ---- Tornado Cash ----

let onTornadoProgress: ((m: string) => void) | null = null;
wallet.on('tornado-progress', (m: string) => onTornadoProgress?.(m));
const NOTE_STATUS: Record<string, string> = { sending: 'Sending', deposited: 'Deposited', withdrawing: 'Withdrawing', withdrawn: 'Withdrawn', scheduled: 'Scheduled' };
/** When a scheduled deposit or withdrawal goes out, as a time today or a date. */
const atText = (at: number): string => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

let tornadoChainSel = 'eth';
const TORNADO_CHAIN_NAMES: Record<string, string> = { eth: 'Ethereum', bsc: 'BNB Chain', pol: 'Polygon', arb: 'Arbitrum' };
/** The coin a chain's pools hold, as the wallet's assets name it (for prices). */
const TORNADO_ASSET: Record<string, string> = { eth: 'ETH', bsc: 'BNB', pol: 'POL', arb: 'ETHA' };

async function renderTornado(message = '', chain = tornadoChainSel): Promise<void> {
  tornadoChainSel = chain;
  const info = await wallet.tornadoInfo(chain);
  const sym: string = info.symbol;
  const box = errorBox();
  const engine = h('p', { class: 'small muted', id: 'tornado-engine' }, 'Checking the proof engine…');
  const recoverPw = h('input', { type: 'password', id: 'tornado-recover-pw', autocomplete: 'current-password' });
  const recoverStatus = h('p', { class: 'small muted', id: 'tornado-recover-status', role: 'status' });
  const recover = h('button', { type: 'submit', id: 'tornado-recover' }, 'Find deposits from seed');
  show('send', subBar('Tornado', () => void renderSwap('ETH', 'XMR')), h('div', { class: 'scroll' }, box.el,
    message && h('div', { class: 'note-ok', id: 'tornado-message' }, message),
    h('div', { class: 'row', id: 'tornado-chains' }, ...info.chains.map((c: string) => h('button', { type: 'button', class: c === chain ? 'primary' : 'secondary', id: `tornado-chain-${c}`, onclick: () => void renderTornado('', c) }, TORNADO_CHAIN_NAMES[c] ?? c))),
    h('div', { class: 'warn' }, 'Deposit and withdrawal addresses are public on the chain. Withdrawing right after depositing can be linked by timing, so wait a long time. Withdrawing needs a relayer to stay unlinked from the deposit address.'),
    chain !== 'eth' && h('div', { class: 'warn', id: 'tornado-small-pool' }, `The ${TORNADO_CHAIN_NAMES[chain]} pools are much smaller than Ethereum's and have few relayers, so a deposit hides among fewer others and a withdrawal may have to wait for a relayer.`),
    h('div', { class: 'panel' }, h('span', { class: 'label' }, `Deposit ${sym} (fixed amounts)`),
      h('div', { class: 'pool-row' }, ...info.pools.map((pool: string, i: number) => h('button', { type: 'button', id: `pool-${i}`, onclick: () => busy(document.getElementById(`pool-${i}`) as HTMLButtonElement, 'Checking…', box, async () => {
        renderTornadoDeposit(await wallet.tornadoDepositPrepare(pool, chain), sym);
      }) }, `${pool} ${sym}`)))),
    chain === 'eth' && splitPanel(box),
    h('h3', {}, 'Your deposits'),
    info.notes.length
      ? h('div', { id: 'tornado-notes' }, ...info.notes.map((n: any) => h('div', { class: 'panel note-row' },
        h('div', {}, h('strong', {}, `${n.pool} ${sym}`),
          h('div', { class: 'small muted' }, n.status === 'scheduled' && n.at ? `${n.scheduledKind === 'deposit' ? 'Deposit' : 'Withdrawal'} goes out around ${atText(n.at)}` : `${NOTE_STATUS[n.status] ?? n.status} · ${when(n.createdAt)}`),
          n.sendTo && n.status === 'deposited' && n.at && h('div', { class: 'small muted' }, `Sent on to ${n.sendTo.slice(0, 8)}…${n.sendTo.slice(-4)} around ${atText(n.at)}, while the app is open.`),
          n.problem && h('div', { class: 'small warn-text' }, n.problem)),
        h('div', { class: 'note-actions' },
          n.status === 'deposited' && h('button', { type: 'button', class: 'secondary', id: `withdraw-${n.index}`, onclick: () => renderTornadoWithdraw(n, info.relayer, sym) }, 'Withdraw'),
          h('button', { type: 'button', class: 'secondary', id: `backup-${n.index}`, onclick: () => renderTornadoBackup(n) }, 'Backup')))))
      : h('p', { class: 'empty', id: 'tornado-empty' }, 'No deposits yet.'),
    engine,
    chain === 'eth' && h('form', { class: 'panel', onsubmit: (e: Event) => {
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

/** An amount that isn't one of the pools' own, made of several fixed deposits, at once or spread out. */
function splitPanel(box: ReturnType<typeof errorBox>): HTMLElement {
  const amount = numbersOnly(h('input', { id: 'tornado-split-amount', class: 'amount-input', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' }) as HTMLInputElement);
  const spread = h('input', { type: 'checkbox', id: 'tornado-split-spread', checked: true }) as HTMLInputElement;
  const go = h('button', { type: 'submit', class: 'secondary', id: 'tornado-split-next' }, 'Plan deposits');
  return h('form', { class: 'panel', onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Checking…', box, async () => { renderTornadoSplit(await wallet.tornadoSplitPrepare(amount.value, spread.checked)); });
  } }, h('span', { class: 'label' }, 'Deposit another amount'),
  h('div', { class: 'input-wrap' }, amount, h('span', { class: 'unit' }, 'ETH')),
  h('label', { class: 'check' }, spread, h('span', {}, 'Spread the deposits over a few hours')),
  h('p', { class: 'small muted' }, 'It is split into the pools\' fixed amounts. Spread out, each deposit after the first goes at a random time 30 minutes to 4 hours after the one before, so they don\'t arrive as one group. Don\'t send other ETH from this wallet until they are all in.'),
  go);
}

function renderTornadoSplit(p: any): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-split', type: 'submit' }, `Deposit ${p.total} ETH`);
  show('send', subBar('Tornado deposits', () => { void wallet.cancelSend(p.id); void renderTornado(); }), h('div', { class: 'scroll' },
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, 'Sending…', box, async () => {
        const notes = await wallet.tornadoSplitConfirm(p.id, pw.value);
        pw.value = '';
        void refresh();
        await renderTornado(p.spread && notes.length > 1 ? `The first deposit is sent. The other ${notes.length - 1} go out over the next hours while the app is open.` : `Deposited ${p.total} ETH.`);
      });
    } }, box.el,
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'Deposits'), h('td', { id: 'review-split' }, p.pools.map((x: string) => `${x} ETH`).join(' + '))),
      h('tr', {}, h('th', {}, 'Stays in the wallet'), h('td', { id: 'review-left' }, `${p.left} ETH`)),
      h('tr', {}, h('th', {}, 'Estimated fees'), h('td', { id: 'review-fee' }, reviewFee(p.fee, 'ETH'))),
      h('tr', {}, h('th', {}, 'When'), h('td', {}, p.spread ? 'The first now, the rest spread over the next hours' : 'All now'))))),
    h('p', { class: 'small muted' }, 'Each deposit\'s secret comes from your seed. Scheduled deposits are signed now and kept encrypted on this device; they go out while the wallet is open.'),
    h('br'), h('label', { class: 'field' }, h('span', {}, 'Password'), pw), go)));
  pw.focus();
}

function renderTornadoDeposit(p: any, sym = 'ETH'): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const sendTo = h('input', { id: 'tornado-send-to', spellcheck: 'false', autocomplete: 'off', placeholder: 'Optional: an address unrelated to this wallet' }) as HTMLInputElement;
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-deposit', type: 'submit' }, `Deposit ${p.pool} ${sym}`);
  show('send', subBar('Tornado deposit', () => { void wallet.cancelSend(p.id); void renderTornado(); }), h('div', { class: 'scroll' },
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, 'Sending…', box, async () => {
        const note = await wallet.tornadoDepositConfirm(p.id, p.pool, pw.value, { chain: p.chain, sendTo: sendTo.value.trim() });
        pw.value = '';
        void refresh();
        await renderTornado(note.sendTo ? `Deposited ${p.pool} ${sym}. It is sent on around ${atText(note.at)}, while the app is open.` : `Deposited ${p.pool} ${sym}. It can be withdrawn after confirmation.`);
      });
    } }, box.el,
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'Amount'), h('td', { id: 'review-amount' }, `${p.amount} ${sym}`)),
      h('tr', {}, h('th', {}, 'Estimated fee'), h('td', { id: 'review-fee' }, reviewFee(p.fee, TORNADO_ASSET[p.chain] ?? 'ETH'))),
      h('tr', {}, h('th', {}, 'Pool address'), h('td', {}, h('div', { class: 'addr-check', id: 'review-pool' }, p.to)))))),
    h('p', { class: 'small muted' }, 'The deposit secret comes from your seed. Lose the seed and this amount is lost too. To use it in another tool, copy the note from Backup.'),
    h('label', { class: 'field' }, h('span', {}, 'Send on to'), sendTo, h('div', { class: 'hint' }, 'Optional. A relayer sends it to this address at a random time 1 to 24 hours after the deposit, less its fee, while the app is open. Leave it empty to withdraw yourself later.')),
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

function renderTornadoWithdraw(n: any, savedRelayer: string, sym = 'ETH'): void {
  const ethOnly = (n.chain ?? 'eth') === 'eth';
  const fresh = h('input', { type: 'checkbox', id: 'tornado-fresh', checked: ethOnly }) as HTMLInputElement;
  const to = h('input', { id: 'tornado-to', spellcheck: 'false', autocomplete: 'off', placeholder: 'A new address unrelated to the deposit' });
  const toRow = h('label', { class: 'field', hidden: ethOnly }, h('span', {}, `Receiving ${sym} address`), to);
  const auto = h('input', { type: 'checkbox', id: 'tornado-auto-relayer', checked: true }) as HTMLInputElement;
  const relayer = h('input', { id: 'tornado-relayer', spellcheck: 'false', autocomplete: 'off', value: savedRelayer, placeholder: 'https://… or .onion' });
  const relayerRow = h('label', { class: 'field', hidden: true }, h('span', {}, 'Relayer address'), relayer, h('div', { class: 'hint' }, 'Empty means this wallet sends it, which links it to the deposit address.'));
  fresh.addEventListener('change', () => { toRow.hidden = fresh.checked; });
  auto.addEventListener('change', () => { relayerRow.hidden = auto.checked; });
  const progress = h('p', { class: 'small muted', id: 'tornado-progress', role: 'status' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'tornado-next', type: 'submit' }, 'Next');
  show('send', subBar(`Withdraw ${n.pool} ${sym}`, () => void renderTornado()), h('div', { class: 'scroll' }, box.el,
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      onTornadoProgress = (m) => { progress.textContent = m; };
      const target = fresh.checked ? 'new' : to.value;
      const via = auto.checked ? 'auto' : relayer.value;
      busy(go, auto.checked ? 'Finding a relayer… The first time reads the relayer list, which takes a few minutes.' : 'Checking…', box, async () => {
        renderTornadoWithdrawReview(n, await wallet.tornadoWithdrawQuote(n.id, target, via), target, savedRelayer, sym);
      });
    } },
    ethOnly && h('label', { class: 'check' }, fresh, h('span', {}, 'To a new address in this wallet (recommended)')),
    toRow,
    h('label', { class: 'check' }, auto, h('span', {}, 'Pick a relayer automatically (recommended)')),
    h('p', { class: 'small muted' }, 'A relayer sends the withdrawal for you and takes its fee from the amount, so the new address needs no ETH and nothing links it to this wallet. One is picked at random from the cheapest working ones on the Tornado relayer registry, as the Tornado site does.'),
    relayerRow,
    progress,
    go)));
}

function renderTornadoWithdrawReview(n: any, q: any, to: string, savedRelayer: string, sym = 'ETH'): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const progress = h('p', { class: 'small muted', id: 'tornado-progress', role: 'status' });
  const whenSel = h('select', { id: 'tornado-when' },
    h('option', { value: '0' }, 'Now'),
    ...(q.mode === 'relayer' ? [h('option', { value: '1' }, 'At a random time in the next 1 to 24 hours')] : [])) as HTMLSelectElement;
  const go = h('button', { class: 'primary', id: 'confirm-withdraw', type: 'submit' }, 'Make proof and withdraw');
  const hidden = q.after === null ? 'Not known yet: the deposit list is read during the withdrawal.' : `${q.after} deposits since yours`;
  show('send', subBar('Review withdrawal', () => renderTornadoWithdraw(n, savedRelayer, sym)), h('div', { class: 'scroll' },
    q.mode === 'self' && h('div', { class: 'warn', id: 'tornado-self-warn' }, 'This wallet sends directly, with no relayer. The chain links the deposit and receiving addresses, so there is almost no privacy benefit.'),
    ...(q.warnings ?? []).map((w: string, i: number) => h('div', { class: 'warn', id: `tornado-warn-${i}` }, w)),
    box.el,
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      onTornadoProgress = (m) => { progress.textContent = m; };
      busy(go, 'In progress…', box, async () => {
        if (q.mode === 'relayer' && q.relayerUrl !== savedRelayer) void wallet.updateSettings({ tornadoRelayer: q.relayerUrl }).catch(() => undefined);
        const delay = Number(whenSel.value) || 0;
        const note = await wallet.tornadoWithdraw(n.id, to, q.mode === 'relayer' ? q.relayerUrl : '', pw.value, { delayMinutes: delay });
        pw.value = '';
        void refresh();
        await renderTornado(note.status === 'scheduled' ? `The withdrawal goes out around ${atText(note.at)} while the app is open.` : `Sent the withdrawal of ${q.receive} ${sym}.`);
      });
    } },
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'You receive'), h('td', { id: 'review-receive' }, `${q.receive} ${sym}`)),
      h('tr', {}, h('th', {}, q.mode === 'self' ? 'Gas (from this wallet)' : 'Relayer fee'), h('td', { id: 'review-fee' }, reviewFee(q.fee, TORNADO_ASSET[q.chain] ?? 'ETH'))),
      q.mode === 'relayer' && h('tr', {}, h('th', {}, 'Relayer'), h('td', { id: 'review-relayer' }, q.relayerUrl.replace(/^https?:\/\//, ''))),
      h('tr', {}, h('th', {}, 'Receiving address'), h('td', {}, h('div', { class: 'addr-check', id: 'review-to' }, q.recipient), q.fresh && h('div', { class: 'small muted' }, 'A new address in this wallet. Find it under ETH, Receive.'))),
      h('tr', {}, h('th', {}, 'Hidden among'), h('td', { id: 'review-after' }, hidden)),
      h('tr', {}, h('th', {}, 'Deposited'), h('td', {}, q.hours < 1 ? 'Less than an hour ago' : `${q.hours} hours ago`))))),
    h('label', { class: 'field' }, h('span', {}, 'When to withdraw'), whenSel,
      q.mode === 'relayer' && h('div', { class: 'hint' }, 'Later: the proof is made and handed to a relayer at a random time 1 to 24 hours from now, while the app is open. Withdrawals at random times are harder to match with deposits.')),
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
