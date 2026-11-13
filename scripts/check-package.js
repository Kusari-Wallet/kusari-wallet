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
// The main process is one bundle (dist/main/app.js); what it loads at run time from outside is Electron itself and the
// packages left out of the bundle. Each of those must be in the packaged app.
let bad = 0;
const main = path.join(dir, 'dist', 'main', 'app.js');
try { new (require('node:vm').Script)(fs.readFileSync(main, 'utf8'), { filename: main }); } catch (e) { console.error(`app.js: ${e.message}`); bad++; }
const external = [...new Set([...fs.readFileSync(main, 'utf8').matchAll(/require\("([^".][^"]*)"\)/g)].map((m) => m[1]).filter((m) => !m.startsWith('node:') && !require('node:module').builtinModules.includes(m) && m !== 'electron'))];
for (const name of external) {
  try { require(require.resolve(name, { paths: [dir] })); } catch (e) { console.error(`${name}: ${e.code ?? ''} ${e.message.split('\n')[0]}`); bad++; }
}
const worker = path.join(dir, 'dist', 'main', 'monero-worker.js');
if (!fs.existsSync(worker.replace('app.asar', 'app.asar.unpacked')) && !fs.existsSync(worker)) { console.error('The Monero worker is missing.'); bad++; }
fs.rmSync(dir, { recursive: true, force: true });
if (bad) process.exit(1);
console.log(`The bundle parses; outside packages it needs: ${external.length ? external.join(', ') : 'none'}.`);
