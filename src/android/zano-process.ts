// The same engine as on the desktop, run from the APK's native libraries by the Android side.
import type { ZanoEngine } from '../main/zano-process';

export type { ZanoEngine };

const native = () => (window as any).VaultNative;
const waiting = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
let next = 1;

(window as any).__zanoLine = (line: string) => {
  const tab = line.indexOf('\t');
  const w = waiting.get(Number(line.slice(0, tab)));
  if (tab < 0 || !w) return;
  waiting.delete(Number(line.slice(0, tab)));
  w.resolve(line.slice(tab + 1));
};
(window as any).__zanoExit = () => {
  const e = new Error('Zano 엔진이 종료됐어.');
  for (const w of waiting.values()) w.reject(e);
  waiting.clear();
};

export const zanoEngineAvailable = (_?: string): boolean => Boolean(native().zanoAvailable());
export const zanoEngineInfo = (_?: string): string => String(native().zanoInfo());

export function startZanoEngine(_: string | undefined, __: string): ZanoEngine {
  if (!native().zanoStart()) throw new Error('이 기기에서는 Zano를 쓸 수 없어.');
  return {
    dir: String(native().zanoDir()),
    call(method, instance, params) {
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        if (!native().zanoWrite(`${id}\t${method}\t${instance}\t${params}`)) {
          waiting.delete(id);
          reject(new Error('Zano 엔진이 종료됐어.'));
        }
      });
    },
    close() { native().zanoStop(); },
  };
}
