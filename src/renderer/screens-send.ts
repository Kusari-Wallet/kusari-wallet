// Sending, Bitcoin coin control, QR scanning, buying and receiving.
// ---- send ----

function renderSend(keep?: { to: string; amount: string }): void {
  const asset = selected;
  const to = h('input', { id: 'to', spellcheck: 'false', autocomplete: 'off', class: 'mono', placeholder: 'Enter, paste or scan an address', value: keep?.to ?? '' });
  const amount = numbersOnly(h('input', { id: 'amount', class: 'amount-input', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', value: keep?.amount ?? '' }) as HTMLInputElement);
  const usd = h('div', { class: 'usd', id: 'usd-preview' });
  const box = errorBox();
  const next = h('button', { class: 'primary', id: 'review', type: 'submit' }, 'Next');
  const mixed = asset === 'DASH' ? Number(overview?.coinjoin?.mixed ?? 0) : 0;
  const fromMixed = mixed > 0 ? h('input', { type: 'checkbox', id: 'cj-from-mixed' }) as HTMLInputElement : null;
  const coins = asset === 'BTC' ? coinControl() : null;
  // Ethereum: which of the wallet's addresses pays, when it has more than one.
  const fromEth = asset === 'ETH' || asset === 'USDTE' ? h('select', { id: 'eth-from', hidden: true }) as HTMLSelectElement : null;
  const fromEthRow = h('div', { class: 'panel', id: 'eth-from-row', hidden: true }, h('label', { class: 'label', for: 'eth-from' }, 'Send from'), fromEth);
  if (fromEth) void (async () => {
    try {
      const list: { n: number; address: string; eth: string | null; usdt: string | null }[] = await wallet.ethAddresses();
      if (!list.length || !fromEth.isConnected) return;
      setKids(fromEth, h('option', { value: '' }, `Main address (${shortAmount(overview?.balances?.[asset]?.spendable ?? '0')} ${unitOf(asset)})`),
        ...list.map((x) => h('option', { value: String(x.n) }, `#${x.n + 1} ${x.address.slice(0, 8)}…${x.address.slice(-6)} (${x.eth === null ? '?' : shortAmount(asset === 'ETH' ? x.eth : x.usdt ?? '0')} ${unitOf(asset)})`)));
      fromEth.hidden = false;
      fromEthRow.hidden = false;
    } catch { /* main address only */ }
  })();
  const btcMixed = asset === 'BTC' && Number(overview?.btcMix?.mixedSpendable ?? 0) > 0;
  const fromMixedBtc = btcMixed ? h('input', { type: 'checkbox', id: 'btc-from-mixed' }) as HTMLInputElement : null;
  fromMixedBtc?.addEventListener('change', () => { if (coins) coins.el.hidden = fromMixedBtc.checked; });
  const dcrMixed = asset === 'DCR' && Number(overview?.dcrMix?.mixedSpendable ?? 0) > 0;
  const fromMixedDcr = dcrMixed ? h('input', { type: 'checkbox', id: 'dcr-from-mixed' }) as HTMLInputElement : null;
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
      const preview = asset === 'DASH' && fromMixed?.checked
        ? await wallet.prepareDashPrivate(to.value, amount.value)
        : await wallet.prepareSend(asset, to.value, amount.value, fromMixedBtc?.checked || fromMixedDcr?.checked ? { fromMixed: true } : coins?.chosen.size ? { coins: [...coins.chosen] } : fromEth?.value ? { fromAddress: Number(fromEth.value) } : undefined);
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
      h('button', { type: 'button', class: 'max', id: 'max', onclick: () => { amount.value = 'max'; update(); } }, 'Max')),
    availableLine(asset, 'send-available')),
  usd,
  fromEth && fromEthRow,
  fromMixedBtc && h('label', { class: 'check', id: 'btc-from-mixed-row' }, fromMixedBtc, h('span', {}, `Send from mixed coins (CoinJoin, ${shortAmount(overview.btcMix.mixedSpendable)} BTC)`)),
  fromMixedDcr && h('label', { class: 'check', id: 'dcr-from-mixed-row' }, fromMixedDcr, h('span', {}, `Send from mixed coins (StakeShuffle, ${shortAmount(overview.dcrMix.mixedSpendable)} DCR)`)),
  coins?.el,
  fromMixed && h('label', { class: 'check', id: 'cj-from-mixed-row' }, fromMixed, h('span', {}, `Send from mixed coins (CoinJoin, ${shortAmount(overview.coinjoin.mixed)} DASH)`)),
  feeLine(asset, 'send-fee', (f) => `Estimated fee: ${feeText(f)}. It depends on the amount and address, and the next screen shows the exact value.`),
  COIN[asset].note && h('p', { class: 'small muted' }, COIN[asset].note),
  h('br'),
  next);
  show('send', subBar('Send', renderHome), h('div', { class: 'scroll' }, picker(() => renderSend({ to: to.value, amount: '' })), form));
  onData = update;
  update();
}

