// Private transfers: sSCRT, LTC MWEB, Dash and Bitcoin CoinJoin, Firo Spark, Zcash; and the coin picker.
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

// ---- Dash CoinJoin ----

const CJ_STEPS: Record<string, string> = {
  checking: 'Checking coins…', masternodes: 'Getting the masternode list…', connecting: 'Connecting to a masternode…',
  queued: 'Waiting for others to join the mix…', mixing: 'Mixing with others…', signing: 'Signing the mix…',
  waiting: 'Waiting for coins to confirm.', done: 'All coins are mixed.',
};

function coinjoinStatusText(cj: any): string {
  if (Number(cj.total) === 0) return '';
  if (!cj.running) return 'Mixing is paused.';
  if (cj.step === 'retrying') return `Trying again soon: ${cj.error ?? ''}`;
  return CJ_STEPS[cj.step] ?? 'Starting…';
}

/** Mixed and mixing DASH, what the mixer is doing, and its controls. */
function coinjoinPanel(cj: any): HTMLElement {
  const has = Number(cj.total) > 0;
  const pause = async (paused: boolean) => { try { await wallet.coinjoinPause(paused); await refresh(); void renderAsset(); } catch (e) { toast(errMsg(e)); } };
  return h('div', { class: 'panel', id: 'coinjoin-panel' },
    has
      ? h('p', { class: 'small', id: 'cj-balance' }, `CoinJoin: ${shortAmount(cj.mixed)} DASH mixed, ${shortAmount(cj.mixing)} DASH still mixing (${cj.progress}% of ${cj.rounds} rounds).`)
      : h('p', { class: 'small', id: 'cj-intro' }, 'CoinJoin mixes your DASH with other people\'s through Dash masternodes, so which coins are yours can\'t be told apart on the chain. Mixing runs while the wallet is open and can take hours.'),
    has && h('p', { class: 'small muted', id: 'cj-step' }, coinjoinStatusText(cj)),
    h('br'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'secondary', id: 'cj-mix', onclick: () => renderDashMix() }, has ? 'Mix more DASH' : 'Mix DASH'),
      has && (cj.running
        ? h('button', { class: 'ghost', id: 'cj-pause', onclick: () => void pause(true) }, 'Pause mixing')
        : h('button', { class: 'ghost', id: 'cj-resume', onclick: () => void pause(false) }, 'Resume mixing'))));
}

// ---- Bitcoin CoinJoin ----

/** Kept in step with COINJOIN_COORDINATORS in btc-mix.ts. */
const COORDINATORS: [string, string][] = [['https://coinjoin.kruw.io/', 'Kruw'], ['https://api.opencoordinator.org/', 'OpenCoordinator'], ['https://coinjoin.nl/', 'Noderunners']];

function btcMixStatusText(m: any): string {
  const n = m.inputs ?? 0;
  if (m.running) {
    if (m.stage === 'waiting') return m.detail === 'tor' ? 'Waiting for Tor to connect.' : m.detail === 'confirmations' ? 'Waiting for the mixed coins to confirm, then they go round again.' : 'Waiting for a round to start.';
    if (m.stage === 'registering') return 'Registering your coins in a round.';
    if (m.stage === 'confirming') return `Your coins are in a round (${n} inputs so far). Waiting for it to fill up.`;
    if (m.stage === 'outputs') return `The round is full (${n} inputs). Registering the mixed outputs.`;
    if (m.stage === 'signing') return `Checking the transaction (${n} inputs) and signing it.`;
    if (m.stage === 'failed') return `That round didn't finish: ${m.detail ?? ''} Trying the next one.`;
    return 'Starting…';
  }
  if (m.stage === 'done') return 'Mixing finished.';
  if (m.last?.ok) return 'The last round finished. The mixed coins arrive once the transaction is in a block.';
  if (m.last && !m.last.ok) return `The last round didn't finish: ${m.last.reason ?? ''}`;
  return '';
}

/** Mixed BTC, what the mixer is doing, and its controls. */
function btcMixPanel(m: any): HTMLElement {
  const mixed = Number(m.mixed) > 0;
  const stop = async () => { try { await wallet.btcMixStop(); await refresh(); void renderAsset(); } catch (e) { toast(errMsg(e)); } };
  const text = btcMixStatusText(m);
  return h('div', { class: 'panel', id: 'btc-coinjoin-panel' },
    mixed
      ? h('p', { class: 'small', id: 'btc-cj-balance' }, `Mixed (CoinJoin): ${shortAmount(m.mixed)} BTC.`)
      : h('p', { class: 'small', id: 'btc-cj-intro' }, 'CoinJoin mixes your BTC with other people\'s in one transaction, so which coins are yours can\'t be told apart on the chain. It runs over Tor while the wallet is open, and a round can take an hour or more.'),
    text && h('p', { class: 'small muted', id: 'btc-cj-step' }, text),
    h('br'),
    h('div', { class: 'btn-row' },
      m.running
        ? h('button', { class: 'ghost', id: 'btc-cj-stop', onclick: () => void stop() }, 'Stop mixing')
        : h('button', { class: 'secondary', id: 'btc-cj-mix', onclick: () => void renderBtcMix() }, 'Mix BTC')));
}

