// The same MWEB engine as on the desktop, run from the APK's native libraries by the Android side.
import type { MwebEngine } from '../main/mweb-process';

export type { MwebEngine };

const native = () => (window as any).VaultNative;
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let next = 1;

(window as any).__mwebLine = (line: string) => {
  let answer: any;
  try { answer = JSON.parse(line); } catch { return; }
  const w = waiting.get(answer.id);
  if (!w) return;
  waiting.delete(answer.id);
  if ('error' in answer) w.reject(new Error(String(answer.error))); else w.resolve(answer.result);
};
(window as any).__mwebExit = () => {
  const e = new Error('MWEB engine stopped.');
  for (const w of waiting.values()) w.reject(e);
  waiting.clear();
};

export const mwebEngineAvailable = (): boolean => Boolean(native().mwebAvailable?.());

export const mwebEngineInfo = (): string => String(native().mwebAvailable?.() ? 'bundled' : 'not in this build');

export function startMwebEngine(): MwebEngine {
  if (!native().mwebStart()) throw new Error('MWEB is not available on this device.');
  return {
    dir: () => String(native().mwebDir()),
    call(method, params = {}) {
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        if (!native().mwebWrite(JSON.stringify({ id, m: method, p: params }))) {
          waiting.delete(id);
          reject(new Error('MWEB engine stopped.'));
        }
      });
    },
    close() { native().mwebStop(); },
  };
}
