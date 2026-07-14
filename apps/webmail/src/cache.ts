import type { ParsedMail } from "./types";

const DB_NAME = "cloudmail_webmail_cache_v1";
const STORE_NAME = "mailboxes";
const MAX_CACHED_MAILS = 300;
export const MAX_MAILBOX_CACHE_BYTES = 4 * 1024 * 1024;
const FALLBACK_MAILBOX_CACHE_BYTES = 512 * 1024;
const MAX_FULL_MAIL_BYTES = 512 * 1024;

export type MailboxCachePayload = {
  cacheKey: string;
  address: string;
  updatedAt: string;
  nextOffset: number;
  mails: ParsedMail[];
};

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function summarizeMail(mail: ParsedMail): ParsedMail {
  return {
    ...mail,
    raw: "",
    html: undefined,
    text: mail.preview || "",
    attachments: mail.attachments?.slice(0, 24).map((attachment) => ({ ...attachment })),
  };
}

export function prepareMailboxCachePayload(
  payload: MailboxCachePayload,
  maxBytes = MAX_MAILBOX_CACHE_BYTES,
): MailboxCachePayload {
  const budget = Math.max(16 * 1024, Number(maxBytes) || MAX_MAILBOX_CACHE_BYTES);
  const base: MailboxCachePayload = {
    ...payload,
    updatedAt: payload.updatedAt || new Date().toISOString(),
    nextOffset: 0,
    mails: [],
  };
  const mails: ParsedMail[] = [];
  for (const mail of payload.mails.slice(0, MAX_CACHED_MAILS)) {
    let candidate = jsonBytes(mail) <= MAX_FULL_MAIL_BYTES ? mail : summarizeMail(mail);
    let next = { ...base, nextOffset: mails.length + 1, mails: [...mails, candidate] };
    if (jsonBytes(next) > budget && candidate === mail) {
      candidate = summarizeMail(mail);
      next = { ...base, nextOffset: mails.length + 1, mails: [...mails, candidate] };
    }
    if (jsonBytes(next) > budget) break;
    mails.push(candidate);
  }
  return { ...base, nextOffset: mails.length, mails };
}

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
    const cached = (await withStore("readonly", (store) => store.get(cacheKey))) || null;
    if (!cached || cached.cacheKey !== cacheKey || !Array.isArray(cached.mails)) return null;
    return {
      ...cached,
      nextOffset: Math.min(cached.mails.length, Math.max(0, Number(cached.nextOffset) || cached.mails.length)),
    };
  } catch {
    return null;
  }
}

export async function writeMailboxCache(payload: MailboxCachePayload): Promise<void> {
  const stamped = { ...payload, updatedAt: new Date().toISOString() };
  try {
    await withStore("readwrite", (store) => store.put(prepareMailboxCachePayload(stamped)));
  } catch {
    try {
      await withStore("readwrite", (store) => store.put(prepareMailboxCachePayload(stamped, FALLBACK_MAILBOX_CACHE_BYTES)));
    } catch {
      // IndexedDB quota/private-mode failures must never abort mailbox synchronization.
    }
  }
}

export async function clearMailboxCache(cacheKey: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(cacheKey));
}
