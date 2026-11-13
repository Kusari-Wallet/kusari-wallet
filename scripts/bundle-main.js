// Bundles the desktop main process (dist/main/main.js and everything it uses) into one minified file,
// dist/main/app.js, which is what the app runs. One file instead of thousands of loose ones in node_modules makes the
// download smaller, unpacking faster and start-up quicker (Windows scans every file it opens).
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.join(__dirname, '..');
// web-worker starts its worker thread from its own file, so it can't be inside a bundle: it ships as a package (8 files).
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', minify: true, legalComments: 'external', logLevel: 'error', external: ['electron', 'web-worker'] };
Promise.all([esbuild.build({
  ...common,
  entryPoints: [path.join(root, 'dist/main/main.js')],
  outfile: path.join(root, 'dist/main/app.js'),
  // Licence notices of bundled libraries are kept in a file next to it.
}),
// monero-ts runs its wallet in a worker thread started from a file: that file is bundled on its own too.
esbuild.build({
  ...common,
  entryPoints: [require.resolve('monero-ts/dist/src/main/ts/common/MoneroWebWorker.js')],
  outfile: path.join(root, 'dist/main/monero-worker.js'),
})]).catch((e) => { console.error(e.message); process.exit(1); });
