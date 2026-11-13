// The last balance of each coin, kept so a restart or an unlock shows the total at once instead of "loading".
// The file is encrypted (AES-256-GCM) with a key derived from the wallet's seed, so it reads as noise without the
// unlocked wallet, and it is only ever read and written on this device.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const { gcm } = require('@noble/ciphers/aes.js');
const { hmac } = require('@noble/hashes/hmac.js');
const { sha256 } = require('@noble/hashes/sha2.js');

export interface SavedBalance { at: number; total: string; spendable: string }

/** Shown at most this old: after a week away, "loading" is more honest than a number. */
export const SAVED_BALANCE_MAX_AGE_MS = 7 * 24 * 3600_000;

const AMOUNT = /^\d{1,40}(\.\d{1,30})?$/;

/** Its own key, separate from anything that signs: knowing it reveals balances, never coins. */
export function balanceCacheKey(seed: string): Uint8Array {
  return hmac(sha256, new TextEncoder().encode(seed.normalize('NFKD')), new TextEncoder().encode('kusari-wallet balance cache v1'));
}

export async function readBalanceCache(file: string, key: Uint8Array): Promise<Map<string, SavedBalance>> {
  const out = new Map<string, SavedBalance>();
  try {
    const j = JSON.parse(await fs.readFile(file, 'utf8'));
    if (j?.v !== 1) return out;
    const plain = gcm(key, Buffer.from(j.iv, 'base64')).decrypt(Buffer.from(j.data, 'base64'));
    const rows = JSON.parse(new TextDecoder().decode(plain));
    const now = Date.now();
    for (const [coin, r] of Object.entries<any>(rows ?? {})) {
      if (!/^[A-Z0-9]{2,8}$/.test(coin) || !Number.isFinite(r?.at) || r.at > now + 60_000 || now - r.at > SAVED_BALANCE_MAX_AGE_MS) continue;
      if (typeof r.total !== 'string' || typeof r.spendable !== 'string' || !AMOUNT.test(r.total) || !AMOUNT.test(r.spendable)) continue;
      out.set(coin, { at: r.at, total: r.total, spendable: r.spendable });
    }
  } catch { /* none yet, another wallet's, or damaged: start empty */ }
  return out;
}

export async function writeBalanceCache(file: string, key: Uint8Array, rows: Map<string, SavedBalance>): Promise<void> {
  const iv = randomBytes(12);
  const data = gcm(key, iv).encrypt(new TextEncoder().encode(JSON.stringify(Object.fromEntries(rows))));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ v: 1, iv: Buffer.from(iv).toString('base64'), data: Buffer.from(data).toString('base64') }), { mode: 0o600 });
  await fs.rename(tmp, file);
}
