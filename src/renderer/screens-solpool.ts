// The Solana private pool (SOL, USDC and USDT on Solana): set up, deposit, private balance, sends out of the pool.

let onSolPoolProgress: ((m: string) => void) | null = null;
const solPoolCache: Record<string, { at: number; info: any }> = {};
wallet.on('sol-pool-progress', (m: string) => {
  onSolPoolProgress?.(m);
  if (/^scanned:/.test(m)) { for (const k of Object.keys(solPoolCache)) solPoolCache[k].at = 0; if (POOL_ASSETS.includes(selected) && document.getElementById('sol-pool-panel')) void renderAsset(); }
});
const POOL_ASSETS: string[] = ['SOL', 'USDCS', 'USDTS'];
const POOL_STAGE: Record<string, string> = {
  proof: 'Making the proof… (about a minute, longer on a phone)',
  path: 'Getting the pool\'s tree path…',
  send: 'Handing it to the pool relayer…',
};

/** The panel on the coin's screen: filled from the last answer at once, then refreshed. */
function solPoolPanel(asset: string): HTMLElement {
  const box = h('div', { class: 'panel', id: 'sol-pool-panel' });
  const fill = (info: any) => {
    const sym = info.symbol;
    if (!info.enabled) {
      setKids(box,
        h('p', { class: 'small', id: 'sol-pool-intro' }, `Private pool: deposit ${sym} into a shared pool and send it out later to any address, with nothing on the chain linking the two. It works like Tornado Cash, on Solana (PrivacyCash).`),
        h('br'),
        h('button', { class: 'secondary', id: 'sol-pool-setup', onclick: () => renderSolPoolSetup(asset) }, 'Set up the private pool'));
      return;
    }
    const scan = info.scanning
      ? (info.scanTotal ? `Looking for your notes… ${Math.max(0, Math.min(100, Math.floor(((info.scanDone ?? 0) / info.scanTotal) * 100)))}%` : 'Looking for your notes…')
      : '';
    setKids(box,
      h('p', { class: 'small', id: 'sol-pool-balance' }, `Private pool: ${hideBalance ? '••••' : `${info.ready} ${sym}`}`),
      Number(info.arriving) > 0 && h('p', { class: 'small muted', id: 'sol-pool-arriving' }, `${info.arriving} ${sym} on its way (shown once the pool has it).`),
      scan && h('p', { class: 'small muted', id: 'sol-pool-scan' }, scan),
      info.error && h('p', { class: 'small warn', id: 'sol-pool-error' }, info.error),
      !info.tor && h('p', { class: 'small warn' }, 'The private pool needs Tor. Turn it on in Settings.'),
      ...info.later.map((l: any) => h('p', { class: 'small muted', id: `sol-pool-later-${l.id}` }, `${l.amount} ${sym} to ${l.to.slice(0, 6)}…${l.to.slice(-4)} goes out around ${atText(l.at)} (while the app is open). `,
        h('button', { class: 'link', onclick: async () => { try { await wallet.solPoolCancelLater(l.id); solPoolCache[asset].at = 0; void renderAsset(); } catch (e) { toast(errMsg(e)); } } }, 'Cancel'))),
      h('br'),
      h('div', { class: 'row' },
        h('button', { class: 'secondary', id: 'sol-pool-deposit', disabled: !info.tor, onclick: () => renderSolPoolDeposit(asset) }, 'Deposit'),
        h('button', { class: 'secondary', id: 'sol-pool-send', disabled: !info.tor || !(Number(info.ready) > 0), onclick: () => renderSolPoolSend(asset) }, 'Send privately')));
  };
  const cached = solPoolCache[asset];
  if (cached) fill(cached.info); else setKids(box, h('p', { class: 'small muted' }, 'Private pool: loading…'));
  if (!cached || Date.now() - cached.at > 10_000) {
    void wallet.solPoolInfo(asset).then((info: any) => { solPoolCache[asset] = { at: Date.now(), info }; fill(info); }, (e: unknown) => { if (!cached) setKids(box, h('p', { class: 'small warn' }, errMsg(e))); });
  }
  return box;
}

