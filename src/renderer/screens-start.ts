// First screens: welcome, creating or restoring a wallet, unlocking.
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
  const terms = termsAgreement();
  const next = h('button', { class: 'primary', id: 'next', disabled: true, onclick: () => busy(next, 'Generating…', box, async () => {
    terms.check();
    const password = f.check();
    createStep2(password, await wallet.generateSeeds());
  }) }, 'Generate seeds');
  terms.el.addEventListener('change', () => { (next as HTMLButtonElement).disabled = !terms.agreed(); });
  entry(h('h2', {}, 'Set a password'), h('p', { class: 'lead' }, 'Entered each time you open the wallet on this device or send coins.'), box.el, ...f.nodes, terms.el,
    h('div', { class: 'btn-row' }, h('button', { class: 'ghost', onclick: welcome }, 'Back'), next));
}

function seedCard(title: string, note: string, phrase: string): HTMLElement {
  return h('div', { class: 'seed' }, h('h3', {}, title), note && h('p', { class: 'muted small' }, note),
    h('ol', { class: 'words' }, ...phrase.split(' ').map((w, i) => h('li', {}, h('i', {}, String(i + 1)), w))));
}

/** Both seeds in one QR code, which this wallet's restore screen reads: kusari-seeds:1?b=<12 words>&m=<25 words>. */
const seedQrText = (seeds: { tronMnemonic: string; moneroSeed: string }) => `kusari-seeds:1?b=${seeds.tronMnemonic.trim().split(/\s+/).join('-')}&m=${seeds.moneroSeed.trim().split(/\s+/).join('-')}`;

/** Reads a seed QR: this wallet's own (both seeds), or a plain list of 12/24 words (BIP39) or 25 words (Monero). */
function parseSeedQr(text: string): { bip39?: string; monero?: string } | null {
  const t = text.trim();
  const own = /^kusari-seeds:1\?b=([a-z-]+)&m=([a-z-]+)$/.exec(t);
  if (own) return { bip39: own[1].split('-').join(' '), monero: own[2].split('-').join(' ') };
  const words = t.toLowerCase().split(/\s+/);
  if (!words.every((w) => /^[a-z]+$/.test(w))) return null;
  if (words.length === 12 || words.length === 24) return { bip39: words.join(' ') };
  if (words.length === 25) return { monero: words.join(' ') };
  return null;
}

/** The seeds as a QR code, hidden until asked for: a picture of it is as good as the seeds themselves. */
function seedQrCard(seeds: { tronMnemonic: string; moneroSeed: string }): HTMLElement {
  const holder = h('div', { class: 'seed-qr', id: 'seed-qr' });
  const show: HTMLButtonElement = h('button', { type: 'button', class: 'secondary', id: 'seed-qr-show', onclick: async () => {
    if (holder.childElementCount) { setKids(holder); show.textContent = 'Show as QR code'; return; }
    const src = await wallet.qr(seedQrText(seeds));
    setKids(holder, h('img', { src, alt: 'Seed QR code', id: 'seed-qr-img' }));
    show.textContent = 'Hide QR code';
  } }, 'Show as QR code');
  return h('div', { class: 'seed' }, h('h3', {}, 'Both seeds as a QR code'),
    h('p', { class: 'muted small' }, 'For restoring this wallet by scanning instead of typing. Anyone who sees or photographs this code can take all your coins: show it only to restore, and keep the written words as the backup.'),
    show, holder);
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
    seedQrCard(seeds),
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
  const terms = termsAgreement();
  const go = h('button', { class: 'primary', id: 'next', disabled: true, onclick: () => busy(go, 'Restoring…', box, async () => {
    terms.check();
    const pw = f.check();
    await withSplash('Restoring the wallet…', async () => {
      await wallet.restore(pw, tron.value, xmr.value, from.value);
      await enterWallet();
    });
  }) }, 'Restore');
  const scan = h('button', { type: 'button', class: 'secondary', id: 'seed-scan', onclick: () => void openScanner('XMR', () => undefined, {
    parse: (t) => (parseSeedQr(t) ? t : null),
    wrong: 'This is not a seed QR code.',
    onText: (t) => {
      const got = parseSeedQr(t)!;
      if (got.bip39) tron.value = got.bip39;
      if (got.monero) xmr.value = got.monero;
      toast(got.bip39 && got.monero ? 'Both seeds filled in.' : 'Seed filled in. Add the other one.');
    },
  }) }, icon('scan'), 'Scan seed QR code');
  terms.el.addEventListener('change', () => { (go as HTMLButtonElement).disabled = !terms.agreed(); });
  entry(h('h2', {}, 'Restore from seeds'), h('p', { class: 'small muted' }, 'Type the words, or scan the QR code this wallet shows for your seeds.'), scan, h('br'), box.el,
    h('label', { class: 'field' }, h('span', {}, 'BTC·ETH·Tron seed (BIP39)'), tron),
    h('label', { class: 'field' }, h('span', {}, 'Monero seed (25 words)'), xmr),
    h('label', { class: 'field' }, h('span', {}, 'When Monero was first used'), from,
      h('div', { class: 'hint' }, 'A date or block height. Empty scans from the start, which can take hours. A date also sets where Zcash starts scanning.')),
    ...f.nodes,
    terms.el,
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
