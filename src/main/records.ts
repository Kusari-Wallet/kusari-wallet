// The wallet's own records on this device (swaps, Tornado deposits, Bitcoin labels and address lists, CoinJoin
// progress) are kept encrypted with AES-256-GCM, under a key derived from the seed, so the files read as noise to anyone
// with the device but not the unlocked wallet. Files written in the clear by older versions are read once and
// rewritten encrypted.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const { gcm } = require('@noble/ciphers/aes.js');
const { hmac } = require('@noble/hashes/hmac.js');
const { sha256 } = require('@noble/hashes/sha2.js');

export interface Records {
  /** The record, or undefined when there is none (or it isn't this wallet's). */
  read(file: string): Promise<any>;
  write(file: string, value: unknown): Promise<void>;
}

export function recordsKey(seed: string): Uint8Array {
  return hmac(sha256, new TextEncoder().encode(seed.normalize('NFKD')), new TextEncoder().encode('kusari-wallet records v1'));
}

export function sealedRecords(key: Uint8Array): Records {
  const write = async (file: string, value: unknown): Promise<void> => {
    if (key.every((b) => b === 0)) return; // locked meanwhile: nothing is written in the clear
    const iv = randomBytes(12);
    const data = gcm(key, iv).encrypt(new TextEncoder().encode(JSON.stringify(value)));
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ sealed: 1, iv: Buffer.from(iv).toString('base64'), data: Buffer.from(data).toString('base64') }), { mode: 0o600 });
    await fs.rename(tmp, file);
  };
  return {
    async read(file) {
      let j: any;
      try { j = JSON.parse(String(await fs.readFile(file, 'utf8'))); } catch { return undefined; }
      if (j?.sealed === 1 && typeof j.iv === 'string' && typeof j.data === 'string') {
        try { return JSON.parse(new TextDecoder().decode(gcm(key, Buffer.from(j.iv, 'base64')).decrypt(Buffer.from(j.data, 'base64')))); } catch { return undefined; }
      }
      // From before records were encrypted: taken as it is, and stored encrypted from now on.
      await write(file, j).catch(() => undefined);
      return j;
    },
    write,
  };
}

/** No unlocked wallet (tests that run parts on their own): plain files, as before. */
export const plainRecords: Records = {
  async read(file) { try { return JSON.parse(String(await fs.readFile(file, 'utf8'))); } catch { return undefined; } },
  async write(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  },
};

/** After a lock: nothing is read and nothing is written until the next unlock. */
export const lockedRecords: Records = { async read() { return undefined; }, async write() {} };