/** What to know before using the pool; one tick to agree. */
function solPoolWarnings(): HTMLElement {
  return h('div', { class: 'warn', id: 'sol-pool-warnings' },
    h('p', {}, 'Before you use it:'),
    h('ul', {},
      h('li', {}, 'The pool\'s program can still be changed by its operators (a shared Squads key). A bad change could freeze or take what is in the pool.'),
      h('li', {}, 'Sends out of the pool go through the pool\'s relayer. It sees the receiving address and amount, checks addresses against risk lists, and can refuse a send.'),
      h('li', {}, 'Amounts and timing can link a deposit to a send. Sending out the amount you put in, soon after, shows they go together. Use round amounts, send out different amounts, and wait.'),
      h('li', {}, 'The pool is much smaller than Tornado Cash on Ethereum, so your coins hide among fewer others.'),
      h('li', {}, 'Its proof keys come from a setup with only 4 participants. If all of them kept their secret parts, they could fake proofs and empty the pool (your privacy would not be affected).')));
}

function renderSolPoolSetup(asset: string): void {
  const agree = h('input', { type: 'checkbox', id: 'sol-pool-agree' }) as HTMLInputElement;
  const earlier = h('input', { type: 'checkbox', id: 'sol-pool-earlier' }) as HTMLInputElement;
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'sol-pool-enable', type: 'submit', disabled: true }, 'Turn on') as HTMLButtonElement;
  agree.addEventListener('change', () => { go.disabled = !agree.checked; });
  show('send', subBar('Private pool', () => void renderAsset()), h('div', { class: 'scroll' },
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, 'Turning on…', box, async () => {
        await wallet.solPoolEnable(asset, earlier.checked);
        delete solPoolCache[asset];
        toast(earlier.checked ? 'Looking through the whole pool for your notes. This can take a while.' : 'The private pool is on.');
        void renderAsset();
      });
    } },
    box.el,
    h('p', { class: 'small muted' }, 'Your private balance is found by downloading every note the pool publishes and opening the ones meant for you, here on this device, over Tor. Nobody is told which notes are yours. The pool\'s site shows the same balance if you sign in there with this wallet\'s SOL key.'),
    solPoolWarnings(),
    h('label', { class: 'check' }, earlier, h('span', {}, 'I used the pool before with this SOL key: look through all of it (downloads about 200 MB)')),
    h('label', { class: 'check' }, agree, h('span', {}, 'I understand the above')),
    go)));
}

function renderSolPoolDeposit(asset: string): void {
  const sym = unitOf(asset as Asset);
  const amount = h('input', { id: 'sol-pool-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.0' }) as HTMLInputElement;
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'sol-pool-next', type: 'submit' }, 'Next') as HTMLButtonElement;
  show('send', subBar(`Deposit ${sym}`, () => void renderAsset()), h('div', { class: 'scroll' },
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, 'Checking…', box, async () => renderSolPoolDepositReview(asset, await wallet.solPoolDepositQuote(asset, amount.value.trim())));
    } },
    box.el,
    h('label', { class: 'field' }, h('span', {}, `Amount (${sym})`), amount, h('div', { class: 'hint' }, 'Round amounts (1, 5, 10…) blend in with other people\'s deposits.')),
    go)));
  amount.focus();
}

function renderSolPoolDepositReview(asset: string, q: any): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' }) as HTMLInputElement;
  const box = errorBox();
  const progress = h('p', { class: 'small muted', id: 'sol-pool-progress', role: 'status' });
  const go = h('button', { class: 'primary', id: 'confirm-deposit', type: 'submit' }, 'Deposit') as HTMLButtonElement;
  show('send', subBar('Review deposit', () => renderSolPoolDeposit(asset)), h('div', { class: 'scroll' },
    !q.round && h('div', { class: 'warn', id: 'sol-pool-not-round' }, 'An unusual amount is easier to recognize when it comes out again. A round amount hides better.'),
    box.el,
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      onSolPoolProgress = (m) => { if (POOL_STAGE[m]) progress.textContent = POOL_STAGE[m]; };
      busy(go, 'In progress…', box, async () => {
        const r = await wallet.solPoolDeposit(asset, q.amount, pw.value);
        pw.value = '';
        delete solPoolCache[asset];
        toast(`Deposited ${q.amount} ${q.symbol}. It shows in the private balance once the pool has it.`);
        void refresh();
        void renderAsset();
        void r;
      });
    } },
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'Into the pool'), h('td', { id: 'review-amount' }, `${q.amount} ${q.symbol}`)),
      h('tr', {}, h('th', {}, 'Network costs'), h('td', { id: 'review-fee' }, reviewFee(q.cost, 'SOL')))))),
    h('p', { class: 'small muted' }, 'The deposit is public: anyone can see this address put this amount in. What stays hidden is where it goes when you send it out of the pool. The network costs include two small account deposits the pool program requires.'),
    h('label', { class: 'field' }, h('span', {}, 'Password'), pw), progress, go)));
  pw.focus();
}

