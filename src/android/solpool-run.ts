/** One web worker per proof, gone afterwards. */
export function runSolPool(op: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker('solpool.worker.js');
    const finish = (fn: (v: any) => void, v: any) => { worker.terminate(); fn(v); };
    worker.onmessage = (e) => { const m = e.data; if (m.error) finish(reject, new Error(m.error)); else finish(resolve, m.result); };
    worker.onerror = (e) => finish(reject, new Error(e.message || 'Proof engine error'));
    worker.postMessage({ op, payload });
  });
}
