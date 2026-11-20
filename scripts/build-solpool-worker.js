// Bundles src/solpool/worker.js (snarkjs and its libraries are bundled in, so they are not runtime dependencies).
const esbuild = require('esbuild');
const path = require('node:path');
const root = path.join(__dirname, '..');
const noWorker = { name: 'no-worker', setup(b) { b.onResolve({ filter: /^web-worker$/ }, () => ({ path: path.join(root, 'src/solpool/no-worker.js') })); } };

async function node() {
  await esbuild.build({
    entryPoints: [path.join(root, 'src/solpool/worker.js')], bundle: true, platform: 'node', target: 'node20',
    outfile: path.join(root, 'dist/main/solpool-worker.js'), define: { __BROWSER__: 'false' }, plugins: [noWorker], logLevel: 'error',
  });
}

async function browser(outfile, shimEmpty, shimGlobals) {
  const empty = /^(node:)?(fs|path|worker_threads|crypto|os|http|https|net|tls|zlib|url|child_process|readline|constants)$/;
  await esbuild.build({
    entryPoints: [path.join(root, 'src/solpool/worker.js')], bundle: true, platform: 'browser', format: 'iife', target: 'chrome100', minifyWhitespace: true, minifySyntax: true,
    outfile, define: { __BROWSER__: 'true', window: 'self', global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
    plugins: [noWorker, { name: 'empty', setup(b) { b.onResolve({ filter: empty }, () => ({ path: shimEmpty })); } }],
    alias: { stream: require.resolve('stream-browserify'), events: require.resolve('events/'), buffer: require.resolve('buffer/'), assert: require.resolve('assert/'), util: require.resolve('util/') },
    inject: [shimGlobals], logLevel: 'error',
  });
}

module.exports = { node, browser };