// ---- Bitcoin coin control ----

/** Choosing which Bitcoin coins pay, with your labels, and freezing coins so they're never picked on their own. */
function coinControl(purpose: 'send' | 'mix' = 'send'): { el: HTMLElement; chosen: Set<string>; onChange?: () => void } {
  const chosen = new Set<string>();
  const ctl: { el: HTMLElement; chosen: Set<string>; onChange?: () => void } = { el: null as any, chosen };
  const list = h('div', { id: 'coin-list', hidden: true });
  const summary = h('div', { class: 'small muted', id: 'coin-summary' }, 'The wallet picks the coins.');
  const box = errorBox();
  const sats = (a: string) => Math.round(Number(a) * 1e8);
  let all: { id: string; amount: string; frozen: boolean }[] = [];
  const sum = () => {
    const total = all.filter((c) => chosen.has(c.id)).reduce((s, c) => s + sats(c.amount), 0);
    summary.textContent = purpose === 'mix'
      ? (chosen.size ? `Chosen: ${chosen.size}, ${shortAmount(String(total / 1e8))} BTC. Only these are mixed.` : 'Every coin that isn\'t frozen is mixed.')
      : (chosen.size ? `Chosen: ${chosen.size}, ${shortAmount(String(total / 1e8))} BTC. Only these are spent, all of them, and what's left comes back as change.` : 'The wallet picks the coins. Frozen coins are left out.');
    ctl.onChange?.();
  };
  const load = async () => {
    list.replaceChildren(h('div', { class: 'small muted' }, 'Loading coins…'));
    try {
      const coinsNow: any[] = await wallet.btcCoins();
      all = coinsNow;
      for (const id of [...chosen]) if (!coinsNow.some((c) => c.id === id)) chosen.delete(id);
      if (!coinsNow.length) { list.replaceChildren(h('div', { class: 'small muted' }, 'No coins yet.')); sum(); return; }
      list.replaceChildren(...coinsNow.map((c) => {
        const pick = h('input', { type: 'checkbox', class: 'coin-pick', 'data-coin': c.id, checked: chosen.has(c.id), disabled: !c.confirmed, 'aria-label': `Spend ${c.amount} BTC` }) as HTMLInputElement;
        pick.addEventListener('change', () => { if (pick.checked) chosen.add(c.id); else chosen.delete(c.id); sum(); });
        const label = h('input', { class: 'coin-label', value: c.label, placeholder: 'Label (only on this device)', maxlength: '80', spellcheck: 'false', 'aria-label': 'Label' }) as HTMLInputElement;
        label.addEventListener('change', () => void wallet.btcCoinSet(c.id, { label: label.value }).catch((e: Error) => box.show(e.message)));
        const freeze = h('button', { type: 'button', class: 'link coin-freeze', 'aria-pressed': String(c.frozen) }, c.frozen ? 'Unfreeze' : 'Freeze');
        freeze.addEventListener('click', () => void wallet.btcCoinSet(c.id, { frozen: !c.frozen }).then(load).catch((e: Error) => box.show(e.message)));
        const tags = [c.confirmed ? '' : 'Waiting for confirmation', c.change ? 'Change' : '', c.frozen ? 'Frozen' : ''].filter(Boolean).flatMap((t) => [' · ', h('span', {}, t)]);
        return h('div', { class: 'coin-row' + (c.frozen ? ' frozen' : '') },
          h('label', { class: 'check' }, pick, h('span', { class: 'mono' }, `${c.amount} BTC`)),
          h('div', { class: 'small muted', title: c.id }, h('span', { class: 'mono' }, `${c.id.slice(0, 8)}…:${c.id.split(':')[1]}`), ...tags),
          h('div', { class: 'coin-edit' }, label, freeze));
      }));
      sum();
    } catch (e) { list.replaceChildren(); box.show((e as Error).message); }
  };
  const toggle = h('button', { type: 'button', class: 'link', id: 'coin-control', 'aria-expanded': 'false', onclick: () => {
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
    if (!list.hidden) void load();
  } }, 'Choose coins');
  sum();
  ctl.el = h('div', { class: 'panel', id: 'coin-panel' }, h('div', { class: 'row-between' }, h('span', { class: 'label' }, 'Coins'), toggle), summary, box.el, list,
    purpose === 'send' && h('p', { class: 'small muted' }, 'Spending coins together shows they belong to one person. Keep coins from different sources apart, and freeze ones you don\'t want spent.'));
  return ctl;
}

