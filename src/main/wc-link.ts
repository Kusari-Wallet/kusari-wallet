/** A WalletConnect v2 pairing link: wc:<64 hex>@2?… */
export const WC_LINK = /^wc:[0-9a-f]{64}@2\?[\x21-\x7e]{10,900}$/i;
export const isWcLink = (text: string): boolean => WC_LINK.test(text.trim());

/** The first wc: link found among command-line arguments or a URL the OS hands the app. */
export function wcLinkOf(args: string[]): string {
  for (const a of args) {
    const t = String(a ?? '').trim();
    if (isWcLink(t)) return t;
    // Some dApps open wallets as <scheme>://wc?uri=<encoded link>.
    const m = t.match(/^[a-z][a-z0-9+.-]*:\/\/wc\?uri=([^&]+)/i);
    if (m) { try { const inner = decodeURIComponent(m[1]); if (isWcLink(inner)) return inner; } catch { /* not a link */ } }
  }
  return '';
}
