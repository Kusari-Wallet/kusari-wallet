// Loads the wallet's code the way a packaged app does, from the files a build actually shipped.
// Usage: electron --no-sandbox scripts/smoke-package.js <extracted app.asar folder>
const path = require('node:path');
const { app } = require('electron');
const dir = path.resolve(process.argv[process.argv.length - 1]);
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
app.whenReady().then(() => {
  try {
    const load = (name) => require(path.join(dir, 'dist/main', name));
    for (const name of ['amount', 'config', 'request', 'insight', 'btc', 'eth', 'tron', 'dash', 'firo', 'doge', 'sol', 'zec', 'zano', 'arrr', 'swap', 'prices', 'tor', 'vault', 'service']) load(name);
    const sol = load('sol').solAddress(PHRASE);
    const dogeModule = load('doge');
    const doge = new dogeModule.DogeClient(dogeModule.dogeAccountXpub(PHRASE), []).addressAt(0, 0);
    if (sol !== 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' || doge !== 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC') throw new Error('wrong addresses');
    console.log('SMOKE OK', process.versions.electron);
    app.exit(0);
  } catch (e) {
    console.log('SMOKE FAILED', e.message);
    app.exit(1);
  }
});
