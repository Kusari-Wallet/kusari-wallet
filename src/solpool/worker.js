// Proves Solana private pool transactions off the app's main thread: witness and Groth16 proof on the pool's
// circuit (transaction2), single-threaded, so it needs no further workers. Bundled twice by esbuild: a
// worker_threads file for desktop and a web worker for Android.
const { groth16 } = require('snarkjs7');

// The pool's circuit files (from its SDK); the program's verifying key matches this proving key.
const HASHES = {
  wasm: 'a277631b7616c2c0bfd78a1648b069972ac6020e5509ae8f9bfc8772bdc70ec1',
  zkey: '4aa7aa5c1c28ed1f00fee84f49c1686f53210fd999ef7c8db6cfcd298af4e693',
};

async function prove(input, assets) {
  const { wasm, zkey } = await assets();
  const { proof, publicSignals } = await groth16.fullProve(input, { type: 'mem', data: wasm }, { type: 'mem', data: zkey }, undefined, { singleThread: true }, { singleThread: true });
  return { proof: { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c }, publicSignals };
}

function handler(post, assets) {
  return async ({ op, payload }) => {
    try {
      if (op === 'prove') post({ result: await prove(payload.input, assets) });
      else throw new Error(`unknown op ${op}`);
    } catch (e) {
      post({ error: String((e && e.message) || e) });
    }
  };
}

if (__BROWSER__) {
  const assets = async () => {
    const [wasm, zkey] = await Promise.all(['solpool/transaction2.wasm', 'solpool/transaction2.zkey'].map((f) => fetch(f).then((r) => {
      if (!r.ok) throw new Error('The proof files are missing.');
      return r.arrayBuffer();
    })));
    const out = { wasm: new Uint8Array(wasm), zkey: new Uint8Array(zkey) };
    for (const k of ['wasm', 'zkey']) {
      const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', out[k])), (b) => b.toString(16).padStart(2, '0')).join('');
      if (h !== HASHES[k]) throw new Error('The proof files have been changed.');
    }
    return out;
  };
  const run = handler((m) => self.postMessage(m), assets);
  self.onmessage = (e) => { run(e.data); };
} else {
  const { parentPort } = require('worker_threads');
  const fs = require('fs');
  const path = require('path');
  const assets = async () => {
    const dir = path.join(__dirname, 'solpool');
    const out = {};
    for (const k of ['wasm', 'zkey']) {
      const data = fs.readFileSync(path.join(dir, `transaction2.${k}`));
      if (require('crypto').createHash('sha256').update(data).digest('hex') !== HASHES[k]) throw new Error('The proof files have been changed.');
      out[k] = new Uint8Array(data);
    }
    return out;
  };
  const run = handler((m) => parentPort.postMessage(m), assets);
  parentPort.on('message', (m) => { run(m).finally(() => undefined); });
}
