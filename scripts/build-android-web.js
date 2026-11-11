// Bundles the shared wallet code for the Android WebView into android/build/www.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const test = process.argv.includes('--test');
const out = path.join(root, test ? 'android/build/www-test' : 'android/build/www');
const android = path.join(root, 'src/android');

const aliasPlugin = {
  name: 'android-aliases',
  setup(b) {
    const swap = { './vault': 'vault.ts', './request': 'request.ts', './tor': 'tor.ts', './tornado-run': 'tornado-run.ts', './zec-process': 'zec-process.ts', './zano-process': 'zano-process.ts', './arrr-process': 'arrr-process.ts', './mweb-process': 'mweb-process.ts', './spark-process': 'spark-process.ts', './dash-net': 'dash-net.ts' };
    b.onResolve({ filter: /^\.\/(vault|request|tor|tornado-run|zec-process|zano-process|arrr-process|mweb-process|spark-process|dash-net)$/ }, (args) => (args.importer.includes(`${path.sep}src${path.sep}main${path.sep}`) ? { path: path.join(android, swap[args.path]) } : undefined));
    // Node-only branches of libraries never run in the WebView. They just need something to import.
    const empty = /^(node:)?(fs|fs\/promises|http|https|net|tls|os|zlib|url|stream|child_process|worker_threads|perf_hooks|crypto|dns|http2)$/;
    b.onResolve({ filter: empty }, (args) => (args.path === 'node:crypto' || args.path === 'node:fs' ? undefined : { path: path.join(android, 'shim-empty.js') }));
    b.onResolve({ filter: /^node:fs$/ }, () => ({ path: path.join(android, 'shim-fs.ts') }));
    b.onResolve({ filter: /^node:crypto$/ }, () => ({ path: path.join(android, 'shim-crypto.ts') }));
    b.onResolve({ filter: /^node:path$/ }, () => ({ path: require.resolve('path-browserify') }));
    b.onResolve({ filter: /^node:events$/ }, () => ({ path: require.resolve('events/') }));
  },
};

(async () => {
  require('./gen-keys');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(android, 'bridge.ts')],
    bundle: true, platform: 'browser', format: 'iife', target: 'chrome100', minify: !test,
    outfile: path.join(out, 'bridge.js'),
    define: { __TEST__: String(test), global: 'globalThis', 'process.env.NODE_ENV': '"production"', __dirname: '"/"' },
    plugins: [aliasPlugin], logLevel: 'error', loader: { '.wasm': 'binary' },
    alias: { events: require.resolve('events/'), path: require.resolve('path-browserify'), buffer: require.resolve('buffer/'), assert: require.resolve('assert/'), util: require.resolve('util/') },
    inject: [path.join(android, 'shim-globals.js')],
  });
  const r = path.join(root, 'dist/renderer');
  for (const f of ['locales.js', 'i18n.js', 'app.js', 'jsQR.js', 'style.css', 'logo.png', 'PretendardVariable.woff2']) fs.copyFileSync(path.join(r, f), path.join(out, f));
  fs.cpSync(path.join(r, 'coins'), path.join(out, 'coins'), { recursive: true });
  fs.copyFileSync(path.join(android, 'index.html'), path.join(out, 'index.html'));
  // Tor's default bridges, from the same signed bundle as the bridge program (scripts/fetch-lyrebird-android.sh).
  const pt = path.join(root, 'android/pt_config.json');
  if (fs.existsSync(pt)) fs.copyFileSync(pt, path.join(out, 'pt_config.json'));
  fs.copyFileSync(path.join(root, 'node_modules/monero-ts/dist/monero.worker.js'), path.join(out, 'monero.worker.js'));
  await require('./build-tornado-worker').browser(path.join(out, 'tornado.worker.js'), path.join(android, 'shim-empty.js'), path.join(android, 'shim-globals.js'));
  fs.cpSync(path.join(root, 'assets/tornado'), path.join(out, 'tornado'), { recursive: true });
  fs.copyFileSync(path.join(android, 'tornado.html'), path.join(out, 'tornado.html'));
  const size = fs.readdirSync(out).filter((f) => fs.statSync(path.join(out, f)).isFile()).map((f) => [f, fs.statSync(path.join(out, f)).size]);
  console.log(size.map(([f, s]) => `${f} ${(s / 1048576).toFixed(1)}MB`).join(', '));
})().catch((e) => { console.error(e.message); process.exit(1); });
