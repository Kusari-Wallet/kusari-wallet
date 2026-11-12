// Tornado Cash and the privacy swap status.
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
