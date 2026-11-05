// The same engine as on the desktop, run from the APK's native libraries by the Android side.
import type { ZecEngine } from '../main/zec-process';

export type { ZecEngine };

const native = () => (window as any).VaultNative;
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let next = 1;

(window as any).__zecLine = (line: string) => {
  let answer: any;
  try { answer = JSON.parse(line); } catch { return; }
  const w = waiting.get(answer.id);
  if (!w) return;
  waiting.delete(answer.id);
  if ('error' in answer) w.reject(new Error(String(answer.error))); else w.resolve(answer.result);
};
(window as any).__zecExit = () => {
  const e = new Error('Zcash 엔진이 종료됐어.');
  for (const w of waiting.values()) w.reject(e);
  waiting.clear();
};

export const zecEngineAvailable = (): boolean => Boolean(native().zecAvailable());

export function startZecEngine(): ZecEngine {
  if (!native().zecStart()) throw new Error('이 기기에서는 Zcash를 쓸 수 없어.');
  return {
    call(method, params = {}) {
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        if (!native().zecWrite(JSON.stringify({ id, m: method, p: params }))) {
          waiting.delete(id);
          reject(new Error('Zcash 엔진이 종료됐어.'));
        }
      });
    },
    close() { native().zecStop(); },
  };
}
