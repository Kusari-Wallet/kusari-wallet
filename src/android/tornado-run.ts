function runWorker(op: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker('tornado.worker.js');
    const finish = (fn: (v: any) => void, v: any) => { worker.terminate(); fn(v); };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.progress) return;
      if (m.error) finish(reject, new Error(m.error));
      else finish(resolve, m.result);
    };
    worker.onerror = (e) => finish(reject, new Error(e.message || '증명 엔진 오류'));
    worker.postMessage({ op, payload });
  });
}

/** A hidden same-origin page with its own stricter-scoped CSP, the only place in the app that allows eval. */
function runFrame(op: string, payload: unknown, onProgress: (stage: string) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.src = 'tornado.html';
    frame.hidden = true;
    const finish = (fn: (v: any) => void, v: any) => { window.removeEventListener('message', listen); frame.remove(); fn(v); };
    const listen = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.origin !== location.origin) return;
      const m = e.data;
      if (m.ready) frame.contentWindow!.postMessage({ op, payload }, location.origin);
      else if (m.progress) onProgress(m.progress);
      else if (m.error) finish(reject, new Error(m.error));
      else finish(resolve, m.result);
    };
    window.addEventListener('message', listen);
    frame.onerror = () => finish(reject, new Error('증명 엔진을 시작하지 못했어.'));
    document.body.append(frame);
  });
}

export async function runTornado(op: string, payload: any, onProgress: (stage: string) => void = () => undefined): Promise<any> {
  if (op !== 'prove') return runWorker(op, payload);
  onProgress('tree');
  const path = await runWorker('path', { leaves: payload.leaves, leafIndex: payload.leafIndex });
  const { leaves, ...rest } = payload;
  return runFrame('prove', { ...rest, path }, onProgress);
}
