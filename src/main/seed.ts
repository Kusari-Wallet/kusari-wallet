// The BIP39 seed of the wallet's 12 words, with the optional passphrase ("13th word") of the open wallet. Every
// coin derived from the 12 words takes its seed from here, so one passphrase changes them all together. The
// passphrase lives only in the vault and, while the wallet is open, in this map; locking clears it.
const { mnemonicToSeedSync } = require('@scure/bip39');

const norm = (m: string): string => m.trim().toLowerCase().split(/\s+/).join(' ');
const passphrases = new Map<string, string>();
const seeds = new Map<string, Uint8Array>();

export function setPassphrase(mnemonic: string, passphrase: string | undefined): void {
  const key = norm(mnemonic);
  if (passphrase) passphrases.set(key, passphrase); else passphrases.delete(key);
  seeds.delete(key);
}

export function clearPassphrases(): void {
  passphrases.clear();
  for (const s of seeds.values()) s.fill(0);
  seeds.clear();
}

export const passphraseOf = (mnemonic: string): string => passphrases.get(norm(mnemonic)) ?? '';
export const hasPassphrase = (mnemonic: string): boolean => passphrases.has(norm(mnemonic));

/** The 64-byte BIP39 seed (computed once per open wallet: it takes 2048 rounds of PBKDF2). */
export function bip39Seed(mnemonic: string): Uint8Array {
  const key = norm(mnemonic);
  let s = seeds.get(key);
  if (!s) {
    s = mnemonicToSeedSync(key, passphrases.get(key) ?? '') as Uint8Array;
    if (seeds.size > 8) seeds.clear();
    seeds.set(key, s);
  }
  return Uint8Array.from(s);
}
