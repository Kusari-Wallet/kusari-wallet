// Bundles src/tornado/worker.js. Its libraries are bundled in, so they are not runtime dependencies.
const esbuild = require('esbuild');
const path = require('node:path');
const root = path.join(__dirname, '..');
const blake = { name: 'blake', setup(b) { b.onResolve({ filter: /^blake-hash$/ }, () => ({ path: require.resolve('blake-hash/js') })); } };

async function node() {
  await esbuild.build({
    entryPoints: [path.join(root, 'src/tornado/worker.js')], bundle: true, platform: 'node', target: 'node20',
    outfile: path.join(root, 'dist/main/tornado-worker.js'), define: { __BROWSER__: 'false' }, plugins: [blake], logLevel: 'error',
  });
}

async function browser(outfile, shimEmpty, shimGlobals) {
  const empty = /^(node:)?(fs|path|worker_threads|crypto|os|http|https|net|tls|zlib|url|child_process)$/;
  await esbuild.build({
    entryPoints: [path.join(root, 'src/tornado/worker.js')], bundle: true, platform: 'browser', format: 'iife', target: 'chrome100', minifyWhitespace: true, minifySyntax: true,
    outfile, define: { __BROWSER__: 'true', window: 'self', global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
    plugins: [blake, { name: 'empty', setup(b) { b.onResolve({ filter: empty }, () => ({ path: shimEmpty })); } }],
    alias: { stream: require.resolve('stream-browserify'), events: require.resolve('events/'), buffer: require.resolve('buffer/'), assert: require.resolve('assert/'), util: require.resolve('util/') },
    inject: [shimGlobals], logLevel: 'error',
  });
}

module.exports = { node, browser };
