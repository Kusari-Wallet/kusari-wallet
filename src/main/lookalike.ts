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
  return list.find((k) => k.length === t.length && k.slice(0, 6) === t.slice(0, 6) && k.slice(-4) === t.slice(-4)) ?? null;
}

/** The addresses this wallet has sent to, newest first, kept to a few hundred. */
export function rememberRecipient(list: unknown, to: string): string[] {
  const prev = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  return [to.trim(), ...prev.filter((x) => key(x) !== key(to))].slice(0, 300);
}
