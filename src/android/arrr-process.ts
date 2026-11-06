// The same engine as on the desktop, run from the APK's native libraries by the Android side.
import type { ArrrEngine } from '../main/arrr-process';

export type { ArrrEngine };

const native = () => (window as any).VaultNative;
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let next = 1;

(window as any).__arrrLine = (line: string) => {
  let answer: any;
  try { answer = JSON.parse(line); } catch { return; }
  const w = waiting.get(answer.id);
  if (!w) return;
  waiting.delete(answer.id);
  if ('error' in answer) w.reject(new Error(String(answer.error))); else w.resolve(answer.result);
};
(window as any).__arrrExit = () => {
  const e = new Error('Pirate Chain engine stopped.');
  for (const w of waiting.values()) w.reject(e);
  waiting.clear();
};

export const arrrEngineAvailable = (): boolean => Boolean(native().arrrAvailable());

export const arrrEngineInfo = (): string => String(native().arrrInfo());

export function startArrrEngine(): ArrrEngine {
  if (!native().arrrStart()) throw new Error('Pirate Chain is not available on this device.');
  return {
    dir: () => String(native().arrrDir()),
    call(method, params = {}) {
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        if (!native().arrrWrite(JSON.stringify({ id, m: method, p: params }))) {
          waiting.delete(id);
          reject(new Error('Pirate Chain engine stopped.'));
        }
      });
    },
    close() { native().arrrStop(); },
  };
}
