import { scopedStorageKey } from '../../../lib/cacheScope.ts';
import { STORAGE_KEYS } from '../../../lib/constants.ts';
import { readJsonStorage, writeJsonStorage } from '../../../lib/storage.ts';
import type { MailMode } from '../domain/mailState.ts';

export const MAIL_LIST_CACHE_VERSION = 6;

export type MailListCache<T> = {
  version: number;
  count: number;
  savedAt: number;
  items: T[];
};

export interface JsonStoragePort {
  read<T>(key: string, fallback: T): T;
  write(key: string, value: unknown): void;
}

export interface StringStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserJsonStorage: JsonStoragePort = {
  read<T>(key: string, fallback: T): T {
    return readJsonStorage(key, fallback);
  },
  write(key: string, value: unknown): void {
    writeJsonStorage(key, value);
  },
};

function browserSessionStorage(): StringStoragePort | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function normalizeCacheNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback;
}

function hasExpectedMailId(value: unknown, id: number): value is { id: number } {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Number((value as { id?: unknown }).id) === id;
}

export function mailListCacheKey(
  scope: string,
  mode: MailMode,
  page: number,
  pageSize: number,
  address: string,
): string {
  return scopedStorageKey(STORAGE_KEYS.mailListCachePrefix, scope, mode, page, pageSize, address.trim());
}

export function mailDetailCacheKey(scope: string, mode: MailMode, id: number): string {
  return scopedStorageKey(STORAGE_KEYS.mailDetailSessionPrefix, `v${MAIL_LIST_CACHE_VERSION}`, scope, mode, id);
}

export function parseMailListCache<T>(value: unknown): MailListCache<T> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== MAIL_LIST_CACHE_VERSION || !Array.isArray(record.items)) return null;
  const items = record.items as T[];
  return {
    version: MAIL_LIST_CACHE_VERSION,
    count: normalizeCacheNumber(record.count, items.length),
    savedAt: normalizeCacheNumber(record.savedAt, 0),
    items,
  };
}

export function readMailListCache<T>(
  key: string,
  storage: JsonStoragePort = browserJsonStorage,
): MailListCache<T> | null {
  try {
    return parseMailListCache<T>(storage.read<unknown>(key, null));
  } catch {
    return null;
  }
}

export function writeMailListCache<TSource, TStored = TSource>(
  key: string,
  items: TSource[],
  count: number,
  serialize: (item: TSource) => TStored,
  storage: JsonStoragePort = browserJsonStorage,
  savedAt = Date.now(),
): MailListCache<TStored> {
  const serializedItems = items.map(serialize);
  const payload: MailListCache<TStored> = {
    version: MAIL_LIST_CACHE_VERSION,
    count: normalizeCacheNumber(count, serializedItems.length),
    savedAt: normalizeCacheNumber(savedAt, 0),
    items: serializedItems,
  };
  try {
    storage.write(key, payload);
  } catch {
    // Cache persistence is best-effort and must not interrupt mailbox loading.
  }
  return payload;
}

export function readMailDetailCache<T extends { id: number }>(
  scope: string,
  mode: MailMode,
  id: number,
  storage: StringStoragePort | null = browserSessionStorage(),
): T | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(mailDetailCacheKey(scope, mode, id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return hasExpectedMailId(parsed, id) ? parsed as T : null;
  } catch {
    return null;
  }
}

export function writeMailDetailCache<TSource extends { id: number }, TStored extends { id: number }>(
  scope: string,
  mode: MailMode,
  mail: TSource,
  serialize: (mail: TSource) => TStored,
  storage: StringStoragePort | null = browserSessionStorage(),
): boolean {
  if (!storage) return false;
  try {
    const serialized = serialize(mail);
    if (!hasExpectedMailId(serialized, mail.id)) return false;
    storage.setItem(mailDetailCacheKey(scope, mode, mail.id), JSON.stringify(serialized));
    return true;
  } catch {
    return false;
  }
}
