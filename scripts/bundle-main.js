// Bundles the desktop main process (dist/main/main.js and everything it uses) into one minified file,
// dist/main/app.js, which is what the app runs. One file instead of thousands of loose ones in node_modules makes the
// download smaller, unpacking faster and start-up quicker (Windows scans every file it opens).
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.join(__dirname, '..');
// web-worker starts its worker thread from its own file, so it can't be inside a bundle: it ships as a package (8 files).
// monero-ts's WebAssembly glue (monero.js) reads its helpers as this.HttpClient etc., which only works outside strict
// mode; a bundle is strict, so `this` is undefined there and every request from the wallet failed. They are globals:
// read them as such.
const moneroGlue = {
  name: 'monero-glue',
  setup(b) {
    b.onLoad({ filter: /monero-ts[\\/]dist[\\/]monero\.js$/ }, async (args) => {
      const text = await require('node:fs/promises').readFile(args.path, 'utf8');
      const fixed = text.replace(/const (HttpClient|LibraryUtils|GenUtils)=this\.\1/g, 'const $1=globalThis.$1');
      if (fixed === text) throw new Error('monero.js changed: check how it reaches HttpClient before bundling it.');
      return { contents: fixed, loader: 'js' };
    });
  },
};
const common = { define: { __KUSARI_FLAVOR__: JSON.stringify(process.env.KUSARI_FLAVOR || 'release') }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', minify: true, legalComments: 'external', logLevel: 'error', external: ['electron', 'web-worker'], plugins: [moneroGlue] };
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
