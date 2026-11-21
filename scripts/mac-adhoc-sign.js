// electron-builder afterSign hook (after the Electron fuses are set, which change the binaries): a macOS build made off a Mac gets an ad-hoc signature, because Apple Silicon
// refuses to start code whose signature no longer matches (packing changes the Electron binaries). Uses rcodesign
// (apple-codesign, an official release checked by its SHA256SUMS) from RCODESIGN or the PATH. An ad-hoc signature is
// not an Apple Developer ID: Gatekeeper still asks the user to confirm the first start.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    return;
  }
  const tool = process.env.RCODESIGN || 'rcodesign';
  execFileSync(tool, ['sign', app], { stdio: 'inherit' });
  // rcodesign's verify expects a CMS signature, which an ad-hoc one hasn't: check the code directory is there.
  for (const f of [path.join(app, 'Contents/MacOS', context.packager.appInfo.productFilename), path.join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')]) {
    const info = execFileSync(tool, ['print-signature-info', f], { encoding: 'utf8' });
    if (!/code_directory|cdhash/i.test(info)) throw new Error(`No code signature on ${f}`);
  }
};