function renderSolPoolSend(asset: string): void {
  const sym = unitOf(asset as Asset);
  const to = h('input', { id: 'sol-pool-to', spellcheck: 'false', autocomplete: 'off', placeholder: 'A SOL address' }) as HTMLInputElement;
  const amount = h('input', { id: 'sol-pool-amount', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.0' }) as HTMLInputElement;
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'sol-pool-next', type: 'submit' }, 'Next') as HTMLButtonElement;
  show('send', subBar(`Send ${sym} privately`, () => void renderAsset()), h('div', { class: 'scroll' },
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      busy(go, 'Checking…', box, async () => renderSolPoolSendReview(asset, await wallet.solPoolWithdrawQuote(asset, amount.value.trim() || 'max', to.value.trim())));
    } },
    box.el,
    h('label', { class: 'field' }, h('span', {}, 'To'), to, h('div', { class: 'hint' }, asset === 'SOL' ? 'Any SOL address except this wallet\'s own.' : `A SOL address; the ${sym} goes to its token account, which must already exist.`)),
    h('label', { class: 'field' }, h('span', {}, `Amount (${sym})`), amount, h('div', { class: 'hint' }, 'Empty sends the most one send can take. A different amount from what you deposited is harder to match.')),
    go)));
  to.focus();
}

function renderSolPoolSendReview(asset: string, q: any): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' }) as HTMLInputElement;
  const box = errorBox();
  const progress = h('p', { class: 'small muted', id: 'sol-pool-progress', role: 'status' });
  const whenSel = h('select', { id: 'sol-pool-when' },
    h('option', { value: '0' }, 'Now'), h('option', { value: '60' }, 'Within an hour'), h('option', { value: '360' }, 'Within 6 hours'), h('option', { value: '1440' }, 'Within a day')) as HTMLSelectElement;
  if (q.matchesDeposit || q.soonAfterDeposit) whenSel.value = '360';
  const go = h('button', { class: 'primary', id: 'confirm-withdraw', type: 'submit' }, 'Send') as HTMLButtonElement;
  show('send', subBar('Review', () => renderSolPoolSend(asset)), h('div', { class: 'scroll' },
    q.matchesDeposit && h('div', { class: 'warn', id: 'sol-pool-match' }, 'This is about the amount you deposited. Anyone watching can pair the two. Send a different amount, or in parts.'),
    q.soonAfterDeposit && h('div', { class: 'warn', id: 'sol-pool-soon' }, 'You deposited less than 6 hours ago. Sending later hides better: pick a time below.'),
    box.el,
    h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      onSolPoolProgress = (m) => { if (POOL_STAGE[m]) progress.textContent = POOL_STAGE[m]; };
      busy(go, 'In progress…', box, async () => {
        const r = await wallet.solPoolWithdraw(asset, q.amount, q.to, pw.value, { delayMinutes: Number(whenSel.value) || 0 });
        pw.value = '';
        delete solPoolCache[asset];
        toast(r.scheduledAt ? `It goes out around ${atText(r.scheduledAt)}, while the app is open.` : `Sent ${q.amount} ${q.symbol} out of the pool.`);
        void refresh();
        void renderAsset();
      });
    } },
    h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'They receive'), h('td', { id: 'review-receive' }, `${q.amount} ${q.symbol}`)),
      h('tr', {}, h('th', {}, 'Relayer fee'), h('td', { id: 'review-fee' }, reviewFee(q.fee, q.symbol === 'SOL' ? 'SOL' : asset))),
      h('tr', {}, h('th', {}, 'From the pool'), h('td', { id: 'review-total' }, `${q.total} ${q.symbol}`)),
      h('tr', {}, h('th', {}, 'To'), h('td', {}, h('div', { class: 'addr-check', id: 'review-to' }, q.to)))))),
    h('label', { class: 'field' }, h('span', {}, 'When'), whenSel, h('div', { class: 'hint' }, 'Later: it goes out at a random time in that window, while the app is open.')),
    h('p', { class: 'small muted' }, 'The pool\'s relayer sends it and pays the network fee, so the receiving address needs nothing and isn\'t linked to this wallet. Keep the app open until it finishes.'),
    h('label', { class: 'field' }, h('span', {}, 'Password'), pw), progress, go)));
  pw.focus();
}
