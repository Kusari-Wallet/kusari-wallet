// The same Spark engine as on the desktop, run from the APK's native libraries by the Android side.
import type { SparkEngine } from '../main/spark-process';
import { readAnswer } from '../main/spark-wire';

export type { SparkEngine };
export { readAnswer };

const native = () => (window as any).VaultNative;
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let next = 1;

(window as any).__sparkLine = (line: string) => {
  const answer = readAnswer(line);
  const w = answer && waiting.get(answer.id);
  if (!answer || !w) return;
  waiting.delete(answer.id);
  if (answer.ok) w.resolve(answer.value); else w.reject(new Error(answer.value));
};
(window as any).__sparkExit = () => {
  const e = new Error('Spark engine stopped.');
  for (const w of waiting.values()) w.reject(e);
  waiting.clear();
};

export const sparkEngineAvailable = (): boolean => Boolean(native().sparkAvailable?.());

export function startSparkEngine(): SparkEngine {
  if (!native().sparkStart()) throw new Error('Spark is not available on this device.');
  return {
    dir: () => String(native().sparkDir()),
    call(method, params = {}) {
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        if (!native().sparkWrite(JSON.stringify({ id, m: method, p: params }))) {
          waiting.delete(id);
          reject(new Error('Spark engine stopped.'));
        }
      });
    },
    close() { native().sparkStop(); },
  };
}