/** The coins to mix (all regular coins that aren't frozen, or the ones picked), then the password to start. */
async function renderBtcMix(): Promise<void> {
  const coins = coinControl('mix');
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const summary = h('div', { class: 'panel', id: 'btc-cj-summary' }, h('div', { class: 'small muted' }, 'Loading…'));
  const go = h('button', { class: 'primary', id: 'btc-cj-start', type: 'submit' }, 'Start mixing');
  const paint = async () => {
    try {
      const info = await wallet.btcMixInfo(coins.chosen.size ? [...coins.chosen] : undefined);
      setKids(summary, h('table', { class: 'review-table' }, h('tbody', {},
        h('tr', {}, h('th', {}, 'To mix'), h('td', { id: 'btc-cj-amount' }, `${info.amount} BTC`)),
        h('tr', {}, h('th', {}, 'Coins'), h('td', { id: 'btc-cj-count' }, String(info.count))),
        info.remix > 0 && h('tr', {}, h('th', {}, 'Mixed again'), h('td', { id: 'btc-cj-remix' }, `${info.remix} (${info.remixAmount} BTC)`)),
        h('tr', {}, h('th', {}, 'Goal'), h('td', { id: 'btc-cj-target' }, info.target > 1 ? `Each coin hidden among at least ${info.target} others` : 'Mix once')),
        h('tr', {}, h('th', {}, 'Coordinator'), h('td', { id: 'btc-cj-coordinator' }, info.coordinator)))),
        info.count > info.perRound && h('p', { class: 'small muted' }, `Up to ${info.perRound} coins go into each round; the rest follow in later rounds.`),
        !info.tor && h('div', { class: 'warn', id: 'btc-cj-no-tor' }, 'CoinJoin needs Tor. Turn it on in Settings first.'));
      go.disabled = (!info.count && !info.remix) || !info.tor;
    } catch (e) { box.show(e); }
  };
  coins.onChange = () => void paint();
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Starting…', box, async () => {
      await wallet.btcMixStart(pw.value, coins.chosen.size ? [...coins.chosen] : undefined);
      pw.value = '';
      toast('Mixing started. Keep the wallet open until it finishes.');
      await refresh();
      void renderAsset();
    });
  } },
  box.el,
  h('p', { class: 'small muted' }, 'Your coins are split into common amounts together with everyone else\'s, and come back in your CoinJoin balance. The coordinator charges nothing; the mining fee is shared by everyone in the round. Each request leaves on its own Tor route, and nothing is signed until the transaction pays your outputs in full.'),
  summary,
  coins.el,
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
  go);
  show('send', subBar('Mix BTC', () => void renderAsset()), h('div', { class: 'scroll' }, form));
  await paint();
}

/** How much regular DASH to split into CoinJoin's sizes, then a review. */
function renderDashMix(): void {
  const amount = numbersOnly(h('input', { id: 'cj-amount', class: 'amount-input', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' }) as HTMLInputElement);
  const box = errorBox();
  const next = h('button', { class: 'primary', id: 'cj-next', type: 'submit' }, 'Next');
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(next, 'Calculating the fee…', box, async () => renderDashMixReview(await wallet.prepareDashMix(amount.value)));
  } },
  box.el,
  h('p', { class: 'small muted' }, 'The amount is split into coins of 10, 1, 0.1, 0.01 and 0.001 DASH, the sizes everyone mixes in, plus a few tiny collateral coins. What doesn\'t fit a size stays in your regular balance.'),
  h('br'),
  h('div', { class: 'panel' }, h('label', { class: 'label', for: 'cj-amount' }, 'Amount to mix'),
    h('div', { class: 'input-wrap' }, amount, h('span', { class: 'unit' }, 'DASH'),
      h('button', { type: 'button', class: 'max', id: 'cj-max', onclick: () => { amount.value = 'max'; } }, 'Max'))),
  h('br'),
  next);
  show('send', subBar('Mix DASH', () => void renderAsset()), h('div', { class: 'scroll' }, form));
  amount.focus();
}

function renderDashMixReview(p: any): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'confirm-send', type: 'submit' }, `Mix ${p.amount} DASH`);
  const back = () => { void wallet.cancelSend(p.id); renderDashMix(); };
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Sending…', box, async () => {
      await wallet.confirmSend(p.id, pw.value);
      pw.value = '';
      toast('Sent. Mixing starts once the coins are in a block.');
      void refresh();
      void renderAsset();
    });
  } },
  box.el,
  ...p.warnings.map((w: string) => h('div', { class: 'warn' }, w)),
  h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
    h('tr', {}, h('th', {}, 'Amount'), h('td', {}, h('div', { class: 'big-amount', id: 'review-amount' }, `${p.amount} DASH → CoinJoin`))),
    h('tr', {}, h('th', {}, 'Coins'), h('td', { id: 'review-coins' }, String(p.coins))),
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