// ---- QR scan ----

/** Reads an address out of a QR code. Accepts a bare address or a wallet link such as monero:4...?tx_amount=1. */
function parseScanned(asset: Asset, raw: string): { address: string; amount: string } | null {
  const text = raw.trim();
  const m = text.match(/^(?:(bitcoincash|bitcoin|btc|litecoin|ltc|secret|scrt|solana|sol|dogecoin|doge|decred|dcr|dash|firo|zcash|zec|zano|kusari|ksr|pirate|arrr|ethereum|eth|tron|trx|usdt|monero|xmr)(?::\/\/|:))?([0-9A-Za-z]+)(?:@1)?(?:\?(.*))?$/i);
  if (!m) return null;
  const scheme = (m[1] ?? '').toLowerCase();
  const family = (a: Asset) => (a === 'BCH' ? ['bitcoincash'] : a === 'LTC' ? ['litecoin', 'ltc'] : a === 'SCRT' || a === 'SSCRT' ? ['secret', 'scrt'] : a === 'SOL' ? ['solana', 'sol'] : SPL_ASSETS.includes(a) ? ['solana', 'sol', 'usdt', 'spl'] : BSC_ASSETS.includes(a) ? ['ethereum', 'bnb', 'bsc', 'usdt'] : a === 'POL' || a === 'USDTP' || a === 'ETHP' ? ['ethereum', 'polygon', 'pol', 'matic', 'usdt'] : a === 'ARB' || a === 'ETHA' || a === 'USDTA' ? ['ethereum', 'arbitrum', 'arb', 'eth', 'usdt'] : a === 'DOGE' ? ['dogecoin', 'doge'] : a === 'DCR' ? ['decred', 'dcr'] : a === 'DASH' ? ['dash'] : a === 'FIRO' ? ['firo'] : a === 'ZEC' ? ['zcash', 'zec'] : a === 'ZANO' ? ['zano'] : a === 'KSR' ? ['kusari', 'ksr'] : a === 'ARRR' ? ['pirate', 'arrr'] : a === 'BTC' ? ['bitcoin', 'btc'] : a === 'XMR' ? ['monero', 'xmr'] : a === 'ETH' || a === 'USDTE' ? ['ethereum', 'eth', 'usdt'] : ['tron', 'trx', 'usdt']);
  if (scheme && !family(asset).includes(scheme)) return null;
  // Bech32 QR codes are often in upper case to make them smaller.
  const address = asset === 'BTC' && /^(BC1|SP1)/.test(m[2]) ? m[2].toLowerCase() : m[2];
  const valid = asset === 'BTC' ? /^(bc1[02-9ac-hj-np-z]{11,87}|sp1[02-9ac-hj-np-z]{100,200}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(address)
    : asset === 'SOL' || SPL_ASSETS.includes(asset) ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
    : asset === 'DOGE' ? /^[DA9][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    : asset === 'DCR' ? /^D[sc][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    : asset === 'BCH' ? /^[qp][02-9ac-hj-np-z]{41}$/i.test(address)
    : asset === 'LTC' ? /^(ltc1[02-9ac-hj-np-z]{8,87}|ltcmweb1[02-9ac-hj-np-z]{100,140}|[LM][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(address)
    : asset === 'SCRT' || asset === 'SSCRT' ? /^secret1[02-9ac-hj-np-z]{38}$/.test(address)
    : asset === 'FIRO' ? /^([a3][1-9A-HJ-NP-Za-km-z]{33}|sm1[02-9ac-hj-np-z]{100,200})$/.test(address)
    : asset === 'DASH' ? /^[X7][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)
    : asset === 'ARRR' ? /^(zs1[02-9ac-hj-np-z]{75}|pirate1[02-9ac-hj-np-z]{40,})$/.test(address)
    : asset === 'ZANO' ? /^(Zx|iZ|aZ|ai)[1-9A-HJ-NP-Za-km-z]{90,120}$/.test(address)
    : asset === 'KSR' ? /^[KL][1-9A-HJ-NP-Za-km-z]{90,120}$/.test(address)
    : asset === 'ZEC' ? /^(t[13][1-9A-HJ-NP-Za-km-z]{33}|zs1[02-9ac-hj-np-z]{75}|u1[02-9ac-hj-np-z]{100,}|tex1[02-9ac-hj-np-z]{30,})$/.test(address)
    : asset === 'XMR' ? /^[48][1-9A-HJ-NP-Za-km-z]{94}([1-9A-HJ-NP-Za-km-z]{11})?$/.test(address)
      : EVM_ASSETS.includes(asset) ? /^0x[0-9a-fA-F]{40}$/.test(address)
      : /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  if (!valid) return null;
  // Ethereum links carry value in wei, so the amount is left for the person to type.
  const amount = EVM_ASSETS.includes(asset) ? '' : new URLSearchParams(m[3] ?? '').get(asset === 'XMR' ? 'tx_amount' : 'amount') ?? '';
  return { address, amount: /^\d+(\.\d+)?$/.test(amount) ? amount : '' };
}

let closeScanner: (() => void) | null = null;

/** custom reads something other than an address: parse returns it, or null with the wrong message. */
async function openScanner(asset: Asset, onFound: (found: { address: string; amount: string }) => void, custom?: { parse: (text: string) => string | null; wrong: string; onText: (text: string) => void }): Promise<void> {
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
        if (custom) {
          const text = custom.parse(code.data);
          if (text) { close(); custom.onText(text); return; }
          status.textContent = custom.wrong;
          timer = window.setTimeout(tick, 180);
          return;
        }
        const found = parseScanned(asset, code.data);
        if (found) { close(); onFound(found); return; }
        status.textContent = `This is not a ${asset === 'XMR' ? 'Monero' : asset === 'SOL' || SPL_ASSETS.includes(asset) ? 'Solana' : asset === 'DOGE' ? 'Dogecoin' : asset === 'BCH' ? 'Bitcoin Cash' : asset === 'LTC' ? 'Litecoin' : asset === 'SCRT' || asset === 'SSCRT' ? 'Secret Network' : asset === 'DASH' ? 'Dash' : asset === 'FIRO' ? 'Firo' : asset === 'ZEC' ? 'Zcash' : asset === 'ZANO' ? 'Zano' : asset === 'KSR' ? 'Kusari' : asset === 'ARRR' ? 'Pirate Chain' : asset === 'BTC' ? 'Bitcoin' : EVM_ASSETS.includes(asset) ? 'Ethereum' : 'Tron'} address QR. Try another one.`;
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
  // Bitcoin can go out later, at a random moment, so its timing doesn't tie it to what just happened.
  const when = p.asset === 'BTC' && !p.speedUp ? h('select', { id: 'send-when' },
    h('option', { value: '0' }, 'Now'), h('option', { value: '10' }, 'At a random time within 10 minutes'),
    h('option', { value: '60' }, 'At a random time within an hour'), h('option', { value: '240' }, 'At a random time within 4 hours')) as HTMLSelectElement : null;
  const box = errorBox();
  const send = h('button', { class: 'primary', id: 'confirm-send', type: 'submit' }, `Send ${p.amount} ${coinName(p.asset)}`);
  const back = () => { void wallet.cancelSend(p.id); renderSend(keep); };
  const price = prices?.[p.asset]?.usd;
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(send, 'Sending…', box, async () => {
      const delayMinutes = when ? Number(when.value) : 0;
      const res = await wallet.confirmSend(p.id, pw.value, delayMinutes ? { delayMinutes } : undefined);
      pw.value = '';
      if (res.scheduledAt) renderScheduled(p, res.scheduledAt); else renderSent(p, res.hashes);
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
  when && h('label', { class: 'field' }, h('span', {}, 'When to send'), when,
    h('div', { class: 'hint' }, 'Signed now and sent later, even if the wallet is locked in between: it goes out when the wallet is next open. Its coins can\'t be used for anything else until then.')),
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
  send);
  show('send', subBar('Review', back), h('div', { class: 'scroll' }, form));
  pw.focus();
}

function renderScheduled(p: any, at: number): void {
  show('receive', subBar('Send scheduled', renderHome), h('div', { class: 'scroll' },
    h('h2', { id: 'send-scheduled' }, `${p.amount} ${coinName(p.asset)}`),
    h('p', { class: 'muted' }, `Signed, and going out at about ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Keep the wallet open or open it again later: a send that is due goes out as soon as the wallet is unlocked.`),
    h('button', { class: 'primary', onclick: renderHome }, 'Done')));
}

/** A Uniswap or PancakeSwap swap: one or two transactions this wallet signs and sends itself. */
function renderDexReview(p: any, back: () => void): void {
  const pw = h('input', { type: 'password', id: 'dex-pw', autocomplete: 'current-password' });
  const box = errorBox();
  const go = h('button', { class: 'primary', id: 'dex-confirm', type: 'submit' }, p.steps > 1 ? `Approve and swap (${p.steps} transactions)` : 'Swap');
  const price = prices?.[p.to]?.usd;
  const form = h('form', { onsubmit: (e: Event) => {
    e.preventDefault();
    busy(go, 'Sending…', box, async () => {
      const res = await wallet.dexConfirm(p.id, pw.value);
      pw.value = '';
      show('receive', subBar('Swap sent', renderHome), h('div', { class: 'scroll' },
        h('h2', { id: 'dex-sent' }, `${p.amount} ${coinName(p.from)} → ${coinName(p.to)}`),
        h('p', { class: 'muted' }, `Sent to the network through ${p.provider}. The balance updates once it's in a block. If the price moves past your limit before then, the swap fails and only the fee is spent.`),
        ...res.hashes.map((hash: string, i: number) => h('div', { class: 'panel' },
          h('span', { class: 'label' }, res.hashes.length > 1 && i < res.hashes.length - 1 ? 'Permission transaction' : 'Swap transaction'),
          h('div', { class: 'mono' }, hash), h('br'),
          h('div', { class: 'row' }, h('button', { onclick: () => wallet.copy(hash) }, 'Copy'), h('button', { onclick: () => void openExplorer(p.from, hash) }, 'View in explorer')))),
        h('button', { class: 'primary', onclick: () => void renderSwap(p.from, p.to) }, 'Swap again')));
      void refresh();
    });
  } },
  box.el,
  ...p.warnings.map((w: string) => h('div', { class: 'warn' }, w)),
  h('div', { class: 'panel' }, h('table', { class: 'review-table' }, h('tbody', {},
    h('tr', {}, h('th', {}, 'You send'), h('td', { id: 'dex-send' }, `${p.amount} ${coinName(p.from)}`)),
    h('tr', {}, h('th', {}, 'You receive'), h('td', {}, h('div', { class: 'big-amount', id: 'dex-receive' }, `about ${p.receive} ${coinName(p.to)}`),
      typeof price === 'number' && h('div', { class: 'small muted' }, `≈ ${usdFormat(Number(p.receive) * price)}`))),
    h('tr', {}, h('th', {}, 'At least'), h('td', { id: 'dex-min' }, `${p.minReceive} ${coinName(p.to)} (slippage limit ${p.slippage}%)`)),
    h('tr', {}, h('th', {}, 'Exchange'), h('td', {}, p.provider)),
    h('tr', {}, h('th', {}, 'Estimated fee'), h('td', { id: 'dex-fee' }, reviewFee(p.fee, p.feeAsset)))))),
  h('label', { class: 'field' }, h('span', {}, 'Password'), pw),
  go);
  show('send', subBar('Review swap', () => { void wallet.cancelSend(p.id); back(); }), h('div', { class: 'scroll' }, form));
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

/** Straight to LocalCoinSwap in the browser; the receiving address comes from Receive, as on any exchange. */
async function openBuyPage(): Promise<void> {
  try {
    await wallet.openBuy('BTC');
    toast('LocalCoinSwap opened in your browser. Use your address from Receive as the receiving address there.');
  } catch (e) { toast(errMsg(e)); }
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
  // Private first where the coin has it: LTC on MWEB, FIRO on Spark (ZEC's first address is already shielded).
  // The public one stays a tap away, for senders without MWEB or Spark.
  let address = current ?? (asset === 'LTC' && overview?.mweb?.receive ? overview.mweb.receive : asset === 'FIRO' && overview?.spark?.receive ? overview.spark.receive : addresses?.[asset] ?? '');
  const copy = h('button', { class: 'icon-btn', id: 'copy', disabled: true, 'aria-label': 'Copy address', title: 'Copy address', onclick: async () => {
    await wallet.copy(address); status.textContent = 'Copied. It clears from the clipboard in 60 seconds.';
  } }, icon('copy'));
  const note = asset === 'ARRR' ? 'Receives ARRR on Pirate Chain mainnet only. Amounts and addresses don\'t show on the chain. Received coins can be used after confirmations.'
    : asset === 'ZANO' ? 'Receives ZANO on Zano mainnet only. Amounts and addresses don\'t show on the chain. Received coins can be used after 10 confirmations.'
    : asset === 'KSR' ? 'Receives KSR on the Kusari chain only. Amounts and addresses don\'t show on the chain. Received coins can be used after 10 confirmations.'
    : asset === 'ZEC' ? (address.startsWith('t') ? 'This is a transparent address. The amount and address are public on the chain. Coins must be shielded after arrival before they can be sent.' : 'This is a shielded address. The amount and address don\'t show on the chain. Received ZEC can be used after a few confirmations. If a provider can\'t pay this address, use the transparent one.')
    : asset === 'SOL' ? 'The same address as USDT (Sol). Receives SOL on Solana mainnet only. Other Solana tokens aren\'t shown.'
    : asset === 'USDTS' ? 'Receives USDT on the Solana network (SPL) only. Sending needs a little SOL at this address for the fee.'
    : asset === 'LTC' && address.startsWith('ltcmweb1') ? 'A private (MWEB) Litecoin address. The amount and both addresses stay hidden on the chain. Senders need a wallet with MWEB support, such as Litecoin Core or Cake Wallet.'
    : asset === 'LTC' ? 'A Litecoin address (ltc1q). Coins sent from Bitcoin or other chains won\'t arrive. Once a deposit is seen, a new address appears next time.'
    : asset === 'SSCRT' ? 'The same secret1 address as plain SCRT. sSCRT sent to it arrives privately, and only after the private balance is turned on can this wallet show it.'
    : asset === 'SCRT' ? 'Receives SCRT on Secret Network mainnet only. The amount and address are public on the chain. No memo is needed.'
    : asset === 'BCH' ? 'Receives BCH on Bitcoin Cash only. Coins sent from Bitcoin or other chains won\'t arrive. Once a deposit is seen, a new address appears next time.'
    : asset === 'DOGE' ? 'Receives DOGE on Dogecoin mainnet only. Once a deposit is seen, a new address appears next time.'
    : asset === 'FIRO' && address.startsWith('sm1') ? 'A private (Spark) Firo address. The amount and both addresses stay hidden on the chain. Senders need a wallet with Spark support, such as Firo\'s own wallet or Stack Wallet. Coins show here once they are in a block.'
    : asset === 'FIRO' ? 'Receives FIRO on Firo mainnet only. This is a transparent address, so the amount and address are public on the chain. Once a deposit is seen, a new address appears next time.'
    : asset === 'DASH' ? 'Receives DASH on Dash mainnet only. Once a deposit is seen, a new address appears next time.'
    : asset === 'BTC' ? 'A Bitcoin Taproot (bc1p) address. Coins sent from other chains won\'t arrive. Once a deposit is seen, a new address appears next time.'
    : asset === 'ETH' ? 'The same address as USDT (Eth). Receives ETH on Ethereum mainnet only. Coins sent over L2s or other chains won\'t arrive.'
    : asset === 'USDTE' ? 'Receives USDT on the Ethereum network (ERC-20) only. Sending needs ETH at this address for the fee.'
    : asset === 'LINK' ? 'Receives LINK on Ethereum (ERC-20) only. Sending needs ETH at this address for the fee.'
    : asset === 'UNI' || asset === 'PEPE' || asset === 'AAVE' || asset === 'SHIB' ? `Receives ${asset} on Ethereum (ERC-20) only. Sending needs ETH at this address for the fee.`
    : asset === 'ETHP' ? 'Receives ETH on Polygon only (bridged ETH). ETH sent on Ethereum or Arbitrum won\'t show here. Sending needs POL at this address for the fee.'
    : asset === 'DCR' ? 'A Decred address (Ds…) from this seed\'s BIP44 account (m/44\'/42\'/0\'), as multi-coin wallets derive it. Decrediton uses its own 33-word seed, so it shows other addresses. Receives DCR on Decred mainnet only.'
    : asset === 'BNB' ? 'The same 0x address as on Ethereum. Receives BNB on BNB Smart Chain (BEP-20) only. BNB on other chains won\'t show here.'
    : asset === 'USDTB' ? `Receives USDT on BNB Smart Chain (BEP-20) only. Sending needs BNB at this address for the fee.`
    : asset === 'ORCA' || asset === 'PUMP' ? `Receives ${asset} on Solana (SPL) only. Sending needs a little SOL at this address for the fee.`
    : asset === 'WLD' ? 'Receives WLD on Ethereum (ERC-20) only. Sending needs ETH at this address for the fee.'
    : asset === 'POL' ? 'The same 0x address as on Ethereum and Arbitrum. Receives POL on Polygon only.'
    : asset === 'USDTP' ? 'Receives USDT on Polygon only. Sending needs POL at this address for the fee.'
    : asset === 'ARB' ? 'Receives the ARB token on Arbitrum One only. Sending needs ETH (Arb) at this address for the fee.'
    : asset === 'ETHA' ? 'Receives ETH on Arbitrum One only. ETH sent on Ethereum mainnet won\'t show here.'
    : asset === 'USDTA' ? 'Receives USDT on Arbitrum One only. Sending needs ETH (Arb) at this address for the fee.'
    : asset === 'USDCE' ? 'Receives USDC on the Ethereum network (ERC-20) only. Sending needs ETH at this address for the fee.'
    : asset === 'USDCB' ? 'Receives USDC on BNB Smart Chain (BEP-20) only. Sending needs BNB at this address for the fee.'
    : asset === 'USDCS' ? 'Receives USDC on Solana (SPL) only. Sending needs a little SOL at this address for the fee.'
    : asset === 'USDCP' ? 'Receives native USDC on Polygon only. Bridged USDC.e won\'t show here. Sending needs POL at this address for the fee.'
    : asset === 'USDCA' ? 'Receives native USDC on Arbitrum One only. Bridged USDC.e won\'t show here. Sending needs ETH (Arb) at this address for the fee.'
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

  if (asset === 'FIRO' && overview?.spark?.receive) {
    const priv = address.startsWith('sm1');
    const list = await wallet.addresses();
    setKids(extra, h('button', { class: 'ghost', id: 'firo-address-kind', onclick: () => void renderReceive(priv ? list.FIRO : overview.spark.receive) }, priv ? 'Show public address' : 'Show private (Spark) address'));
    return;
  }
  if (asset === 'LTC' && overview?.mweb?.receive) {
    const priv = address.startsWith('ltcmweb1');
    const list = await wallet.addresses();
    setKids(extra, h('button', { class: 'ghost', id: 'ltc-address-kind', onclick: () => void renderReceive(priv ? list.LTC : overview.mweb.receive) }, priv ? 'Show public address' : 'Show private (MWEB) address'));
    return;
  }
  if (asset === 'ZEC') {
    const list = await wallet.addresses();
    const shieldedOn = address === list.ZEC;
    setKids(extra, h('button', { class: 'ghost', id: 'zec-address-kind', onclick: () => void renderReceive(shieldedOn ? list.ZEC_T : list.ZEC) }, shieldedOn ? 'Show transparent address' : 'Show shielded address'));
    return;
  }
  if (asset === 'ETH' || asset === 'USDTE') {
    // Extra Ethereum addresses: each a separate account on the chain, spent on its own.
    const findBtn = h('button', { class: 'ghost', id: 'eth-find', onclick: () => busy(findBtn, 'Looking…', box, async () => { const n = await wallet.ethAddressesFind(); status.textContent = n ? `Found ${n} address(es) used before.` : 'No other used addresses found.'; await listEth(); }) }, 'Find addresses used before');
    const add = h('button', { class: 'ghost', id: 'eth-new', onclick: () => busy(add, 'Creating…', box, async () => { const r = await wallet.ethAddressNew(); await renderReceive(r.address); }) }, 'New address');
    const listEth = async () => {
      const list: { n: number; address: string; eth: string | null; usdt: string | null }[] = await wallet.ethAddresses();
      if (!extra.isConnected) return;
      const main = addresses?.ETH ?? '';
      setKids(extra, h('p', { class: 'small muted' }, 'A new address is a separate account on the chain: nobody can tell it belongs with the others until coins move between them. Each one pays its own fees, so keep a little ETH on any address you send USDT from.'),
        add, findBtn,
        list.length ? h('div', { class: 'sub-list', id: 'eth-addresses' },
          h('button', { class: `mono${address === main ? ' on' : ''}`, onclick: () => void renderReceive(main) }, `Main  ${main.slice(0, 10)}…${main.slice(-8)}`),
          ...list.map((x) => h('button', { class: `mono${x.address === address ? ' on' : ''}`, onclick: () => void renderReceive(x.address) },
            `#${x.n + 1}  ${x.address.slice(0, 10)}…${x.address.slice(-8)}${x.eth === null ? '' : `  ${shortAmount(x.eth)} ETH · ${shortAmount(x.usdt ?? '0')} USDT`}`))) : null);
    };
    setKids(extra, add, findBtn);
    try { await listEth(); } catch { /* the main address is already on screen */ }
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
