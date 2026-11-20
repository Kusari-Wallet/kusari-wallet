// Address poisoning: a scammer sends a tiny amount from an address made to start and end like one the person
// uses, hoping it gets copied from the history next time. A send to such an address is flagged before it goes.

/** Hex addresses compare without case; the others as written. */
const key = (a: string): string => (/^0x[0-9a-f]+$/i.test(a) ? a.toLowerCase() : a.trim());

/**
 * The known address that `to` imitates (same start and end, different middle), or null. An address that is itself
 * known is never flagged.
 */
export function lookalikeOf(to: string, known: string[]): string | null {
  const t = key(to);
  if (t.length < 20) return null;
  const list = [...new Set(known.filter(Boolean).map(key))];
  if (list.includes(t)) return null;
  return list.find((k) => looksLike(k, t)) ?? null;
}

/** The part every address of a kind starts with, which says nothing about which address it is. */
const SCHEME = /^(0x|bc1[qp]|ltc1[qp]|ltcmweb1|tb1[qp]|sp1q|bitcoincash:[qp]|[qp](?=[02-9ac-hj-np-z]{41}$)|addr1|zs1|u1|t[13]|tex1|pirate1|sm1|[UEk0]Q(?=[A-Za-z0-9_-]{46}$)|r(?=[1-9A-HJ-NP-Za-km-z]{24,34}$)|[13LMTDAX79a48KZ])/;

/**
 * Two different addresses that someone checking the start and end would take for each other: what a scammer pays to
 * make grows with every matching character, so it is judged on those, past the part all such addresses share.
 * At least 3 at each end and 7 in all: a few seconds of a scammer's search, but almost never by chance.
 */
function looksLike(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  const scheme = SCHEME.exec(a)?.[0] ?? '';
  if (!b.startsWith(scheme)) return false;
  let start = 0;
  while (scheme.length + start < a.length && a[scheme.length + start] === b[scheme.length + start]) start++;
  let end = 0;
  while (end < a.length - scheme.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return start >= 3 && end >= 3 && start + end >= 7;
}

/** The addresses this wallet has sent to, newest first, kept to a few hundred. */
export function rememberRecipient(list: unknown, to: string): string[] {
  const prev = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  return [to.trim(), ...prev.filter((x) => key(x) !== key(to))].slice(0, 300);
}
