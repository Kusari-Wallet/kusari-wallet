const test = require('node:test');
const assert = require('node:assert');
const QRCode = require('qrcode');
const { findWcQr } = require('../dist/main/qr-scan');
const { isWcLink, wcLinkOf } = require('../dist/main/wc-link');

const LINK = `wc:${'ab12'.repeat(16)}@2?relay-protocol=irn&symKey=${'cd34'.repeat(16)}&expiryTimestamp=1762600000`;

/** A screen-sized picture with the QR code drawn at (x, y), as Electron gives it: BGRA. */
function screenWith(text, width, height, x, y, cell) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const px = Buffer.alloc(width * height * 4, 0xee); // a light page
  const quiet = 4;
  for (let r = -quiet; r < n + quiet; r++) for (let c = -quiet; c < n + quiet; c++) {
    const dark = r >= 0 && c >= 0 && r < n && c < n && qr.modules.get(r, c);
    for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) {
      const i = ((y + (r + quiet) * cell + dy) * width + (x + (c + quiet) * cell + dx)) * 4;
      px[i] = px[i + 1] = px[i + 2] = dark ? 0 : 255;
    }
  }
  return px;
}

test('the WalletConnect QR is found wherever it sits on the screen', () => {
  assert.equal(findWcQr(screenWith(LINK, 1600, 1000, 900, 300, 4), 1600, 1000), LINK);
  assert.equal(findWcQr(screenWith(LINK, 1920, 1080, 40, 620, 3), 1920, 1080), LINK, 'a small code in a corner');
});

test('a QR with anything else is not taken', () => {
  assert.equal(findWcQr(screenWith('https://example.com/not-a-wallet-link', 1200, 900, 300, 200, 5), 1200, 900), '');
  assert.equal(findWcQr(Buffer.alloc(800 * 600 * 4, 0xff), 800, 600), '');
});

test('links handed over by the system', () => {
  assert.ok(isWcLink(LINK));
  assert.ok(!isWcLink('wc:abc@2?x=1'));
  assert.ok(!isWcLink(`${LINK} rm -rf`));
  assert.equal(wcLinkOf(['Kusari Wallet.exe', '--flag', LINK]), LINK);
  assert.equal(wcLinkOf([`kusari://wc?uri=${encodeURIComponent(LINK)}`]), LINK);
  assert.equal(wcLinkOf(['Kusari Wallet.exe']), '');
});
