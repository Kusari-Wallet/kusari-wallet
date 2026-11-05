// Runs the heavy Tornado work off the app's main thread: Pedersen and MiMC hashing, witness and proof.
// Bundled twice by esbuild: a worker_threads file for desktop and a web worker for Android.
const circomlib = {
  pedersenHash: require('circomlib/src/pedersenHash.js'),
  babyJub: require('circomlib/src/babyjub.js'),
  mimcsponge: require('circomlib/src/mimcsponge.js'),
};
const bigInt = require('snarkjs/src/bigint');
const buildGroth16 = require('websnark/src/groth16');
const websnarkUtils = require('websnark/src/utils');
const MerkleTree = require('fixed-merkle-tree');

const ZERO = '21663839004416932945382355908790599225266501822907911457504978515578255421292';
const LEVELS = 20;

const pedersen = (data) => circomlib.babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0];
const mimc = (l, r) => circomlib.mimcsponge.multiHash([bigInt(l), bigInt(r)]).toString();
const hex = (n, bytes = 32) => `0x${bigInt(n).toString(16).padStart(bytes * 2, "0")}`;
const le = (h) => bigInt.leBuff2int(Buffer.from(h, 'hex'));

function commit({ nullifier, secret }) {
  const n = le(nullifier);
  const s = le(secret);
  const preimage = Buffer.concat([n.leInt2Buff(31), s.leInt2Buff(31)]);
  return { commitment: hex(pedersen(preimage)), nullifierHash: hex(pedersen(n.leInt2Buff(31))) };
}

function buildPath({ leaves, leafIndex }) {
  const tree = new MerkleTree(LEVELS, leaves.map((l) => bigInt(l).toString()), { hashFunction: mimc, zeroElement: ZERO });
  const { pathElements, pathIndices } = tree.path(leafIndex);
  return { root: tree.root().toString(), pathElements: pathElements.map(String), pathIndices };
}

async function prove(payload, assets, progress) {
  const { nullifier, secret, recipient, relayer, fee } = payload;
  progress('tree');
  const { root, pathElements, pathIndices } = payload.path ?? buildPath(payload);
  const n = le(nullifier);
  const s = le(secret);
  const input = {
    root: bigInt(root), nullifierHash: pedersen(n.leInt2Buff(31)),
    recipient: bigInt(recipient), relayer: bigInt(relayer), fee: bigInt(fee), refund: bigInt(0),
    nullifier: n, secret: s, pathElements, pathIndices,
  };
  progress('proof');
  const { circuit, provingKey } = await assets();
  const groth16 = await buildGroth16();
  const data = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, provingKey);
  const { proof } = websnarkUtils.toSolidityInput(data);
  return {
    proof,
    args: [hex(input.root), hex(input.nullifierHash), hex(input.recipient, 20), hex(input.relayer, 20), hex(input.fee), hex(input.refund)],
  };
}

function handler(post, assets) {
  return async ({ op, payload }) => {
    try {
      const progress = (stage) => post({ progress: stage });
      if (op === 'commit') post({ result: payload.notes.map(commit) });
      else if (op === 'path') post({ result: buildPath(payload) });
      else if (op === 'prove') post({ result: await prove(payload, assets, progress) });
      else throw new Error(`unknown op ${op}`);
    } catch (e) {
      post({ error: String((e && e.message) || e) });
    }
  };
}

if (__BROWSER__) {
  const assets = async () => {
    const [circuit, key] = await Promise.all([
      fetch('tornado/tornado.json').then((r) => r.json()),
      fetch('tornado/tornadoProvingKey.bin').then((r) => r.arrayBuffer()),
    ]);
    return { circuit, provingKey: key };
  };
  if (typeof document === 'undefined') {
    const run = handler((m) => self.postMessage(m), assets);
    self.onmessage = (e) => { run(e.data); };
  } else {
    // Hidden page: witness generation recurses deeper than a browser worker's stack allows.
    const run = handler((m) => parent.postMessage(m, location.origin), assets);
    self.addEventListener('message', (e) => { if (e.origin === location.origin && e.source === parent) run(e.data); });
    parent.postMessage({ ready: true }, location.origin);
  }
} else {
  const { parentPort } = require('worker_threads');
  const fs = require('fs');
  const path = require('path');
  const assets = async () => {
    const dir = path.join(__dirname, 'tornado');
    const key = fs.readFileSync(path.join(dir, 'tornadoProvingKey.bin'));
    return { circuit: JSON.parse(fs.readFileSync(path.join(dir, 'tornado.json'), 'utf8')), provingKey: key.buffer.slice(key.byteOffset, key.byteOffset + key.length) };
  };
  const run = handler((m) => parentPort.postMessage(m), assets);
  parentPort.on('message', (m) => { run(m).finally(() => undefined); });
}
