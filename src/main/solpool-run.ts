import { Worker } from 'node:worker_threads';
import path from 'node:path';

/** One worker per proof, gone afterwards, so note secrets and the proving key don't stay in memory. */
export function runSolPool(op: string, payload: unknown): Promise<any> {
  const file = path.join(__dirname, 'solpool-worker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return new Promise((resolve, reject) => {
    const worker = new Worker(file);
    const finish = (fn: (v: any) => void, v: any) => { void worker.terminate(); fn(v); };
    worker.on('message', (m: any) => { if (m.error) finish(reject, new Error(m.error)); else finish(resolve, m.result); });
    worker.on('error', (e) => finish(reject, e));
    worker.postMessage({ op, payload });
  });
}
