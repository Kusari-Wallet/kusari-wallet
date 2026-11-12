// node:crypto for the WebView: random bytes as a Buffer, as Node gives them, from the system's secure source.
export function randomBytes(n: number): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
}
/** A uniform integer in [0, max), without modulo bias. */
export function randomInt(max: number): number {
  if (!Number.isSafeInteger(max) || max <= 0 || max > 2 ** 32) throw new RangeError('randomInt: bad range');
  const limit = 2 ** 32 - (2 ** 32 % max);
  for (;;) { const v = crypto.getRandomValues(new Uint32Array(1))[0]; if (v < limit) return v % max; }
}
export const randomUUID = () => crypto.randomUUID();
