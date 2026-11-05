// Same file format and parameters as the desktop vault, on WebCrypto and a JS scrypt.
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { kvDel, kvGet, kvSet } from './kv';
import type { Secrets } from '../main/vault';

export type { Secrets };
export const MIN_PASSWORD = 10;
const KDF = { N: 2 ** 17, r: 8, p: 1 };
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password: string, salt: Uint8Array, kdf: { N: number; r: number; p: number }): Promise<CryptoKey> {
  const raw = await scryptAsync(new TextEncoder().encode(password.normalize('NFKC')), salt, {
    N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32, maxmem: 256 * 1024 * 1024, asyncTick: 50,
  });
  const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  raw.fill(0);
  return key;
}

const aad = (f: { v: number; kdf: unknown }) => new TextEncoder().encode(JSON.stringify({ v: f.v, kdf: f.kdf }));

export class Vault {
  private readonly key: string;
  constructor(filePath: string, private readonly kdf = KDF) { this.key = 'vault:' + filePath; }

  async exists(): Promise<boolean> { return (await kvGet(this.key)) !== undefined; }

  async save(password: string, secrets: Secrets): Promise<void> {
    if (password.length < MIN_PASSWORD) throw new Error(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 해.`);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const header = { v: 1, kdf: { name: 'scrypt', ...this.kdf, salt: b64(salt) } };
    const key = await deriveKey(password, salt, this.kdf);
    const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(header) }, key, new TextEncoder().encode(JSON.stringify(secrets))));
    const ct = out.subarray(0, out.length - 16);
    const tag = out.subarray(out.length - 16);
    await kvSet(this.key, JSON.stringify({ ...header, iv: b64(iv), tag: b64(tag), ct: b64(ct) }));
  }

  async open(password: string): Promise<Secrets> {
    const raw = await kvGet<string>(this.key);
    if (raw === undefined) throw new Error('지갑이 없어.');
    const file = JSON.parse(raw);
    if (file.v !== 1 || file.kdf.name !== 'scrypt') throw new Error('지원하지 않는 지갑 파일이야.');
    const key = await deriveKey(password, unb64(file.kdf.salt), file.kdf);
    const ct = unb64(file.ct);
    const tag = unb64(file.tag);
    const joined = new Uint8Array(ct.length + tag.length);
    joined.set(ct); joined.set(tag, ct.length);
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv), additionalData: aad(file) }, key, joined);
      return JSON.parse(new TextDecoder().decode(pt));
    } catch {
      throw new Error('비밀번호가 틀렸어.');
    }
  }

  async destroy(): Promise<void> { await kvDel(this.key); }
}
