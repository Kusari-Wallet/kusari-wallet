// Small key-value store on IndexedDB. Everything secret stored here is already encrypted.
const DB = 'vault-wallet';
const STORE = 'kv';
let dbp: Promise<IDBDatabase> | null = null;
const cache = new Set<string>();

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const kvGet = <T = any>(k: string) => tx<T | undefined>('readonly', (s) => s.get(k));
export const kvSet = (k: string, v: unknown) => tx('readwrite', (s) => s.put(v, k)).then(() => { cache.add(k); });
export const kvDel = (k: string) => tx('readwrite', (s) => s.delete(k)).then(() => { cache.delete(k); });
export const kvDelPrefix = (p: string) => tx('readwrite', (s) => s.delete(IDBKeyRange.bound(p, p + '￿')));
