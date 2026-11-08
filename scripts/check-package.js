// Loads every main-process module from the packaged Windows app, the way it runs there, so a dependency that only
// exists in development (as @noble/hashes once did) fails here instead of on someone's machine.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const asar = path.join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(asar)) { console.error('No packaged app. Run npm run dist:win first.'); process.exit(1); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kusari-asar-'));
execFileSync(process.execPath, [require.resolve('@electron/asar/bin/asar.js'), 'extract', asar, dir]);
const skip = new Set(['tornado-worker.js']); // runs only inside a worker thread
let bad = 0;
for (const f of fs.readdirSync(path.join(dir, 'dist', 'main')).filter((f) => f.endsWith('.js') && !skip.has(f))) {
  try { require(path.join(dir, 'dist', 'main', f)); } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && /'electron'/.test(e.message)) continue; // provided by Electron itself
    console.error(`${f}: ${e.code ?? ''} ${e.message.split('\n')[0]}`);
    bad++;
  }
}
fs.rmSync(dir, { recursive: true, force: true });
if (bad) process.exit(1);
console.log('Every packaged main module loads.');
