const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export function randomBytes(n: number) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return { toString: () => hex(b) };
}
export const randomUUID = () => crypto.randomUUID();
