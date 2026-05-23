import type { ParsedMail } from "./types";

const DB_NAME = "cloudmail_webmail_cache_v1";
const STORE_NAME = "mailboxes";
const MAX_CACHED_MAILS = 300;

export type MailboxCachePayload = {
  cacheKey: string;
  address: string;
  updatedAt: string;
  nextOffset: number;
  mails: ParsedMail[];
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = run(tx.objectStore(STORE_NAME));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function readMailboxCache(cacheKey: string): Promise<MailboxCachePayload | null> {
  try {
    return (await withStore("readonly", (store) => store.get(cacheKey))) || null;
  } catch {
    return null;
  }
}

export async function writeMailboxCache(payload: MailboxCachePayload): Promise<void> {
  const nextPayload: MailboxCachePayload = {
    ...payload,
    updatedAt: new Date().toISOString(),
    mails: payload.mails.slice(0, MAX_CACHED_MAILS),
  };
  await withStore("readwrite", (store) => store.put(nextPayload));
}

export async function clearMailboxCache(cacheKey: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(cacheKey));
}
