// Private transfers: LTC MWEB, Dash and Bitcoin CoinJoin, Firo Spark, Zcash; and the coin picker.
// ---- Litecoin MWEB ----

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

// ---- Decred mixing (StakeShuffle) ----

function dcrMixPanel(m: any): HTMLElement {
  const mixed = Number(m.mixed) > 0;
  const stop = async () => { try { await wallet.dcrMixStop(); await refresh(); void renderAsset(); } catch (e) { toast(errMsg(e)); } };
  return h('div', { class: 'panel', id: 'dcr-mix-panel' },
    mixed
      ? h('p', { class: 'small', id: 'dcr-mix-balance' }, `Mixed (StakeShuffle): ${shortAmount(m.mixed)} DCR.`)
      : h('p', { class: 'small', id: 'dcr-mix-intro' }, 'StakeShuffle mixes your DCR with other Decred users\' in one transaction, into coins of the same sizes, so which coins are yours can\'t be told apart on the chain. It runs over Tor while the wallet is open; a mix happens every 10 minutes when others are mixing too.'),
    m.running && m.step && h('p', { class: 'small muted', id: 'dcr-mix-step' }, m.mixing ? `${m.step} (${m.mixing})` : m.step),
    m.mixes > 0 && h('p', { class: 'small muted', id: 'dcr-mix-count' }, m.mixes === 1 ? 'One mix done since starting.' : `${m.mixes} mixes done since starting.`),
    m.error && h('p', { class: 'small warn', id: 'dcr-mix-error' }, m.error),
    h('br'),
    m.running
      ? h('button', { class: 'ghost', id: 'dcr-mix-stop', onclick: () => void stop() }, 'Stop mixing')
      : h('button', { class: 'secondary', id: 'dcr-mix-open', onclick: () => void renderDcrMix() }, 'Mix DCR'));
}

async function renderDcrMix(): Promise<void> {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' }) as HTMLInputElement;
  const box = errorBox();
  const summary = h('div', { class: 'panel', id: 'dcr-mix-summary' }, h('div', { class: 'small muted' }, 'Loading…'));
  const go = h('button', { class: 'primary', id: 'dcr-mix-start', type: 'submit' }, 'Start mixing') as HTMLButtonElement;
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Starting…', box, async () => {
      await wallet.dcrMixStart(pw.value);
      pw.value = '';
      toast('Mixing started. Keep the wallet open; it goes on until every coin is mixed.');
      await refresh();
      void renderAsset();
    });
  } },
  box.el,
  h('p', { class: 'small muted' }, 'Each coin is split into up to four coins of one standard size (the sizes Decred\'s own wallet uses), mixed with other people\'s coins of that size, and comes back in your mixed balance. Change returns to your regular balance and is mixed again later. Nobody, other mixers included, learns which new coins are yours. The only cost is a small network fee.'),
  summary,
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
  go);
  show('send', subBar('Mix DCR', () => void renderAsset()), h('div', { class: 'scroll' }, form));
  try {
    const info = await wallet.dcrMixInfo();
    setKids(summary, h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'To mix'), h('td', { id: 'dcr-mix-amount' }, `${info.amount} DCR`)),
      h('tr', {}, h('th', {}, 'Coins'), h('td', { id: 'dcr-mix-coins' }, String(info.count))))),
      !info.tor && h('div', { class: 'warn', id: 'dcr-mix-no-tor' }, 'Mixing needs Tor. Turn it on in Settings first.'),
      !info.count && h('p', { class: 'small muted', id: 'dcr-mix-none' }, 'No coins to mix yet: they need a confirmation and at least 0.003 DCR.'));
    go.disabled = !info.tor || !info.count;
  } catch (e) { box.show(e); }
}

// ---- Decred tickets (staking through a VSP) ----

function dcrStakePanel(): HTMLElement {
  return h('div', { class: 'panel', id: 'dcr-stake-panel' },
    h('p', { class: 'small' }, 'Staking: lock DCR in tickets that vote on Decred\'s blocks and earn a reward. A Voting Service Provider (VSP) votes for you; your DCR never leaves your control.'), h('br'),
    h('button', { class: 'secondary', id: 'dcr-stake-open', onclick: () => void renderDcrStake() }, 'Tickets'));
}

function dcrTicketText(t: any): string {
  if (t.state === 'failed') return 'Not mined: its DCR is back in your balance';
  if (t.state === 'new') return 'The VSP fee isn\'t paid yet';
  if (t.status === 'voted') return 'Voted: the reward can be spent after 256 blocks';
  if (t.status === 'revoked') return 'Revoked: its DCR came back';
  if (t.status === 'missed' || t.status === 'expired') return 'Didn\'t vote: its DCR is coming back';
  if (t.status === 'live') return 'Live: waiting to be chosen to vote';
  if (t.status === 'immature') return 'Maturing (256 blocks)';
  return 'Waiting to be mined';
}

