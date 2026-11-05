import { Worker } from 'node:worker_threads';
import path from 'node:path';

/** One worker per job, gone afterwards, so secrets and hundreds of MB don't stay in memory. */
export function runTornado(op: string, payload: unknown, onProgress: (stage: string) => void = () => undefined): Promise<any> {
  const file = path.join(__dirname, 'tornado-worker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return new Promise((resolve, reject) => {
    const worker = new Worker(file);
    const finish = (fn: (v: any) => void, v: any) => { void worker.terminate(); fn(v); };
    worker.on('message', (m: any) => {
      if (m.progress) onProgress(m.progress);
      else if (m.error) finish(reject, new Error(m.error));
      else finish(resolve, m.result);
    });
    worker.on('error', (e) => finish(reject, e));
    worker.postMessage({ op, payload });
  });
}
