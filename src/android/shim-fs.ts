// node:fs stand-in for the shared service code. Only settings use it on Android.
import { kvDelPrefix, kvGet, kvSet } from './kv';

const fileKey = (p: string) => 'file:' + p;
export const promises = {
  async readFile(p: string) {
    const v = await kvGet<string>(fileKey(p));
    if (v === undefined) throw new Error('ENOENT');
    return v;
  },
  async writeFile(p: string, data: string) { await kvSet(fileKey(p), String(data)); },
  async mkdir() {},
  async rm(p: string) { await kvDelPrefix(fileKey(p)); },
};
export const existsSync = () => false;
export const mkdirSync = () => undefined;
export default { promises, existsSync, mkdirSync };