async function renderDcrStake(): Promise<void> {
  const body = h('div', {}, h('p', { class: 'empty' }, 'Loading…'));
  show('send', subBar('Decred tickets', () => void renderAsset()), h('div', { class: 'scroll' }, body));
  let info: any;
  try { info = await wallet.dcrStakeInfo(); } catch (e) { setKids(body, h('div', { class: 'warn' }, errMsg(e))); return; }
  if (!body.isConnected) return;
  const unpaid = info.tickets.filter((t: any) => t.state === 'new').length;
  const pw = h('input', { type: 'password', id: 'dcr-finish-pw', autocomplete: 'current-password' }) as HTMLInputElement;
  const box = errorBox();
  const finish = h('button', { class: 'primary', id: 'dcr-finish', type: 'submit' }, 'Pay the VSP fee') as HTMLButtonElement;
  setKids(body,
    h('table', { class: 'review-table' }, h('tbody', {},
      h('tr', {}, h('th', {}, 'Ticket price'), h('td', { id: 'dcr-price' }, `${info.price} DCR`)),
      h('tr', {}, h('th', {}, 'Your tickets'), h('td', { id: 'dcr-count' }, String(info.tickets.filter((t: any) => t.state !== 'failed').length))))),
    h('p', { class: 'small muted' }, 'A ticket votes on average about 28 days after it is bought (at most about 142 days). Until then its DCR is locked; afterwards it comes back to this wallet with the reward. If the VSP fails to vote, the ticket is revoked and the DCR still comes back.'),
    unpaid > 0 && h('form', { class: 'panel', id: 'dcr-finish-form', onsubmit: (e: Event) => {
      e.preventDefault();
      busy(finish, 'Paying…', box, async () => {
        const r = await wallet.dcrStakeFinish(pw.value);
        pw.value = '';
        if (r.problem) throw new Error(r.problem);
        toast('VSP fee paid.');
        void renderDcrStake();
      });
    } },
    h('p', { class: 'small' }, unpaid === 1 ? 'One ticket is waiting for its VSP fee. It can\'t vote until the fee is paid.' : `${unpaid} tickets are waiting for their VSP fee. They can't vote until it is paid.`),
    box.el,
    h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
    finish),
    info.canBuy
      ? h('button', { class: 'primary', id: 'dcr-buy-open', onclick: () => void renderDcrBuy(info) }, 'Buy tickets')
      : h('div', { class: 'warn', id: 'dcr-wait' }, 'The ticket price changes with the next block. Come back in a few minutes.'),
    h('br'),
    h('div', { class: 'list', id: 'dcr-tickets' },
      info.tickets.length
        ? info.tickets.map((t: any) => h('button', { class: 'hist-row', title: 'Open in explorer', onclick: () => void openExplorer('DCR', t.hash) },
          coin('DCR'),
          h('div', {}, h('div', {}, dcrTicketText(t)),
            t.state === 'paid' && !t.feeConfirmed && h('div', { class: 'small muted' }, 'The VSP sends its fee after 6 confirmations.'),
            t.error && t.state !== 'paid' && t.state !== 'done' && h('div', { class: 'small muted' }, t.error),
            h('div', { class: 'small muted' }, `${when(t.boughtAt)} · ${t.vsp}`)),
          h('div', { class: 'amt' }, `${t.price} DCR`)))
        : h('p', { class: 'empty' }, 'No tickets yet.')));
}

