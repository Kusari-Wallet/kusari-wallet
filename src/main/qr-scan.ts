import { isWcLink } from './wc-link';

const jsQR = require('jsqr');

/**
 * Looks for a WalletConnect QR code in a captured image (BGRA as Electron gives it, or RGBA).
 * Reading happens here on the computer only; the image is not kept.
 */
export function findWcQr(pixels: Uint8Array | Buffer, width: number, height: number, order: 'bgra' | 'rgba' = 'bgra'): string {
  if (!width || !height || pixels.length < width * height * 4) return '';
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = pixels[order === 'bgra' ? i + 2 : i];
    rgba[i + 1] = pixels[i + 1];
    rgba[i + 2] = pixels[order === 'bgra' ? i : i + 2];
    rgba[i + 3] = 255;
  }
  const tryRead = (data: Uint8ClampedArray, w: number, h: number) => {
    const code = jsQR(data, w, h, { inversionAttempts: 'attemptBoth' });
    const text = String(code?.data ?? '').trim();
    return isWcLink(text) ? text : '';
  };
  const whole = tryRead(rgba, width, height);
  if (whole) return whole;
  // A small code in a big screenshot reads better in quarters, which jsQR scans at a finer scale.
  if (width < 600 || height < 600) return '';
  const hw = Math.ceil(width / 2);
  const hh = Math.ceil(height / 2);
  for (const [x0, y0] of [[0, 0], [hw / 2, 0], [hw, 0], [0, hh / 2], [hw / 2, hh / 2], [hw, hh / 2], [0, hh], [hw / 2, hh], [hw, hh]]) {
    const x = Math.floor(Math.min(x0, width - hw));
    const y = Math.floor(Math.min(y0, height - hh));
    const part = new Uint8ClampedArray(hw * hh * 4);
    for (let row = 0; row < hh; row++) part.set(rgba.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + hw) * 4), row * hw * 4);
    const found = tryRead(part, hw, hh);
    if (found) return found;
  }
  return '';
}
