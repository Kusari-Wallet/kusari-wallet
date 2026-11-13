// Builds the developer version of Kusari Wallet for Windows: coins and features not yet released (KSR first) to try
// before everyone gets them. It is named "Kusari Wallet Dev", with its own app ID and data folder, so it runs beside
// the regular wallet without ever touching its wallets. Output: release/dev/.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const env = { ...process.env, KUSARI_FLAVOR: 'developer' };
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit', env });

// The KSR engine waits in native-bin/_later until KSR launches; only this build carries it.
const parked = path.join(root, 'native-bin', '_later', 'ksr-bridge.exe');
const ksrDir = path.join(root, 'native-bin', 'ksr');
if (!fs.existsSync(parked)) throw new Error('native-bin/_later/ksr-bridge.exe is missing (the KSR engine for Windows).');
const hadKsr = fs.existsSync(ksrDir);
fs.mkdirSync(ksrDir, { recursive: true });
fs.copyFileSync(parked, path.join(ksrDir, 'ksr-bridge.exe'));
try {
  run('npm run build');
  run([
    'npx electron-builder --win',
    '-c.productName="Kusari Wallet Dev"',
    '-c.appId=dev.edge.kusariwallet.dev',
    '-c.extraMetadata.name=kusari-wallet-dev',
    '-c.extraMetadata.productName="Kusari Wallet Dev"',
    '-c.directories.output=release/dev',
    // Single quotes: the shell must leave electron-builder's ${...} placeholders alone.
    "-c.artifactName='KusariWallet-Dev-${version}-${os}-${arch}.${ext}'",
  ].join(' '));
} finally {
  if (!hadKsr) fs.rmSync(ksrDir, { recursive: true, force: true });
  // Leave dist/ as a regular build, so nothing built next carries the developer flavor by accident.
  execSync('npm run build', { cwd: root, stdio: 'inherit', env: { ...process.env, KUSARI_FLAVOR: '' } });
}
