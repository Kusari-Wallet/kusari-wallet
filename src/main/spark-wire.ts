/** The Spark engine answers {id, r} or {id, e}, one JSON object per line. */
export function readAnswer(line: string): { id: number; ok: boolean; value: any } | null {
  let a: any;
  try { a = JSON.parse(line); } catch { return null; }
  if (!a || typeof a.id !== 'number') return null;
  return 'e' in a ? { id: a.id, ok: false, value: String(a.e) } : { id: a.id, ok: true, value: a.r };
}