async function renderDcrBuy(info: any): Promise<void> {
  const box = errorBox();
  const vsp = h('select', { id: 'dcr-vsp' }, h('option', { value: '' }, 'Loading the list of VSPs…')) as HTMLSelectElement;
  const custom = h('input', { id: 'dcr-vsp-url', autocomplete: 'off', placeholder: 'https://', value: info.vsp ?? '' }) as HTMLInputElement;
  const count = numbersOnly(h('input', { id: 'dcr-count-input', class: 'amount-input', inputmode: 'numeric', autocomplete: 'off', value: '1' }) as HTMLInputElement);
  const next = h('button', { class: 'primary', id: 'dcr-quote', type: 'submit' }, 'Review') as HTMLButtonElement;
  const useMixed = Number(overview?.dcrMix?.mixedSpendable ?? 0) > 0 ? h('input', { type: 'checkbox', id: 'dcr-buy-mixed', checked: true }) as HTMLInputElement : null;
  const chosen = () => (vsp.value === 'custom' || !vsp.value ? custom.value.trim() : vsp.value);
  const customRow = h('label', { class: 'field', id: 'dcr-vsp-custom' }, h('span', {}, 'VSP address'), custom);
  const syncCustom = () => { customRow.style.display = vsp.value === 'custom' ? '' : 'none'; };
  vsp.onchange = syncCustom;
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(next, 'Asking the VSP…', box, async () => renderDcrReview(await wallet.dcrStakeQuote(Number(count.value), chosen(), !!useMixed?.checked), info));
  } },
  box.el,
  h('p', { class: 'small muted' }, 'The VSP gets a key that can only vote with these tickets; it can\'t move any DCR. It learns which tickets are yours, so a VSP you trust (or one on your own server) is best. Every request to it goes over its own Tor route.'),
  h('label', { class: 'field' }, h('span', {}, 'VSP'), vsp),
  customRow,
  h('div', { class: 'panel' }, h('label', { class: 'label', for: 'dcr-count-input' }, `Tickets (1 to ${info.max})`),
    h('div', { class: 'input-wrap' }, count, h('span', { class: 'unit' }, `× ${info.price} DCR`))),
  useMixed && h('label', { class: 'check', id: 'dcr-buy-mixed-row' }, useMixed, h('span', {}, `Buy with mixed DCR (${shortAmount(overview.dcrMix.mixedSpendable)} DCR): the tickets aren't linked to your other coins, and their DCR comes back to the mixed balance.`)),
  h('br'),
  next);
  show('send', subBar('Buy tickets', () => void renderDcrStake()), h('div', { class: 'scroll' }, form));
  try {
    const list: any[] = await wallet.dcrVspList();
    setKids(vsp, ...list.map((v) => h('option', { value: v.url }, `${new URL(v.url).host} · ${v.feePercentage}% fee`)), h('option', { value: 'custom' }, 'Enter an address…'));
    if (info.vsp) vsp.value = list.some((v) => v.url === info.vsp) ? info.vsp : 'custom';
  } catch {
    setKids(vsp, h('option', { value: 'custom' }, 'Enter an address…'));
    vsp.value = 'custom';
  }
  syncCustom();
}

function renderDcrReview(q: any, info: any): void {
  const pw = h('input', { type: 'password', id: 'confirm-pw', autocomplete: 'current-password' }) as HTMLInputElement;
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'dcr-buy', type: 'submit' }, q.count === 1 ? 'Buy 1 ticket' : `Buy ${q.count} tickets`) as HTMLButtonElement;
  go.disabled = !q.enough;
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Buying…', box, async () => {
      const r = await wallet.dcrStakeBuy(q.count, q.vsp, pw.value, !!q.fromMixed);
      pw.value = '';
      await refresh();
      if (r.problem) toast(`Bought, but a VSP fee didn't go through: ${r.problem}`);
      else toast(r.bought === 1 ? 'Ticket bought.' : `${r.bought} tickets bought.`);
      void renderDcrStake();
    });
  } },
  box.el,
  h('table', { class: 'review-table' }, h('tbody', {},
    h('tr', {}, h('th', {}, 'VSP'), h('td', { id: 'dcr-review-vsp' }, `${new URL(q.vsp).host} (${q.vspFeePercent}%)`)),
    h('tr', {}, h('th', {}, 'Tickets'), h('td', { id: 'dcr-review-count' }, `${q.count} × ${q.price} DCR`)),
    h('tr', {}, h('th', {}, 'Locked until they vote'), h('td', { id: 'dcr-review-locked' }, `${q.locked} DCR`)),
    h('tr', {}, h('th', {}, 'VSP fee'), h('td', { id: 'dcr-review-vspfee' }, `${q.vspFee} DCR`)),
    h('tr', {}, h('th', {}, 'Network fees'), h('td', { id: 'dcr-review-fees' }, `${q.ticketFees} DCR`)),
    h('tr', {}, h('th', {}, 'Total'), h('td', { id: 'dcr-review-total' }, `${q.total} DCR`)))),
  !q.enough && h('div', { class: 'warn', id: 'dcr-not-enough' }, `Not enough spendable DCR: ${q.held} DCR is needed while buying (the VSP fee is set aside until it is paid).`),
  h('p', { class: 'small muted' }, 'Nothing reaches the chain until the VSP accepts the tickets; it then broadcasts them. If a ticket isn\'t mined before the price changes, its DCR returns to your balance.'),
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
  go);
  show('send', subBar('Review', () => void renderDcrBuy(info)), h('div', { class: 'scroll' }, form));
}
