import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface Secrets {
  tronMnemonic: string;
  moneroSeed: string;
  /** Random passwords for the Monero wallet files, one per network. */
  moneroFilePasswords: { mainnet: string; testnet: string };
  /** Where Monero scanning starts, one per network. */
  restoreHeights: { mainnet: number; testnet: number };
  /** Where Zcash scanning starts on a restored wallet, if a date was given. */
  zecBirthday?: number;
  /** The date a restored wallet started from, for Pirate Chain, whose height needs asking the server. */
  restoreDate?: string;
}

interface VaultFile {
  v: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string;
  tag: string;
  ct: string;
}

const KDF = { N: 2 ** 17, r: 8, p: 1 };
export const MIN_PASSWORD = 10;

function deriveKey(password: string, salt: Buffer, kdf: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key));
  });
}

function aad(file: Pick<VaultFile, 'v' | 'kdf'>): Buffer {
  return Buffer.from(JSON.stringify({ v: file.v, kdf: file.kdf }));
}

export class Vault {
  constructor(private readonly filePath: string, private readonly kdf = KDF) {}

  async exists(): Promise<boolean> {
    return fs.access(this.filePath).then(() => true, () => false);
  }

  async save(password: string, secrets: Secrets): Promise<void> {
    if (password.length < MIN_PASSWORD) throw new Error(`The password must be at least ${MIN_PASSWORD} characters.`);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const header = { v: 1 as const, kdf: { name: 'scrypt' as const, ...this.kdf, salt: salt.toString('base64') } };
    const key = await deriveKey(password, salt, this.kdf);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(header));
    const ct = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
    key.fill(0);
    const file: VaultFile = { ...header, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomBytes(4).toString('hex')}.tmp`;
    const handle = await fs.open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(file));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.filePath);
  }

  async open(password: string): Promise<Secrets> {
    const file = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as VaultFile;
    if (file.v !== 1 || file.kdf.name !== 'scrypt') throw new Error('This wallet file is not supported.');
    const key = await deriveKey(password, Buffer.from(file.kdf.salt, 'base64'), file.kdf);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
      decipher.setAAD(aad(file));
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      const pt = Buffer.concat([decipher.update(Buffer.from(file.ct, 'base64')), decipher.final()]);
      return JSON.parse(pt.toString('utf8')) as Secrets;
    } catch {
      throw new Error('Wrong password.');
    } finally {
      key.fill(0);
    }
  }

  async destroy(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}
