// Kusari Wallet's Terms of Use, shown and agreed to every time a wallet is created or restored. Written for this
// wallet; the structure follows common practice for self-custody wallets. English is the binding text.

const TERMS_UPDATED = 'Last updated: November 13, 2026';

const TERMS: [string, string][] = [
  ['1. About these terms', 'Kusari Wallet is free, self-custody wallet software made by its developers ("we", "us"). By creating, restoring or using a wallet in the app, you agree to these Terms of Use. If you don\'t agree, don\'t use the app.'],
  ['2. Changes', 'We may update these terms. The current version is always shown in the app, and you accept it each time you create or restore a wallet. If you keep using the app after a change, the new version applies.'],
  ['3. Your keys, your responsibility', 'Your seed phrases, password and private keys are created and kept only on your device. We never see them, can\'t recover them and can\'t reverse anything done with them. Write your seeds down and keep them safe and private: anyone who has them controls your coins, and if you lose them, your coins can\'t be recovered.'],
  ['4. We don\'t hold your coins', 'The app is software, not a bank, exchange, broker or custodian. Your coins live on their blockchains, not in the app or with us. We can\'t freeze, move, cancel or refund any transaction.'],
  ['5. Services run by others', 'Some features rely on services we don\'t run: swap and exchange services, blockchain nodes and explorers, price sources, CoinJoin coordinators, Tornado Cash relayers, Tor and others. They have their own terms, fees, limits and checks, and they may be slow, wrong, unavailable or refuse a transaction. We aren\'t responsible for them, including for rates, delays, holds or refunds of a swap.'],
  ['6. Privacy features', 'Tor, CoinJoin, Tornado Cash, shielded and other private transactions make your activity harder to trace, but nothing guarantees complete anonymity. The rules for these tools differ by country. You alone decide whether and how to use them, and you must follow the laws that apply to you.'],
  ['7. Lawful use only', 'Don\'t use the app for anything illegal, including fraud, money laundering, financing terrorism or getting around sanctions. Don\'t attack, overload or interfere with the app, its users, or the networks and services it connects to, don\'t spread malicious code through it, and don\'t misuse the service credentials built into it.'],
  ['8. Where you live', 'You are responsible for making sure that using the app and the coins and services in it is allowed where you are. Don\'t use it where that is prohibited. You must be old enough to agree to these terms where you live, or have the consent of a parent or guardian.'],
  ['9. Risks', 'Crypto involves real risk. Prices can change sharply. Transactions can\'t be undone, and coins sent to a wrong address or the wrong network are usually lost. Fees can change, networks can fail or split, software can have bugs, and a lost, stolen or infected device can expose your coins. You use the app at your own risk.'],
  ['10. No advice', 'Nothing in the app is financial, investment, legal or tax advice. Prices and values are for information only and may be delayed or wrong.'],
  ['11. Taxes', 'You are responsible for any taxes on your transactions and for reporting them.'],
  ['12. Provided "as is"', 'The app is provided "as is" and "as available", without warranties of any kind, as far as the law allows. We don\'t promise that it will be free of errors, always available, compatible with every device or kept up to date.'],
  ['13. Limitation of liability', 'As far as the law allows, we aren\'t liable for any loss of coins, profits or data, or for any indirect or consequential damage, arising from your use of the app or of services reached through it. This doesn\'t limit liability that the law doesn\'t let us exclude, such as for intent or gross negligence.'],
  ['14. Your responsibility to us', 'If your breach of these terms or unlawful use of the app leads to a claim against us, you agree to cover the resulting losses and reasonable costs.'],
  ['15. Name, logo and software', 'The Kusari Wallet name, logo and app belong to their developers. Parts of the app come from other projects under their own licenses, listed in the app\'s third-party notices; those licenses apply to those parts.'],
  ['16. Translations', 'These terms may be shown in other languages for convenience. If a translation differs from the English text, the English text applies.'],
  ['17. Disputes', 'A dispute about these terms or the app is decided under the law that applies to the developers, by the courts that are competent for them, unless the mandatory consumer protection law where you live gives you other rights.'],
  ['18. Other terms', 'If part of these terms can\'t be enforced, the rest still applies. Not enforcing a term at one time doesn\'t waive it. These terms are the whole agreement between you and us about the app.'],
  ['19. Contact', 'Questions about these terms can be sent through the contact shown on the official Kusari Wallet download page.'],
];

/** The terms in a layer over the current screen, so whatever was typed underneath stays. */
function showTerms(): void {
  const close = h('button', { class: 'primary', id: 'terms-close', onclick: () => layer.remove() }, 'Close');
  const layer = h('div', { class: 'terms-layer', id: 'terms', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Terms of Use' },
    h('div', { class: 'terms-sheet' },
      h('h2', {}, 'Terms of Use'),
      h('p', { class: 'small muted' }, TERMS_UPDATED),
      h('div', { class: 'terms-body' }, ...TERMS.flatMap(([title, text]) => [h('h3', {}, title), h('p', { class: 'small' }, text)])),
      close));
  document.body.append(layer);
  close.focus();
}

/** The agreement a wallet needs before it is created or restored: a box to tick and a way to read the terms. */
function termsAgreement(): { el: HTMLElement; agreed: () => boolean; check: () => void } {
  const box = h('input', { type: 'checkbox', id: 'terms-agree' });
  const read = h('button', { type: 'button', class: 'link', id: 'terms-open', onclick: () => showTerms() }, 'Read the Terms of Use');
  const el = h('div', { class: 'terms-agree' },
    h('label', { class: 'check' }, box, h('span', {}, 'I have read and agree to the Terms of Use. I understand that I alone hold my seeds and that lost seeds can\'t be recovered.')),
    read);
  return {
    el,
    agreed: () => (box as HTMLInputElement).checked,
    check() { if (!(box as HTMLInputElement).checked) throw new Error('Agree to the Terms of Use to continue.'); },
  };
}
